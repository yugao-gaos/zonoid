#!/usr/bin/env node
// Tests for scripts/gate-label.js — the outcome-linkage labeler.
//
// Strategy: spin up a lightweight mock HTTP server that impersonates the daemon's
// /task/detail and /search endpoints. Write synthetic gate-journal.jsonl rows to a
// temp workspace. Run gate-label.js as a child process pointed at the mock server
// (via ORCH_PORT env). Use async spawn (not spawnSync) so the parent event loop
// stays live to serve the mock server while the child runs.
//
// Covers:
//   1. inject row + task done + topKey in transcript text → TP, label=1.
//   2. inject row + task done + topKey NOT in transcript  → FP, label=0.
//   3. abstain row + task done (pass)                    → TN, label=0.
//   4. Idempotency: running twice does not duplicate rows.
//   5. task_key=null                                      → unlabelable (not in labeled file).
//   6. Coverage summary fields present in stdout.
//   7. (best-effort) abstain+fail+FN-match               → FN, label=1.
//
// Run: node test/gate-label.test.js
// Also runs under: ZONOID_SKIP_LIVE=1 node test/gate-label.test.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const LABEL_SCRIPT = path.join(REPO, 'scripts', 'gate-label.js');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
};

// ── Temp workspace ────────────────────────────────────────────────────────────
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gate-label-ws-')));
const GRAPH_DIR = path.join(WS, '.graph');
const JOURNAL_PATH = path.join(GRAPH_DIR, 'gate-journal.jsonl');
const LABELED_PATH = path.join(GRAPH_DIR, 'gate-labeled.jsonl');

fs.mkdirSync(GRAPH_DIR, { recursive: true });

// ── Mock daemon server ────────────────────────────────────────────────────────
// Serves /task/detail and /search from in-memory fixtures.
// NOTE: Must stay async-friendly — use spawn (not spawnSync) for child process so
// the parent event loop can serve mock requests while the child runs.
const MOCK_PORT = 19900 + Math.floor(Math.random() * 100);

// In-memory fixtures, mutated per test.
const taskRegistry = {};   // key → { task, summary, transcript }
let searchResults = [];    // returned by /search

function startMockServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${MOCK_PORT}`);

      if (url.pathname === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname === '/task/detail') {
        const key = url.searchParams.get('key');
        const entry = taskRegistry[key];
        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          task: entry.task,
          summary: entry.summary || '',
          transcript: entry.transcript || null,
          tokenUsage: entry.tokenUsage || null,
        }));
        return;
      }

      if (url.pathname === '/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: searchResults }));
        return;
      }

      res.writeHead(404);
      res.end('{}');
    });

    server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server));
  });
}

// ── Async child runner ────────────────────────────────────────────────────────
// Runs gate-label.js as a non-blocking child so the mock server's event loop
// stays live to respond to HTTP requests from the child.
function runLabeler() {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(process.execPath, [LABEL_SCRIPT, '--workspace', WS], {
      env: { ...process.env, ORCH_PORT: String(MOCK_PORT) },
    });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
    // Safety timeout — kill after 15s.
    setTimeout(() => { child.kill(); resolve({ status: -1, stdout, stderr }); }, 15000);
  });
}

// ── JSONL helpers ─────────────────────────────────────────────────────────────
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function writeJournal(rows) {
  fs.writeFileSync(JOURNAL_PATH, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function clearLabeled() {
  if (fs.existsSync(LABELED_PATH)) fs.unlinkSync(LABELED_PATH);
}

function writeTranscript(text) {
  const p = path.join(WS, `transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

