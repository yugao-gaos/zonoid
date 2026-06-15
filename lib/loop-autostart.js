'use strict';

// AUTO-mode loop autostart: when a session is in an auto-accept permission mode (bypassPermissions
// or acceptEdits) AND tasks are ready AND no loop is already bound to the session, the daemon starts
// the heartbeat loop ITSELF instead of merely nudging the model to call loop_control. This enforces
// the loop-default-on behavior the soft nudge could only suggest. Starting a loop does NOT change the
// merge-hold default (note:note-mq561rur) — it only begins dispatching; merges still await approval.

const AUTO_PERMISSION_MODES = new Set(['bypassPermissions', 'acceptEdits']);

const AUTOSTART_CONFIG = {
  tokenBudget: 80000,
  maxIterations: 100,
  minPoll: 30,
  maxPoll: 300,
  batch: 4,
  maxConcurrency: 6,
};

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

/**
 * If auto-mode + ready tasks + no active session loop, start a loop directly and return a
 * confirmation line. Otherwise return null (caller falls back to the existing nudge). Idempotent:
 * a session that already drives an active loop gets null (no double-start).
 *
 * @returns {string|null} confirmation line, or null when no autostart happened.
 */
function maybeAutostartLoop({ ctx, sessionId, autoMode, hasReady }) {
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
  L.workspace = (state && state.workspace) || null;
  Object.assign(L.config, AUTOSTART_CONFIG);
  loops.set(L.id, L);
  saveLoops();
  return `[Orchestrator] Auto-started loop ${L.id} (auto mode)`;
}

module.exports = {
  AUTO_PERMISSION_MODES,
  AUTOSTART_CONFIG,
  isAutoMode,
  hasActiveSessionLoop,
  maybeAutostartLoop,
};
