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

module.exports = { appendRow, readRows, latestByTask, STATUS_TO_OUTCOME, OUTCOMES };
