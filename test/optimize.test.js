#!/usr/bin/env node
// Plain Node test for the converged-vs-iterate control (⑥): lib/optimize.decideOptimize across all
// five outcomes (converge-on-target, converge-on-diminishing-returns, budget-exhausted, stuck→escalate,
// iterate-with-prior-learning) plus the config sanitizer and the overlay.setOptimize bookkeeping.
// No framework; matches the style of test/measure.test.js. Run: node test/optimize.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox BASE so overlays land in a temp dir (BASE is read at require-time).
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-optimize-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const optimize = require('../lib/optimize');
const overlay = require('../lib/overlay');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// A winning verdict at metric_value v (guardrails ok unless overridden).
const win = (v, extra = {}) => ({ winner: 'sess/a', metric_value: v, guardrails_ok: true, ...extra });
// A no-winner verdict (all attempts failed).
const noWin = (extra = {}) => ({ winner: null, needs_attention: true, ...extra });
// A guardrail-blocked verdict (winner picked but regressed a guardrail).
const blocked = (v) => ({ winner: 'sess/a', metric_value: v, guardrails_ok: false });

const SPEC_MIN = { metric: 'p95_latency_ms', direction: 'min', target: 120 };
const SPEC_MAX = { metric: 'score', direction: 'max', target: 90 };
const BUDGET = 50000;
const CFG = { epsilon: 1, diminishing_rounds: 3 };           // explicit knobs for deterministic asserts

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-optimize-ws-')));
const KEY = 'sess-xyz/3';
try {
  // ---- optimizeConfig: defaults + sanitization ----
  ok('config: defaults applied when absent', (() => { const c = optimize.optimizeConfig(undefined); return c.epsilon === optimize.DEFAULTS.epsilon && c.diminishing_rounds === optimize.DEFAULTS.diminishing_rounds; })());
  ok('config: honors valid knobs', (() => { const c = optimize.optimizeConfig({ epsilon: 2, diminishing_rounds: 5 }); return c.epsilon === 2 && c.diminishing_rounds === 5; })());
  ok('config: epsilon 0 honored (not falsy-replaced)', optimize.optimizeConfig({ epsilon: 0 }).epsilon === 0);
  ok('config: negative epsilon falls back', optimize.optimizeConfig({ epsilon: -3 }).epsilon === optimize.DEFAULTS.epsilon);
  ok('config: non-int K falls back', optimize.optimizeConfig({ diminishing_rounds: 2.5 }).diminishing_rounds === optimize.DEFAULTS.diminishing_rounds);
  ok('config: K<=0 falls back', optimize.optimizeConfig({ diminishing_rounds: 0 }).diminishing_rounds === optimize.DEFAULTS.diminishing_rounds);

  // ---- targetHit direction semantics ----
  ok('targetHit: min hits at-or-below', optimize.targetHit('min', 120, 118) === true && optimize.targetHit('min', 120, 121) === false);
  ok('targetHit: max hits at-or-above', optimize.targetHit('max', 90, 90) === true && optimize.targetHit('max', 90, 89) === false);
  ok('targetHit: no target -> false', optimize.targetHit('min', undefined, 1) === false);

  // ---- CONVERGE on target (highest precedence) ----
  let d = optimize.decideOptimize({ spec: SPEC_MIN, verdicts: [win(200), win(150), win(118)], budgetRemaining: BUDGET, config: CFG });
  ok('converge-on-target (min): hits target', d.decision === 'converged' && /target/.test(d.reason));
  d = optimize.decideOptimize({ spec: SPEC_MAX, verdicts: [win(80), win(95)], budgetRemaining: BUDGET, config: CFG });
  ok('converge-on-target (max): hits target', d.decision === 'converged');
  // target beats budget: target met even with no budget left -> converged, not budget
  d = optimize.decideOptimize({ spec: SPEC_MIN, verdicts: [win(118)], budgetRemaining: 0, config: CFG });
  ok('target beats budget', d.decision === 'converged');
  // a no-winner LATEST round means no merged value at target -> not converged-on-target
  d = optimize.decideOptimize({ spec: SPEC_MIN, verdicts: [win(118), noWin()], budgetRemaining: BUDGET, config: { epsilon: 1, diminishing_rounds: 5 } });
  ok('no-winner latest does not count as target hit', d.decision !== 'converged');

  // ---- CONVERGE on diminishing returns (deltas < epsilon for K rounds) ----
  // values 200,150,130,129.5,129.2,129.0 -> last 3 deltas: 0.5,0.3,0.2 all < eps(1) over K=3
  d = optimize.decideOptimize({ spec: { metric: 'm', direction: 'min' }, verdicts: [win(200), win(150), win(130), win(129.5), win(129.2), win(129.0)], budgetRemaining: BUDGET, config: CFG });
  ok('converge-on-diminishing-returns', d.decision === 'converged' && /diminishing/.test(d.reason));
  // big steady gains -> NOT diminishing -> iterate
  d = optimize.decideOptimize({ spec: { metric: 'm', direction: 'min' }, verdicts: [win(200), win(150), win(100), win(50)], budgetRemaining: BUDGET, config: CFG });
  ok('steady big gains -> iterate (not converged)', d.decision === 'iterate');
  // not enough rounds to declare diminishing -> iterate
  d = optimize.decideOptimize({ spec: { metric: 'm', direction: 'min' }, verdicts: [win(130), win(129.8)], budgetRemaining: BUDGET, config: CFG });
  ok('too few rounds -> iterate not converged', d.decision === 'iterate');

  // ---- BUDGET exhausted ----
  d = optimize.decideOptimize({ spec: { metric: 'm', direction: 'min' }, verdicts: [win(200), win(150)], budgetRemaining: 0, config: CFG });
  ok('budget-exhausted-stop', d.decision === 'budget' && /budget/.test(d.reason));
  d = optimize.decideOptimize({ spec: { metric: 'm', direction: 'min' }, verdicts: [win(200), win(150)], budgetRemaining: -5, config: CFG });
  ok('negative budget remaining -> budget', d.decision === 'budget');

  // ---- STUCK -> escalate ----
  d = optimize.decideOptimize({ spec: { metric: 'm', direction: 'min' }, verdicts: [noWin(), noWin(), noWin()], budgetRemaining: BUDGET, config: CFG });
  ok('stuck: K no-winner rounds', d.decision === 'stuck' && /no winning/.test(d.reason));
  d = optimize.decideOptimize({ spec: { metric: 'm', direction: 'min' }, verdicts: [blocked(150), blocked(151), blocked(149)], budgetRemaining: BUDGET, config: CFG });
  ok('stuck: K guardrail-blocked rounds', d.decision === 'stuck' && /guardrail/.test(d.reason));
  // stuck beats budget: every round failing AND no budget -> escalate (human), not silent budget stop
  d = optimize.decideOptimize({ spec: { metric: 'm', direction: 'min' }, verdicts: [noWin(), noWin(), noWin()], budgetRemaining: 0, config: CFG });
  ok('stuck beats budget (escalate over silent stop)', d.decision === 'stuck');
  // a recent win within the window breaks the stuck streak -> not stuck
  d = optimize.decideOptimize({ spec: { metric: 'm', direction: 'min' }, verdicts: [noWin(), win(150), noWin()], budgetRemaining: BUDGET, config: CFG });
  ok('one win in window breaks stuck streak', d.decision !== 'stuck');

  // ---- ITERATE (the default with prior learning fed forward) ----
  d = optimize.decideOptimize({ spec: { metric: 'm', direction: 'min', target: 100 }, verdicts: [win(200), win(160)], budgetRemaining: BUDGET, config: CFG });
  ok('iterate: improving, target not yet hit, budget remains', d.decision === 'iterate');

  // ---- improvementDeltas helper ----
  ok('improvementDeltas: |consecutive winning metric_values|', JSON.stringify(optimize.improvementDeltas([win(200), win(150), win(130)])) === JSON.stringify([50, 20]));
  ok('improvementDeltas: skips non-winning rounds', JSON.stringify(optimize.improvementDeltas([win(200), noWin(), win(150)])) === JSON.stringify([50]));
  ok('improvementDeltas: <2 points -> []', optimize.improvementDeltas([win(200)]).length === 0);

  // ---- overlay.setOptimize bookkeeping (the iterate-no-tight-loop substrate) ----
  const ov = overlay.EMPTY();
  ok('optimize map present in EMPTY()', ov.optimize && typeof ov.optimize === 'object');
  overlay.setOptimize(ov, KEY, { decision: 'iterate', verdicts: 2 });
  ok('setOptimize records decision+count+at', ov.optimize[KEY].decision === 'iterate' && ov.optimize[KEY].verdicts === 2 && !!ov.optimize[KEY].at);
  overlay.setOptimize(ov, KEY, { closed: true, decision: 'converged' });
  ok('setOptimize merges (keeps verdicts, flips closed)', ov.optimize[KEY].closed === true && ov.optimize[KEY].verdicts === 2 && ov.optimize[KEY].decision === 'converged');
  overlay.save(workspace, ov);
  ok('optimize persists across save/load', overlay.load(workspace).optimize[KEY].closed === true);
  // back-compat: an OLD overlay with no optimize map back-fills on load.
  const old = overlay.EMPTY(); delete old.optimize; old.summaries[KEY] = 'legacy'; overlay.save(workspace, old);
  const back = overlay.load(workspace);
  ok('old overlay back-fills optimize map', back.optimize && typeof back.optimize === 'object' && back.summaries[KEY] === 'legacy');
} finally {
  for (const d of [workspace, SANDBOX]) fs.rmSync(d, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
