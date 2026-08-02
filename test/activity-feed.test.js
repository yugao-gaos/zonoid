#!/usr/bin/env node
// Autonomy activity feed: the in-memory ring (lib/activity.js) + the GET /activity contract
// (routes/activity.js). No port binding — the route handler is driven directly with a fake ctx,
// same pattern as config-orch-auto.test.js.
//
// Covers:
//   RING
//   (1) begin() registers an in-flight row; end() settles it with a terminal status + duration
//   (2) end() is idempotent (safe to call from both a success path and a finally)
//   (3) the ring is bounded by ORCH_ACTIVITY_CAPACITY and counts what it evicted
//   (4) an evicted in-flight row leaves the running list (no phantom job outliving the buffer)
//   (5) workspace filtering is separator/case tolerant (Windows: D:\zonoid === D:/zonoid)
//   (6) since/limit/kind filtering — the incremental-polling contract a digest consumer needs
//   (7) list() keeps the NEWEST rows when limit bites, newest first
//   (8) fromDrainSummary maps the project's drain-summary shape onto ok/failed/skipped
//   ROUTE
//   (9) GET /activity returns running + events + governor + autonomy flags
//  (10) workspace-scoped requests only see that workspace's events
//  (11) an unresolvable workspace degrades to the unscoped feed (never a 400)
//  (12) the route ignores non-/activity paths and non-GET methods
//
// Run: node test/activity-feed.test.js
'use strict';

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const fs = require('fs');
const os = require('os');
const path = require('path');

// Set capacity BEFORE requiring: lib/activity reads the env var per call, but keeping it stable
// across the whole file makes the ring assertions deterministic.
process.env.ORCH_ACTIVITY_CAPACITY = '5';
// Redirect the persisted archive into a temp dir — the suite must never append to the real
// runtime activity.jsonl.
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-test-'));
const LOG = path.join(LOG_DIR, 'activity.jsonl');
process.env.ORCH_ACTIVITY_LOG = LOG;
const clearLog = () => { for (const f of [LOG, `${LOG}.1`]) { try { fs.unlinkSync(f); } catch { /* absent */ } } };

const activity = require('../lib/activity');
const activityRoute = require('../routes/activity');

const WS_A = 'D:\\zonoid';
const WS_B = '/tmp/other-ws';

// ---- (1) begin/end lifecycle ----------------------------------------------------------
activity.reset();
{
  const h = activity.begin({ kind: activity.KIND.WORKER, workspace: WS_A, task: 't/1', agent_id: 'headless-worker-1' });
  const live = activity.running();
  ok('begin registers an in-flight row', live.length === 1 && live[0].task === 't/1' && live[0].status === 'running');
  ok('in-flight row carries elapsed_ms', live[0].elapsed_ms >= 0);
  ok('running row text says running', /running/.test(live[0].text));

  h.end({ status: activity.STATUS.OK });
  ok('end clears the in-flight row', activity.running().length === 0);
  const [settled] = activity.list();
  ok('settled event keeps its identity', settled.task === 't/1' && settled.kind === 'worker');
  ok('settled event has terminal status', settled.status === 'ok');
  ok('settled event has a duration', settled.duration_ms != null && settled.duration_ms >= 0);
  ok('settled text is re-derived (no stale "running")', !/running/.test(settled.text));
}

// ---- (2) end() is idempotent ----------------------------------------------------------
activity.reset();
{
  const h = activity.begin({ kind: activity.KIND.JUDGE, workspace: WS_A });
  h.end({ status: activity.STATUS.FAILED, error: 'boom' });
  h.end({ status: activity.STATUS.OK });   // a stray second call must not rewrite the verdict
  const [ev] = activity.list();
  ok('second end() is a no-op', ev.status === 'failed' && ev.error === 'boom');
  ok('idempotent end leaves nothing in flight', activity.running().length === 0);
}

