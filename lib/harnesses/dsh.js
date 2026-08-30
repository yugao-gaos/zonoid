// DeepSeek Harness adapter: DSH file-drop namespace, durable session usage, and the shared
// hookless scheduler. The supported host contract is pinned in docs/dsh-host-contract.md.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const harnessUsage = require('../harness-usage');
const usageAccounting = require('../usage-accounting');
const scheduler = require('../adapters/scheduler-substrate');
const { createFiledropNamespaceTasks } = require('./filedrop-namespace');

const PRICING_PATH = path.join(__dirname, '..', '..', 'pricing.json');
let pricingCache = { mtimeMs: 0, models: {} };

function loadPricingModels() {
  try {
    const stat = fs.statSync(PRICING_PATH);
    if (stat.mtimeMs !== pricingCache.mtimeMs) {
      const parsed = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8'));
      pricingCache = { mtimeMs: stat.mtimeMs, models: (parsed && parsed.models) || {} };
    }
  } catch { pricingCache = { mtimeMs: 0, models: {} }; }
  return pricingCache.models;
}

function dshHome() {
  return path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
}

function sessionsDir() {
  return path.resolve(process.env.DSH_SESSION_ROOT || path.join(dshHome(), 'sessions'));
}

function listSessionFiles(root = sessionsDir(), depth = 0, out = []) {
  if (depth > 6) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) listSessionFiles(full, depth + 1, out);
    else if (entry.isFile() && (entry.name === 'session.jsonl' || entry.name === 'session.jsonl.zstd')) out.push(full);
  }
  return out;
}

function readSessionText(file) {
  const bytes = fs.readFileSync(file);
  if (!String(file).endsWith('.zstd')) return bytes.toString('utf8');
  if (typeof zlib.zstdDecompressSync !== 'function') {
    const error = new Error('this Node runtime cannot decode DSH zstd session logs');
    error.code = 'ZSTD_UNAVAILABLE';
    throw error;
  }
  // DSH appends one independent zstd frame per durable batch. Node's one-shot decoder stops after
  // the first frame, so advance by the decoder's consumed-byte count until the whole log is read.
  const frames = [];
  let offset = 0;
  while (offset < bytes.length) {
    const decoded = zlib.zstdDecompressSync(bytes.subarray(offset), { info: true });
    const consumed = Number(decoded.engine && decoded.engine.bytesWritten) || 0;
    if (consumed <= 0) throw new Error('DSH zstd decoder made no progress');
    frames.push(decoded.buffer);
    offset += consumed;
  }
  return Buffer.concat(frames).toString('utf8');
}

function canonicalPath(value) {
  const resolved = path.resolve(String(value || ''));
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function isoTime(value) {
  if (value == null) return null;
  const millis = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  return new Date(millis).toISOString();
}

function inWindow(value, window) {
  if (!window) return true;
  const millis = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(millis)) return true;
  const start = window.start ? Date.parse(window.start) : null;
  const end = window.end ? Date.parse(window.end) : null;
  return !(Number.isFinite(start) && millis < start) && !(Number.isFinite(end) && millis > end);
}

function tokenBuckets(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw.usage || raw;
  return {
    input_tokens: Number(value.inputTokens ?? value.input_tokens) || 0,
    output_tokens: Number(value.outputTokens ?? value.output_tokens) || 0,
    cache_read_input_tokens: Number(
      value.cacheReadTokens ?? value.cache_read_input_tokens ?? value.cache_read_tokens,
    ) || 0,
    cache_creation_input_tokens: Number(
      value.cacheWriteTokens ?? value.cache_creation_input_tokens ?? value.cache_write_tokens,
    ) || 0,
  };
}

function normalizeDshUsage(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const value = raw.usage || raw;
  const totals = tokenBuckets(value);
  const inputByModel = value.by_model || value.byModel;
  const byModel = {};
  if (inputByModel && typeof inputByModel === 'object') {
    for (const [model, modelUsage] of Object.entries(inputByModel)) {
      byModel[model] = tokenBuckets(modelUsage);
    }
  }
  return {
    ...totals,
    ...(Object.keys(byModel).length ? { by_model: byModel } : {}),
    ...(value.model || raw.model ? { model: value.model || raw.model } : {}),
    ...(value.source || raw.source ? { source: value.source || raw.source } : {}),
  };
}

function usageFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'assistant/chunk' && event.data && event.data.chunk
      && event.data.chunk.type === 'usage') return event.data.chunk.usage || null;
  if (event.type === 'assistant/message' && event.data) return event.data.usage || null;
  if (event.type === 'compaction/summary' && event.data) return event.data.usage || null;
  return null;
}

function eventModel(event, fallback) {
  const data = (event && event.data) || {};
  return (data.message && data.message.source && data.message.source.model)
    || data.model || fallback || null;
}

