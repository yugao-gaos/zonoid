'use strict';
const overlayStore = require('../lib/overlay');
const { rowKey, readJsonl, journalPath, labeledPath } = require('../scripts/gate-label');

// Pressure nudge rate-limit: one nudge per NUDGE_INTERVAL_MS, in-memory (a missed hour after
// restart is harmless). First caller within the window that sees depth>=NUDGE_LABEL_DEPTH wins
// the nudge token; concurrent callers in that same tick get nudge:false.
const NUDGE_LABEL_DEPTH = 10;
const NUDGE_INTERVAL_MS = 3600000; // 1 hour
let _lastNudgeAt = 0;

// Stable key for the standing "harness: label drain" task. Fixed slug so it is findable by label
// prefix across daemon restarts; the snapshot substrate keeps it in the graph indefinitely.
// Workers call start_task with this key before labeling, complete_task after — per-pass
// complete_task (status → done) is the claim-conflict guarantee: the next pass's start_task sees
// 'done' (not 'in_progress'), so no CAS conflict.
const HARNESS_LABEL_DRAIN_KEY = 'followup/harness-label-drain';

// Ensure the standing harness task exists idempotently in the overlay (pure mutation; caller saves).
// Uses the snapshot substrate so buildGraph, status derivation, and cost attribution all work
// with zero special-casing. The node is marked_root (no unwired quarantine) via the overlay.unwired delete.
function ensureHarnessLabelDrainTask(ov, save) {
  if (ov.snapshots && ov.snapshots[HARNESS_LABEL_DRAIN_KEY]) return; // already present
  overlayStore.setSnapshot(ov, HARNESS_LABEL_DRAIN_KEY, {
    subject: 'harness: label drain',
    description: 'Standing recurrent task claimed by each grader-drain background pass. ' +
      'Runs node scripts/gate-label.js and reports coverage counts. ' +
      'Token attribution for gate-labeling self-maintenance flows to this node (HARNESS cost bucket).',
    status: 'pending',
    blockedBy: [],
    owner: null,
    metadata: { harness: true, created_by: 'daemon:label-route' },
  });
  // Remove from unwired quarantine — this is a genuine root (no prerequisites).
  if (ov.unwired) delete ov.unwired[HARNESS_LABEL_DRAIN_KEY];
  save();
}

const makeRoute = (ctx) => async (p, m, req, res, u, body) => {
  const { send, notifyChange, buildGraph, state, targetOverlay } = ctx;

  if (p === '/label/pressure' && m === 'GET') {
    // Ensure the standing harness task exists before we might nudge (idempotent, cheap).
    const T = targetOverlay(null, u);
    ensureHarnessLabelDrainTask(T.ov, () => { T.save(); notifyChange(); });

    // Compute gradable backlog: journal rows that (a) have a non-null task_key, (b) are not
    // already labeled, and (c) whose task_key resolves to a TERMINAL task.
    const ws = state.workspace;
    const journalRows = readJsonl(journalPath(ws));
    const labeledRows = readJsonl(labeledPath(ws));
    const labeledKeys = new Set(labeledRows.map((r) => r._key).filter(Boolean));

    // Build a task status map from the graph for terminal check.
    const TERMINAL_STATUSES = new Set(['done', 'tested', 'failed', 'canceled']);
    const g = buildGraph(ws);
    const statusById = new Map(g.tasks.map((t) => [t.id, t.status]));

    let depth = 0;
    for (const row of journalRows) {
      if (!row.task_key) continue;                          // (a) must have task_key
      const key = rowKey(row);
      if (labeledKeys.has(key)) continue;                   // (b) not already labeled
      const status = statusById.get(row.task_key);
      if (!status || !TERMINAL_STATUSES.has(status)) continue; // (c) must be terminal
      depth++;
    }

    let nudge = false;
    if (depth >= NUDGE_LABEL_DEPTH) {
      const now = Date.now();
      if (now - _lastNudgeAt >= NUDGE_INTERVAL_MS) {
        _lastNudgeAt = now;  // stamp atomically — first caller wins the hour
        nudge = true;
      }
    }
    send(res, 200, { depth, nudge, harness_task_key: HARNESS_LABEL_DRAIN_KEY }); return true;
  }

  return false;
};

// Test seams: allows unit tests to control the nudge stamp without sleeping, and to inspect the
// standing harness task key and ensure function.
makeRoute._setLastNudgeAt = (ts) => { _lastNudgeAt = ts; };
makeRoute.HARNESS_LABEL_DRAIN_KEY = HARNESS_LABEL_DRAIN_KEY;
makeRoute.ensureHarnessLabelDrainTask = ensureHarnessLabelDrainTask;

module.exports = makeRoute;
