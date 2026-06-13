'use strict';
const filedrop = require('../filedrop-tasks');
const usage = require('../harness-usage');
const usageAccounting = require('../usage-accounting');
const tasks = {
  aggregateWorkspace() { return []; },
  readTask(namespacedKey) { return null; },
  readSessionTasksRaw() { return []; },
  writeStatus(namespacedKey, status) { return filedrop.writeStatus(namespacedKey, status); },
  watch(onChange) { return filedrop.watch(onChange); },
  formatHealth() { return { sessions: 0, files: 0, parsed: 0, wellFormed: 0, anomalies: [], healthy: true }; },
};
const transcripts = {
  source: 'self_reported',
  projectDir() { return null; },
  sessionTranscriptPath() { return null; },
  listSessionTranscripts() { return []; },
  humanInputTokens(_p, opts) { return usage.emptyHuman(opts); },
  harnessOverheadTokens(_p, opts) { return usage.emptyOverhead(opts); },
  selfReportedUsage(agents, opts) { return usage.aggregateSelfReported(agents, opts); },
  taskUsageFromAgent(agent) { return usage.parseReportedUsage(agent); },
};
const scheduler = require('./scheduler-substrate');

const usageApi = {
  sample(_transcript_path, opts = {}) {
    if (opts.reported_usage) return usageAccounting.normalizeReported(opts.reported_usage, 'stub', opts);
    return usageAccounting.emptySlice('stub', opts);
  },
  normalizeReported(raw, ctx = {}) {
    return usageAccounting.normalizeReported(raw, 'stub', ctx);
  },
  reconcile(workspace) {
    return {
      harness: 'stub',
      workspace,
      totals: { ...usageAccounting.EMPTY_USAGE, by_model: {} },
      human: usage.emptyHuman(),
      sessions: [],
    };
  },
  onSessionStart({ session, port }) {
    return usageAccounting.armDailyReconcileWakeup(scheduler, { session, harness: 'stub', port });
  },
};

module.exports = { name: 'stub', tasks, transcripts, scheduler, usage: usageApi };
