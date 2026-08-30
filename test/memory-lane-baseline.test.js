#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { runBenchmark } = require('../bench/agent-memory/memory-lane-baseline/run');
const { runEvaluation } = require('../bench/agent-memory/memory-lane-baseline/evaluate');

(async () => {
  const report = await runBenchmark({ repeats: 2 });

  assert.equal(report.schema_version, 1);
  assert.equal(report.compiler, 'lib/search/context-compiler.js');
  assert.equal(report.case_count, 6);
  assert.equal(report.k, 5);

  const ids = new Set(report.cases.map((item) => item.id));
  assert(ids.has('user-fact-vs-assistant-speculation'));
  assert(ids.has('guidance-is-not-current-fact'));
  assert(ids.has('superseded-preference'));
  assert(ids.has('tool-evidence'));
  assert(ids.has('entity-expanded-recall'));
  assert(ids.has('no-evidence-abstention'));

  for (const metric of [
    'factual_accuracy',
    'guidance_leakage_rate',
    'source_role_confusion_rate',
    'stale_memory_leakage_rate',
    'recall_at_5',
    'mrr',
  ]) {
    assert(report.metrics[metric] >= 0 && report.metrics[metric] <= 1, `${metric} must be a rate`);
  }
  assert(report.metrics.mean_estimated_prompt_tokens >= 0);
  assert.equal(report.metrics.mean_estimated_guidance_tokens, 0);
  assert.equal(report.metrics.mean_estimated_injected_tokens, report.metrics.mean_estimated_evidence_tokens);
  assert(report.metrics.p95_retrieval_latency_ms >= 0);
  assert.equal(report.metrics.latency_sample_count, report.case_count * report.repeats);

  const staleCase = report.cases.find((item) => item.id === 'superseded-preference');
  assert.equal(staleCase.stale_memory_leak, false);
  assert(!staleCase.retrieved_keys.includes('note:old-review-guidance'));

  const entityCase = report.cases.find((item) => item.id === 'entity-expanded-recall');
  assert(entityCase.retrieved_keys.includes('note:zonoid-accounting'));

  const abstainCase = report.cases.find((item) => item.id === 'no-evidence-abstention');
  assert.equal(abstainCase.hit, true);
  assert.deepEqual(abstainCase.retrieved_keys, []);

  const laneAware = await runBenchmark({ arm: 'lane-aware', repeats: 2 });
  assert.equal(laneAware.metrics.guidance_leakage_rate, 0);
  assert.equal(laneAware.metrics.source_role_confusion_rate, 0);
  assert.equal(laneAware.metrics.stale_memory_leakage_rate, 0);
  assert.equal(laneAware.metrics.recall_at_5, report.metrics.recall_at_5);
  assert(laneAware.metrics.mean_estimated_guidance_tokens > 0);

  const outcome = await runBenchmark({ arm: 'lane-aware-outcome', repeats: 2 });
  assert.equal(outcome.outcome_policy.created_count, 1);
  assert.equal(outcome.outcome_policy.recalled_as_guidance, true);
  assert.equal(outcome.metrics.guidance_leakage_rate, 0);
  assert(outcome.metrics.mean_estimated_guidance_tokens > laneAware.metrics.mean_estimated_guidance_tokens);

  const evaluation = await runEvaluation({ repeats: 2 });
  assert.equal(evaluation.held_out_task_context.regression, false);
  assert(evaluation.gates.find((gate) => gate.id === 'guidance_as_fact_leakage').passed);
  assert(evaluation.gates.find((gate) => gate.id === 'source_role_confusion').passed);
  assert(evaluation.gates.find((gate) => gate.id === 'stale_current_leakage').passed);
  assert(evaluation.gates.find((gate) => gate.id === 'recall_at_5_regression').passed);
  assert(evaluation.gates.find((gate) => gate.id === 'outcome_policy_is_guidance').passed);
  assert(evaluation.gates.find((gate) => gate.id === 'features_default_off').passed);
  assert.equal(evaluation.gates.find((gate) => gate.id === 'injected_token_overhead').passed, false);
  assert.equal(evaluation.decision, 'HOLD');
  assert.match(evaluation.scoring_notes.audit, /Recall@5=0\.8/);

  console.log(JSON.stringify(report.metrics, null, 2));
  console.log('PASS memory-lane baseline benchmark');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
