'use strict';
// Append-only writer/reader for the recall→outcome attribution journal
// (.graph/recall-outcome-journal.jsonl).
//
// Purpose: produce a free implicit-lift signal by logging, for each task, which RAG-recalled KB
// notes were in its context and what the task's outcome was. No per-note bench on the hot path.
//
// Each JSONL row has one of two shapes:
//
//   pending (written at context-assembly time):
//     { ts, workspace, task_key, recalled_note_keys: [...], outcome: 'pending', via: 'rag'|'dag' }
//
//   resolved (written at task terminal transition):
//     { ts, workspace, task_key, recalled_note_keys: [...], outcome: 'approve'|'kickback'|'tested'|'failed', via: 'rag'|'dag' }
//
// Append-only: resolved rows are appended (never mutate prior rows). Readers take the LATEST row
// for a given task_key (last-write-wins); a pending row without a subsequent resolved row means
// the task has not yet reached a terminal outcome.
//
// Mirrors the pattern in lib/judge-journal.js: pure read/write, no daemon state, no HTTP.

const fs = require('fs');
const path = require('path');

// Valid outcome values.
const OUTCOMES = ['pending', 'approve', 'kickback', 'tested', 'failed'];

// Map from task terminal status strings to journal outcome values.
const STATUS_TO_OUTCOME = {
  done:     'approve',
  tested:   'tested',
  failed:   'failed',
  canceled: 'kickback',
};

/**
 * Append a single row to the recall-outcome journal under `ws`.
 * Silently no-ops if ws is falsy or the row is invalid (caller already guards task_key).
 * Never throws — journal failures must not break the surrounding HTTP path.
 *
 * @param {string} ws  - workspace root (e.g. state.workspace)
 * @param {object} row - { task_key, recalled_note_keys, outcome, via }
 */
function appendRow(ws, row) {
  if (!ws || !row || !row.task_key) return;
  const outcome = row.outcome || 'pending';
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    workspace: ws,
    task_key: row.task_key,
    recalled_note_keys: Array.isArray(row.recalled_note_keys) ? row.recalled_note_keys : [],
    outcome,
    via: row.via || 'rag',
  });
  try {
    fs.appendFileSync(path.join(ws, '.graph', 'recall-outcome-journal.jsonl'), line + '\n');
  } catch { /* journal failure must not propagate */ }
}

/**
 * Read every row from the recall-outcome journal under `ws`.
 * Tolerant: missing file → [], blank/corrupt lines are skipped.
 *
 * @param {string} ws
 * @returns {object[]}
 */
function readRows(ws) {
  const file = path.join(ws, '.graph', 'recall-outcome-journal.jsonl');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip torn/corrupt line */ }
  }
  return out;
}

/**
 * Return the latest row for each task_key (last-write-wins over the append-only log).
 * Rows are keyed by task_key; the last occurrence wins.
 *
 * @param {string} ws
 * @returns {Map<string, object>}  task_key → latest row
 */
function latestByTask(ws) {
  const map = new Map();
  for (const row of readRows(ws)) {
    if (row.task_key) map.set(row.task_key, row);
  }
  return map;
}

// --- Decay constants (exported for judge.js and tests) ----------------------------
const MIN_AGE_DAYS = 30;
const MIN_OPPORTUNITIES = 3;
const WIN_RATE_THRESHOLD = 0.25;

// --- Confidence scoring constants --------------------------------------------------
// Smoothing constant: shrinks low-n scores toward 0 (Bayesian-ish prior).
const CONFIDENCE_PRIOR = 4;
// Injection floor: notes below this confidence score are excluded from RAG context.
// Override via env var CONFIDENCE_FLOOR (parsed once at module init).
const _envFloor = parseFloat(process.env.CONFIDENCE_FLOOR);
const CONFIDENCE_FLOOR = Number.isFinite(_envFloor) ? _envFloor : 0.3;

// Outcomes that count as a WIN for a recalled note (task succeeded).
const WIN_OUTCOMES = new Set(['approve', 'tested']);
// Outcomes that count as a LOSS for a recalled note (task was rejected/failed).
const LOSS_OUTCOMES = new Set(['kickback', 'failed']);

