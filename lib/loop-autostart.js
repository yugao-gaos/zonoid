'use strict';

const crypto = require('crypto');
const { isStandingHarnessTask } = require('./harness-task');

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

/** Auto-mode iff the payload carried an auto permission_mode OR the env fallback fired. */
function isAutoMode({ permissionMode, autoLoopEnv }) {
  if (autoLoopEnv) return true;
  return AUTO_PERMISSION_MODES.has(String(permissionMode || ''));
}

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

function hasNormalReadyWork(graph, overlay) {
  const blocked = (overlay && overlay.blocked) || {};
  return !!(graph && Array.isArray(graph.tasks) && graph.tasks.some((t) => (
    t && t.status === 'ready' && !blocked[t.id] && !isStandingHarnessTask(overlay, t.id)
  )));
}

function ensureManagedGraphLoop({ ctx, workspace, graph, overlay }) {
  if (!workspace || !hasNormalReadyWork(graph, overlay)) return { created: false, loop: null };
  const { loops, newLoop, now } = ctx;
  const existing = activeManagedGraphLoop(loops, workspace);
  if (existing) return { created: false, loop: existing };

  const loopId = managedGraphLoopId(workspace);
  const L = newLoop({ id: loopId });
  L.active = true;
  L.startedAt = now();
  L.lastProgress = now();
  L.session = null;
  L.workspace = workspace;
  L.managed = MANAGED_GRAPH_LOOP;
  Object.assign(L.config, MANAGED_GRAPH_LOOP_CONFIG);
  loops.set(loopId, L);
  return { created: true, loop: L };
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
  isAutoMode,
  hasActiveSessionLoop,
  managedGraphLoopId,
  isManagedGraphLoop,
  activeManagedGraphLoop,
  hasNormalReadyWork,
  ensureManagedGraphLoop,
  maybeAutostartLoop,
};
