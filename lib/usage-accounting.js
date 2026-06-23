// Uniform UsageSlice / UsageReport helpers — adapters translate IDE layouts; daemon stores and sums.
'use strict';
const fs = require('fs');
const humanInput = require('./human-input');

const DEFAULT_RECONCILE_STALE_MS = 24 * 3600 * 1000;

const EMPTY_USAGE = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  by_model: {},
});

const EMPTY_HUMAN = Object.freeze({ tokens: 0, chars: 0, messages: 0, dropped: 0 });
const EMPTY_OVERHEAD = Object.freeze({ tokens: 0, by_category: {} });

// Dollar overlay on a slice. ADDITIVE — tokens stay the source of truth; cost is derived from
// usage.by_model token counts by the ADAPTER's price() method (pricing logic is adapter-owned;
// the daemon only SUMS already-computed cost.usd). source: 'real' when the underlying tokens were
// captured from a transcript / usage event; 'estimated' when from a chars/4 fallback. by_model
// mirrors usage.by_model keys: { <model>: { tokens, usd } }.
function emptyCost(source = 'real') {
  return { usd: 0, source, by_model: {} };
}

function emptySlice(harness, ctx = {}) {
  return {
    harness: harness || 'stub',
    agent_id: ctx.agent_id || null,
    session_id: ctx.session_id || null,
    transcript_path: ctx.transcript_path || null,
    task_key: ctx.task_key || null,
    startedAt: ctx.startedAt || null,
    endedAt: ctx.endedAt || null,
    usage: { ...EMPTY_USAGE, by_model: {} },
    human: { ...EMPTY_HUMAN },
    overhead: { ...EMPTY_OVERHEAD, by_category: {} },
    cost: emptyCost(),
  };
}

function inWindow(ts, window) {
  if (!window) return true;
  const t = String(ts || '').slice(0, 19);
  if (!t) return true;
  const start = window.start ? String(window.start).slice(0, 19) : null;
  const end = window.end ? String(window.end).slice(0, 19) : null;
  if (start && t < start) return false;
  if (end && t > end) return false;
  return true;
}

// Sum per-message token usage from one transcript JSONL (Claude/Cursor-shaped lines).
function parseTranscriptUsage(transcriptPath, opts = {}) {
  const out = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total: 0,
    messages: 0,
    by_model: {},
  };
  if (!transcriptPath) return out;
  const window = opts.window || null;
  const baseline = opts.baseline || null;
  let raw;
  try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch (e) {
    return { ...out, error: e.code || e.message };
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const ts = o.timestamp || (o.message && o.message.timestamp) || null;
    if (!inWindow(ts, window)) continue;
    const u = (o.message && o.message.usage) || o.usage;
    if (!u) continue;
    out.messages++;
    out.input_tokens += u.input_tokens || 0;
    out.output_tokens += u.output_tokens || 0;
    out.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    out.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    const m = (o.message && o.message.model) || o.model;
    if (m) {
      if (!out.by_model[m]) {
        out.by_model[m] = {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        };
      }
      out.by_model[m].input_tokens += u.input_tokens || 0;
      out.by_model[m].output_tokens += u.output_tokens || 0;
      out.by_model[m].cache_read_input_tokens += u.cache_read_input_tokens || 0;
      out.by_model[m].cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    }
  }
  // TWO SERIES — intentional, not a bug:
  //   scalar totals (input/output/cache_read/cache_creation) = net-of-baseline (DELTA / attribution)
  //     → used for token-economy buckets, productivity %, autonomy score
  //   by_model = GROSS (pre-baseline, never subtracted)
  //     → used for billing cost, per-model output %, plan/quota recommendations
  // Inherited context IS really billed (per billing principle note-mq75a817),
  // so by_model stays gross. Do NOT add baseline subtraction to by_model.
  if (baseline && typeof baseline === 'object') {
    out.input_tokens = Math.max(0, out.input_tokens - (baseline.input_tokens || 0));
    out.output_tokens = Math.max(0, out.output_tokens - (baseline.output_tokens || 0));
    out.cache_read_input_tokens = Math.max(0, out.cache_read_input_tokens - (baseline.cache_read_input_tokens || 0));
    out.cache_creation_input_tokens = Math.max(0, out.cache_creation_input_tokens - (baseline.cache_creation_input_tokens || 0));
  }
  out.total = out.input_tokens + out.output_tokens;
  return out;
}

