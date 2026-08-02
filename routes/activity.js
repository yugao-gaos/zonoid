'use strict';
/**
 * GET /activity + GET /status — the ambient "what is the autonomous tier doing right now" surface.
 *
 * /activity is the full feed (for the dashboard panel); /status is the one-line digest a CLI or a
 * periodic report can poll without parsing an event list.
 *
 * Reads the in-process ring buffer (lib/activity.js) that headless-spawn + headless-drain write to,
 * and pairs it with the two pieces of context a viewer needs to interpret an EMPTY feed:
 *   - `autonomy`: the workspace's overlay flags (self_plan / automode / headless_driver). All off ⇒
 *     nothing is SUPPOSED to be happening.
 *   - `governor`: the shared headless budget/backoff counters. Non-zero `backoff_ms` or an exhausted
 *     budget ⇒ work is due but deliberately paused.
 *
 * Query params:
 *   workspace / graph_repo — scope to one workspace (optional; omitted ⇒ every workspace's events)
 *   limit                  — max events (default 100)
 *   since                  — only events with seq > since (incremental polling)
 *   kind                   — comma-separated kind filter (worker,planner,judge,…)
 */
const activity = require('../lib/activity');
const headlessDrain = require('../lib/headless-drain');

function governorView() {
  try {
    const g = headlessDrain._governor || {};
    const cfg = headlessDrain.effectiveConfig();
    const backoffMs = g.backoffUntil ? Math.max(0, g.backoffUntil - Date.now()) : 0;
    return {
      concurrent_running: g.concurrentRunning || 0,
      max_concurrency: cfg.maxConcurrency,
      iterations_used: g.iterationsUsed || 0,
      max_iterations: cfg.maxIterations,
      tokens_used: g.tokensUsed || 0,
      token_budget: cfg.tokenBudget,
      backoff_ms: backoffMs,
      throttled: backoffMs > 0,
    };
  } catch {
    return null;   // governor detail is advisory — never fail the feed over it
  }
}

function autonomyView(ov) {
  const cfg = (ov && ov.config) || {};
  const self_plan = !!cfg.self_plan;
  const automode = !!cfg.automode;
  const headless_driver = !!cfg.headless_driver;
  const on = [self_plan, automode, headless_driver].filter(Boolean).length;
  return {
    self_plan,
    automode,
    headless_driver,
    // `auto` is the one-switch tier: all three together. Anything in between is honestly partial.
    auto: on === 3,
    partial: on > 0 && on < 3,
  };
}

/** Start of the current local day — the window `merges_today` reports over. */
function startOfDayMs(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * Count TESTED tasks still waiting on same-node review. Reads straight off the overlay the request
 * already resolved — findReviewVerdictCandidates re-walks the graph, which is exactly the cost a
 * "lightweight status" endpoint must not pay. The PREDICATE is still the drain's own
 * (`_reviewVerdictPending`), so this count cannot drift from what the drain will actually pick up.
 */
function reviewsPending(ov) {
  if (!ov || !ov.status) return 0;
  const overlayStore = require('../lib/overlay');
  let n = 0;
  for (const [key, status] of Object.entries(ov.status)) {
    if (status !== 'tested') continue;
    if (headlessDrain._reviewVerdictPending(overlayStore.reviewLifecycleFor(ov, key, status))) n++;
  }
  return n;
}

module.exports = (ctx) => async (p, m, req, res, u) => {
  const { send, targetOverlay } = ctx;

  if ((p !== '/activity' && p !== '/status') || m !== 'GET') return false;

  // Workspace is OPTIONAL here: the ring is process-wide, and a daemon-level view ("is anything
  // running at all?") is a legitimate question. targetOverlay throwing / resolving nothing must
  // therefore degrade to the unscoped feed, not a 400.
  let ws = null;
  let ov = null;
  if (u.searchParams.get('workspace') || u.searchParams.get('graph_repo')) {
    try {
      const T = targetOverlay(null, u);
      ws = T.ws || null;
      ov = T.ov || null;
    } catch { /* unresolvable workspace ⇒ unscoped feed */ }
  }

  if (p === '/status') {
    const gov = governorView();
    const plannerMarker = ov && ov.planner && ov.planner.lastPlanAt;
    const lastPlanner = plannerMarker
      ? new Date(plannerMarker).toISOString()
      : (activity.lastEvent({ kind: activity.KIND.PLANNER, workspace: ws }) || {}).ts || null;
    send(res, 200, {
      ok: true,
      workspace: ws,
      autonomy: autonomyView(ov),
      workers_running: activity.running({ workspace: ws, kinds: activity.KIND.WORKER }).length,
      drains_running: gov ? gov.concurrent_running : null,
      reviews_pending: reviewsPending(ov),
      // Restart-durable: counted from the persisted archive, not the in-memory ring.
      merges_today: activity.countSince(startOfDayMs(), {
        kind: activity.KIND.REVIEW_MERGE, status: activity.STATUS.OK, workspace: ws,
      }),
      last_planner_run: lastPlanner,
      backoff_until: gov && gov.backoff_ms > 0 ? new Date(Date.now() + gov.backoff_ms).toISOString() : null,
    });
    return true;
  }

  const snap = activity.snapshot({
    workspace: ws,
    limit: u.searchParams.get('limit'),
    since: u.searchParams.get('since'),
    kinds: u.searchParams.get('kind'),
  });

  send(res, 200, {
    ok: true,
    workspace: ws,
    autonomy: autonomyView(ov),
    governor: governorView(),
    ...snap,
  });
  return true;
};
