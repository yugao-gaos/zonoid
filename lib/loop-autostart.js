'use strict';

const crypto = require('crypto');
const { isStandingHarnessTask } = require('./harness-task');
const overlayStore = require('./overlay');

// AUTO-mode loop autostart: when a session is in an auto-accept permission mode (bypassPermissions
// or acceptEdits) AND tasks are ready AND no loop is already bound to the session, the daemon starts
// the heartbeat loop ITSELF instead of merely nudging the model to call loop_control. This enforces
// the loop-default-on behavior the soft nudge could only suggest. Starting a loop does NOT change the
// merge-hold default (note:note-mq561rur) — it only begins dispatching; merges still await approval.

const AUTO_PERMISSION_MODES = new Set(['bypassPermissions', 'acceptEdits']);

const AUTOSTART_CONFIG = {
  tokenBudget: 5000000,
  maxIterations: 6250,
  minPoll: 30,
  maxPoll: 300,
  batch: 4,
  maxConcurrency: 6,
};

const MANAGED_GRAPH_LOOP = 'graph';
const MANAGED_GRAPH_LOOP_CONFIG = { ...AUTOSTART_CONFIG };
const TERMINAL_TASK_STATUSES = new Set(['done', 'completed', 'failed', 'canceled', 'cancelled']);

function truthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'yes';
}

/**
 * Universal auto-loop contract:
 * - autoMode/clientCapabilities.auto_execute are adapter-neutral signals.
 * - permissionMode keeps backcompat for Claude/Codex harness strings.
 * - autoLoopEnv keeps the explicit environment override.
 */
function resolveAutoLoopMode({ autoMode, clientCapabilities, permissionMode, autoLoopEnv } = {}) {
  if (truthy(autoLoopEnv) || truthy(autoMode)) return true;
  if (clientCapabilities && truthy(clientCapabilities.auto_execute)) return true;
  return AUTO_PERMISSION_MODES.has(String(permissionMode || ''));
}

const isAutoMode = resolveAutoLoopMode;

/** True iff some loop in the registry is active AND bound to this session. */
function hasActiveSessionLoop(loops, sessionId) {
  if (!sessionId) return false;
  for (const L of loops.values()) {
    if (L.active && L.session === sessionId) return true;
  }
  return false;
}

function managedGraphLoopId(workspace) {
  const h = crypto.createHash('sha1').update(String(workspace || '')).digest('hex').slice(0, 16);
  return `managed:graph:${h}`;
}

function isManagedGraphLoop(loop, workspace) {
  if (!loop || loop.managed !== MANAGED_GRAPH_LOOP) return false;
  if (workspace !== undefined && loop.workspace !== workspace) return false;
  return true;
}

function activeManagedGraphLoop(loops, workspace) {
  if (!workspace) return null;
  for (const L of loops.values()) {
    if (L.active && isManagedGraphLoop(L, workspace)) return L;
  }
  return null;
}

function autonomyEnabled(overlay) {
  const cfg = (overlay && overlay.config) || {};
  return truthy(cfg.self_plan) || truthy(cfg.automode) || truthy(cfg.headless_driver);
}

function isDisposableWorktreeWorkspace(workspace) {
  const ws = String(workspace || '');
  return ws.includes('/.zonoid/worktrees/')
    || ws.includes('/worktrees/')
    || ws.includes('/worktree/');
}

function taskAlreadySettled(overlay, key, currentStatus) {
  const git = overlay && overlay.git && overlay.git[key];
  const review = overlay && overlay.reviews && overlay.reviews[key];
  const snap = overlay && overlay.snapshots && overlay.snapshots[key];
  // Native projection, explicit overlay status, and the adoption snapshot can drift independently.
  // Any terminal source wins over stale review/merge metadata left behind by an older transition.
  const statuses = [
    currentStatus,
    overlay && overlay.status && overlay.status[key],
    snap && snap.status,
  ].map((status) => String(status || '').toLowerCase());
  return !!(
    (git && git.merged)
    || (review && (review.merge_state === 'merged' || review.review_state === 'landed'))
    || statuses.some((status) => TERMINAL_TASK_STATUSES.has(status))
  );
}

function isEligibleIntegrationTask(task, overlay) {
  if (!task || !task.id || overlayStore.isNonTaskNode(task)) return false;
  if (isStandingHarnessTask(overlay, task.id)) return false;
  if (overlay && overlay.blocked && overlay.blocked[task.id]) return false;
  return !taskAlreadySettled(overlay, task.id, task.status);
}

