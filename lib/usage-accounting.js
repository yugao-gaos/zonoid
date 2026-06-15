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
  slice.usage = {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: Number(raw.cache_read_input_tokens ?? raw.cache_read_tokens) || 0,
    cache_creation_input_tokens: Number(raw.cache_creation_input_tokens) || 0,
    by_model: raw.by_model && typeof raw.by_model === 'object' ? raw.by_model : {},
  };
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

function sumUsageRecords(ov) {
  const totals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, by_model: {} };
  let human = { tokens: 0, chars: 0, messages: 0, dropped: 0 };
  for (const slice of Object.values((ov && ov.usage_records) || {})) {
    if (!slice || typeof slice !== 'object') continue;
    mergeTotals(totals, slice.usage);
    if (slice.human) {
      human.tokens += slice.human.tokens || 0;
      human.chars += slice.human.chars || 0;
      human.messages += slice.human.messages || 0;
      human.dropped += slice.human.dropped || 0;
    }
  }
  const snap = ov && ov.usage_reconcile_snapshot;
  if (snap && snap.totals) mergeTotals(totals, snap.totals);
  if (snap && snap.human) {
    human.tokens += snap.human.tokens || 0;
    human.chars += snap.human.chars || 0;
    human.messages += snap.human.messages || 0;
    human.dropped += snap.human.dropped || 0;
  }
  return { totals, human };
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
  if (!ov.task_costs) ov.task_costs = {};
  const taskKey = slice.task_key;
  let roll = ov.task_costs[taskKey];
  if (!roll || typeof roll !== 'object') {
    roll = { task_key: taskKey, impl_tokens: 0, review_tokens: 0, total: 0, attempts: 0, contributions: [] };
  }
  const role = roleForSlice(slice);
  const runId = `${slice.agent_id || 'anon'}|${slice.endedAt || ''}`;
  if (roll.contributions.some((c) => c.run_id === runId)) return roll; // same finish already counted
  roll.contributions.push({
    run_id: runId,
    agent_id: slice.agent_id || null,
    role,
    output_tokens: out,
    judged_node: slice.judged_node || null,
    at: slice.endedAt || null,
  });
  if (role === 'review') roll.review_tokens += out; else roll.impl_tokens += out;
  roll.total = roll.impl_tokens + roll.review_tokens;
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
