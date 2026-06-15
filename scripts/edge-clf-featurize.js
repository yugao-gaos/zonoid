#!/usr/bin/env node
// edge-clf-featurize.js — featurizer for the edge classifier.
//
// Reads .graph/judge-journal.jsonl (judge verdict rows) and writes
// .graph/judge-train.jsonl (featurized training examples for the edge classifier).
//
// Each output row:
//   { label, cosine_sim, origin, src_type, tgt_type, same_session,
//     both_notes, note_to_task, task_to_task, edge_kind, by, epoch,
//     note_a_kind, note_b_kind, task_kind, task_complexity,
//     dag_depth_a, dag_depth_b, weight, source_row,
//     shadow_verdict, shadow_conf, model_version }
//
// Run: node scripts/edge-clf-featurize.js [--workspace <path>] [--port <n>] [--dry-run]
// Idempotent: re-running overwrites judge-train.jsonl.
// --dry-run: print stats without writing judge-train.jsonl
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

// ── CLI args ──────────────────────────────────────────────────────────────────
function getArg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const DRY_RUN = process.argv.includes('--dry-run');
const PORT = process.env.ORCH_PORT || getArg('--port', '8787');
const WORKSPACE = getArg('--workspace', process.cwd());
const JOURNAL_PATH = path.join(WORKSPACE, '.graph', 'judge-journal.jsonl');
const TRAIN_PATH = path.join(WORKSPACE, '.graph', 'judge-train.jsonl');

// ── Node-type classifier (from journal key, no HTTP needed) ───────────────────
// Returns a broad category string:
//   "note"     — "note:*"
//   "followup" — starts with "followup/"
//   "bench"    — starts with "bench/"
//   "local"    — starts with "local/"
//   "task"     — UUID/subtask pattern (e.g. "abc-…/7")
//   "other"    — anything else
function nodeTypeFromKey(key) {
  if (!key || typeof key !== 'string') return 'other';
  if (key.startsWith('note:')) return 'note';
  if (key.startsWith('followup/')) return 'followup';
  if (key.startsWith('bench/')) return 'bench';
  if (key.startsWith('local/')) return 'local';
  if (/^[0-9a-f-]{8,}\/\d+$/.test(key)) return 'task';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(key)) return 'task';
  return 'other';
}

