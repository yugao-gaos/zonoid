// Harness adapter registry: the seam between the (harness-agnostic) daemon core and concrete
// agent harnesses (Claude, Cursor, Codex, …). Adapters translate IDE layouts; the daemon
// only sees uniform task/usage shapes (see docs/adapter-contract.md Usage accounting).
//
// Registry only — harness.all(), harness.get(name), harness.route(key) for namespace dispatch.
// No ZONOID_HARNESS / active() on the daemon. MCP stdio client identity (ORCH_CLIENT) is MS4.
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
//   usage — cost attribution (TARGET local/ms3; adapters translate, daemon stores):
//     sample(transcript_path, { baseline?, window }) -> UsageSlice   hot: /agent/done
//     normalizeReported(raw) -> UsageSlice                           hookless bodies
//     price(slice) -> UsageSlice                                      fill cost.usd/by_model
//     reconcile(workspace, { since }) -> UsageReport                 cold: adapter sweep
//     onSessionStart({ session, workspace }) -> void                 stale-at + arm daily wake
//   Legacy (remove from daemon call sites with MS3): projectDir, listSessionTranscripts,
//     humanInputTokens, harnessOverheadTokens — replaced by sample/reconcile on adapters.
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

// Claude session keys are '<uuid>/<id>'; file-drop keys are '<harness>/<id>'.
const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function register(name, adapter) { adapters.set(name, adapter); }

function get(name) {
  const a = adapters.get(name);
  if (!a) throw new Error(`unknown harness adapter: ${name}`);
  return a;
}

function all() { return [...adapters.values()]; }

function namespaceOf(key) {
  const k = String(key || '');
  const i = k.indexOf('/');
  if (i <= 0) return null;
  return k.slice(0, i);
}

// Dispatch a namespaced task key to the adapter owning that namespace.
// '<session-uuid>/…' → claude; '<registered-harness>/…' → that adapter (file-drop stubs).
function route(key) {
  const ns = namespaceOf(key);
  if (!ns) return get('claude');
  if (UUID_PREFIX.test(ns)) return get('claude');
  if (adapters.has(ns)) return get(ns);
  return get('claude');
}

register('claude', require('./adapters/claude'));
register('cursor', require('./adapters/cursor'));
register('codex', require('./adapters/codex'));
register('stub', require('./adapters/stub'));

module.exports = { all, get, route, register, scheduleWakeup };