function humanForFile(transcriptPath, opts = {}) {
  if (!transcriptPath) return { ...EMPTY_HUMAN };
  const since = opts.window && opts.window.start ? opts.window.start : opts.since || null;
  const r = humanInput.countFile(transcriptPath, since);
  return {
    tokens: Math.round(r.chars / humanInput.CHARS_PER_TOKEN),
    chars: r.chars,
    messages: r.messages,
    dropped: r.dropped,
  };
}

function normalizeReported(raw, harness, ctx = {}) {
  const slice = emptySlice(harness, ctx);
  if (!raw || typeof raw !== 'object') return slice;
  const input = Number(raw.input_tokens) || 0;
  const output = Number(raw.output_tokens) || 0;
  const cacheRead = Number(raw.cache_read_input_tokens ?? raw.cache_read_tokens) || 0;
  const cacheCreate = Number(raw.cache_creation_input_tokens) || 0;
  let byModel = raw.by_model && typeof raw.by_model === 'object' ? raw.by_model : {};
  // Hookless harnesses (Codex) often report flat totals with no by_model breakdown. Pricing keys
  // off by_model, so synthesize a single-model entry from a model hint (raw.model / ctx.model) when
  // there is real usage but no breakdown — otherwise the slice would price to $0 despite real tokens.
  const model = raw.model || ctx.model || null;
  if (model && Object.keys(byModel).length === 0 && (input + output + cacheRead + cacheCreate) > 0) {
    byModel = { [model]: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
    } };
  }
  slice.usage = {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
    by_model: byModel,
  };
  // Carry the source hint onto the cost block (the adapter's price() fills usd/by_model). An
  // 'estimated' upstream (chars/4 fallback) taints cost.source so the daemon rollup can propagate
  // the weakest source. Real-token reports keep the default 'real'.
  if (raw.source === 'estimated') slice.cost.source = 'estimated';
  return slice;
}

// Price a slice IN PLACE from a per-model rate table (pricing.json `models` map). This is the
// MATH ONLY — the rate lookup and the decision to call it are ADAPTER-owned (the adapter passes
// the loaded pricing table). The daemon never calls this; it only sums slice.cost.usd afterwards.
// Multiplies usage.by_model token counts by the matching model's USD/MTok rates and fills
// slice.cost.usd + slice.cost.by_model[{model}] = { tokens, usd }. Unknown model -> 0 (no throw),
// recorded in slice.cost.unpriced_models so callers can surface it without crashing.
function priceSlice(slice, pricingModels) {
  if (!slice || typeof slice !== 'object') return slice;
  if (!slice.cost) slice.cost = emptyCost();
  const models = (pricingModels && typeof pricingModels === 'object') ? pricingModels : {};
  const byModel = (slice.usage && slice.usage.by_model) || {};
  let totalUsd = 0;
  const unpriced = [];
  slice.cost.by_model = {};
  // Longest-prefix match: 'claude-opus-4-8-20260514' -> 'claude-opus-4'. Pick the longest key that
  // is a prefix of the model id so more specific rate rows win over generic ones.
  const rateKeys = Object.keys(models).sort((a, b) => b.length - a.length);
  for (const [model, v] of Object.entries(byModel)) {
    const key = rateKeys.find((k) => String(model).startsWith(k));
    const tokens = (v.input_tokens || 0) + (v.output_tokens || 0)
      + (v.cache_read_input_tokens || 0) + (v.cache_creation_input_tokens || 0);
    if (!key) { unpriced.push(model); slice.cost.by_model[model] = { tokens, usd: 0 }; continue; }
    const r = models[key];
    const usd = ((v.input_tokens || 0) * (r.input || 0)
      + (v.output_tokens || 0) * (r.output || 0)
      + (v.cache_read_input_tokens || 0) * (r.cache_read || 0)
      + (v.cache_creation_input_tokens || 0) * (r.cache_write || 0)) / 1e6;
    slice.cost.by_model[model] = { tokens, usd };
    totalUsd += usd;
  }
  slice.cost.usd = totalUsd;
  if (unpriced.length) slice.cost.unpriced_models = unpriced;
  return slice;
}

