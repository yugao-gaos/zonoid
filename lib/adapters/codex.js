// Codex harness adapter: file-drop tasks + self-reported usage; hookless scheduler substrate.
// USAGE CAPTURE (CDX-3): Codex DOES emit real tokens. Two on-disk shapes are swept here:
//   (A) interactive rollout JSONL under ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl — lines
//       {type:"event_msg", payload:{type:"token_count", info:{total_token_usage:{...}}}} where
//       total_token_usage is CUMULATIVE per session (take the LAST such event).
//   (B) `codex exec --json` stream — terminal {type:"turn.completed"|"response.done", ... usage:{...}}
//       in the OpenAI Responses shape.
// Both normalize to the daemon's canonical UsageSlice usage (Claude semantics: input_tokens = UNCACHED
// input, cache_read_input_tokens = cached subset, output_tokens includes reasoning). When no usage
// event is found we fall back to a chars/4 ESTIMATE stamped cost.source:'estimated'.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const filedrop = require('../filedrop-tasks');
const usage = require('../harness-usage');
const usageAccounting = require('../usage-accounting');
const scheduler = require('./scheduler-substrate');

const DEFAULT_CODEX_MODEL = 'gpt-5-codex';

// --- pricing.json loader (ADAPTER-OWNED) -------------------------------------------------------
// Pricing LOGIC lives in the adapter; the daemon only sums dollar subtotals. We read the shipped
// pricing.json (repo root) once and cache by mtime so a rate edit is picked up without a restart and
// without a per-call disk hit. Missing/corrupt file → empty table → cost stays 0 (never throws).
const PRICING_PATH = path.join(__dirname, '..', '..', 'pricing.json');
let _pricingCache = { mtimeMs: 0, models: {} };
function loadPricingModels() {
  try {
    const st = fs.statSync(PRICING_PATH);
    if (st.mtimeMs !== _pricingCache.mtimeMs) {
      const json = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8'));
      _pricingCache = { mtimeMs: st.mtimeMs, models: (json && json.models) || {} };
    }
  } catch { _pricingCache = { mtimeMs: 0, models: {} }; }
  return _pricingCache.models;
}

// --- Codex session rollout location ------------------------------------------------------------
// Codex keeps interactive session rollouts under ~/.codex/sessions, date-bucketed YYYY/MM/DD.
// CODEX_HOME overrides ~/.codex (matches the Codex CLI env contract). Be defensive: tolerate either
// the date-bucketed layout or a flat sessions dir, and a missing dir.
function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}
function sessionsDir() {
  return path.join(codexHome(), 'sessions');
}

// Recursively collect rollout-*.jsonl files under a dir (date buckets are 3 levels deep; we walk
// generically so a layout change doesn't silently drop capture). Bounded + best-effort.
function listRolloutFiles(dir, depth = 0, acc = []) {
  if (depth > 4) return acc;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listRolloutFiles(full, depth + 1, acc);
    else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) acc.push(full);
  }
  return acc;
}

// Map either Codex usage shape to canonical UsageSlice usage fields.
//   Shape A (token_count.info.total_token_usage): { input_tokens (GROSS, incl cached),
//     cached_input_tokens, output_tokens (incl reasoning), reasoning_output_tokens, total_tokens }.
//   Shape B (turn.completed/response.done usage): { input_tokens (GROSS), output_tokens,
//     input_token_details:{cached_tokens}, output_tokens_details:{reasoning_tokens} }.
// Canonical: cache_read = cached; input = grossInput - cached (Claude convention, input = uncached).
function normalizeCodexUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const grossInput = Number(u.input_tokens) || 0;
  const cached = Number(
    u.cached_input_tokens
    ?? (u.input_token_details && u.input_token_details.cached_tokens)
    ?? (u.input_tokens_details && u.input_tokens_details.cached_tokens)
    ?? 0,
  ) || 0;
  const output = Number(u.output_tokens) || 0;
  return {
    input_tokens: Math.max(0, grossInput - cached),
    output_tokens: output,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

// Extract the LATEST usage for one rollout file: the last token_count.total_token_usage (cumulative)
// or, for an exec stream, the last turn.completed/response.done usage. Also sniffs a model id from
// session_meta / turn_context. Returns { usage, model } or null when the file carries no usage event.
function usageFromRolloutFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let latest = null;
  let model = null;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    // Model sniff (best-effort): session_meta or turn_context payloads carry it on some versions.
    const p = o.payload || o;
    if (!model) {
      model = o.model || p.model || (p.info && p.info.model)
        || (o.type === 'session_meta' && p.model) || null;
    }
    // Shape A: interactive rollout token_count event (cumulative total_token_usage).
    if (p && p.type === 'token_count' && p.info && p.info.total_token_usage) {
      latest = p.info.total_token_usage; // later events supersede — cumulative
      continue;
    }
    // Shape B: codex exec --json terminal usage.
    if (o.type === 'turn.completed' || o.type === 'response.done' || p.type === 'turn.completed') {
      const u = o.usage || (o.response && o.response.usage) || (p && p.usage);
      if (u) latest = u;
      continue;
    }
    // Bare {usage:{...}} line (fixture / response object).
    if (o.usage && typeof o.usage === 'object') latest = o.usage;
    else if (o.response && o.response.usage) latest = o.response.usage;
  }
  const norm = normalizeCodexUsage(latest);
  if (!norm) return null;
  return { usage: norm, model: model || DEFAULT_CODEX_MODEL };
}