// ---- (3)+(4) ring bound, drop counting, in-flight eviction ----------------------------
activity.reset();
{
  const stranded = activity.begin({ kind: activity.KIND.WORKER, workspace: WS_A, task: 'stranded' });
  ok('stranded job starts in flight', activity.running().length === 1);
  // Capacity is 5; push 5 more events so the stranded row is evicted out of the ring.
  for (let i = 0; i < 5; i++) activity.record({ kind: activity.KIND.LABEL, workspace: WS_A, detail: { n: i } });
  const snap = activity.snapshot({ limit: 50 });
  ok('ring is bounded by ORCH_ACTIVITY_CAPACITY', snap.buffered === 5);
  ok('ring counts what it evicted', snap.dropped === 1);
  ok('evicted in-flight row is dropped from running', snap.running_count === 0);
  stranded.end({ status: activity.STATUS.OK });   // must not resurrect it
  ok('ending an evicted row does not resurrect it', activity.running().length === 0);
}

// ---- (4b) point events are terminal; running() ignores `since` -------------------------
activity.reset();
{
  const ev = activity.record({ kind: activity.KIND.REVIEW_MERGE, workspace: WS_A, status: 'running' });
  ok('record() coerces a running point event to terminal', ev.status === 'ok');
  ok('coerced point event is not in flight', activity.running().length === 0);

  const h = activity.begin({ kind: activity.KIND.WORKER, workspace: WS_A, task: 'long' });
  const later = activity.record({ kind: activity.KIND.LABEL, workspace: WS_A });
  ok('running() ignores `since` (a long job stays visible)', activity.running({ since: later.seq }).length === 1);
  ok('list() still honours `since`', activity.list({ since: later.seq }).length === 0);
  h.end({ status: activity.STATUS.OK });
}

// ---- (5) workspace filtering is path-shape tolerant -----------------------------------
activity.reset();
{
  activity.record({ kind: activity.KIND.WORKER, workspace: 'D:\\zonoid', task: 'win' });
  activity.record({ kind: activity.KIND.WORKER, workspace: WS_B, task: 'other' });
  const forward = activity.list({ workspace: 'D:/zonoid' });
  ok('backslash workspace matches forward-slash query', forward.length === 1 && forward[0].task === 'win');
  if (process.platform === 'win32') {
    ok('drive-letter case is ignored on win32', activity.list({ workspace: 'd:/ZONOID' }).length === 1);
  } else {
    ok('drive-letter case is ignored on win32 (skipped: not win32)', true);
  }
  ok('other workspace is filtered out', activity.list({ workspace: WS_B }).length === 1);
  ok('unscoped list sees both', activity.list().length === 2);
}

// ---- (6)+(7) since / limit / kind filtering -------------------------------------------
activity.reset();
process.env.ORCH_ACTIVITY_CAPACITY = '50';
{
  const first = activity.record({ kind: activity.KIND.JUDGE, workspace: WS_A });
  activity.record({ kind: activity.KIND.WORKER, workspace: WS_A, task: 'a' });
  const third = activity.record({ kind: activity.KIND.WORKER, workspace: WS_A, task: 'b' });

  ok('since returns only newer events', activity.list({ since: first.seq }).length === 2);
  ok('since at the head returns nothing', activity.list({ since: third.seq }).length === 0);
  ok('kind filters by a single kind', activity.list({ kinds: 'worker' }).length === 2);
  ok('kind accepts a comma list', activity.list({ kinds: 'worker,judge' }).length === 3);

  const limited = activity.list({ limit: 2 });
  ok('limit keeps the NEWEST rows, newest first', limited.length === 2 && limited[0].task === 'b' && limited[1].task === 'a');
  ok('seq is monotonically increasing', third.seq > first.seq);
}

