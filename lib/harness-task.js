'use strict';
const overlayStore = require('./overlay');

const HARNESS_JUDGE_DRAIN_KEY = 'followup/harness-judge-drain';
const HARNESS_LABEL_DRAIN_KEY = 'followup/harness-label-drain';
const DAEMON_RESTART_KEY = 'followup/harness-daemon-restart';

const STANDING_DRAIN_KEYS = new Set([HARNESS_JUDGE_DRAIN_KEY, HARNESS_LABEL_DRAIN_KEY]);

function isStandingHarnessTask(ov, key) {
  if (!key || key === DAEMON_RESTART_KEY) return false;
  if (STANDING_DRAIN_KEYS.has(key)) return true;
  const snap = ov && ov.snapshots && ov.snapshots[key];
  return !!(snap && snap.metadata && snap.metadata.harness === true);
}

function requeueStandingHarness(ov, key, note) {
  if (!isStandingHarnessTask(ov, key)) return false;
  overlayStore.setStatus(ov, key, 'ready', note);
  if (ov.assignee) delete ov.assignee[key];
  const snap = ov.snapshots && ov.snapshots[key];
  if (snap) snap.status = 'pending';
  const n = Date.now();
  const ts = ov.timestamps[key] = ov.timestamps[key] || {};
  if (!ts.firstSeen) ts.firstSeen = n;
  ts.lastChanged = n;
  ts.lastStatus = 'ready';
  return true;
}

module.exports = {
  HARNESS_JUDGE_DRAIN_KEY,
  HARNESS_LABEL_DRAIN_KEY,
  DAEMON_RESTART_KEY,
  isStandingHarnessTask,
  requeueStandingHarness,
};
