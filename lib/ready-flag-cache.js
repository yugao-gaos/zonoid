'use strict';

const CACHE_TTL_SEC = 600;

/** @type {Map<string, { ts: number, count: number, labels: string[] }>} */
const flags = new Map();
/** @type {Set<string>} */
const busy = new Set();

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function isLoopTick(prompt) {
  return /(Autonomous loop tick|autonomous-loop-dynamic)/i.test(String(prompt || ''));
}

function refreshReadyFlag(sessionId, getReadyTasks) {
  if (!sessionId) return null;
  const now = nowSec();
  const existing = flags.get(sessionId);
  if (existing && (now - existing.ts) <= CACHE_TTL_SEC) return existing;

  const ready = getReadyTasks();
  if (ready.length > 0) {
    const entry = {
      ts: now,
      count: ready.length,
      labels: ready.map((t) => t.label || t.key || '?'),
    };
    flags.set(sessionId, entry);
    return entry;
  }
  flags.delete(sessionId);
  return null;
}

function syncBusyState(sessionId, prompt) {
  if (!sessionId) return;
  if (isLoopTick(prompt)) busy.delete(sessionId);
  if (!flags.has(sessionId)) busy.delete(sessionId);
}

function readyInjection(sessionId, prompt, hasActiveLoop = false) {
  if (!sessionId) return { text: '', injected: false };
  syncBusyState(sessionId, prompt);
  const entry = flags.get(sessionId);
  if (!entry || busy.has(sessionId)) return { text: '', injected: false };

  const labelStr = entry.labels.join(', ');
  const middle = hasActiveLoop
    ? `Loop already active — do NOT call loop_control start (it would mint a duplicate loop). ScheduleWakeup(delaySeconds=270, reason="watching active loop", prompt="<<autonomous-loop-dynamic>>").`
    : `No active loop detected — call loop_control({action:"start", tokenBudget:5000000, maxIterations:6250, minPoll:30, maxPoll:300, batch:4, maxConcurrency:6}) immediately, unless you are already handling a higher-priority user request (in which case ScheduleWakeup(delaySeconds=7200, reason="idle heartbeat", prompt="<<autonomous-loop-dynamic>>") as fallback).
If loop already active: ScheduleWakeup(delaySeconds=270, reason="watching active loop", prompt="<<autonomous-loop-dynamic>>").`;
  const text = `[Orchestrator] ${entry.count} tasks ready: [${labelStr}].
If you are working on something higher priority, use ScheduleWakeup(delaySeconds=7200, reason="idle heartbeat", prompt="<<autonomous-loop-dynamic>>") as a fallback.
${middle}
Never claim tasks directly — loop_control handles dispatch to subagents.`;
  busy.add(sessionId);
  return { text, injected: true };
}

// Mark a session as already-nudged without composing the nudge text. Used by AUTO-mode autostart:
// the daemon started the loop and emitted its own confirmation, so the soft nudge must stay
// suppressed on subsequent ticks (same busy semantics readyInjection applies after it emits).
function markReadyInjected(sessionId) {
  if (sessionId) busy.add(sessionId);
}

function _resetForTests() {
  flags.clear();
  busy.clear();
}

module.exports = {
  CACHE_TTL_SEC,
  refreshReadyFlag,
  readyInjection,
  markReadyInjected,
  syncBusyState,
  isLoopTick,
  _resetForTests,
};
