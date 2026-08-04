'use strict';
/**
 * autonomy-budget.js — the per-workspace DAILY token ceiling for the whole autonomy surface.
 *
 * WHY THIS EXISTS
 * ---------------
 * "When does it stop?" had no crisp answer under `orch auto`. The governor's `tokenBudget` is a
 * PER-DAEMON-BOOT soft cap on `_governor.tokensUsed` — and `tokensUsed` was never incremented by
 * anything, so the check at the top of runDueDrains/runDueSpawns could never fire. A managed loop's
 * own `tokenBudget` is per LOOP INSTANCE, so a fresh loop mints a fresh budget and the previous
 * spend is forgotten. Net effect: nothing bounded a day's autonomous spend.
 *
 * This module is the missing ceiling, deliberately scoped PER WORKSPACE PER CALENDAR DAY so it is
 * independent of loop instances and daemon restarts:
 *
 *   overlay.autonomySpend = { day: 'YYYY-MM-DD', tokens, runs, by_kind: { worker, planner, … },
 *                             notified_day: 'YYYY-MM-DD'|null, first_exceeded_at: ISO|null }
 *
 * `autonomySpend` is an overlay LOCAL_FIELDS entry, so it round-trips the save/load every pump does.
 * A fresh managed loop cannot bypass it: the counter is keyed by workspace + day, never by loop.
 *
 * WHAT COUNTS AS A TOKEN
 * ----------------------
 * `input_tokens + output_tokens` — the same `total` convention lib/usage-accounting.js uses.
 * Cache reads are deliberately EXCLUDED: a single long agentic session reports hundreds of millions
 * of `cache_read_input_tokens` against ~1M real input+output, so folding them in would make any
 * human-meaningful ceiling trip within one worker run. OpenAI-compatible providers report
 * `prompt_tokens`/`completion_tokens`; both shapes normalize here.
 *
 * The meter reads whatever the CONFIGURED PROVIDER's own `parseResult` extracts from the child's
 * stdout — no second stream parser. A child whose stdout carries no usage (a Node-script drain, a
 * crashed CLI) meters 0: the ceiling under-counts rather than guessing, because a fabricated
 * estimate would pause real work on invented spend.
 *
 * NEVER THROWS / NEVER SPAMS
 * --------------------------
 * Every entry point is defensive (a malformed overlay degrades to "not over budget"): a metering
 * bug must never be the reason autonomous work stops. The pause notification is edge-triggered on
 * (workspace, day) through activity.recordChange, so a workspace parked over its ceiling writes ONE
 * digest row for the day, not one per pump tick.
 */

const activity = require('./activity');

/** Generous default: ~20M input+output tokens of autonomous work per workspace per day. */
const DEFAULT_DAILY_TOKEN_BUDGET = 20_000_000;

/** The skip reason every paused surface reports (drain rows, /status, pump summaries). */
const DAILY_BUDGET_SKIP = 'daily_budget';

// ---- config -----------------------------------------------------------------------------

/**
 * Resolve the workspace's daily ceiling: overlay config > env > default. `0` DISABLES the ceiling
 * (explicit opt-out), which is why every tier uses a `>= 0` check rather than a truthiness test.
 */
function dailyTokenBudget(overlay) {
  const cfgRaw = overlay && overlay.config ? overlay.config.autonomy_daily_token_budget : null;
  const cfgV = cfgRaw == null ? NaN : Number(cfgRaw);
  if (Number.isFinite(cfgV) && cfgV >= 0) return cfgV;
  const envV = Number(process.env.ORCH_AUTONOMY_DAILY_TOKEN_BUDGET);
  if (Number.isFinite(envV) && envV >= 0) return envV;
  return DEFAULT_DAILY_TOKEN_BUDGET;
}

/**
 * LOCAL calendar day key. Local (not UTC) on purpose: an operator asking "did it stop for today?"
 * means their day, and /status' `merges_today` already anchors on the local day boundary.
 */
function dayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---- usage normalization ----------------------------------------------------------------

/**
 * Normalize one provider usage object to a token count. Handles the Anthropic shape
 * (`input_tokens`/`output_tokens`) and the OpenAI-compatible shape
 * (`prompt_tokens`/`completion_tokens`, or a precomputed `total_tokens`). Pure; never throws.
 */
function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  const input = n(usage.input_tokens) || n(usage.prompt_tokens);
  const output = n(usage.output_tokens) || n(usage.completion_tokens);
  if (input || output) return input + output;
  return n(usage.total_tokens) || n(usage.total);
}

/**
 * Token count for one settled child run. Prefers a usage object the caller already has (the api
 * providers' runJudgeLoop resolves one), otherwise asks the PROVIDER to parse its own stdout — the
 * provider owns its output format, so there is no second stream parser here. Never throws: a
 * provider whose parseResult blows up meters 0.
 */
function tokensFromResult(result, provider) {
  if (!result) return 0;
  let usage = result.usage || null;
  if (!usage && provider && typeof provider.parseResult === 'function' && result.stdout) {
    try {
      const parsed = provider.parseResult(result.stdout);
      usage = (parsed && parsed.usage) || null;
    } catch {
      usage = null;
    }
  }
  return usageTokens(usage);
}

// ---- persisted per-day counter ------------------------------------------------------------

/**
 * The workspace's spend record ROLLED TO TODAY. Mutating: a stale day is reset in place, which is
 * how "next-day reset" happens without a scheduled job — the first write (or read-through-mutate)
 * after midnight zeroes the counter. Callers that must not mutate use spentToday/overBudget.
 */
