'use strict';
/**
 * lib/activity.js — in-memory activity ring buffer for the autonomous tier.
 *
 * WHY: headless work (spawned workers, planner children, judge/review-verdict/learner/label drains,
 * review merges) previously left NO trace a user could see. Its only record was a `process.stdout`
 * line, which survives solely when the daemon happens to have been started with output redirection.
 * The dashboard could show graph node STATES but never "what is running right now".
 *
 * WHAT: a process-local, bounded ring of activity events plus a live in-flight registry.
 *   - `begin()`  records a `running` event AND registers the job as in-flight; the returned handle's
 *     `end()` closes it out with a terminal status + duration.
 *   - `record()` appends a point-in-time event (things with no meaningful duration, e.g. a merge).
 *   - `list()` / `running()` / `snapshot()` read it back.
 *
 * Deliberately NOT persisted: this is an ambient "now" surface, not an audit log. The graph already
 * owns durable history (task states, review verdicts, notes). Losing the ring on daemon restart is
 * correct — a restart means nothing is in flight anymore anyway.
 *
 * Polling contract: every event carries a monotonically increasing `seq`. A consumer (the dashboard
 * panel, or a periodic digest) polls with `since: <last seq seen>` to get only what is new, and
 * compares `dropped` to detect ring overflow between polls.
 */

const DEFAULT_CAPACITY = 500;

