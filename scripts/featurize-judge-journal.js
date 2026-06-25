#!/usr/bin/env node
// featurize-judge-journal.js — featurizer for the gate/edge classifier.
//
// Reads .graph/gate-labeled.jsonl (labeled gate-journal rows) and writes
// data/judge-train.jsonl (structured training examples for the edge classifier).
//
// Schema of each output row:
//   cosine_score         {number}  — top1 cosine similarity of best KB candidate
//   from_kind            {string}  — node kind of the top KB result (note|task|followup|bench|local|other)
//   to_kind              {string}  — node kind of the requesting task (task|followup|bench|local|other)
//   neighborhood_size    {number}  — size of the KB candidate cluster (cluster field)
//   neighborhood_avg_relevance {number} — empTop10: fraction of top-10 empirical notes with score >= 0.45
//   supersede_chain_len  {number}  — number of supersede hops for the top note (0 if unavailable)
//   task_task            {boolean} — true when both from_kind and to_kind are task-like (not notes)
//   verdict              {0|1}     — training label (1=keep/inject, 0=prune/abstain)
//
// Rows are skipped when:
//   - No `label` field (not yet labeled by gate-label.js)
//   - label is not 0 or 1
//
// Run: node scripts/featurize-judge-journal.js [--workspace <path>] [--dry-run]
// Idempotent: re-running overwrites data/judge-train.jsonl.
// --dry-run: print stats without writing output file.
'use strict';

const fs = require('fs');
const path = require('path');

// ── CLI args ──────────────────────────────────────────────────────────────────
function getArg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const DRY_RUN = process.argv.includes('--dry-run');
const WORKSPACE = getArg('--workspace', process.cwd());

// Input: labeled gate-journal
const LABELED_PATH = path.join(WORKSPACE, '.graph', 'gate-labeled.jsonl');

// Output: structured training data for the edge classifier
const OUT_DIR = path.join(WORKSPACE, 'data');
const OUT_PATH = path.join(OUT_DIR, 'judge-train.jsonl');

// ── Node-kind classifier ──────────────────────────────────────────────────────
// Derives a broad kind string from a graph node key.
//   "note"     — "note:*"
//   "followup" — starts with "followup/"
//   "bench"    — starts with "bench/"
//   "local"    — starts with "local/"
//   "task"     — UUID/subtask pattern  (e.g. "abc-.../7")
//   "other"    — anything else (null, empty, unknown)
function kindFromKey(key) {
  if (!key || typeof key !== 'string') return 'other';
  if (key.startsWith('note:')) return 'note';
  if (key.startsWith('followup/')) return 'followup';
  if (key.startsWith('bench/')) return 'bench';
  if (key.startsWith('local/')) return 'local';
  if (/^[0-9a-f-]{8,}\/\d+$/.test(key)) return 'task';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(key)) return 'task';
  // Named task keys (e.g. "codex/foo", "unify/bar") are task-like
  if (key.includes('/')) return 'task';
  return 'other';
}

// Whether a kind is "task-like" (not a note)
function isTaskLike(kind) {
  return kind === 'task' || kind === 'followup' || kind === 'bench' || kind === 'local';
}

