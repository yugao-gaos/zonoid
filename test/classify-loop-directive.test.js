'use strict';

// Unit coverage for the [Loop] request-scoped directive added by assembleClassifyResponse.
// Asserts: present for substantive prompts, absent for trivial ones, and that the existing
// HEARTBEAT + judge/label/learner nudges are not regressed.

const { test } = require('node:test');
const assert = require('node:assert');

const { classifyHeuristic } = require('../lib/prompt-heuristic');
const {
  assembleClassifyResponse, HEARTBEAT, GATE_REMINDER, LOOP_DIRECTIVE,
} = require('../lib/classify-assemble');

function assemble(prompt, cc, extra = {}) {
  return assembleClassifyResponse({
    prompt,
    sessionId: null,
    heuristic: classifyHeuristic(prompt),
    contextClassify: { complexity: 0.5, gate_decision: 'abstain', rag_score: 0, dag_score: 0, ...cc },
    hasMetricSpec: false,
    readyEntry: null,
    judgePressure: null,
    labelPressure: null,
    learnerPressure: null,
    orchGateOff: false,
    ...extra,
  });
}

test('[Loop] directive present for a substantive prompt', () => {
  // High complexity solo build → substantive.
  const ctx = assemble('refactor the auth subsystem to support OIDC', { complexity: 0.8 }).additional_context;
  assert.ok(ctx.includes('[Loop]'), 'expected [Loop] directive for substantive prompt');
  assert.ok(ctx.includes('until the USER'), 'loop directive should scope to the request, not forever');
});

test('[Loop] directive present for non-solo heuristic decisions', () => {
  // "compare" → team decision → substantive regardless of complexity.
  const ctx = assemble('compare three approaches and pick the best', { complexity: 0.2 }).additional_context;
  assert.ok(ctx.includes('[Loop]'), 'expected [Loop] directive for team-routed prompt');
});

test('[Loop] directive ABSENT for a trivial prompt', () => {
  // solo + low complexity + abstain → trivial.
  const ctx = assemble('fix typo', { complexity: 0.2 }).additional_context;
  assert.ok(!ctx.includes('[Loop]'), 'trivial prompt must NOT get the loop directive');
});

test('HEARTBEAT and existing nudges are not regressed', () => {
  const judgePressure = { nudge: true, depth: 5, dupClusters: 1, harness_task_key: 'followup/harness-judge-drain' };
  const labelPressure = { nudge: true, depth: 3, harness_task_key: 'followup/harness-label-drain' };
  const learnerPressure = {
    nudge: true, depth: 2, repoName: 'zonoid', repoPath: '/repo', outDir: '/out', harness_task_key: 'followup/harness-learner-drain',
  };
  const ctx = assemble('refactor the auth subsystem to support OIDC', { complexity: 0.8 }, {
    judgePressure, labelPressure, learnerPressure,
  }).additional_context;

  assert.ok(ctx.includes(HEARTBEAT), 'HEARTBEAT must still be present');
  assert.ok(ctx.includes(GATE_REMINDER), 'GATE_REMINDER must still be present');
  assert.ok(ctx.includes('[Judge]'), 'judge nudge must still be present');
  assert.ok(ctx.includes('[Grader]'), 'label nudge must still be present');
  assert.ok(ctx.includes('[Learner]'), 'learner nudge must still be present');
  assert.ok(ctx.includes('[Loop]'), 'loop directive coexists with the nudges (additive)');
});

test('LOOP_DIRECTIVE export is the string pushed into parts', () => {
  const ctx = assemble('refactor the auth subsystem to support OIDC', { complexity: 0.8 }).additional_context;
  assert.ok(ctx.includes(LOOP_DIRECTIVE), 'exported LOOP_DIRECTIVE should match injected text');
});