// ---- (8) fromDrainSummary --------------------------------------------------------------
{
  const clean = activity.fromDrainSummary({ exitCode: 0, timedOut: false, spawnError: null });
  ok('clean drain summary → ok', clean.status === 'ok' && clean.error === null);

  const failed = activity.fromDrainSummary({ exitCode: 3, timedOut: false, spawnError: null });
  ok('non-zero exit → failed with exit code', failed.status === 'failed' && failed.error === 'exit 3');

  const timedOut = activity.fromDrainSummary({ exitCode: null, timedOut: true });
  ok('timeout → failed with timeout reason', timedOut.status === 'failed' && timedOut.error === 'timed out');
  ok('timeout carries the flag in detail', timedOut.detail && timedOut.detail.timed_out === true);

  const skipped = activity.fromDrainSummary({ skipped: 'prepare_failed', error: 'no worktree' });
  ok('skipped drain → skipped with reason', skipped.status === 'skipped' && skipped.reason === 'prepare_failed');
  ok('skipped keeps the error text', skipped.error === 'no worktree');

  const marked = activity.fromDrainSummary({ exitCode: 1, marked_failed: true, never_claimed: false });
  ok('marked_failed surfaces in detail', marked.detail && marked.detail.marked_failed === true);
  ok('falsy never_claimed is omitted from detail', marked.detail && marked.detail.never_claimed === undefined);
}

// ---- (8b) persisted archive: worker start→done round-trips, survives the ring -------------
activity.reset(); clearLog();
{
  const h = activity.begin({ kind: activity.KIND.WORKER, workspace: WS_A, task: 'round/trip', agent_id: 'w1' });
  ok('a running job is NOT archived yet', !fs.existsSync(LOG) || fs.readFileSync(LOG, 'utf8').trim() === '');
  h.end({ status: activity.STATUS.OK });

  const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok('settled job is archived exactly once (no running + done pair)', lines.length === 1);
  ok('archived row round-trips its identity', lines[0].task === 'round/trip' && lines[0].kind === 'worker');
  ok('archived row is the SETTLED shape', lines[0].status === 'ok' && lines[0].duration_ms != null);

  // The archive answers restart-spanning questions the bounded ring cannot.
  activity.record({ kind: activity.KIND.REVIEW_MERGE, workspace: WS_A, task: 'm1' });
  activity.record({ kind: activity.KIND.REVIEW_MERGE, workspace: WS_A, task: 'm2' });
  activity.record({ kind: activity.KIND.REVIEW_MERGE, workspace: WS_B, task: 'm3' });
  const since = new Date(new Date().getFullYear(), 0, 1).getTime();
  ok('countSince counts archived merges', activity.countSince(since, { kind: activity.KIND.REVIEW_MERGE }) === 3);
  ok('countSince honours the workspace filter', activity.countSince(since, { kind: activity.KIND.REVIEW_MERGE, workspace: WS_A }) === 2);
  ok('countSince honours a future floor', activity.countSince(Date.now() + 60000, { kind: activity.KIND.REVIEW_MERGE }) === 0);

  const last = activity.lastEvent({ kind: activity.KIND.WORKER });
  ok('lastEvent finds the newest archived match', last && last.task === 'round/trip');
  ok('lastEvent returns null when nothing matches', activity.lastEvent({ kind: activity.KIND.JUDGE }) === null);

  // A torn/partial trailing line must not poison the reader.
  fs.appendFileSync(LOG, '{"kind":"worker","at":');
  ok('a torn trailing line is skipped, not fatal', activity.countSince(since, { kind: activity.KIND.REVIEW_MERGE }) === 3);
}

// ---- (8c) recordChange is edge-triggered --------------------------------------------------
activity.reset(); clearLog();
{
  const first = activity.recordChange('backoff', 1, { kind: activity.KIND.DRAIN, text: 'backing off' });
  const same = activity.recordChange('backoff', 1, { kind: activity.KIND.DRAIN, text: 'backing off' });
  const changed = activity.recordChange('backoff', 2, { kind: activity.KIND.DRAIN, text: 'backing off harder' });
  ok('first edge records', first !== null);
  ok('unchanged signature does NOT record (no per-tick flood)', same === null);
  ok('changed signature records again', changed !== null);
  ok('only the two edges are in the ring', activity.list({ kinds: 'drain' }).length === 2);

  // Independent signals do not shadow each other.
  ok('a different signal records on its own edge', activity.recordChange('no_backend', 1, { kind: activity.KIND.DRAIN }) !== null);
}

