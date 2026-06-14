'use strict';

const JUDGE_DEPTH = 30;
const LABEL_DEPTH = 10;
const DEFAULT_MAX_RUNNING = 10;

function countRunning(buildGraph, ws) {
  if (!buildGraph || !ws) return 0;
  const g = buildGraph(ws);
  return g.tasks.filter((t) => t.status === 'in_progress').length;
}

function harnessInProgress(overlay, buildGraph, ws, harnessKey) {
  if (!harnessKey) return false;
  if (overlay && overlay.status && overlay.status[harnessKey] === 'in_progress') return true;
  if (buildGraph && ws) {
    const g = buildGraph(ws);
    const t = g.tasks.find((x) => x.id === harnessKey);
    if (t && t.status === 'in_progress') return true;
  }
  return false;
}

// eagerActive: eager dispatch (task C) is the PRIMARY judge trigger and node-scoped marks in
// overlay.eagerJudge mean it is ACTIVELY draining freshly-wired nodes this tick. When that path is
// live, the periodic prompt-driven catch-up nudge is DEMOTED to a fallback: it must not fire and
// double-dispatch on top of eager. It re-arms only once eager has no pending work (legacy/stuck
// backlog the eager trigger never queued) — i.e. eager is not keeping up. Default false so the
// label/learner pressure callers (which have no eager path) are unaffected.
function computePressureNudge({ depth, depthThreshold, buildGraph, ws, overlay, harnessKey, maxRunning = DEFAULT_MAX_RUNNING, eagerActive = false }) {
  const running = countRunning(buildGraph, ws);
  const drainInProgress = harnessInProgress(overlay, buildGraph, ws, harnessKey);
  const capacityOk = running < maxRunning;
  const depthOk = depth >= depthThreshold;
  const nudge = depthOk && capacityOk && !drainInProgress && !eagerActive;
  return { nudge, running, capacity_ok: capacityOk, drain_in_progress: drainInProgress, eager_active: eagerActive };
}

module.exports = {
  JUDGE_DEPTH,
  LABEL_DEPTH,
  DEFAULT_MAX_RUNNING,
  countRunning,
  harnessInProgress,
  computePressureNudge,
};