// Latest rollout file by mtime (the active/most-recent session). null when none exist.
function latestRolloutFile() {
  const files = listRolloutFiles(sessionsDir());
  if (!files.length) return null;
  let best = null, bestM = -1;
  for (const f of files) {
    try { const m = fs.statSync(f).mtimeMs; if (m > bestM) { bestM = m; best = f; } } catch { /* skip */ }
  }
  return best;
}

const tasks = {
  aggregateWorkspace() { return []; }, // daemon unions filedrop.aggregateWorkspace directly
  readTask(namespacedKey) { return null; }, // adoption routes via daemon readNativeTask + workspace
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

const usageApi = {
  // Hot path. Codex has no per-agent transcript path, so we either normalize the reported_usage the
  // agent-done hook forwarded, OR sweep the latest rollout file for a real usage event, OR (last
  // resort) estimate from chars. Whatever the source, we price the slice before returning (pricing
  // is adapter-owned; the daemon only sums slice.cost.usd afterwards).
  sample(_transcript_path, opts = {}) {
    let slice;
    if (opts.reported_usage) {
      slice = usageAccounting.normalizeReported(opts.reported_usage, 'codex', opts);
    } else {
      const file = latestRolloutFile();
      const got = file ? usageFromRolloutFile(file) : null;
      if (got) {
        slice = usageAccounting.normalizeReported({ ...got.usage, model: got.model }, 'codex', opts);
        slice.cost.source = 'real';
      } else if (opts.chars || opts.estimate_chars) {
        slice = this.estimateFromChars(Number(opts.chars || opts.estimate_chars) || 0, opts);
      } else {
        slice = usageAccounting.emptySlice('codex', opts);
      }
    }
    this.price(slice);
    return slice;
  },
  normalizeReported(raw, ctx = {}) {
    const slice = usageAccounting.normalizeReported(raw, 'codex', ctx);
    this.price(slice);
    return slice;
  },
  // Chars/4 estimate fallback — stamped source:'estimated' so the rollup degrades correctly.
  estimateFromChars(chars, ctx = {}) {
    const tokens = Math.max(0, Math.round((Number(chars) || 0) / 4));
    const model = ctx.model || DEFAULT_CODEX_MODEL;
    const slice = usageAccounting.normalizeReported(
      { output_tokens: tokens, model, source: 'estimated' }, 'codex', ctx,
    );
    slice.cost.source = 'estimated';
    this.price(slice);        // price the estimate too (cost.source stays 'estimated')
    return slice;
  },
  // ADAPTER-OWNED pricing: read pricing.json, multiply slice.usage.by_model token counts by the
  // matching rates, fill slice.cost.usd + slice.cost.by_model. Unknown model -> 0 (noted, no crash).
  price(slice) {
    return usageAccounting.priceSlice(slice, loadPricingModels());
  },
  // Cold path. Sweep every Codex rollout for the latest cumulative usage per session, mirroring how
  // the Claude adapter walks its transcripts. Each session contributes one priced slice; totals sum
  // (gross) and a per-session list is returned in the UsageReport shape.
  reconcile(workspace, opts = {}) {
    const since = opts.since ? String(opts.since).slice(0, 19) : null;
    const totals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, by_model: {} };
    const cost = { usd: 0, source: 'real', by_model: {} };
    const sessions = [];
    for (const file of listRolloutFiles(sessionsDir())) {
      if (since) {
        try { if (new Date(fs.statSync(file).mtimeMs).toISOString().slice(0, 19) < since) continue; } catch { /* keep */ }
      }
      const got = usageFromRolloutFile(file);
      if (!got) continue;
      const id = path.basename(file).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
      const byModel = { [got.model]: { ...got.usage } };
      usageAccounting.mergeTotals(totals, { ...got.usage, by_model: byModel });
      const priced = usageAccounting.priceSlice(
        { usage: { ...got.usage, by_model: byModel }, cost: usageAccounting.emptyCost() },
        loadPricingModels(),
      );
      cost.usd += priced.cost.usd;
      for (const [m, v] of Object.entries(priced.cost.by_model || {})) {
        if (!cost.by_model[m]) cost.by_model[m] = { tokens: 0, usd: 0 };
        cost.by_model[m].tokens += v.tokens || 0;
        cost.by_model[m].usd += v.usd || 0;
      }
      sessions.push({ id, path: file, total: got.usage.output_tokens || 0, model: got.model });
    }
    return { harness: 'codex', workspace, totals, cost, human: usage.emptyHuman(), sessions };
  },
  onSessionStart({ session, port }) {
    return usageAccounting.armDailyReconcileWakeup(scheduler, { session, harness: 'codex', port });
  },
};

module.exports = {
  name: 'codex', tasks, transcripts, scheduler, usage: usageApi,
  // Exposed for unit tests / reuse — not part of the harness interface.
  _internal: { normalizeCodexUsage, usageFromRolloutFile, sessionsDir, latestRolloutFile, loadPricingModels },
};