function parseDshTranscript(file, opts = {}) {
  let text;
  try { text = readSessionText(file); }
  catch (error) { return { error: error.code || error.message, header: null }; }

  let header = null;
  let currentModel = opts.model || null;
  let endedAt = null;
  const samples = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'session') {
      header = event;
      continue;
    }
    if (event.type === 'request/context' && event.data) {
      currentModel = event.data.model || currentModel;
    }
    endedAt = isoTime(event.time) || endedAt;
    const rawUsage = usageFromEvent(event);
    if (!rawUsage || !inWindow(event.time, opts.window)) continue;
    const data = event.data || {};
    const key = event.type === 'compaction/summary'
      ? `compaction:${event.seq}`
      : `step:${data.turn ?? 'unknown'}:${data.step ?? 'unknown'}`;
    samples.set(key, { usage: tokenBuckets(rawUsage), model: eventModel(event, currentModel) });
  }

  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    by_model: {},
  };
  for (const sample of samples.values()) {
    usageAccounting.mergeTotals(totals, {
      ...sample.usage,
      by_model: sample.model ? { [sample.model]: sample.usage } : {},
    });
  }
  const grossByModel = totals.by_model;
  const baseline = opts.baseline || {};
  totals.input_tokens = Math.max(0, totals.input_tokens - (Number(baseline.input_tokens) || 0));
  totals.output_tokens = Math.max(0, totals.output_tokens - (Number(baseline.output_tokens) || 0));
  totals.cache_read_input_tokens = Math.max(
    0, totals.cache_read_input_tokens - (Number(baseline.cache_read_input_tokens) || 0),
  );
  totals.cache_creation_input_tokens = Math.max(
    0, totals.cache_creation_input_tokens - (Number(baseline.cache_creation_input_tokens) || 0),
  );
  totals.by_model = grossByModel;
  totals.total = totals.input_tokens + totals.output_tokens;
  totals.messages = samples.size;
  return {
    header,
    usage: totals,
    startedAt: header ? isoTime(header.createdAt) : null,
    endedAt,
  };
}

function headerFor(file) {
  const parsed = parseDshTranscript(file);
  return parsed.header;
}

function sessionTranscriptPath(mainTranscript, sessionId) {
  if (mainTranscript) {
    const header = headerFor(mainTranscript);
    if (header && (!sessionId || String(header.id) === String(sessionId))) return mainTranscript;
  }
  if (!sessionId) return null;
  for (const file of listSessionFiles()) {
    const header = headerFor(file);
    if (header && String(header.id) === String(sessionId)) return file;
  }
  return null;
}

function listSessionTranscripts(projectDir = sessionsDir()) {
  const out = [];
  for (const file of listSessionFiles(projectDir)) {
    const header = headerFor(file);
    if (header && header.id != null) out.push({ id: String(header.id), path: file });
  }
  return out;
}

function addCost(into, priced) {
  if (!priced || !priced.cost) return;
  into.usd += priced.cost.usd || 0;
  for (const [model, value] of Object.entries(priced.cost.by_model || {})) {
    if (!into.by_model[model]) into.by_model[model] = { tokens: 0, usd: 0 };
    into.by_model[model].tokens += value.tokens || 0;
    into.by_model[model].usd += value.usd || 0;
  }
}

const tasks = createFiledropNamespaceTasks('dsh');

const transcripts = {
  source: 'transcripts',
  projectDir() { return sessionsDir(); },
  sessionTranscriptPath,
  listSessionTranscripts,
  humanInputTokens(_path, opts) { return harnessUsage.emptyHuman(opts); },
  harnessOverheadTokens(_path, opts) { return harnessUsage.emptyOverhead(opts); },
  selfReportedUsage(agents, opts) { return harnessUsage.aggregateSelfReported(agents, opts); },
  taskUsageFromAgent(agent) { return harnessUsage.parseReportedUsage(agent); },
};

const usageApi = {
  sample(transcriptPath, opts = {}) {
    if (opts.reported_usage) return this.normalizeReported(opts.reported_usage, opts);
    const file = transcriptPath || process.env.DSH_SESSION_JSONL || null;
    const slice = usageAccounting.emptySlice('dsh', {
      ...opts,
      transcript_path: file,
      startedAt: (opts.window && opts.window.start) || opts.startedAt || null,
      endedAt: (opts.window && opts.window.end) || opts.endedAt || null,
    });
    const parsed = file ? parseDshTranscript(file, opts) : null;
    if (parsed && parsed.usage) {
      slice.usage = parsed.usage;
      slice.startedAt = slice.startedAt || parsed.startedAt;
      slice.endedAt = slice.endedAt || parsed.endedAt;
    }
    if (parsed && parsed.error) slice.error = parsed.error;
    this.price(slice);
    return slice;
  },

  normalizeReported(raw, ctx = {}) {
    const slice = usageAccounting.normalizeReported(normalizeDshUsage(raw), 'dsh', ctx);
    this.price(slice);
    return slice;
  },

  price(slice) {
    return usageAccounting.priceSlice(slice, loadPricingModels());
  },

  reconcile(workspace, opts = {}) {
    const wantedWorkspace = canonicalPath(workspace);
    const totals = { ...usageAccounting.EMPTY_USAGE, by_model: {} };
    const cost = usageAccounting.emptyCost();
    const sessions = [];
    const window = opts.since ? { start: opts.since } : null;
    for (const file of listSessionFiles()) {
      const parsed = parseDshTranscript(file, { window });
      const header = parsed.header;
      if (!header || !header.cwd || canonicalPath(header.cwd) !== wantedWorkspace || !parsed.usage) continue;
      usageAccounting.mergeTotals(totals, parsed.usage);
      addCost(cost, this.price({ usage: parsed.usage, cost: usageAccounting.emptyCost() }));
      sessions.push({
        id: String(header.id),
        path: file,
        total: parsed.usage.output_tokens || 0,
        startedAt: parsed.startedAt,
        endedAt: parsed.endedAt,
      });
    }
    return { harness: 'dsh', workspace, totals, cost, human: harnessUsage.emptyHuman(), sessions };
  },

  onSessionStart({ session, port }) {
    return usageAccounting.armDailyReconcileWakeup(scheduler, { session, harness: 'dsh', port });
  },
};

module.exports = {
  name: 'dsh',
  tasks,
  transcripts,
  scheduler,
  usage: usageApi,
  _internal: {
    dshHome,
    sessionsDir,
    listSessionFiles,
    readSessionText,
    normalizeDshUsage,
    parseDshTranscript,
    loadPricingModels,
  },
};
