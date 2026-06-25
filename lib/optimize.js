// Converged-vs-iterate control for the metric-driven self-improvement loop (note note-mq6xh98a, ⑥).
// The MECHANICAL half of "propose → measure → judge → (iterate | stop | escalate)": given a
// problem P's recorded judge verdicts (most-recent-LAST), its metric spec, the loop's remaining
// token budget, and the optimize config, decide deterministically what to do next on P.
//
// Deliberately pure + daemon-decoupled (mirrors lib/measure.js): no overlay/loop coupling, no LLM
// free-choice. The daemon's decideAction() gathers the inputs and consults decideOptimize(); the
// only human-in-the-loop path it returns is 'escalate' (the caller routes that through the existing
// request_guidance gate — NEVER an auto-cancel/replan).
'use strict';

const DEFAULTS = { epsilon: 0.01, diminishing_rounds: 3 };

// Merge a caller-supplied optimize config with defaults. Negative/NaN knobs fall back to the
// default (a mis-set knob must not silently disable the control).
function optimizeConfig(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const eps = typeof c.epsilon === 'number' && c.epsilon >= 0 ? c.epsilon : DEFAULTS.epsilon;
  const k = Number.isInteger(c.diminishing_rounds) && c.diminishing_rounds > 0 ? c.diminishing_rounds : DEFAULTS.diminishing_rounds;
  return { epsilon: eps, diminishing_rounds: k };
}

// Did `value` reach `target` under `direction`? min ⇒ at-or-below; max ⇒ at-or-above.
// Returns false unless both are finite numbers (no target / no measurement ⇒ not converged).
function targetHit(direction, target, value) {
  if (typeof target !== 'number' || typeof value !== 'number' || Number.isNaN(target) || Number.isNaN(value)) return false;
  return direction === 'min' ? value <= target : value >= target;
}

// A verdict counts as a "win" (a real improving round) only if it named a winner AND did not
// regress a guardrail. Used for both the stuck check (no real wins) and the delta series.
function isWin(v) { return !!(v && v.winner != null && v.guardrails_ok !== false); }

// Per-cycle improvement magnitudes from a chronological verdict series: the absolute change in
// `metric_value` between consecutive WINNING verdicts. (Non-winning rounds produce no new merged
// value, so they don't contribute a delta.) Returns oldest→newest magnitudes; [] if <2 numeric points.
function improvementDeltas(verdicts) {
  const vals = verdicts.filter((v) => isWin(v) && typeof v.metric_value === 'number' && !Number.isNaN(v.metric_value)).map((v) => v.metric_value);
  const out = [];
  for (let i = 1; i < vals.length; i++) out.push(Math.abs(vals[i] - vals[i - 1]));
  return out;
}

// Decide what to do next on a just-judged problem P. MECHANICAL + DETERMINISTIC — no LLM choice.
//   input = {
//     spec,              // P's inline metric spec ({ direction, target? }) or null
//     verdicts,          // P's judge verdicts, CHRONOLOGICAL (most-recent LAST); each may carry
//                        //   { winner, metric_value, guardrails_ok, needs_attention, ... }
//     budgetRemaining,   // loop tokenBudget - spent (the existing loop budget)
//     config,            // { epsilon, diminishing_rounds } (defaults applied)
//   }
// -> { decision: 'converged'|'budget'|'stuck'|'iterate', reason }
// Precedence (first match wins): target-converged → stuck → diminishing-converged → budget → iterate.
//   - target-converged FIRST: an explicit target met is unambiguous success, beats everything.
//   - stuck BEFORE the silent stops: a problem failing every round needs a HUMAN (escalate), not a
//     quiet drop, so it outranks diminishing-returns + budget.
//   - diminishing-converged then budget: stop reasons, in that order.
//   - iterate otherwise: propose a DIFFERENT change next round.
function decideOptimize(input) {
  const spec = input.spec || null;
  const verdicts = Array.isArray(input.verdicts) ? input.verdicts : [];
  const budgetRemaining = typeof input.budgetRemaining === 'number' ? input.budgetRemaining : 0;
  const { epsilon, diminishing_rounds: K } = optimizeConfig(input.config);
  const latest = verdicts.length ? verdicts[verdicts.length - 1] : null;

  // 1) CONVERGED on target — the metric reached spec.target. (Only the winning latest value counts;
  //    a no-winner latest round means we have no merged value at target.)
  if (spec && isWin(latest) && targetHit(spec.direction, spec.target, latest.metric_value)) {
    return { decision: 'converged', reason: `metric reached target (${spec.target})` };
  }

  // 2) STUCK — the last K rounds produced NO real win: every one was either no-winner
  //    (winner == null / needs_attention) or blocked by a guardrail regression (guardrails_ok=false).
  //    Needs human judgement; escalate (never auto-cancel/replan).
  if (verdicts.length >= K) {
    const recent = verdicts.slice(-K);
    if (recent.every((v) => !isWin(v))) {
      const guardrailBlocked = recent.every((v) => v && v.winner != null && v.guardrails_ok === false);
      return { decision: 'stuck', reason: guardrailBlocked ? `every attempt regressed a guardrail for ${K} rounds` : `no winning attempt for ${K} rounds` };
    }
  }

  // 3) CONVERGED on diminishing returns — the last K per-cycle improvements are all < epsilon.
  //    Requires K deltas (K+1 winning measured points) so a short history can't false-converge.
  const deltas = improvementDeltas(verdicts);
  if (deltas.length >= K && deltas.slice(-K).every((d) => d < epsilon)) {
    return { decision: 'converged', reason: `diminishing returns: improvement < ${epsilon} for ${K} rounds` };
  }

  // 4) BUDGET — the loop's token budget is exhausted.
  if (budgetRemaining <= 0) return { decision: 'budget', reason: 'token budget exhausted' };

  // 5) ITERATE — propose a DIFFERENT change next round (prior verdict fed forward as context).
  return { decision: 'iterate', reason: 'room to improve and budget remains' };
}

module.exports = { decideOptimize, optimizeConfig, targetHit, improvementDeltas, isWin, DEFAULTS };