// ── Base journal row ──────────────────────────────────────────────────────────
function makeRow(overrides = {}) {
  return {
    ts: new Date().toISOString(),
    workspace: WS,
    query: 'some query text',
    task_key: null,
    decision: 'abstain',
    reason: 'low-confidence',
    top1: 0.3,
    margin: 0.05,
    gap: 0.05,
    locality: 1,
    topType: 'empirical',
    topKey: null,
    via: 'semantic',
    embedModel: 'Xenova/all-MiniLM-L6-v2',
    gated: true,
    round: 1,
    kbCands: 10,
    cluster: 1,
    near45: 0,
    qTokens: 3,
    empTop10: 0.2,
    qWords: 3,
    taskWords: 5,
    hasSpec: false,
    complexity: 0.3,
    ...overrides,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  let server;
  let exitCode = 0;

  try {
    server = await startMockServer();

    // ── Shared fixtures ───────────────────────────────────────────────────────
    const NOTE_KEY = 'note:note-label-test-abc';
    const TASK_TP   = 'task-tp/1';
    const TASK_FP   = 'task-fp/1';
    const TASK_TN   = 'task-tn/1';
    const TASK_FAIL = 'task-fail/1';

    // Transcript containing the note key (TP case).
    const tpTranscript = writeTranscript(
      `Task running. Retrieved context from ${NOTE_KEY}. Used it to fix the session window bug. Done.`
    );
    // Transcript NOT containing the note key (FP case).
    const fpTranscript = writeTranscript(
      'Task running. Completed independently without external context. Done.'
    );
    // Transcript for TN.
    const tnTranscript = writeTranscript('Task running. Solved it. Done.');

    taskRegistry[NOTE_KEY] = {
      task: { id: NOTE_KEY, label: 'session window note', status: 'note', summary: 'session window overlap causes ~40% miss rate; measureWindowOverlap()' },
      summary: 'session window overlap causes ~40% miss rate; measureWindowOverlap()',
      transcript: null,
    };
    taskRegistry[TASK_TP] = {
      task: { id: TASK_TP, label: 'TP task', status: 'done', summary: 'fixed session window', metric: null, measurement: null },
      summary: 'fixed session window',
      transcript: tpTranscript,
      tokenUsage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 5000, total: 7000 },
    };
    taskRegistry[TASK_FP] = {
      task: { id: TASK_FP, label: 'FP task', status: 'done', summary: 'completed without note', metric: null, measurement: null },
      summary: 'completed without note',
      transcript: fpTranscript,
    };
    taskRegistry[TASK_TN] = {
      task: { id: TASK_TN, label: 'TN task', status: 'done', summary: 'solved independently', metric: null, measurement: null },
      summary: 'solved independently',
      transcript: tnTranscript,
    };
    taskRegistry[TASK_FAIL] = {
      task: { id: TASK_FAIL, label: 'failed task', status: 'failed', summary: 'could not resolve session window timing issue', metric: null, measurement: null },
      summary: 'could not resolve session window timing issue',
      transcript: null,
    };

    // ══ TEST 1: inject + done + topKey in transcript → TP ════════════════════
    {
      clearLabeled();
      writeJournal([
        makeRow({ decision: 'inject', reason: 'gap-specific-empirical', topKey: NOTE_KEY, task_key: TASK_TP }),
      ]);
      searchResults = [];

      const r = await runLabeler();
      const labeled = readJsonl(LABELED_PATH);
      const row = labeled[0];

      ok('TP: exit code 0', r.status === 0);
      ok('TP: exactly one labeled row', labeled.length === 1);
      ok('TP: quadrant is TP', row && row.quadrant === 'TP');
      ok('TP: label is 1', row && row.label === 1);
      ok('TP: note_used is true', row && row.note_used === true);
      ok('TP: task_status is done', row && row.task_status === 'done');
      ok('TP: labeled_at is ISO string', row && /^\d{4}-\d{2}-\d{2}T/.test(row.labeled_at));
      ok('TP: _key present', row && typeof row._key === 'string' && row._key.length > 0);
      ok('TP: top1 preserved', row && typeof row.top1 === 'number');
      ok('TP: embedModel preserved', row && row.embedModel === 'Xenova/all-MiniLM-L6-v2');
      ok('TP: fn_match is null (inject path)', row && row.fn_match === null);
      ok('TP: token_cost.output is 800', row && row.token_cost && row.token_cost.output === 800);
      ok('TP: token_cost.total is 7000', row && row.token_cost && row.token_cost.total === 7000);
    }

    // ══ TEST 2: inject + done + topKey NOT in transcript → FP ════════════════
    {
      clearLabeled();
      writeJournal([
        makeRow({ decision: 'inject', reason: 'gap-specific-empirical', topKey: NOTE_KEY, task_key: TASK_FP }),
      ]);
      searchResults = [];

      const r = await runLabeler();
      const labeled = readJsonl(LABELED_PATH);
      const row = labeled[0];

      ok('FP: exit code 0', r.status === 0);
      ok('FP: exactly one labeled row', labeled.length === 1);
      ok('FP: quadrant is FP', row && row.quadrant === 'FP');
      ok('FP: label is 0', row && row.label === 0);
      ok('FP: note_used is false', row && row.note_used === false);
    }

    // ══ TEST 3: abstain + pass → TN ══════════════════════════════════════════
    {
      clearLabeled();
      writeJournal([
        makeRow({ decision: 'abstain', topKey: null, task_key: TASK_TN }),
      ]);
      searchResults = [];

      const r = await runLabeler();
      const labeled = readJsonl(LABELED_PATH);
      const row = labeled[0];

      ok('TN: exit code 0', r.status === 0);
      ok('TN: exactly one labeled row', labeled.length === 1);
      ok('TN: quadrant is TN', row && row.quadrant === 'TN');
      ok('TN: label is 0', row && row.label === 0);
      // abstain path: fn_match only computed on fail; pass → null
      ok('TN: fn_match is null', row && row.fn_match === null);
    }

    // ══ TEST 4: idempotency — second run does not duplicate rows ═════════════
    {
      clearLabeled();
      // Use a fixed ts so row key is stable across runs.
      writeJournal([
        makeRow({ decision: 'abstain', task_key: TASK_TN, ts: '2026-01-01T00:00:00.000Z', query: 'idempotency-test' }),
      ]);
      searchResults = [];

      const r1 = await runLabeler();
      ok('idempotency: first run exit code 0', r1.status === 0);
      const afterFirst = readJsonl(LABELED_PATH);
      ok('idempotency: one row after first run', afterFirst.length === 1);

      const r2 = await runLabeler();
      ok('idempotency: second run exit code 0', r2.status === 0);
      const afterSecond = readJsonl(LABELED_PATH);
      ok('idempotency: still one row after second run (no duplicate)', afterSecond.length === 1);
    }

    // ══ TEST 5: task_key=null → unlabelable, not in labeled file ═════════════
    {
      clearLabeled();
      writeJournal([
        makeRow({ task_key: null, decision: 'abstain' }),
      ]);
      searchResults = [];

      const r = await runLabeler();
      const labeled = readJsonl(LABELED_PATH);

      ok('null task_key: exit code 0', r.status === 0);
      ok('null task_key: labeled file has no rows', labeled.length === 0);
      ok('null task_key: stdout mentions Unlabelable', r.stdout.includes('Unlabelable'));
    }

    // ══ TEST 6: coverage summary fields present in stdout ════════════════════
    {
      clearLabeled();
      writeJournal([
        makeRow({ task_key: TASK_TN, decision: 'abstain', ts: '2026-01-02T00:00:00.000Z', query: 'summary-test-a' }),
        makeRow({ task_key: null,    decision: 'abstain', ts: '2026-01-02T00:01:00.000Z', query: 'summary-test-b' }),
      ]);
      searchResults = [];

      const r = await runLabeler();
      const stdout = r.stdout;

      ok('summary: Total journal rows present', stdout.includes('Total journal rows'));
      ok('summary: Newly labeled present', stdout.includes('Newly labeled'));
      ok('summary: Still pending present', stdout.includes('Still pending'));
      ok('summary: Unlabelable present', stdout.includes('Unlabelable'));
      ok('summary: quadrant TP line present', stdout.includes('TP'));
      ok('summary: quadrant FP line present', stdout.includes('FP'));
      ok('summary: quadrant TN line present', stdout.includes('TN'));
      ok('summary: quadrant FN line present', stdout.includes('FN'));
    }

    // ══ TEST 7 (best-effort): abstain + fail + FN-match → FN ════════════════
    {
      clearLabeled();
      writeJournal([
        makeRow({ decision: 'abstain', task_key: TASK_FAIL, ts: '2026-01-03T00:00:00.000Z', query: 'fn-match-test' }),
      ]);
      // High-score search result → triggers FN branch.
      searchResults = [{ key: NOTE_KEY, title: 'session window note', score: 0.72, kind: 'note' }];

      const r = await runLabeler();
      const labeled = readJsonl(LABELED_PATH);
      const row = labeled[0];

      ok('FN: exit code 0', r.status === 0);
      ok('FN: exactly one labeled row', labeled.length === 1);
      ok('FN: quadrant is FN', row && row.quadrant === 'FN');
      ok('FN: label is 1', row && row.label === 1);
      ok('FN: fn_match is true', row && row.fn_match === true);
    }

    // ══ TEST 8: no tokenUsage on task → token_cost all zeros (graceful) ═══════
    {
      clearLabeled();
      // TASK_FP has no tokenUsage in the registry (undefined → null in mock response).
      writeJournal([
        makeRow({ decision: 'inject', reason: 'gap-specific-empirical', topKey: NOTE_KEY, task_key: TASK_FP,
                  ts: '2026-01-04T00:00:00.000Z', query: 'no-token-usage-test' }),
      ]);
      searchResults = [];

      const r = await runLabeler();
      const labeled = readJsonl(LABELED_PATH);
      const row = labeled[0];

      ok('no-tokenUsage: exit code 0', r.status === 0);
      ok('no-tokenUsage: labeled row present', labeled.length === 1);
      ok('no-tokenUsage: token_cost.output is 0', row && row.token_cost && row.token_cost.output === 0);
      ok('no-tokenUsage: token_cost.total is 0', row && row.token_cost && row.token_cost.total === 0);
    }

  } catch (e) {
    console.error('ERROR:', e && (e.stack || e.message));
    exitCode = 1;
  } finally {
    if (server) server.close();
    try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) exitCode = 1;
  process.exit(exitCode);
})().catch((e) => { console.error('ERROR:', e && (e.stack || e.message)); process.exit(1); });