function isLegitimateReadyTask(task, overlay) {
  if (!task || task.status !== 'ready') return false;
  const key = task.id;
  if (!key || isStandingHarnessTask(overlay, key)) return false;
  if (overlay && overlay.blocked && overlay.blocked[key]) return false;
  if (overlay && overlay.unwired && overlay.unwired[key]) return false;
  if (taskAlreadySettled(overlay, key, task.status)) return false;
  return true;
}

function hasNormalReadyWork(graph, overlay) {
  return !!(graph && Array.isArray(graph.tasks) && graph.tasks.some((t) => isLegitimateReadyTask(t, overlay)));
}

function hasVisibleIntegrationWork(graph, overlay) {
  if (!graph || !Array.isArray(graph.tasks) || !overlay) return false;
  const reviewLifecycleFor = typeof overlay.reviewLifecycleFor === 'function'
    ? overlay.reviewLifecycleFor
    : overlayStore.reviewLifecycleFor;
  return graph.tasks.some((t) => {
    if (!isEligibleIntegrationTask(t, overlay)) return false;
    const lifecycle = reviewLifecycleFor(overlay, t.id, t.status);
    if (!lifecycle) return false;
    if (lifecycle.merge_state === 'review_pending') return true;
    if (lifecycle.review_state === 'approved' && lifecycle.review_verdict === 'APPROVE') {
      return lifecycle.merge_state === 'pending' || lifecycle.merge_state === 'conflict';
    }
    return lifecycle.review_state === 'requested' || lifecycle.review_state === 'pending' || lifecycle.merge_state === 'review_pending';
  });
}

function unsafeReadyReason(graph, overlay) {
  if (!graph || !Array.isArray(graph.tasks)) return null;
  const unwired = graph.tasks.some((t) => t && t.status === 'ready'
    && overlay && overlay.unwired && overlay.unwired[t.id]
    && !isStandingHarnessTask(overlay, t.id)
    && !taskAlreadySettled(overlay, t.id, t.status));
  return unwired ? 'ready_work_requires_wiring' : null;
}

function updateLiveness(overlay, next, nowValue) {
  if (!overlay || !next) return false;
  const prev = overlay.frontier_liveness || null;
  const comparable = (v) => v && JSON.stringify({
    status: v.status || null,
    reason: v.reason || null,
    managed_loop_id: v.managed_loop_id || null,
  });
  if (comparable(prev) === comparable(next)) return false;
  const n = typeof nowValue === 'function' ? nowValue() : Date.now();
  overlay.frontier_liveness = {
    status: next.status,
    reason: next.reason || null,
    managed_loop_id: next.managed_loop_id || null,
    updated_at: new Date(typeof n === 'number' ? n : Date.parse(n) || Date.now()).toISOString(),
  };
  return true;
}

