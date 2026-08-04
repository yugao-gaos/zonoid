'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { encodeWorkspace } = require('../native-tasks');
const runtimePaths = require('../runtime-paths');
const { EMPTY } = require('./schema');

const DIR = runtimePaths.runtimePath('overlay');

// Collision-free overlay filename: encodeWorkspace is lossy (both `/` and `.` -> `-`), so distinct
// workspaces could map to ONE file and clobber each other. Use a content hash, keeping a readable
// basename prefix for debuggability.
function fileFor(workspace) {
  const h = crypto.createHash('sha1').update(String(workspace || '')).digest('hex').slice(0, 16);
  const base = (path.basename(String(workspace || '')) || 'ws').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(DIR, `${base}-${h}.json`);
}

// Pre-hash filename — read for one-time migration of overlays written before the H2 fix.
function legacyFileFor(workspace) {
  return path.join(DIR, `${encodeWorkspace(workspace)}.json`);
}

// Collision-free diagnostics filename (separate from overlay config, survives regeneration).
function diagnosticsFileFor(workspace) {
  const h = crypto.createHash('sha1').update(String(workspace || '')).digest('hex').slice(0, 16);
  const base = (path.basename(String(workspace || '')) || 'ws').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(DIR, `${base}-${h}.diagnostics.json`);
}

function readLocalOverlay(workspace) {
  let o = null;
  try {
    o = JSON.parse(fs.readFileSync(fileFor(workspace), 'utf8'));
  } catch {
    try { o = JSON.parse(fs.readFileSync(legacyFileFor(workspace), 'utf8')); } catch { o = null; }
  }
  return o ? { ...EMPTY(), ...o } : EMPTY();
}

const LOCAL_FIELDS = [
  'git', 'reviews', 'cancel_requested', 'stop_requested', 'config', 'unwired',
  'judgedAtEpoch', 'judgeCursor', 'judgedClusters', 'judgedTaskDecisions', 'distinctClusters',
  // No graph-store event type covers these; without them here they'd be silently
  // dropped on every save/load round-trip (notes/guidance/optimize/epoch).
  'notes', 'guidance', 'decision_holds', 'optimize', 'epoch',
  // force-claim cap counters — must persist across daemon restarts
  'forceClaims',
  // explicit per-task block flags — must persist across daemon restarts + graph rebuilds
  'blocked',
  // MS3 usage accounting — hot-path agent slices + cold-path reconcile watermarks
  'usage_records', 'usage_reconcile', 'usage_reconcile_snapshot',
  // Rework-aware, role-tagged per-task cost rollup (accumulates across agent-run finishes).
  // Local-only: no graph-store event type covers it, so it must round-trip via the overlay file.
  'task_costs',
  'dispatcher_focus',
  // Runtime execution state and local diagnostics. Git-synced claim files are advisory audit
  // records; these local fields are the daemon's live/session view and must not enter graph-store.
  'claimSessions', 'git_claims', 'git_users', 'work_sessions', 'spawnLease',
  // HEADLESS SPAWN prepare backoff ({ taskKey -> { until, attempts, error, at } } —
  // lib/headless-spawn.js): a task whose prepare fails structurally fails identically on every
  // pump, so the penalty window must survive the overlay reload each pump does — otherwise the
  // executor re-attempts (and re-logs) the same unpreparable task every tick forever.
  'spawnBackoff',
  // HEADLESS PLANNER debounce state ({ lease, lastPlanAt, lastMode, noActionStreak, lastEpoch } —
  // lib/headless-spawn.js): must round-trip through the overlay file because every drain pump
  // reloads the overlay from disk — an unpersisted lease/cooldown would let repeated ticks stack
  // planner children, and an unpersisted no-action streak would restart the exponential cooldown
  // ladder at its base on every daemon restart.
  'planner',
  // AUTONOMY DAILY SPEND ceiling ({ day, tokens, runs, by_kind, notified_day, first_exceeded_at } —
  // lib/autonomy-budget.js): the per-workspace-per-day token counter every headless surface meters
  // into. It MUST be persisted, not in-memory: the whole point is a ceiling that a fresh managed
  // loop (or a daemon restart) cannot reset by minting a fresh budget.
  'autonomySpend',
  // FEATURE registry ({ key -> { feature_branch, feature_worktree, base, target? } } — routes/git.js
  // /feature/create): no graph-store event type covers it, so it must round-trip through the
  // overlay file — a dropped record leaves a later /feature/merge with no worktree to checkpoint.
  'features',
  // TASK embeddings: { taskKey -> [vec, ...] } (multi-vec schema). Local-only — no graph-store
  // event type covers them, so they must round-trip through the overlay file like notes/git.
  'taskVecs',
  'taskVecMeta',
  // EAGER JUDGE (task C): node keys with fresh unjudged candidate edges awaiting immediate
  // adjudication. Persisted so a daemon restart mid-burst doesn't drop the eager dispatch.
  'eagerJudge',
  // JUDGING->READY gate (task D): wall-clock anchor { nodeKey -> ms } for the judging timeout.
  // Persisted so a daemon restart does NOT reset the deadlock-prevention clock (the timeout is
  // measured from when edges were seeded, not from boot).
  'judgingSince',
  // Event-triggered re-judgment map.
  'edgeRejudge',
  // EAGER JUDGE LEASE (task 27): per-node dispatch lease.
  'eagerJudgeLease',
  // PENDING-DUP defer-to-judge (write-time dup guard): { noteKey -> { match, score } } for notes
  // ADMITTED provisional on a dup-guard fire. A pending_dup note is RETRIEVAL-INVISIBLE (excluded
  // from /search recall) and enqueued for the dup-judge. Persisted so the invisibility + the queued
  // adjudication survive a daemon restart (a dropped entry would silently make the note visible).
  'pendingDup',
  // Readiness-repair queue items. These are LLM-judgeable graph hygiene issues, distinct from
  // edge promotion: missing/canceled deps, stale projection, and stale explicit holds.
  'readinessRepairs',
  // Entity nodes still round-trip locally for compatibility; graph-store events now provide the
  // replayable/shared source of truth for fresh loads and projection.
  'entity_nodes',
];

function writeLocalOverlay(workspace, overlay) {
  fs.mkdirSync(DIR, { recursive: true });
  const dest = fileFor(workspace);
  const tmp = `${dest}.${process.pid}.tmp`;
  const empty = EMPTY();
  const localOnly = Object.fromEntries(LOCAL_FIELDS.map(k => [k, overlay[k] ?? empty[k]]));
  fs.writeFileSync(tmp, JSON.stringify(localOnly, null, 2));
  fs.renameSync(tmp, dest);
}

// Retrieve diagnostics for a workspace. Returns the diagnostics object or null if none exist.
// Shape: { lastError: string|null, errorCount: number, lastChecked: string }
function getDiagnostics(workspace) {
  try {
    return JSON.parse(fs.readFileSync(diagnosticsFileFor(workspace), 'utf8'));
  } catch {
    return null;
  }
}

// Store diagnostics for a workspace. Persists atomically (temp + rename pattern).
// value should be: { lastError: string|null, errorCount: number, lastChecked: string }
function setDiagnostics(workspace, value) {
  fs.mkdirSync(DIR, { recursive: true });
  const dest = diagnosticsFileFor(workspace);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, dest);
  return value;
}

module.exports = {
  DIR,
  fileFor,
  getDiagnostics,
  legacyFileFor,
  readLocalOverlay,
  setDiagnostics,
  writeLocalOverlay,
};