// ---- (8d) never throws ---------------------------------------------------------------------
activity.reset(); clearLog();
{
  // A getter that throws during serialization is the realistic failure: instrumentation must
  // swallow it rather than take the drain down.
  const hostile = { get boom() { throw new Error('hostile detail'); } };
  let threw = false;
  try { activity.record({ kind: activity.KIND.WORKER, workspace: WS_A, detail: hostile }); } catch { threw = true; }
  ok('record() never throws on a hostile payload', threw === false);

  threw = false;
  let handle = null;
  try { handle = activity.begin({ kind: activity.KIND.WORKER, workspace: WS_A, detail: hostile }); } catch { threw = true; }
  ok('begin() never throws on a hostile payload', threw === false);
  ok('begin() still returns an end()-able handle', handle && typeof handle.end === 'function');
  threw = false;
  try { handle.end({ status: activity.STATUS.OK }); } catch { threw = true; }
  ok('the returned end() never throws', threw === false);
}

// ---- route harness ---------------------------------------------------------------------
// The overlay is a REAL overlayStore.EMPTY() so the route's reviewLifecycleFor/_reviewVerdictPending
// calls exercise the production predicates, not a stub that could drift from them.
const overlayStore = require('../lib/overlay');
function makeCtx(opts = {}) {
  const { _status, _review, planner, ...config } = opts;
  const ov = overlayStore.EMPTY();
  ov.config = config;
  if (_status) ov.status = { ..._status };
  if (planner) ov.planner = planner;
  for (const [key, patch] of Object.entries(_review || {})) overlayStore.setReviewLifecycle(ov, key, patch);
  let sent = null;
  return {
    ctx: {
      send: (res, code, body) => { sent = { code, body }; },
      targetOverlay: (_b, u) => {
        const wanted = u.searchParams.get('workspace') || u.searchParams.get('graph_repo');
        if (wanted === '__unresolvable__') throw new Error('no such workspace');
        return { ws: wanted, ov };
      },
    },
    sent: () => sent,
  };
}
async function call(harness, url, method = 'GET') {
  const u = new URL(`http://localhost:8787${url}`);
  const handled = await activityRoute(harness.ctx)(u.pathname, method, {}, {}, u);
  return { handled, ...(harness.sent() || {}) };
}