function ensureManagedGraphLoop({ ctx, workspace, graph, overlay }) {
  if (isDisposableWorktreeWorkspace(workspace)) return { created: false, changed: false, overlayChanged: false, loop: null, stalledReason: null };
  if (!workspace) return { created: false, changed: false, overlayChanged: false, loop: null, stalledReason: 'workspace_unavailable' };

  const normalReady = hasNormalReadyWork(graph, overlay);
  const integration = hasVisibleIntegrationWork(graph, overlay);
  const unsafeReason = unsafeReadyReason(graph, overlay);
  if (!normalReady && !integration) {
    const overlayChanged = unsafeReason && autonomyEnabled(overlay)
      ? updateLiveness(overlay, { status: 'stalled', reason: unsafeReason }, ctx && ctx.now)
      : false;
    return { created: false, changed: overlayChanged, overlayChanged, loop: null, stalledReason: unsafeReason };
  }

  const { loops, newLoop, now } = ctx;
  if (!loops || typeof loops.values !== 'function' || typeof newLoop !== 'function') {
    const stalledReason = 'managed_loop_registry_unavailable';
    const overlayChanged = updateLiveness(overlay, { status: 'stalled', reason: stalledReason }, now);
    return { created: false, changed: overlayChanged, overlayChanged, loop: null, stalledReason };
  }

  let overlayChanged = false;
  const cfg = overlay && overlay.config;
  // Legacy installs commonly carry the first two autonomy flags but predate the daemon-owned
  // executor flag. That state looks autonomous in the UI while no process can consume a managed
  // loop, so complete the already-expressed opt-in as one repair.
  if (cfg && (truthy(cfg.automode) || truthy(cfg.self_plan)) && !truthy(cfg.headless_driver)) {
    cfg.headless_driver = true;
    overlayChanged = true;
  }

  const loopId = managedGraphLoopId(workspace);
  let L = loops.get(loopId);
  let created = false;
  let changed = overlayChanged;

  // Normalize restored legacy owners before evaluating the canonical owner's state. Even a
  // deliberately exhausted canonical loop must not leave a second legacy owner dispatching.
  for (const candidate of loops.values()) {
    if (candidate === L || !candidate.active || !isManagedGraphLoop(candidate, workspace)) continue;
    candidate.active = false;
    candidate.sweptReason = `superseded by ${loopId}`;
    changed = true;
  }

  // Token/iteration caps are explicit safety boundaries. Do not silently reset them; report the
  // reason so an operator can deliberately renew the budget instead of watching a dead loop.
  const exhausted = L && !L.active && (L.sweptReason === 'iteration cap reached' || L.sweptReason === 'token budget exhausted');
  if (exhausted) {
    const stalledReason = L.sweptReason === 'iteration cap reached'
      ? 'managed_loop_iteration_cap_reached'
      : 'managed_loop_token_budget_exhausted';
    overlayChanged = updateLiveness(overlay, { status: 'stalled', reason: stalledReason, managed_loop_id: loopId }, now) || overlayChanged;
    return { created: false, changed: changed || overlayChanged, overlayChanged, loop: null, stalledReason };
  }

  if (!L || !isManagedGraphLoop(L, workspace)) {
    L = newLoop({ id: loopId });
    loops.set(loopId, L);
    created = true;
    changed = true;
  }
  if (!L.active) {
    L.active = true;
    L.iterations = 0;
    L.spent = 0;
    L.startedAt = now();
    L.lastProgress = now();
    delete L.sweptReason;
    changed = true;
  }
  L.session = null;
  L.workspace = workspace;
  L.managed = MANAGED_GRAPH_LOOP;
  Object.assign(L.config, MANAGED_GRAPH_LOOP_CONFIG);

  if (autonomyEnabled(overlay)) {
    overlayChanged = updateLiveness(overlay, { status: 'active', reason: null, managed_loop_id: loopId }, now) || overlayChanged;
    changed = changed || overlayChanged;
  }
  return { created, changed, overlayChanged, loop: L, stalledReason: null };
}

/**
 * If auto-mode + ready tasks + no active session loop, start a loop directly and return a
 * confirmation line. Otherwise return null (caller falls back to the existing nudge). Idempotent:
 * a session that already drives an active loop gets null (no double-start).
 *
 * @returns {string|null} confirmation line, or null when no autostart happened.
 */
function maybeAutostartLoop({ ctx, sessionId, autoMode, hasReady, workspace }) {
  if (!sessionId || !autoMode || !hasReady) return null;
  const { loops, newLoop, saveLoops, state, now } = ctx;
  if (hasActiveSessionLoop(loops, sessionId)) return null;

  const L = newLoop();
  // newLoop defaults id:null — the registry is keyed by id, so mint one (mirrors POST /loop/start).
  L.id = require('crypto').randomUUID();
  L.active = true;
  L.startedAt = now();
  L.lastProgress = now();
  L.session = sessionId;
  L.workspace = workspace || (state && state.workspace) || null;
  Object.assign(L.config, AUTOSTART_CONFIG);
  loops.set(L.id, L);
  saveLoops();
  return `[Orchestrator] Auto-started loop ${L.id} (auto mode)`;
}

module.exports = {
  AUTO_PERMISSION_MODES,
  AUTOSTART_CONFIG,
  MANAGED_GRAPH_LOOP,
  MANAGED_GRAPH_LOOP_CONFIG,
  resolveAutoLoopMode,
  isAutoMode,
  hasActiveSessionLoop,
  managedGraphLoopId,
  isManagedGraphLoop,
  isDisposableWorktreeWorkspace,
  activeManagedGraphLoop,
  autonomyEnabled,
  isLegitimateReadyTask,
  isEligibleIntegrationTask,
  taskAlreadySettled,
  hasNormalReadyWork,
  hasVisibleIntegrationWork,
  unsafeReadyReason,
  ensureManagedGraphLoop,
  maybeAutostartLoop,
};
