'use strict';
const overlayStore = require('../lib/overlay');
const { rowKey, readJsonl, journalPath, labeledPath } = require('../scripts/gate-label');

const { LABEL_DEPTH, computePressureNudge } = require('../lib/pressure-nudge');

// Stable key for the standing "harness: label drain" task. Fixed slug so it is findable by label
// prefix across daemon restarts; the snapshot substrate keeps it in the graph indefinitely.
// Workers call start_task with this key before labeling, complete_task after. Standing harness
// tasks auto-requeue to ready on complete_task so the next pass is immediately claimable; claim
// conflict is preserved because complete clears in_progress before requeue.
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
    if (!T.ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    const targetWs = T.ws;
    ensureHarnessLabelDrainTask(T.ov, () => { T.save(); notifyChange(); });

    // Compute gradable backlog: journal rows that (a) have a non-null task_key, (b) are not
    // already labeled, and (c) whose task_key resolves to a TERMINAL task.
    const ws = targetWs;
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

    const gate = computePressureNudge({
      depth,
      depthThreshold: LABEL_DEPTH,
      buildGraph,
      ws,
      overlay: T.ov,
      harnessKey: HARNESS_LABEL_DRAIN_KEY,
    });
    send(res, 200, {
      workspace: ws,
      depth, nudge: gate.nudge, harness_task_key: HARNESS_LABEL_DRAIN_KEY,
      running: gate.running, capacity_ok: gate.capacity_ok, drain_in_progress: gate.drain_in_progress,
    }); return true;
  }

  return false;
};

// Deprecated test seam (hourly debounce removed — capacity gate is stateless).
makeRoute._setLastNudgeAt = () => {};
makeRoute.HARNESS_LABEL_DRAIN_KEY = HARNESS_LABEL_DRAIN_KEY;
makeRoute.ensureHarnessLabelDrainTask = ensureHarnessLabelDrainTask;

module.exports = makeRoute;