/**
 * Aggregate win/loss statistics per recalled note key from the recall-outcome journal.
 *
 * Algorithm:
 *   1. Take the LATEST row per task_key (last-write-wins via latestByTask).
 *   2. Skip rows with outcome 'pending' — they have no terminal signal yet.
 *   3. For each remaining resolved row, credit every recalled_note_key:
 *        WIN_OUTCOMES  → +1 win
 *        LOSS_OUTCOMES → +1 loss
 *        (anything else is ignored — defensive against unknown future outcome values)
 *   4. Return a Map keyed by note key carrying { wins, losses, total, winRate }.
 *
 * @param {string} ws  - workspace root
 * @returns {Map<string, { wins: number, losses: number, total: number, winRate: number }>}
 */
function computeNoteStats(ws) {
  const latest = latestByTask(ws); // Map<taskKey, latestRow>
  const stats = new Map(); // noteKey → { wins, losses }

  for (const row of latest.values()) {
    // Skip pending rows — they have not yet reached a terminal outcome.
    if (!row.outcome || row.outcome === 'pending') continue;

    const isWin  = WIN_OUTCOMES.has(row.outcome);
    const isLoss = LOSS_OUTCOMES.has(row.outcome);
    if (!isWin && !isLoss) continue; // unknown outcome — skip defensively

    const keys = Array.isArray(row.recalled_note_keys) ? row.recalled_note_keys : [];
    for (const noteKey of keys) {
      if (!noteKey) continue;
      if (!stats.has(noteKey)) stats.set(noteKey, { wins: 0, losses: 0 });
      const s = stats.get(noteKey);
      if (isWin)  s.wins++;
      if (isLoss) s.losses++;
    }
  }

  // Compute derived fields.
  const out = new Map();
  for (const [noteKey, { wins, losses }] of stats) {
    const total   = wins + losses;
    const winRate = total > 0 ? wins / total : 0;
    out.set(noteKey, { wins, losses, total, winRate });
  }
  return out;
}

/**
 * Compute a continuous confidence score (0..1) for a note given its recall stats.
 *
 * Formula: confidence = winRate * (total / (total + CONFIDENCE_PRIOR))
 *
 * Rationale: a Bayesian-ish shrinkage score —
 *   - high winRate + high total  → score approaches winRate
 *   - low total (few observations) → score is shrunk toward 0 by the prior
 *   - zero total → 0 (but callers should treat "no history" as confidence = 1.0 to avoid
 *     penalising new notes)
 *
 * @param {{ wins: number, losses: number, total: number, winRate: number }} stats
 * @returns {number}  confidence in [0, 1]
 */
function computeConfidence(stats) {
  if (!stats || stats.total <= 0) return 0;
  return stats.winRate * (stats.total / (stats.total + CONFIDENCE_PRIOR));
}

/**
 * Convenience function: run computeNoteStats and map each entry to a scalar confidence score.
 *
 * @param {string} ws  - workspace root
 * @returns {Map<string, number>}  noteKey → confidence in [0, 1]
 */
function noteConfidenceMap(ws) {
  const statsMap = computeNoteStats(ws);
  const out = new Map();
  for (const [noteKey, stats] of statsMap) {
    out.set(noteKey, computeConfidence(stats));
  }
  return out;
}


// --- Corroboration threshold -----------------------------------------------
const CORROBORATION_MIN = 2;
function isCorroborated(noteKey, wsOrMap) {
  const statsMap = (wsOrMap instanceof Map) ? wsOrMap : computeNoteStats(wsOrMap);
  const s = statsMap.get(noteKey);
  if (!s) return false;
  return s.total >= CORROBORATION_MIN;
}

module.exports = {
  appendRow, readRows, latestByTask, STATUS_TO_OUTCOME, OUTCOMES,
  computeNoteStats,
  computeConfidence, noteConfidenceMap,
  CONFIDENCE_PRIOR, CONFIDENCE_FLOOR,
  MIN_AGE_DAYS, MIN_OPPORTUNITIES, WIN_RATE_THRESHOLD,
};
