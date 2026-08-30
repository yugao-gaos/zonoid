#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const outcomePolicy = require('../../../lib/outcome-policy-memory');
const { makeContext, retrieve, runBenchmark } = require('./run');

const ARM_NAMES = ['current', 'lane-aware', 'lane-aware-outcome'];

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function note(id, label, summary, extra = {}) {
  return {
    id,
    label,
    summary,
    kind: 'note',
    status: 'done',
    deps: [],
    context_deps: [],
    context_weights: {},
    ...extra,
  };
}

async function runHeldOutTaskContext() {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-memory-lane-task-context-')));
  fs.mkdirSync(path.join(workspace, '.graph'), { recursive: true });
  const graph = {
    tasks: [
      {
        id: 'task:held-out',
        label: 'Held-out task',
        summary: '',
        status: 'ready',
        deps: [],
        context_deps: ['note:held-out-evidence', 'note:held-out-guidance'],
        context_weights: {},
        provisional: false,
      },
      note('note:held-out-evidence', 'Observed task constraint', 'The package test command is npm test.', {
        memory_lane: 'evidence', source_role: 'artifact', authority: 'observation',
      }),
      note('note:held-out-guidance', 'Preferred test order', 'Run a focused test before npm test.', {
        memory_lane: 'guidance', source_role: 'user', authority: 'directive', category: 'preference',
      }),
    ],
  };
  const overlay = { knowledge: {}, note_nodes: {}, entity_nodes: {}, edges: [] };
  const ctx = makeContext(graph, overlay, workspace);
  try {
    const current = await retrieve(ctx, workspace, 'how should this task be tested', 5, null, 'task:held-out');
    const laneAware = await retrieve(ctx, workspace, 'how should this task be tested', 5, true, 'task:held-out');
    const currentKeys = (current.results || []).map((item) => item.key);
    const evidenceKeys = (laneAware.evidence_results || []).map((item) => item.key);
    const guidanceKeys = (laneAware.guidance_results || []).map((item) => item.key);
    return {
      current_keys: currentKeys,
      lane_aware_evidence_keys: evidenceKeys,
      lane_aware_guidance_keys: guidanceKeys,
      evidence_preserved: currentKeys.includes('note:held-out-evidence')
        && evidenceKeys.includes('note:held-out-evidence'),
      guidance_preserved_in_internal_lane: currentKeys.includes('note:held-out-guidance')
        && guidanceKeys.includes('note:held-out-guidance'),
      regression: !(evidenceKeys.includes('note:held-out-evidence')
        && guidanceKeys.includes('note:held-out-guidance')),
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function loadJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function makeGate(id, threshold, values, passed) {
  return { id, threshold, values, passed: !!passed };
}

function evaluateGates(arms, taskContext) {
  const current = arms.current.metrics;
  const enabled = [arms['lane-aware'], arms['lane-aware-outcome']];
  const latencyLimit = current.p95_retrieval_latency_ms * 1.1;
  const tokenLimit = current.mean_estimated_injected_tokens * 1.1;
  return [
    makeGate(
      'guidance_as_fact_leakage',
      '0 in both enabled arms',
      Object.fromEntries(enabled.map((arm) => [arm.arm, arm.metrics.guidance_leakage_rate])),
      enabled.every((arm) => arm.metrics.guidance_leakage_rate === 0),
    ),
    makeGate(
      'source_role_confusion',
      '0 in both enabled arms',
      Object.fromEntries(enabled.map((arm) => [arm.arm, arm.metrics.source_role_confusion_rate])),
      enabled.every((arm) => arm.metrics.source_role_confusion_rate === 0),
    ),
    makeGate(
      'stale_current_leakage',
      '0 in both enabled arms',
      Object.fromEntries(enabled.map((arm) => [arm.arm, arm.metrics.stale_memory_leakage_rate])),
      enabled.every((arm) => arm.metrics.stale_memory_leakage_rate === 0),
    ),
    makeGate(
      'recall_at_5_regression',
      `each enabled arm >= ${round(current.recall_at_5 - 0.01)} (baseline minus 0.01)`,
      Object.fromEntries(enabled.map((arm) => [arm.arm, arm.metrics.recall_at_5])),
      enabled.every((arm) => arm.metrics.recall_at_5 >= current.recall_at_5 - 0.01),
    ),
    makeGate(
      'held_out_task_context_regression',
      'no evidence or guidance loss after partitioning',
      taskContext,
      !taskContext.regression,
    ),
    makeGate(
      'p95_retrieval_latency_overhead',
      `each enabled arm's approximate p95 interval high <= ${round(latencyLimit)} ms (baseline p95 +10%)`,
      Object.fromEntries(enabled.map((arm) => [arm.arm, {
        p95_ms: arm.metrics.p95_retrieval_latency_ms,
        interval_ms: arm.metrics.p95_retrieval_latency_interval_ms,
        samples: arm.metrics.latency_sample_count,
      }])),
      enabled.every((arm) => arm.metrics.p95_retrieval_latency_interval_ms.high <= latencyLimit),
    ),
    makeGate(
      'injected_token_overhead',
      `each enabled arm <= ${round(tokenLimit)} estimated tokens (baseline +10%)`,
      Object.fromEntries(enabled.map((arm) => [arm.arm, arm.metrics.mean_estimated_injected_tokens])),
      enabled.every((arm) => arm.metrics.mean_estimated_injected_tokens <= tokenLimit),
    ),
    makeGate(
      'outcome_policy_is_guidance',
      'one scoped policy derived and recalled only through guidance',
      arms['lane-aware-outcome'].outcome_policy,
      arms['lane-aware-outcome'].outcome_policy.created_count === 1
        && arms['lane-aware-outcome'].outcome_policy.recalled_as_guidance,
    ),
    makeGate(
      'features_default_on',
      'memory lanes default on; outcome policy requires config/env opt-in',
      {
        current_memory_lanes: arms.current.memory_lanes,
        outcome_policy_default_enabled: outcomePolicy.enabled({ config: {} }, {}),
      },
      arms.current.memory_lanes === true && outcomePolicy.enabled({ config: {} }, {}) === false,
    ),
  ];
}

async function runEvaluation(options = {}) {
  const repeats = Math.max(1, Number(options.repeats || 50));
  const armReports = await Promise.all(ARM_NAMES.map((arm) => runBenchmark({ arm, repeats })));
  const arms = Object.fromEntries(armReports.map((report) => [report.arm, report]));
  const taskContext = await runHeldOutTaskContext();
  const gates = evaluateGates(arms, taskContext);
  const failedGates = gates.filter((gate) => !gate.passed).map((gate) => gate.id);
  const temporalPath = path.resolve(__dirname, '../../temporal/report.json');
  const locomoPath = path.resolve(__dirname, '../../../reports/voicemem-memory-lanes/locomo-fixture/report.json');
  const longMemEvalPath = path.resolve(__dirname, '../../../reports/voicemem-memory-lanes/longmemeval-oracle-fixture/report.json');
  const locomoFixture = loadJsonIfPresent(locomoPath);
  const longMemEvalFixture = loadJsonIfPresent(longMemEvalPath);

  return {
    schema_version: 1,
    benchmark: 'voicemem-memory-lane-evaluation',
    generated_at: new Date().toISOString(),
    decision: failedGates.length ? 'HOLD' : 'GO',
    reason: failedGates.length
      ? `Promotion held because ${failedGates.join(', ')} did not clear.`
      : 'Every frozen promotion gate cleared.',
    repeats,
    arms,
    scoring_notes: {
      definition: 'Recall and reciprocal rank are evaluated within the lane containing the gold item. Factual accuracy and factual abstention use evidence_results only. Source-role attribution is checked against the top item in the gold lane. Evidence and guidance token estimates are reported separately and summed for total injected-token overhead.',
      audit: 'An initial pre-correction lane scorer treated a correctly separated guidance result as absent evidence and reported lane-aware Recall@5=0.8 and source-role confusion=0.2. That scorer output is retained here as an audit note and is not used for promotion gates; no fixture or gold labels changed.',
    },
    held_out_task_context: taskContext,
    gates,
    failed_gates: failedGates,
    temporal: loadJsonIfPresent(temporalPath),
    bounded_external_benchmarks: {
      status: locomoFixture && longMemEvalFixture
        ? 'current_synthetic_fixture_evidence'
        : 'fixture_evidence_missing',
      scoring: 'token F1 only; LLM judge intentionally disabled for the bounded compatibility run',
      locomo_fixture: locomoFixture ? {
        source: 'reports/voicemem-memory-lanes/locomo-fixture/report.json',
        probes: locomoFixture.arms.search.total,
        arms: Object.fromEntries(Object.entries(locomoFixture.arms).map(([name, arm]) => [name, {
          probes: arm.total,
          f1_mean: arm.f1_mean,
        }])),
      } : null,
      longmemeval_oracle_fixture: longMemEvalFixture ? {
        source: 'reports/voicemem-memory-lanes/longmemeval-oracle-fixture/report.json',
        probes: longMemEvalFixture.arms.search.total,
        arms: Object.fromEntries(Object.entries(longMemEvalFixture.arms).map(([name, arm]) => [name, {
          probes: arm.total,
          f1_mean: arm.f1_mean,
        }])),
      } : null,
      real_locomo_reference: {
        source: 'bench/agent-memory/results-dag-combined-50/report.json',
        probes: 50,
        combined_accuracy: 0.54,
        note: 'Historical run under a different setup; not rerun or used as a promotion gate.',
      },
    },
    limitations: [
      'The promotion fixture has six deterministic cases; it is a regression gate, not a broad memory-quality claim.',
      'Only committed synthetic LoCoMo and LongMemEval fixtures are available in this checkout.',
      'The current bounded LoCoMo and LongMemEval compatibility runs contain two probes each and use token F1 without an LLM judge.',
      'The checked-in real LoCoMo evidence is bounded to 50 probes and comes from a different historical setup.',
      'Latency is an in-process local microbenchmark; rerun on target hardware before changing defaults.',
      'Latency gates use an approximate 95% order-statistic interval around p95; a result is held unless the interval high clears the 10% limit.',
      'Estimated injected tokens use character-count approximation and include both evidence and internal guidance channels.',
    ],
  };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repeats') options.repeats = Number(argv[++i]);
    else if (argv[i] === '--output') options.output = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  runEvaluation(options)
    .then((report) => {
      const json = `${JSON.stringify(report, null, 2)}\n`;
      if (options.output) fs.writeFileSync(options.output, json);
      process.stdout.write(json);
    })
    .catch((error) => {
      console.error(error && error.stack ? error.stack : error);
      process.exit(1);
    });
}

module.exports = { evaluateGates, runEvaluation, runHeldOutTaskContext };
