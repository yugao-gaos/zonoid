#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { runBenchmark } = require('../bench/agent-memory/memory-lane-baseline/run');

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
  assert(report.metrics.p95_retrieval_latency_ms >= 0);

  const staleCase = report.cases.find((item) => item.id === 'superseded-preference');
  assert.equal(staleCase.stale_memory_leak, false);
  assert(!staleCase.retrieved_keys.includes('note:old-review-guidance'));

  const entityCase = report.cases.find((item) => item.id === 'entity-expanded-recall');
  assert(entityCase.retrieved_keys.includes('note:zonoid-accounting'));

  const abstainCase = report.cases.find((item) => item.id === 'no-evidence-abstention');
  assert.equal(abstainCase.hit, true);
  assert.deepEqual(abstainCase.retrieved_keys, []);

  console.log(JSON.stringify(report.metrics, null, 2));
  console.log('PASS memory-lane baseline benchmark');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
