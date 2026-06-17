// Cursor harness adapter: file-drop tasks + Cursor transcript JSONLs under
// ~/.cursor/projects/<encoded-workspace>/agent-transcripts/. Token usage in Cursor
// transcripts is often absent — cost attribution falls back to agent reported_usage.
'use strict';
const fs = require('fs');
const path = require('path');
const filedrop = require('../filedrop-tasks');
const cursorTx = require('../cursor-transcripts');
const usage = require('../harness-usage');
const usageAccounting = require('../usage-accounting');

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

function addCost(into, priced) {
  const cost = priced && priced.cost;
  if (!cost) return;
  into.usd += cost.usd || 0;
  for (const [m, v] of Object.entries(cost.by_model || {})) {
    if (!into.by_model[m]) into.by_model[m] = { tokens: 0, usd: 0 };
    into.by_model[m].tokens += v.tokens || 0;
    into.by_model[m].usd += v.usd || 0;
  }
}

const tasks = {
  // Cursor has no harness-native task store; file-drop stubs union in daemon.js via filedrop.
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
  source: 'transcripts',
  projectDir(ws) { return cursorTx.projectDir(ws); },
  sessionTranscriptPath(mainTranscript, sessionId) {
    return cursorTx.sessionTranscriptPath(mainTranscript, sessionId);
  },
  humanInputTokens(projectDir, opts) {
    if (!projectDir) return usage.emptyHuman(opts);
    try {
      const r = cursorTx.humanInputTokens(projectDir, opts);
      return r.files > 0 ? r : usage.emptyHuman(opts);
    } catch { return usage.emptyHuman(opts); }
  },
  harnessOverheadTokens(projectDir, opts) {
    if (!projectDir) return usage.emptyOverhead(opts);
    try {
      const r = cursorTx.harnessOverheadTokens(projectDir, opts);
      return r.files > 0 ? r : usage.emptyOverhead(opts);
    } catch { return usage.emptyOverhead(opts); }
  },
  listSessionTranscripts(projectDir) { return cursorTx.listSessionTranscripts(projectDir); },
  selfReportedUsage(agents, opts) { return usage.aggregateSelfReported(agents, opts); },
  taskUsageFromAgent(agent) { return usage.parseReportedUsage(agent); },
};

const scheduler = require('./scheduler-substrate');

const usageApi = {
  sample(transcript_path, opts = {}) {
    const slice = usageAccounting.emptySlice('cursor', {
      agent_id: opts.agent_id,
      session_id: opts.session_id,
      transcript_path,
      task_key: opts.task_key || null,
      startedAt: (opts.window && opts.window.start) || opts.startedAt || null,
      endedAt: (opts.window && opts.window.end) || opts.endedAt || null,
    });
    slice.usage = usageAccounting.parseTranscriptUsage(transcript_path, opts);
    slice.human = usageAccounting.humanForFile(transcript_path, opts);
    slice.overhead = { tokens: 0, by_category: {} };
    this.price(slice);
    return slice;
  },
  normalizeReported(raw, ctx = {}) {
    const slice = usageAccounting.normalizeReported(raw, 'cursor', ctx);
    this.price(slice);
    return slice;
  },
  price(slice) {
    return usageAccounting.priceSlice(slice, loadPricingModels());
  },
  reconcile(workspace, opts = {}) {
    const pd = transcripts.projectDir(workspace);
    const totals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, by_model: {} };
    const cost = usageAccounting.emptyCost();
    const sessions = [];
    for (const { id, path: tp } of cursorTx.listSessionTranscripts(pd)) {
      const u = usageAccounting.parseTranscriptUsage(tp, opts.since ? { window: { start: opts.since } } : {});
      usageAccounting.mergeTotals(totals, u);
      addCost(cost, this.price({ usage: u, cost: usageAccounting.emptyCost() }));
      sessions.push({ id, path: tp, total: u.output_tokens || 0 });
    }
    const human = transcripts.humanInputTokens(pd, { since: opts.since || null });
    return { harness: 'cursor', workspace, totals, cost, human, sessions };
  },
  onSessionStart({ session, workspace, port }) {
    return usageAccounting.armDailyReconcileWakeup(scheduler, { session, harness: 'cursor', port });
  },
};

module.exports = { name: 'cursor', tasks, transcripts, scheduler, usage: usageApi };
