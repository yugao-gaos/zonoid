// Harness adapter registry: the seam between the (harness-agnostic) daemon core and a
// concrete agent harness (Claude Code today). Core code never touches harness file layouts
// directly — it asks the ACTIVE adapter, selected by ZONOID_HARNESS (default 'claude').
//
// Adapter interface contract (every adapter implements all of it):
//   name — adapter id used for registration/selection.
//   tasks — native task-list integration:
//     aggregateWorkspace(ws, snapshots) -> [task]  union of the workspace's native tasks
//         ({ key:'session/id', session, id, label, description, native_status, deps[] }),
//         serving `snapshots` (overlay adoption/terminal copies) for tasks whose native
//         files are gone; adopted snapshots are authoritative over native structure.
//     readTask(namespacedKey) -> task|null         one native task by 'session/id' key.
//     readSessionTasksRaw(sessionId) -> [task]     every parseable native task file of one
//         session (no filtering beyond parseability — the caller decides).
//     writeStatus(namespacedKey, status) -> bool   write-through status onto the native
//         task file; best-effort, never throws, false when unkeyed/missing.
//     watch(onChange) -> dispose()                 watch the native task store, firing
//         onChange on any write; no-op disposer when watching is unavailable.
//     formatHealth(ws) -> health                   native-format drift check (counts + anomalies).
//   usage / transcripts — cost-attribution source (graceful degradation when absent):
//     source — 'transcripts' | 'self_reported' | 'none' (capability tag for callers).
//     projectDir(ws) -> path|null                  dir of transcript JSONLs, or null.
//     sessionTranscriptPath(mainTranscript, sessionId) -> path|null
//     listSessionTranscripts(projectDir) -> [{ id, path }]  main-session JSONLs only.
//     humanInputTokens(projectDir, opts) -> {...}  human-typed estimate; zeros when unavailable.
//     harnessOverheadTokens(projectDir, opts) -> {...}  harness overhead; zeros when unavailable.
//     selfReportedUsage(agents, opts) -> {...}     sum agent.reported_usage (hookless fallback).
//     taskUsageFromAgent(agent) -> usage|null        one agent's optional reported_usage field.
//   scheduler — harness-native scheduled (timed) tasks:
//     writeScheduledTask(opts) -> { ok, armed, ... } write + arm a one-time scheduled task.
//     armWakeup(ArmWakeupOpts) -> WakeupResult
//         cancel any prior wake for session, sleep delaySeconds, re-prompt same session.
//         ArmWakeupOpts: { session, delaySeconds, reason?, prompt? }
//     cancelWakeup(CancelWakeupOpts) -> WakeupResult
//         cancel a pending session wake. CancelWakeupOpts: { session }
//         WakeupResult: { ok, method?, pid?, delaySeconds?, canceled?, error? }
//         Claude delegates to native ScheduleWakeup (method:'native'); hookless harnesses use
//         lib/schedule-wakeup.js / adapters/common/schedule-wakeup.sh (hb4).
'use strict';

const scheduleWakeup = require('./schedule-wakeup');

const adapters = new Map();
let activeName = process.env.ZONOID_HARNESS || 'claude';

function register(name, adapter) { adapters.set(name, adapter); }

function select(name) {
  if (!adapters.has(name)) throw new Error(`unknown harness adapter: ${name}`);
  activeName = name;
}

function active() {
  const a = adapters.get(activeName);
  if (!a) throw new Error(`unknown harness adapter: ${activeName} (set ZONOID_HARNESS to a registered adapter)`);
  return a;
}

register('claude', require('./adapters/claude'));
register('cursor', require('./adapters/cursor'));
register('stub', require('./adapters/stub'));

module.exports = { active, register, select, scheduleWakeup };