function _rolled(overlay, nowMs = Date.now()) {
  if (!overlay.autonomySpend || typeof overlay.autonomySpend !== 'object') overlay.autonomySpend = {};
  const s = overlay.autonomySpend;
  const day = dayKey(nowMs);
  if (s.day !== day) {
    s.day = day;
    s.tokens = 0;
    s.runs = 0;
    s.by_kind = {};
    s.first_exceeded_at = null;
    // notified_day is intentionally NOT cleared here — it is already a day key, so a new day is
    // automatically "not yet notified" without a second reset path to keep in sync.
  }
  return s;
}

/** Tokens spent in the workspace TODAY. Pure read — a stale (yesterday's) record reads as 0. */
function spentToday(overlay, nowMs = Date.now()) {
  const s = overlay && overlay.autonomySpend;
  if (!s || typeof s !== 'object') return 0;
  if (s.day !== dayKey(nowMs)) return 0;
  const v = Number(s.tokens);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Is this workspace at or over its ceiling for today? A budget of 0 disables the ceiling. */
function overBudget(overlay, nowMs = Date.now()) {
  const budget = dailyTokenBudget(overlay);
  if (!(budget > 0)) return false;
  return spentToday(overlay, nowMs) >= budget;
}

/**
 * Fold one child run's token spend into the workspace's day counter. Mutating; the caller persists.
 *
 * @returns {{day, tokens, spent, budget, remaining, exceeded, crossed}} — `crossed` is true ONLY on
 *          the transition from under to over, which is what makes the pause notification a single
 *          event instead of a per-run one.
 */
function recordSpend(overlay, tokens, opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const budget = dailyTokenBudget(overlay);
  if (!overlay || typeof overlay !== 'object') {
    return { day: dayKey(nowMs), tokens: 0, spent: 0, budget, remaining: budget, exceeded: false, crossed: false };
  }
  const s = _rolled(overlay, nowMs);
  const add = Number(tokens);
  const delta = Number.isFinite(add) && add > 0 ? Math.round(add) : 0;
  const wasOver = budget > 0 && (Number(s.tokens) || 0) >= budget;

  s.tokens = (Number(s.tokens) || 0) + delta;
  s.runs = (Number(s.runs) || 0) + 1;
  if (opts.kind) {
    if (!s.by_kind || typeof s.by_kind !== 'object') s.by_kind = {};
    s.by_kind[opts.kind] = (Number(s.by_kind[opts.kind]) || 0) + delta;
  }

  const exceeded = budget > 0 && s.tokens >= budget;
  if (exceeded && !s.first_exceeded_at) s.first_exceeded_at = new Date(nowMs).toISOString();
  return {
    day: s.day,
    tokens: delta,
    spent: s.tokens,
    budget,
    remaining: budget > 0 ? Math.max(0, budget - s.tokens) : null,
    exceeded,
    crossed: exceeded && !wasOver,
  };
}

// ---- notification / activity surface -------------------------------------------------------

/**
 * Announce that a workspace is parked on its daily ceiling — ONE digest event per workspace per
 * day, no matter how many pump ticks bounce off the ceiling. Two dedups, deliberately:
 *   - `autonomySpend.notified_day` is the DURABLE one (survives a daemon restart, which the
 *     in-memory activity ring does not), so a restart under the ceiling does not re-announce.
 *   - activity.recordChange is edge-triggered on (workspace, day) as the in-process backstop.
 *
 * MUTATES the overlay when it announces (stamping notified_day); the caller persists on a true
 * return. Returns false when this workspace+day was already announced — i.e. nothing to save.
 */
function noteDailyBudgetPause(workspace, overlay, nowMs = Date.now()) {
  const day = dayKey(nowMs);
  const s = (overlay && typeof overlay === 'object') ? _rolled(overlay, nowMs) : null;
  if (s && s.notified_day === day) return false;
  const budget = dailyTokenBudget(overlay);
  const spent = spentToday(overlay, nowMs);
  activity.recordChange(`autonomy:daily_budget:${workspace}`, day, {
    kind: activity.KIND.DRAIN,
    workspace,
    status: activity.STATUS.SKIPPED,
    reason: DAILY_BUDGET_SKIP,
    detail: { day, spent, budget },
    text: `autonomy paused for ${day} — daily token ceiling reached (${spent.toLocaleString('en-US')}/${budget.toLocaleString('en-US')})`,
  });
  if (s) s.notified_day = day;
  return true;
}

/** The /status view: what was spent today, against what ceiling, and whether work is paused. */
function budgetView(overlay, nowMs = Date.now()) {
  const budget = dailyTokenBudget(overlay);
  const spent = spentToday(overlay, nowMs);
  const s = (overlay && overlay.autonomySpend) || {};
  const today = s.day === dayKey(nowMs) ? s : {};
  return {
    day: dayKey(nowMs),
    spent,
    budget,
    enabled: budget > 0,
    remaining: budget > 0 ? Math.max(0, budget - spent) : null,
    exceeded: budget > 0 && spent >= budget,
    runs: Number(today.runs) || 0,
    by_kind: (today.by_kind && typeof today.by_kind === 'object') ? { ...today.by_kind } : {},
    first_exceeded_at: today.first_exceeded_at || null,
    notified_day: s.notified_day || null,
  };
}

module.exports = {
  DEFAULT_DAILY_TOKEN_BUDGET,
  DAILY_BUDGET_SKIP,
  dailyTokenBudget,
  dayKey,
  usageTokens,
  tokensFromResult,
  spentToday,
  overBudget,
  recordSpend,
  noteDailyBudgetPause,
  budgetView,
};
