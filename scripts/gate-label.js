#!/usr/bin/env node
// gate-label.js — outcome-linkage labeler for the gate flywheel.
//
// Joins gate-journal.jsonl rows to their task's terminal outcome via the daemon, emits
// labeled rows to gate-labeled.jsonl using the four-quadrant scheme:
//
//   inject + note_used + pass  → TP (label=1)
//   inject + !note_used        → FP (label=0)   wasted inject, regardless of pass
//   abstain + pass             → TN (label=0)   correctly skipped
//   abstain + fail + FN-match  → FN (label=1)   should have injected
//   abstain + fail + no match  → TN (label=0)
//
// Run: node scripts/gate-label.js [--workspace <path>] [--port <n>]
// Idempotent: skips rows already in gate-labeled.jsonl (dedup by hash of ts+task_key+query).
//
// See design notes: note-mqb1i6ssdft, note-mqasdxx0tnt.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { contentTokens } = require('../lib/context-gate');
const predictiveLearning = require('../lib/search/predictive-learning');

// ── CLI args ──────────────────────────────────────────────────────────────────
function getArg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PORT = process.env.ORCH_PORT || getArg('--port', '8787');
const WORKSPACE = getArg('--workspace', process.cwd());
const JOURNAL_PATH = path.join(WORKSPACE, '.graph', 'gate-journal.jsonl');
const LABELED_PATH = path.join(WORKSPACE, '.graph', 'gate-labeled.jsonl');

