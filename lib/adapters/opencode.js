'use strict';
const fs = require('fs');
const path = require('path');
const filedrop = require('../filedrop-tasks');
const usage = require('../harness-usage');
const usageAccounting = require('../usage-accounting');
const scheduler = require('./scheduler-substrate');

const PRICING_PATH = path.join(__dirname, '..', '..', 'pricing.json');
let _pricingCache = { mtimeMs: 0, models: {} };
function loadPricingModels() {
  try {
    const st = fs.statSync(PRICING_PATH);
    if (st.mtimeMs !== _pricingCache.mtimeMs) {
      const json = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8'));
      _pricingCache = { mtimeMs: st.mtimeMs, models: (json && json.models) || {} };
    }
  } catch {
    _pricingCache = { mtimeMs: 0, models: {} };
  }
  return _pricingCache.models;
}

const tasks = {
  aggregateWorkspace() { return []; },
  readTask() { return null; },
  readSessionTasksRaw() { return []; },
  writeStatus() { return false; },
  watch(onChange) { return filedrop.watch(onChange); },
  formatHealth() {
    return { sessions: 0, files: 0, parsed: 0, wellFormed: 0, anomalies: [], healthy: true };
  },
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

const usageApi = {
  sample(_transcript_path, opts = {}) {
    const slice = opts.reported_usage
      ? usageAccounting.normalizeReported(opts.reported_usage, 'opencode', opts)
      : usageAccounting.emptySlice('opencode', opts);
    this.price(slice);
    return slice;
  },
  normalizeReported(raw, ctx = {}) {
    const slice = usageAccounting.normalizeReported(raw, 'opencode', ctx);
    this.price(slice);
    return slice;
  },
  price(slice) {
    return usageAccounting.priceSlice(slice, loadPricingModels());
  },
  reconcile(workspace) {
    return {
      harness: 'opencode',
      workspace,
      totals: { ...usageAccounting.EMPTY_USAGE, by_model: {} },
      cost: usageAccounting.emptyCost(),
      human: usage.emptyHuman(),
      sessions: [],
    };
  },
  onSessionStart({ session, port }) {
    return usageAccounting.armDailyReconcileWakeup(scheduler, { session, harness: 'opencode', port });
  },
};

module.exports = { name: 'opencode', tasks, transcripts, scheduler, usage: usageApi };