/** Terminal + live statuses an event may carry. */
const STATUS = {
  RUNNING: 'running',
  OK: 'ok',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

/** Activity kinds. Kept as a closed set so consumers can filter/label without string drift. */
const KIND = {
  WORKER: 'worker',                   // headless-spawn: a task-implementing worker child
  PLANNER: 'planner',                 // headless-spawn: a plan/optimize planner child
  JUDGE: 'judge',                     // headless-drain: edge/attempt judge drain
  REVIEW_VERDICT: 'review_verdict',   // headless-drain: same-node code review
  REVIEW_MERGE: 'review_merge',       // headless-drain: approved attempt merged/promoted
  LEARNER: 'learner',                 // headless-drain: KB learner drain
  LABEL: 'label',                     // headless-drain: node labeling drain
};

const KINDS = new Set(Object.values(KIND));

/** Cap on any single free-text field so a runaway stderr snippet cannot balloon the ring. */
const MAX_TEXT = 400;

function clip(value, max = MAX_TEXT) {
  if (value == null) return null;
  const s = typeof value === 'string' ? value : String(value);
  const flat = s.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function capacity() {
  const raw = Number(process.env.ORCH_ACTIVITY_CAPACITY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CAPACITY;
}

/**
 * Normalize a workspace path for FILTERING only (the event keeps the caller's original spelling).
 * Windows callers mix `D:\zonoid` and `D:/zonoid` and differ in drive-letter case, so a raw string
 * compare would silently drop every event from the panel's view.
 */
function wsKey(workspace) {
  if (!workspace) return '';
  let s = String(workspace).replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}

// ---- state -------------------------------------------------------------------------------

const events = [];          // oldest → newest, length bounded by capacity()
const inflight = new Map();  // id → event (the same object that sits in `events`)
let seqCounter = 0;
let dropped = 0;             // events evicted by the ring since boot (overflow detector for pollers)

function trim() {
  const cap = capacity();
  while (events.length > cap) {
    const evicted = events.shift();
    dropped++;
    // An evicted event may still be in flight (a very long-running worker under heavy churn). Keep
    // the in-flight registry authoritative: `running()` must not resurrect a row `list()` dropped.
    if (evicted && inflight.get(evicted.id) === evicted) inflight.delete(evicted.id);
  }
}

/**
 * Human-readable one-liner. Built here rather than in each consumer so the dashboard panel and any
 * digest describe the same event identically.
 */
function describe(ev) {
  const d = ev.detail || {};
  const subject = ev.task ? `task ${ev.task}`
    : d.repo ? `repo ${d.repo}`
      : d.mode ? String(d.mode)
        : null;
  const label = subject ? `${ev.kind} · ${subject}` : ev.kind;
  if (ev.status === STATUS.RUNNING) return `${label} — running`;
  if (ev.status === STATUS.OK) return `${label} — done`;
  if (ev.status === STATUS.SKIPPED) return `${label} — skipped${ev.reason ? ` (${ev.reason})` : ''}`;
  return `${label} — failed${ev.error ? `: ${ev.error}` : ''}`;
}

function build(fields) {
  const now = Date.now();
  const kind = KINDS.has(fields.kind) ? fields.kind : String(fields.kind || 'unknown');
  const ev = {
    seq: ++seqCounter,
    id: `act-${seqCounter}`,
    at: now,
    ts: new Date(now).toISOString(),
    kind,
    status: fields.status || STATUS.RUNNING,
    workspace: fields.workspace || null,
    ws_key: wsKey(fields.workspace),
    task: fields.task || null,
    agent_id: fields.agent_id || null,
    provider: fields.provider || null,
    reason: clip(fields.reason, 120),
    error: clip(fields.error),
    duration_ms: fields.duration_ms != null ? Number(fields.duration_ms) : null,
    detail: fields.detail && typeof fields.detail === 'object' ? { ...fields.detail } : null,
  };
  ev.text = clip(fields.text) || describe(ev);
  return ev;
}

// ---- write API ---------------------------------------------------------------------------

/**
 * Append a point-in-time event (no duration). Use for things that either succeed or fail atomically,
 * e.g. a review merge or a prepare that never produced a child.
 *
 * A point event is TERMINAL by definition — it is never registered as in-flight, so nothing would
 * ever settle a `running` one. A caller that asks for `running` here meant `begin()`; coerce rather
 * than emit an event that `running()` cannot see and consumers would filter out as a live row.
 *
 * @returns {object} the recorded event (frozen-by-convention: callers must not mutate it).
 */
function record(fields = {}) {
  const ev = build({ status: STATUS.OK, ...fields });
  if (ev.status === STATUS.RUNNING) {
    ev.status = STATUS.OK;
    ev.text = clip(fields.text) || describe(ev);
  }
  events.push(ev);
  trim();
  return ev;
}

/**
 * Open a running job: records a `running` event and registers it as in-flight.
 * @returns {{id:string, seq:number, end:(outcome?:object)=>object}} handle whose `end()` closes the
 *   job out. `end()` is idempotent — a second call returns the already-settled event, so a caller
 *   may safely call it from both a success path and a `finally`.
 */
function begin(fields = {}) {
  const ev = build({ ...fields, status: STATUS.RUNNING });
  ev.started_at = ev.at;
  events.push(ev);
  inflight.set(ev.id, ev);
  trim();

  let settled = false;
  const end = (outcome = {}) => {
    if (settled) return ev;
    settled = true;
    inflight.delete(ev.id);
    ev.status = outcome.status || STATUS.OK;
    ev.duration_ms = Date.now() - ev.started_at;
    if (outcome.error != null) ev.error = clip(outcome.error);
    if (outcome.reason != null) ev.reason = clip(outcome.reason, 120);
    if (outcome.task) ev.task = outcome.task;
    if (outcome.detail && typeof outcome.detail === 'object') {
      ev.detail = { ...(ev.detail || {}), ...outcome.detail };
    }
    // Re-derive the summary line unless the caller pinned one: the status just changed, so the
    // "— running" text built at begin() is now wrong.
    ev.text = clip(outcome.text) || describe(ev);
    return ev;
  };

  return { id: ev.id, seq: ev.seq, end };
}

/**
 * Translate a headless DRAIN SUMMARY — the `{ skipped?, error?, exitCode, timedOut, spawnError }`
 * shape every drain/spawn path already builds and pushes onto `drains` — into an `end()` outcome.
 * Lives here so headless-spawn and headless-drain do not each carry a copy of the same mapping.
 */
function fromDrainSummary(summary = {}) {
  if (summary.skipped) {
    return { status: STATUS.SKIPPED, reason: summary.skipped, error: summary.error || null };
  }
  const clean = summary.exitCode === 0 && !summary.timedOut && !summary.spawnError;
  const detail = {};
  if (summary.exitCode != null) detail.exit_code = summary.exitCode;
  if (summary.timedOut) detail.timed_out = true;
  if (summary.marked_failed) detail.marked_failed = true;
  if (summary.never_claimed) detail.never_claimed = true;
  return {
    status: clean ? STATUS.OK : STATUS.FAILED,
    error: clean
      ? null
      : (summary.error || summary.spawnError
        || (summary.timedOut ? 'timed out' : `exit ${summary.exitCode}`)),
    detail: Object.keys(detail).length ? detail : null,
  };
}

// ---- read API ----------------------------------------------------------------------------

function matches(ev, { key, kinds, since }) {
  if (key && ev.ws_key && ev.ws_key !== key) return false;
  if (kinds && !kinds.has(ev.kind)) return false;
  if (since != null && ev.seq <= since) return false;
  return true;
}

function parseKinds(kind) {
  if (!kind) return null;
  const arr = Array.isArray(kind) ? kind : String(kind).split(',');
  const set = new Set(arr.map((k) => String(k).trim()).filter(Boolean));
  return set.size ? set : null;
}

/**
 * Read events, NEWEST FIRST (the order a feed renders in).
 * @param {object} opts
 *   workspace — restrict to one workspace (events with no workspace are always included; they are
 *               daemon-wide by nature).
 *   kinds     — kind string, comma list, or array.
 *   since     — only events with `seq > since` (incremental polling).
 *   limit     — max rows (default 100).
 */
function list(opts = {}) {
  const filter = {
    key: wsKey(opts.workspace),
    kinds: parseKinds(opts.kinds || opts.kind),
    since: opts.since != null && opts.since !== '' ? Number(opts.since) : null,
  };
  const limit = Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : 100;
  const out = [];
  // Walk newest → oldest so `limit` keeps the MOST RECENT rows, not the oldest surviving ones.
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    if (matches(events[i], filter)) out.push(events[i]);
  }
  return out;
}

/**
 * Currently in-flight jobs, longest-running first, each stamped with live `elapsed_ms`.
 * `since` is deliberately NOT applied: a job that started before the poller's cursor is still
 * running NOW, and dropping it would make a long job vanish from the live view mid-run.
 */
function running(opts = {}) {
  const key = wsKey(opts.workspace);
  const kinds = parseKinds(opts.kinds || opts.kind);
  const now = Date.now();
  const out = [];
  for (const ev of inflight.values()) {
    if (!matches(ev, { key, kinds, since: null })) continue;
    out.push({ ...ev, elapsed_ms: now - ev.started_at });
  }
  out.sort((a, b) => b.elapsed_ms - a.elapsed_ms);
  return out;
}

/**
 * One-call view for the HTTP surface: what is running now + what happened recently + the counters a
 * poller needs to tell "quiet" from "I missed events".
 */
function snapshot(opts = {}) {
  const rows = list(opts);
  const live = running(opts);
  return {
    now: new Date().toISOString(),
    seq: seqCounter,
    capacity: capacity(),
    dropped,
    buffered: events.length,
    running_count: live.length,
    running: live,
    events: rows,
  };
}

/** Test seam: wipe the ring + in-flight registry. Not used in production paths. */
function reset() {
  events.length = 0;
  inflight.clear();
  seqCounter = 0;
  dropped = 0;
}

module.exports = {
  KIND,
  STATUS,
  // write
  record,
  begin,
  fromDrainSummary,
  // read
  list,
  running,
  snapshot,
  // test seam
  reset,
};