// ── Exports (for routes/label.js and tests) ───────────────────────────────────
// Guarded by require.main check so requiring this module does NOT execute the CLI.
function journalPath(workspace) { return path.join(workspace, '.graph', 'gate-journal.jsonl'); }
function labeledPath(workspace) { return path.join(workspace, '.graph', 'gate-labeled.jsonl'); }

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
        } catch (e) {
          reject(new Error(`JSON parse error for ${url}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`timeout fetching ${url}`)); });
    req.end();
  });
}

// ── Stable row key: hash of ts + task_key + query ────────────────────────────
function rowKey(row) {
  return crypto.createHash('sha256')
    .update(`${row.ts || ''}|${row.task_key || ''}|${row.query || ''}`)
    .digest('hex').slice(0, 16);
}

// ── JSONL helpers ─────────────────────────────────────────────────────────────
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

// ── Task detail fetch ─────────────────────────────────────────────────────────
async function fetchTaskDetail(taskKey) {
  const url = `http://localhost:${PORT}/task/detail?key=${encodeURIComponent(taskKey)}`;
  const r = await httpGet(url);
  if (r.status !== 200) throw new Error(`task detail ${taskKey} → HTTP ${r.status}`);
  return r.body;
}

// ── Note content fetch (for token-overlap note_used check) ────────────────────
// Returns the note's combined title+summary text, or '' on failure.
async function fetchNoteText(noteKey) {
  try {
    const detail = await fetchTaskDetail(noteKey);
    const t = detail.task || {};
    return `${t.label || t.title || ''} ${t.summary || ''}`.trim();
  } catch {
    return '';
  }
}

// ── Transcript text reader ────────────────────────────────────────────────────
// Reads the raw JSONL transcript file as a single string for lexical matching.
// Returns '' if path is null/missing.
function readTranscriptText(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return '';
  try {
    if (!fs.existsSync(transcriptPath)) return '';
    return fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }
}

// ── note_used: lexical proxy ──────────────────────────────────────────────────
// true if topKey appears literally in taskText, OR >= 0.5 of the note's content
// tokens recur in the task text.
function computeNoteUsed(topKey, noteText, taskText) {
  if (!topKey || !taskText) return false;
  // Simple string inclusion of the topKey (e.g. "note:note-mqXXX")
  if (taskText.includes(topKey)) return true;
  // Token overlap fallback
  if (!noteText) return false;
  const noteToks = contentTokens(noteText);
  if (noteToks.length === 0) return false;
  const taskLower = taskText.toLowerCase();
  let hits = 0;
  for (const tok of noteToks) {
    if (taskLower.includes(tok)) hits++;
  }
  return (hits / noteToks.length) >= 0.5;
}

// ── FN matcher: post-mortem search ───────────────────────────────────────────
// abstain+fail → search KB as-of the journal row's ts; FN if any result scores >= 0.5.
// Returns { fnMatch: bool, fnTopKey, fnTopScore } on success; { fnMatch: null } on error.
async function fnMatcher(summaryText, asOfTs) {
  if (!summaryText || !summaryText.trim()) return { fnMatch: null };
  try {
    const q = encodeURIComponent(summaryText.slice(0, 300));
    const asOf = encodeURIComponent(asOfTs);
    const url = `http://localhost:${PORT}/search?q=${q}&asOf=${asOf}&k=5`;
    const r = await httpGet(url);
    if (r.status !== 200) return { fnMatch: null };
    const results = (r.body.results || []);
    const top = results.find((n) => (n.score || 0) >= 0.5);
    return {
      fnMatch: !!top,
      fnTopKey: top ? (top.key || null) : null,
      fnTopScore: top && typeof top.score === 'number' ? top.score : null,
    };
  } catch {
    return { fnMatch: null };
  }
}

// ── Terminal status helpers ───────────────────────────────────────────────────
const TERMINAL_STATUSES = new Set(['done', 'tested', 'failed', 'canceled']);
function isTerminal(status) { return TERMINAL_STATUSES.has(status); }
function isPass(task) {
  const status = task.status;
  if (status === 'done' || status === 'tested') return true;
  // metric-beat-baseline pass
  if (task.metric && task.measurement != null && task.measurement.baseline != null) {
    return task.measurement.value >= task.measurement.baseline;
  }
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Load journal rows
  const journalRows = readJsonl(JOURNAL_PATH);
  // Load already-labeled row keys for dedup
  const labeledRows = readJsonl(LABELED_PATH);
  const labeledKeys = new Set(labeledRows.map((r) => r._key).filter(Boolean));

  let newlyLabeled = 0;
  let stillPending = 0;
  let unlabelable = 0;
  const quadCounts = { TP: 0, FP: 0, TN: 0, FN: 0 };

  for (const row of journalRows) {
    const key = rowKey(row);

    // Skip already labeled
    if (labeledKeys.has(key)) continue;

    // No task_key → unlabelable
    if (!row.task_key) {
      unlabelable++;
      continue;
    }

    // Fetch task detail — fail-soft
    let detail;
    try {
      detail = await fetchTaskDetail(row.task_key);
    } catch {
      // daemon error or key not found — treat as pending (skip)
      stillPending++;
      continue;
    }

    const task = detail.task || {};
    const status = task.status || '';
    const tu = detail.tokenUsage || null;
    const token_cost = tu
      ? {
          output: tu.output_tokens || 0,
          input: tu.input_tokens || 0,
          cache_read: tu.cache_read_input_tokens || 0,
          total: tu.total != null ? tu.total : (tu.input_tokens || 0) + (tu.output_tokens || 0) + (tu.cache_read_input_tokens || 0),
        }
      : { output: 0, input: 0, cache_read: 0, total: 0 };

    // Not terminal yet → pending
    if (!isTerminal(status)) {
      stillPending++;
      continue;
    }

    const pass = isPass(task);
    const decision = row.decision; // 'inject' | 'abstain'
    const topKey = row.topKey || null;

    // Get task text for note_used: transcript + summary
    const summary = task.summary || detail.summary || '';
    const transcriptText = readTranscriptText(detail.transcript);
    const taskText = transcriptText + ' ' + summary;

    // note_used: only relevant for inject decisions
    let note_used = false;
    if (decision === 'inject' && topKey) {
      const noteText = await fetchNoteText(topKey).catch(() => '');
      note_used = computeNoteUsed(topKey, noteText, taskText);
    }

    // FN matcher: only for abstain+fail
    let fn_match = null;
    let fnResult = { fnMatch: null };
    if (decision === 'abstain' && !pass) {
      // Use task summary + label as the search query for the post-mortem
      const searchText = [task.label || '', summary].filter(Boolean).join(' ').trim();
      fnResult = await fnMatcher(searchText, row.ts);
      fn_match = fnResult.fnMatch;
    }

    // Four-quadrant label
    let quadrant, label;
    if (decision === 'inject') {
      if (note_used && pass) {
        quadrant = 'TP'; label = 1;
      } else if (!note_used) {
        quadrant = 'FP'; label = 0;
      } else {
        // inject + note_used + fail — note was referenced but task still failed
        // treat as FP (the inject didn't help, even if note was read)
        quadrant = 'FP'; label = 0;
      }
    } else {
      // abstain
      if (pass) {
        quadrant = 'TN'; label = 0;
      } else if (fn_match === true) {
        quadrant = 'FN'; label = 1;
      } else {
        quadrant = 'TN'; label = 0;
      }
    }

    quadCounts[quadrant]++;

    const labeledRow = {
      ...row,
      _key: key,
      label,
      quadrant,
      task_status: status,
      note_used,
      fn_match,
      fn_top_key: fnResult.fnTopKey || null,
      fn_top_score: typeof fnResult.fnTopScore === 'number' ? fnResult.fnTopScore : null,
      token_cost,
      labeled_at: new Date().toISOString(),
    };

    appendJsonl(LABELED_PATH, labeledRow);
    try { predictiveLearning.applyGateLabel(WORKSPACE, labeledRow); } catch { /* learning must not block labeling */ }
    labeledKeys.add(key);
    newlyLabeled++;
  }

  // Coverage summary
  const total = journalRows.length;
  const alreadyLabeled = labeledRows.length;
  console.log('');
  console.log('=== gate-label.js coverage summary ===');
  console.log(`Total journal rows:   ${total}`);
  console.log(`Already labeled:      ${alreadyLabeled}`);
  console.log(`Newly labeled:        ${newlyLabeled}`);
  console.log(`Still pending:        ${stillPending}  (task not terminal yet)`);
  console.log(`Unlabelable:          ${unlabelable}  (no task_key)`);
  console.log(`Quadrant distribution (new rows):`);
  console.log(`  TP (inject+used+pass):     ${quadCounts.TP}`);
  console.log(`  FP (inject+not-used):      ${quadCounts.FP}`);
  console.log(`  TN (abstain+pass or fail-no-match): ${quadCounts.TN}`);
  console.log(`  FN (abstain+fail+KB-match): ${quadCounts.FN}`);
  console.log('');

  return { total, alreadyLabeled, newlyLabeled, stillPending, unlabelable, quadCounts };
}

if (require.main === module) {
  main().catch((e) => {
    console.error('gate-label ERROR:', e && (e.stack || e.message));
    process.exit(1);
  });
}

module.exports = { rowKey, readJsonl, journalPath, labeledPath };