// ── Session prefix extractor ──────────────────────────────────────────────────
function sessionPrefix(key) {
  if (!key) return null;
  const m = key.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : null;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { timeout: 10000 }, (res) => {
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

// ── Task detail fetch (cached) ────────────────────────────────────────────────
const nodeCache = new Map();

async function fetchNode(key) {
  if (nodeCache.has(key)) return nodeCache.get(key);
  try {
    const url = `http://localhost:${PORT}/task/detail?key=${encodeURIComponent(key)}`;
    const r = await httpGet(url);
    if (r.status !== 200) { nodeCache.set(key, null); return null; }
    const task = r.body.task || null;
    nodeCache.set(key, task);
    return task;
  } catch {
    nodeCache.set(key, null);
    return null;
  }
}

// ── Dot product of two vecs (cosine similarity when both are unit-normalized) ──
function dotProduct(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

// ── JSONL reader ──────────────────────────────────────────────────────────────
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const journalRows = readJsonl(JOURNAL_PATH);

  // Only process keep/prune verdicts — other verdicts (markJudged, consolidate, surface)
  // are not binary edge decisions.
  const eligible = journalRows.filter((r) => r.verdict === 'keep' || r.verdict === 'prune');

  const trainRows = [];
  let skippedNoVecs = 0;
  let hasV2 = 0;

  for (let i = 0; i < eligible.length; i++) {
    const row = eligible[i];
    const sourceRow = journalRows.indexOf(row);

    const fromKey = row.from;
    const toKey = row.to;

    if (!fromKey || !toKey) { skippedNoVecs++; continue; }

    // Key-derived features (no HTTP needed)
    const srcType = nodeTypeFromKey(fromKey);
    const tgtType = nodeTypeFromKey(toKey);
    const srcSession = sessionPrefix(fromKey);
    const tgtSession = sessionPrefix(toKey);
    const sameSession = !!(srcSession && tgtSession && srcSession === tgtSession);
    const isTaskLike = (t) => t === 'task' || t === 'followup' || t === 'bench' || t === 'local';

    // Fetch both nodes for embedding-derived features (best-effort, cached)
    const [nodeA, nodeB] = await Promise.all([fetchNode(fromKey), fetchNode(toKey)]);

    const vecA = nodeA?.vec || null;
    const vecB = nodeB?.vec || null;

    // Skip if BOTH embeddings are missing (can't compute cosine from live vecs)
    // but still include if journal has a cosine value
    if (!vecA && !vecB && row.cosine == null) { skippedNoVecs++; continue; }

    // cosine_sim: prefer live vecs, fall back to journal's pre-computed value
    let cosine_sim;
    if (vecA && vecB) {
      cosine_sim = dotProduct(vecA, vecB);
    } else if (row.cosine != null) {
      cosine_sim = row.cosine;
    } else {
      cosine_sim = 0;
    }

    // Node kind from daemon (rich) or key-derived fallback
    const note_a_kind = nodeA?.kind || srcType;
    const note_b_kind = nodeB?.kind || tgtType;

    // task_kind: category from the task-like node
    const taskNode = note_b_kind !== 'note' ? nodeB : (note_a_kind !== 'note' ? nodeA : null);
    const task_kind = taskNode?.category || 'unknown';

    // task_complexity: journaled if present, else 0.5
    const task_complexity = row.task_complexity != null ? row.task_complexity : 0.5;

    // dag_depth: number of blocking deps
    const dag_depth_a = (nodeA?.deps || []).length;
    const dag_depth_b = (nodeB?.deps || []).length;

    // label and weight
    const label = row.verdict; // 'keep' or 'prune'
    const weight = row.weight != null ? row.weight : (label === 'keep' ? 1.0 : 0.0);

    // v2 shadow fields (null when absent — legacy rows)
    if (row.shadow_verdict) hasV2++;

    trainRows.push({
      // Primary label
      label,
      // Core edge signal
      cosine_sim,
      origin: row.origin || null,
      // Key-derived structural features
      src_type: srcType,
      tgt_type: tgtType,
      same_session: sameSession,
      both_notes: srcType === 'note' && tgtType === 'note',
      note_to_task: srcType === 'note' && isTaskLike(tgtType),
      task_to_task: isTaskLike(srcType) && isTaskLike(tgtType),
      edge_kind: row.edgeKind || null,
      by: row.by || null,
      epoch: typeof row.epoch === 'number' ? row.epoch : null,
      // Daemon-enriched features
      note_a_kind,
      note_b_kind,
      task_kind,
      task_complexity,
      dag_depth_a,
      dag_depth_b,
      // Training metadata
      weight,
      source_row: sourceRow,
      // v2 shadow fields (null on legacy rows)
      shadow_verdict: row.shadow_verdict || null,
      shadow_conf: typeof row.shadow_conf === 'number' ? row.shadow_conf : null,
      model_version: row.model_version || null,
    });
  }

  const total = eligible.length;
  const kept = trainRows.filter((r) => r.label === 'keep').length;
  const pruned = trainRows.filter((r) => r.label === 'prune').length;
  const skipped = skippedNoVecs;

  if (DRY_RUN) {
    console.log(`journal rows : ${journalRows.length}`);
    console.log(`eligible     : ${total}  (keep/prune only)`);
    console.log(`training rows: ${trainRows.length}  (keep=${kept}, prune=${pruned})`);
    console.log(`skipped      : ${skipped}  (no cosine + no vecs)`);
    console.log(`v2 rows      : ${hasV2}  (have shadow_verdict)`);

    // Per-origin breakdown
    const byOrigin = {};
    for (const ex of trainRows) {
      const o = ex.origin || 'unknown';
      const b = byOrigin[o] || (byOrigin[o] = { kept: 0, pruned: 0 });
      if (ex.label === 'keep') b.kept++; else b.pruned++;
    }
    console.log('\nby origin:');
    for (const [o, b] of Object.entries(byOrigin)) {
      const t = b.kept + b.pruned;
      const rate = t ? (b.kept / t).toFixed(2) : 'n/a';
      console.log(`  ${o.padEnd(24)} keep=${b.kept} prune=${b.pruned} keepRate=${rate}`);
    }

    // Edge-type breakdown
    const byPair = {};
    for (const ex of trainRows) {
      const pair = `${ex.src_type}→${ex.tgt_type}`;
      const b = byPair[pair] || (byPair[pair] = { kept: 0, pruned: 0 });
      if (ex.label === 'keep') b.kept++; else b.pruned++;
    }
    console.log('\nby src->tgt type:');
    for (const [pair, b] of Object.entries(byPair)) {
      const t = b.kept + b.pruned;
      const rate = t ? (b.kept / t).toFixed(2) : 'n/a';
      console.log(`  ${pair.padEnd(20)} keep=${b.kept} prune=${b.pruned} keepRate=${rate}`);
    }

    console.log(`\n[dry-run] would write ${trainRows.length} rows to ${TRAIN_PATH}`);
    return;
  }

  // Write output (overwrite — re-runs are idempotent)
  const out = trainRows.map((r) => JSON.stringify(r)).join('\n') + (trainRows.length ? '\n' : '');
  fs.writeFileSync(TRAIN_PATH, out, 'utf8');
  console.log(`wrote ${trainRows.length} training examples to ${TRAIN_PATH}`);
  console.log(`  keep=${kept} prune=${pruned} v2rows=${hasV2} skipped=${skipped}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('edge-clf-featurize ERROR:', e && (e.stack || e.message));
    process.exit(1);
  });
}

module.exports = { nodeTypeFromKey, sessionPrefix, readJsonl };