// ── JSONL reader ──────────────────────────────────────────────────────────────
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ── Feature extraction ────────────────────────────────────────────────────────
// Maps one labeled gate-journal row → one training example, or null if skippable.
function extractFeatures(row) {
  // Must have a label (0 or 1)
  if (row.label !== 0 && row.label !== 1) return null;

  // cosine_score: top1 cosine similarity of best KB candidate
  const cosine_score = typeof row.top1 === 'number' ? row.top1 : 0;

  // from_kind: kind of the top KB result (note that provided/would-provide context)
  // topKey is the key of the highest-scoring KB candidate
  const from_kind = kindFromKey(row.topKey || null);

  // to_kind: kind of the requesting task
  const to_kind = kindFromKey(row.task_key || null);

  // neighborhood_size: number of KB candidates in the cluster the top result belongs to.
  // The gate journal records `cluster` as the cluster id, but what we want is the size of
  // the neighborhood — `kbCands` is the total KB candidate count; `cluster` is the cluster
  // index/id (not directly useful as a size). We use kbCands as the neighborhood size since
  // that reflects how many notes were competing for this slot.
  const neighborhood_size = typeof row.kbCands === 'number' ? row.kbCands : 0;

  // neighborhood_avg_relevance: empTop10 — fraction of top-10 empirical notes with score in
  // the interesting range (~0.45), already normalized 0.0–1.0 by gate-journal.
  const neighborhood_avg_relevance = typeof row.empTop10 === 'number' ? row.empTop10 : 0;

  // supersede_chain_len: number of supersede hops on the top note.
  // The gate journal does not record this directly; default to 0 (enrichable later via daemon).
  // When available, this comes from note metadata tracking how many times the note was superseded.
  const supersede_chain_len = typeof row.supersede_chain_len === 'number' ? row.supersede_chain_len : 0;

  // task_task: true when neither party is a note — the edge connects task-like nodes on both ends.
  // In the gate context, the "from" is always a KB note candidate, so task_task = false unless
  // topKey is task-like too (unusual but possible for context edges from task nodes).
  const task_task = isTaskLike(from_kind) && isTaskLike(to_kind);

  // verdict: training label (1 = keep/inject, 0 = prune/abstain)
  const verdict = row.label;

  return {
    cosine_score,
    from_kind,
    to_kind,
    neighborhood_size,
    neighborhood_avg_relevance,
    supersede_chain_len,
    task_task,
    verdict,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  // Read labeled rows
  const rows = readJsonl(LABELED_PATH);
  if (rows.length === 0) {
    console.error(`No rows found in ${LABELED_PATH}`);
    process.exit(1);
  }

  const trainRows = [];
  let skippedNoLabel = 0;
  let kept = 0;
  let pruned = 0;

  for (const row of rows) {
    const ex = extractFeatures(row);
    if (ex === null) {
      skippedNoLabel++;
      continue;
    }
    if (ex.verdict === 1) kept++;
    else pruned++;
    trainRows.push(ex);
  }

  // Stats
  console.log(`gate-labeled rows : ${rows.length}`);
  console.log(`training examples : ${trainRows.length}  (verdict=1: ${kept}, verdict=0: ${pruned})`);
  console.log(`skipped (no label): ${skippedNoLabel}`);

  // Per-from_kind breakdown
  const byFromKind = {};
  for (const ex of trainRows) {
    const k = ex.from_kind;
    const b = byFromKind[k] || (byFromKind[k] = { keep: 0, prune: 0 });
    if (ex.verdict === 1) b.keep++; else b.prune++;
  }
  console.log('\nby from_kind:');
  for (const [k, b] of Object.entries(byFromKind)) {
    const t = b.keep + b.prune;
    const rate = t ? (b.keep / t).toFixed(2) : 'n/a';
    console.log(`  ${k.padEnd(12)} verdict=1: ${b.keep}  verdict=0: ${b.prune}  keep_rate: ${rate}`);
  }

  // Per-to_kind breakdown
  const byToKind = {};
  for (const ex of trainRows) {
    const k = ex.to_kind;
    const b = byToKind[k] || (byToKind[k] = { keep: 0, prune: 0 });
    if (ex.verdict === 1) b.keep++; else b.prune++;
  }
  console.log('\nby to_kind:');
  for (const [k, b] of Object.entries(byToKind)) {
    const t = b.keep + b.prune;
    const rate = t ? (b.keep / t).toFixed(2) : 'n/a';
    console.log(`  ${k.padEnd(12)} verdict=1: ${b.keep}  verdict=0: ${b.prune}  keep_rate: ${rate}`);
  }

  if (DRY_RUN) {
    console.log(`\n[dry-run] would write ${trainRows.length} rows to ${OUT_PATH}`);
    return;
  }

  // Ensure output directory exists
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  // Write output (overwrite — re-runs are idempotent)
  const out = trainRows.map((r) => JSON.stringify(r)).join('\n') + (trainRows.length ? '\n' : '');
  fs.writeFileSync(OUT_PATH, out, 'utf8');
  console.log(`\nwrote ${trainRows.length} rows to ${OUT_PATH}`);
}

main();
