// Harness adapter registry: the seam between the (harness-agnostic) daemon core and a
// concrete agent harness (Claude Code today). Core code never touches harness file layouts
// directly — it asks the ACTIVE adapter, selected by ZONOID_HARNESS (default 'claude').
//
// Adapter interface contract (every adapter implements all of it):
//   name — adapter id used for registration/selection.
//   tasks — native task-list integration:
//     aggregateWorkspace(ws, snapshots) -> [task]  union of the workspace's native tasks
//         ({ key:'session/id', session, id, label, description, native_status, deps[] }),
//         serving `snapshots` (overlay terminal-status copies) for tasks whose native
//         files are gone.
//     readTask(namespacedKey) -> task|null         one native task by 'session/id' key.
//     readSessionTasksRaw(sessionId) -> [task]     every parseable native task file of one
//         session (no filtering beyond parseability — the caller decides).
//     writeStatus(namespacedKey, status) -> bool   write-through status onto the native
//         task file; best-effort, never throws, false when unkeyed/missing.
//     watch(onChange) -> dispose()                 watch the native task store, firing
//         onChange on any write; no-op disposer when watching is unavailable.
//     formatHealth(ws) -> health                   native-format drift check (counts + anomalies).
//   transcripts — locating agent transcript / token-usage JSONLs:
//     projectDir(ws) -> path                       dir holding the workspace's transcript JSONLs.
//     sessionTranscriptPath(mainTranscript, sessionId) -> path
//         a session's transcript JSONL, resolved relative to the main transcript.
//     humanInputTokens(projectDir, opts) -> {...}  genuinely-human-typed token estimate.
//     harnessOverheadTokens(projectDir, opts) -> {...} machine-injected overhead breakdown.
//   scheduler — harness-native scheduled (timed) tasks:
//     writeScheduledTask(opts) -> { ok, armed, ... } write + arm a one-time scheduled task.
'use strict';

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

module.exports = { active, register, select };
