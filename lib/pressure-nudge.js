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

function computePressureNudge({ depth, depthThreshold, buildGraph, ws, overlay, harnessKey, maxRunning = DEFAULT_MAX_RUNNING }) {
  const running = countRunning(buildGraph, ws);
  const drainInProgress = harnessInProgress(overlay, buildGraph, ws, harnessKey);
  const capacityOk = running < maxRunning;
  const depthOk = depth >= depthThreshold;
  const nudge = depthOk && capacityOk && !drainInProgress;
  return { nudge, running, capacity_ok: capacityOk, drain_in_progress: drainInProgress };
}

module.exports = {
  JUDGE_DEPTH,
  LABEL_DEPTH,
  DEFAULT_MAX_RUNNING,
  countRunning,
  harnessInProgress,
  computePressureNudge,
};