async function routeTests() {
// ---- (9) full response shape ------------------------------------------------------------
activity.reset();
{
  const live = activity.begin({ kind: activity.KIND.WORKER, workspace: WS_A, task: 'live/1' });
  activity.record({ kind: activity.KIND.REVIEW_MERGE, workspace: WS_A, task: 'merged/1', detail: { action: 'merge' } });

  const h = makeCtx({ self_plan: true, automode: true, headless_driver: true });
  const r = await call(h, '/activity?workspace=' + encodeURIComponent(WS_A));
  ok('route handles GET /activity', r.handled === true && r.code === 200);
  ok('response reports the running job', r.body.running_count === 1 && r.body.running[0].task === 'live/1');
  ok('response includes settled events', r.body.events.some((e) => e.task === 'merged/1'));
  ok('response echoes the workspace', r.body.workspace === WS_A);
  ok('response exposes seq for incremental polling', typeof r.body.seq === 'number');
  ok('all three flags set → auto true, partial false', r.body.autonomy.auto === true && r.body.autonomy.partial === false);
  ok('governor block is present', r.body.governor && typeof r.body.governor.concurrent_running === 'number');

  const partial = makeCtx({ automode: true });
  const rp = await call(partial, '/activity?workspace=' + encodeURIComponent(WS_A));
  ok('one flag of three → partial, not auto', rp.body.autonomy.partial === true && rp.body.autonomy.auto === false);

  const off = makeCtx({});
  const ro = await call(off, '/activity?workspace=' + encodeURIComponent(WS_A));
  ok('no flags → neither auto nor partial', ro.body.autonomy.auto === false && ro.body.autonomy.partial === false);

  live.end({ status: activity.STATUS.OK });
}

// ---- (10) workspace scoping through the route -------------------------------------------
activity.reset();
{
  activity.record({ kind: activity.KIND.WORKER, workspace: WS_A, task: 'in-a' });
  activity.record({ kind: activity.KIND.WORKER, workspace: WS_B, task: 'in-b' });

  const h = makeCtx({});
  const scoped = await call(h, '/activity?workspace=' + encodeURIComponent(WS_B));
  ok('scoped request sees only its workspace', scoped.body.events.length === 1 && scoped.body.events[0].task === 'in-b');

  const unscoped = await call(h, '/activity');
  ok('unscoped request sees every workspace', unscoped.body.events.length === 2);
  ok('unscoped request reports a null workspace', unscoped.body.workspace === null);
}

// ---- (11) unresolvable workspace degrades, never 400 -------------------------------------
{
  const h = makeCtx({});
  const r = await call(h, '/activity?workspace=__unresolvable__');
  ok('unresolvable workspace still returns 200', r.code === 200 && r.body.ok === true);
  ok('unresolvable workspace degrades to the unscoped feed', r.body.workspace === null && r.body.events.length === 2);
}

// ---- (12) route scoping -------------------------------------------------------------------
{
  const h = makeCtx({});
  ok('non-/activity path is not handled', (await call(h, '/state')).handled === false);
  ok('POST /activity is not handled', (await call(h, '/activity', 'POST')).handled === false);
  ok('POST /status is not handled', (await call(h, '/status', 'POST')).handled === false);
}

// ---- (13) GET /status — the lightweight CLI digest ------------------------------------------
activity.reset(); clearLog();
{
  const live = activity.begin({ kind: activity.KIND.WORKER, workspace: WS_A, task: 'w/1' });
  activity.begin({ kind: activity.KIND.JUDGE, workspace: WS_A });          // a drain, NOT a worker
  activity.record({ kind: activity.KIND.REVIEW_MERGE, workspace: WS_A, task: 'm/1' });
  activity.record({ kind: activity.KIND.REVIEW_MERGE, workspace: WS_A, task: 'm/2', status: activity.STATUS.FAILED, error: 'conflict' });

  // Two tested tasks: one awaiting review, one already approved (must NOT count as pending).
  const h = makeCtx({
    automode: true,
    _status: { 'p/1': 'tested', 'p/2': 'tested' },
    _review: { 'p/1': { review_state: 'requested', merge_state: 'review_pending' } },
  });
  const r = await call(h, '/status?workspace=' + encodeURIComponent(WS_A));
  ok('route handles GET /status', r.handled === true && r.code === 200);
  ok('workers_running counts ONLY worker jobs', r.body.workers_running === 1);
  ok('reviews_pending counts tasks awaiting review', r.body.reviews_pending === 1);
  ok('merges_today counts only merges that LANDED', r.body.merges_today === 1);
  ok('backoff_until is null when not throttled', r.body.backoff_until === null);
  ok('status echoes the autonomy flags', r.body.autonomy && r.body.autonomy.partial === true);
  ok('status reports last_planner_run (null with no planner history)', 'last_planner_run' in r.body);

  const withPlanner = makeCtx({ planner: { lastPlanAt: Date.parse('2026-07-04T12:00:00Z') } });
  const rp = await call(withPlanner, '/status?workspace=' + encodeURIComponent(WS_A));
  ok('last_planner_run prefers the durable overlay marker', rp.body.last_planner_run === '2026-07-04T12:00:00.000Z');

  live.end({ status: activity.STATUS.OK });
}
}

routeTests().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.log(`FAIL  route tests threw: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