function mergeTotals(into, usage) {
  if (!usage) return into;
  into.input_tokens = (into.input_tokens || 0) + (usage.input_tokens || 0);
  into.output_tokens = (into.output_tokens || 0) + (usage.output_tokens || 0);
  into.cache_read_input_tokens = (into.cache_read_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  into.cache_creation_input_tokens = (into.cache_creation_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const bm = usage.by_model || {};
  if (!into.by_model) into.by_model = {};
  for (const [m, v] of Object.entries(bm)) {
    if (!into.by_model[m]) {
      into.by_model[m] = {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      };
    }
    into.by_model[m].input_tokens += v.input_tokens || 0;
    into.by_model[m].output_tokens += v.output_tokens || 0;
    into.by_model[m].cache_read_input_tokens += v.cache_read_input_tokens || 0;
    into.by_model[m].cache_creation_input_tokens += v.cache_creation_input_tokens || 0;
  }
  return into;
}

function sumOverhead(ov) {
  const overhead = { tokens: 0, chars: 0, by_category: {} };
  for (const slice of Object.values((ov && ov.usage_records) || {})) {
    const o = slice && slice.overhead;
    if (!o) continue;
    overhead.tokens += o.tokens || 0;
    overhead.chars += o.chars || 0;
    for (const [k, v] of Object.entries(o.by_category || {})) {
      overhead.by_category[k] = (overhead.by_category[k] || 0) + (v || 0);
    }
  }
  return overhead;
}

// Accumulate one slice's dollar cost into a rollup accumulator { usd, source, by_model }.
// DAEMON SUMS ONLY — it adds already-computed slice.cost.usd; pricing logic stays in the adapter.
// Source propagation is WEAKEST-WINS: any 'estimated' slice taints the whole rollup to 'estimated'.
function addCost(into, cost) {
  if (!cost || typeof cost !== 'object') return into;
  into.usd += Number(cost.usd) || 0;
  if (cost.source === 'estimated') into.source = 'estimated';
  for (const [m, v] of Object.entries(cost.by_model || {})) {
    if (!into.by_model[m]) into.by_model[m] = { tokens: 0, usd: 0 };
    into.by_model[m].tokens += (v && v.tokens) || 0;
    into.by_model[m].usd += (v && v.usd) || 0;
  }
  return into;
}

function snapshotCost(snap) {
  if (!snap || typeof snap !== 'object') return null;
  if (snap.cost && typeof snap.cost === 'object') return snap.cost;
  const active = snap.harness && snap[snap.harness];
  if (active && active.cost && typeof active.cost === 'object') return active.cost;
  const cost = { usd: 0, source: 'real', by_model: {} };
  let found = false;
  for (const [k, report] of Object.entries(snap)) {
    if (['at', 'harness', 'totals', 'cost', 'human', 'sessions'].includes(k)) continue;
    if (!report || typeof report !== 'object' || !report.cost || typeof report.cost !== 'object') continue;
    addCost(cost, report.cost);
    found = true;
  }
  return found ? cost : null;
}

function sumUsageRecords(ov) {
  const totals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, by_model: {} };
  let human = { tokens: 0, chars: 0, messages: 0, dropped: 0 };
  // Dollar overlay: sums per-slice cost.usd (adapter-computed). source starts 'real' and degrades
  // to 'estimated' if ANY contributing slice is estimated (weakest-source-wins).
  const cost = { usd: 0, source: 'real', by_model: {} };
  for (const slice of Object.values((ov && ov.usage_records) || {})) {
    if (!slice || typeof slice !== 'object') continue;
    mergeTotals(totals, slice.usage);
    addCost(cost, slice.cost);
    if (slice.human) {
      human.tokens += slice.human.tokens || 0;
      human.chars += slice.human.chars || 0;
      human.messages += slice.human.messages || 0;
      human.dropped += slice.human.dropped || 0;
    }
  }
  const snap = ov && ov.usage_reconcile_snapshot;
  if (snap && snap.totals) mergeTotals(totals, snap.totals);
  addCost(cost, snapshotCost(snap));
  if (snap && snap.human) {
    human.tokens += snap.human.tokens || 0;
    human.chars += snap.human.chars || 0;
    human.messages += snap.human.messages || 0;
    human.dropped += snap.human.dropped || 0;
  }
  return { totals, human, cost };
}

function taskOutputFromRecords(ov, taskKey) {
  let total = 0;
  for (const slice of Object.values((ov && ov.usage_records) || {})) {
    if (slice && slice.task_key === taskKey && slice.usage) total += slice.usage.output_tokens || 0;
  }
  return total;
}

// Sum output_tokens for node-scoped judge dispatches attributed to a specific triggering node.
// Only slices with judged_node === nodeKey are counted; non-node-scoped (pooled harness) slices lack
// the field and are excluded. The per-task_key rollup (taskOutputFromRecords) is unchanged.
function judgeNodeOutputFromRecords(ov, nodeKey) {
  if (!nodeKey) return 0;
  let total = 0;
  for (const slice of Object.values((ov && ov.usage_records) || {})) {
    if (slice && slice.judged_node === nodeKey && slice.usage) total += slice.usage.output_tokens || 0;
  }
  return total;
}

// --- Rework-aware, role-tagged per-task cost accumulation (ov.task_costs) ---
// The task lifecycle is multi-attempt: worker run (+impl tokens) → judge run (+review tokens) →
// KICK BACK → worker run (+impl) → judge run (+review) → complete. usage_records is keyed by
// agent_id and OVERWRITES, so it cannot sum across attempts that reuse an agent_id. task_costs is
// a parallel rollup keyed by task_key that ACCUMULATES one contribution per agent-run finish, each
// role-tagged implementation|review, so cost(task) = Σimpl + Σreview and rework stays visible.

// A run is a "review" run when it carries the judge marker (judged_node, set for node-scoped eager
// judge dispatches) — otherwise it is implementation work. The dispatcher may also stamp role
// explicitly on the slice (slice.role) when it knows the run is a judge dispatched against an
// attempt branch; that explicit tag wins.
function roleForSlice(slice) {
  if (slice && (slice.role === 'review' || slice.role === 'implementation')) return slice.role;
  if (slice && slice.judged_node) return 'review';
  return 'implementation';
}

// Append one agent-run finish to the per-task rollup. Idempotent-ish: each call is one contribution.
// A unique runId (agent_id + endedAt) guards against a double POST of the SAME finish re-adding;
// a legitimate re-run reuses the agent_id but has a new endedAt, so it accumulates as intended.
function recordTaskCost(ov, slice) {
  if (!ov || !slice || !slice.task_key) return null;
  const out = (slice.usage && slice.usage.output_tokens) || 0;
  const sliceUsd = (slice.cost && Number(slice.cost.usd)) || 0;
  const sliceSrc = (slice.cost && slice.cost.source) || 'real';
  if (!ov.task_costs) ov.task_costs = {};
  const taskKey = slice.task_key;
  let roll = ov.task_costs[taskKey];
  if (!roll || typeof roll !== 'object') {
    roll = { task_key: taskKey, impl_tokens: 0, review_tokens: 0, total: 0, attempts: 0, contributions: [] };
  }
  // Dollar overlay on the per-task rollup. ADDITIVE — token fields unchanged. usd accumulates per
  // contribution (already-computed slice.cost.usd, summed not priced); cost_source degrades to
  // 'estimated' if any contribution is estimated (weakest-wins, mirrors the rollup-level rule).
  if (typeof roll.usd !== 'number') roll.usd = 0;
  if (!roll.cost_source) roll.cost_source = 'real';
  const role = roleForSlice(slice);
  const runId = `${slice.agent_id || 'anon'}|${slice.endedAt || ''}`;
  if (roll.contributions.some((c) => c.run_id === runId)) return roll; // same finish already counted
  roll.contributions.push({
    run_id: runId,
    agent_id: slice.agent_id || null,
    role,
    output_tokens: out,
    usd: sliceUsd,
    judged_node: slice.judged_node || null,
    at: slice.endedAt || null,
  });
  if (role === 'review') roll.review_tokens += out; else roll.impl_tokens += out;
  roll.total = roll.impl_tokens + roll.review_tokens;
  roll.usd += sliceUsd;
  if (sliceSrc === 'estimated') roll.cost_source = 'estimated';
  roll.attempts = roll.contributions.length;
  ov.task_costs[taskKey] = roll;
  return roll;
}

// Read the rollup for one task_key (or null). Returns the public shape the rollup endpoint serves.
function taskCost(ov, taskKey) {
  const roll = ov && ov.task_costs && ov.task_costs[taskKey];
  if (!roll) return null;
  return {
    task_key: taskKey,
    impl_tokens: roll.impl_tokens || 0,
    review_tokens: roll.review_tokens || 0,
    total: roll.total || 0,
    attempts: roll.attempts || 0,
    cost_usd: roll.usd || 0,
    cost_source: roll.cost_source || 'real',
  };
}

function recordDispatcherEdit(ov, opts = {}) {
  const { agent_id, task_key, chars, file, parent_session } = opts;
  if (!task_key) return null;
  const editChars = Math.max(0, Number(chars) || 0);
  if (!ov.usage_records) ov.usage_records = {};
  const recKey = agent_id || `dispatcher:${task_key}`;
  let slice = ov.usage_records[recKey];
  if (!slice || typeof slice !== 'object') {
    slice = emptySlice('dispatcher', { agent_id: agent_id || null, task_key, session_id: parent_session || null });
  }
  slice.task_key = task_key;
  slice.attributed_from = 'dispatcher';
  if (!slice.dispatcher_edits) slice.dispatcher_edits = [];
  slice.dispatcher_edits.push({
    chars: editChars,
    file: file || null,
    at: new Date().toISOString(),
    attributed_from: 'dispatcher',
  });
  if (!slice.human) slice.human = { ...EMPTY_HUMAN };
  slice.human.chars += editChars;
  slice.human.tokens += Math.round(editChars / humanInput.CHARS_PER_TOKEN);
  ov.usage_records[recKey] = slice;
  return slice;
}

function reconcileStale(at, staleMs = DEFAULT_RECONCILE_STALE_MS) {
  if (!at) return true;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return true;
  return Date.now() - t >= staleMs;
}

function reconcilePrompt(harness, session, port) {
  const p = port || (process.env.ORCH_PORT ? Number(process.env.ORCH_PORT) : 8787);
  return `Mechanical usage reconcile: curl -s --max-time 5 -XPOST http://localhost:${p}/usage/reconcile -H 'content-type: application/json' -d '${JSON.stringify({ harness, session: session || null })}'`;
}

function armDailyReconcileWakeup(scheduler, { session, harness, port }) {
  if (!session || !scheduler || typeof scheduler.armWakeup !== 'function') return { ok: false, skipped: true };
  scheduler.cancelWakeup({ session });
  return scheduler.armWakeup({
    session,
    delaySeconds: 86400,
    reason: 'usage reconcile daily',
    prompt: reconcilePrompt(harness, session, port),
  });
}

module.exports = {
  DEFAULT_RECONCILE_STALE_MS,
  EMPTY_USAGE,
  emptySlice,
  emptyCost,
  priceSlice,
  parseTranscriptUsage,
  humanForFile,
  normalizeReported,
  mergeTotals,
  sumUsageRecords,
  taskOutputFromRecords,
  judgeNodeOutputFromRecords,
  roleForSlice,
  recordTaskCost,
  taskCost,
  recordDispatcherEdit,
  reconcileStale,
  reconcilePrompt,
  armDailyReconcileWakeup,
  inWindow,
};
