'use strict';

const { parentPort, workerData } = require('worker_threads');
const overlayStore = require('./overlay');
const judge = require('./judge');
const { DEFAULT_MAX_RUNNING } = require('./pressure-nudge');

function overlayRunningCount(overlay) {
  const running = new Set();
  for (const [key, status] of Object.entries((overlay && overlay.status) || {})) {
    if (status === 'in_progress') running.add(key);
  }
  for (const [key, snap] of Object.entries((overlay && overlay.snapshots) || {})) {
    if (snap && snap.status === 'in_progress') running.add(key);
  }
  return running.size;
}

function overlayHarnessInProgress(overlay, harnessKey) {
  if (!harnessKey) return false;
  if (overlay && overlay.status && overlay.status[harnessKey] === 'in_progress') return true;
  const snap = overlay && overlay.snapshots && overlay.snapshots[harnessKey];
  return !!(snap && snap.status === 'in_progress');
}

function assemble() {
  const workspace = workerData && workerData.workspace;
  if (!workspace) return { ok: false, error: 'workspace required' };
  const harnessKey = workerData.harnessKey;
  const depthThreshold = Number(workerData.depthThreshold) || 30;
  const maxRunning = Number(workerData.maxRunning) || DEFAULT_MAX_RUNNING;
  const overlay = overlayStore.load(workspace);
  overlay.workspace = workspace;

  const depth = judge.judgeQueueDepth(overlay);
  const dupClusters = judge.pendingDupClusterCount(overlay);
  const eagerActive = judge.eagerJudgePending(overlay);
  const running = overlayRunningCount(overlay);
  const drainInProgress = overlayHarnessInProgress(overlay, harnessKey);
  const capacityOk = running < maxRunning;

  return {
    ok: true,
    result: {
      workspace,
      depth,
      dupClusters,
      nudge: depth >= depthThreshold && capacityOk && !drainInProgress && !eagerActive,
      harness_task_key: harnessKey,
      running,
      capacity_ok: capacityOk,
      drain_in_progress: drainInProgress,
      eager_active: eagerActive,
    },
  };
}

try {
  parentPort.postMessage(assemble());
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.stack) || e) });
}
