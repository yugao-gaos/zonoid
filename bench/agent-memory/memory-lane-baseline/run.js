#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { compileSearchContext } = require('../../../lib/search/context-compiler');

const DEFAULT_DATASET = path.join(__dirname, 'dataset.json');
const K = 5;

function suggestToks(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function scoreNodeAgainstTokens(item, queryTokens) {
  const itemTokens = suggestToks(`${item.label || ''} ${item.summary || ''}`);
  const shared = [...queryTokens].filter((token) => itemTokens.has(token));
  const score = queryTokens.size && itemTokens.size
    ? shared.length / Math.sqrt(queryTokens.size * itemTokens.size)
    : 0;
  return { shared, score };
}

function noteCurrentAsOf(item, asOf) {
  if (!asOf || (item.kind || 'task') !== 'note') return true;
  const at = Date.parse(asOf);
  if (!Number.isFinite(at)) return true;
  if (item.validFrom && Date.parse(item.validFrom) > at) return false;
  return !(item.validTo && Date.parse(item.validTo) <= at);
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function makeContext(graph, overlay, workspace) {
  return {
    buildGraph: () => graph,
    overlayFor: () => overlay,
    isTruthy: (value) => value != null && value !== '' && value !== '0' && value !== 'false' && value !== 'no',
    embed: async () => null,
    suggestToks,
    scoreNodeAgainstTokens,
    knowledgeText: (item) => String((item && (item.value || item.text || item.summary)) || ''),
    noteCurrentAsOf,
    gateTask: async () => ({ decision: 'abstain', reason: 'benchmark', via: 'lexical' }),
    gatedSearchCounts: new Map(),
    checkGatedRateLimit: () => false,
    enqueueSearchTelemetry: () => {},
    EMBED_MODEL: 'memory-lane-baseline',
    workspace,
  };
}

async function retrieve(ctx, workspace, query, k = K) {
  const url = new URL('http://127.0.0.1/search');
  url.searchParams.set('workspace', workspace);
  url.searchParams.set('q', query);
  url.searchParams.set('k', String(k));
  url.searchParams.set('rerank', '0');
  const result = await compileSearchContext(ctx, {
    req: { socket: { remoteAddress: '127.0.0.1' } },
    u: url,
  });
  if (result.status !== 200) throw new Error(`search failed with status ${result.status}`);
  return result.body.results || [];
}

function scoreCase(testCase, results, metadata) {
  const keys = results.map((result) => result.key);
  const relevant = new Set(testCase.relevant_keys || []);
  const firstRelevant = keys.findIndex((key) => relevant.has(key));
  const rank = firstRelevant < 0 ? 0 : firstRelevant + 1;
  const top = results[0] || null;
  const topMeta = top ? metadata.get(top.key) : null;
  const expectedAbstain = testCase.expect_abstain === true;
  const factualCorrect = testCase.factual
    ? (expectedAbstain ? results.length === 0 : rank === 1)
    : null;
  const forbiddenLanes = new Set(testCase.forbidden_lanes || []);
  const leakedGuidance = results.some((result) => {
    const node = metadata.get(result.key);
    return node && forbiddenLanes.has(node.memory_lane);
  });
  const forbiddenKeys = new Set(testCase.forbidden_keys || []);
  const staleLeak = results.some((result) => forbiddenKeys.has(result.key));
  const sourceRoleConfusion = !!(
    testCase.expected_source_role
    && (!topMeta || topMeta.source_role !== testCase.expected_source_role)
  );
  const contextChars = results.reduce(
    (total, result) => total + String(result.title || '').length + String(result.summary || '').length,
    0,
  );

  return {
    id: testCase.id,
    query: testCase.query,
    relevant_keys: testCase.relevant_keys || [],
    retrieved_keys: keys,
    hit: expectedAbstain ? results.length === 0 : rank > 0,
    rank,
    reciprocal_rank: rank ? round(1 / rank) : 0,
    factual_correct: factualCorrect,
    guidance_leak: leakedGuidance,
    source_role_confusion: sourceRoleConfusion,
    stale_memory_leak: staleLeak,
    estimated_prompt_tokens: Math.ceil(contextChars / 4),
  };
}

async function runBenchmark(options = {}) {
  const datasetPath = options.datasetPath || DEFAULT_DATASET;
  const repeats = Math.max(1, Number(options.repeats || 5));
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-memory-lane-bench-')));
  fs.mkdirSync(path.join(workspace, '.graph'), { recursive: true });

  const nodes = dataset.nodes.map((item) => ({
    ...item,
    kind: 'note',
    status: 'done',
    deps: [],
    context_deps: [],
    context_weights: {},
  }));
  const graph = { tasks: nodes };
  const overlay = {
    knowledge: {},
    entity_nodes: dataset.entities || {},
    edges: dataset.edges || [],
  };
  const ctx = makeContext(graph, overlay, workspace);
  const metadata = new Map(nodes.map((node) => [node.id, node]));
  const latencies = [];
  const cases = [];

  try {
    for (const testCase of dataset.cases) {
      let measuredResults = [];
      for (let attempt = 0; attempt < repeats; attempt++) {
        const started = performance.now();
        const results = await retrieve(ctx, workspace, testCase.query, K);
        latencies.push(performance.now() - started);
        if (attempt === 0) measuredResults = results;
      }
      cases.push(scoreCase(testCase, measuredResults, metadata));
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  const positiveCases = cases.filter((item) => item.relevant_keys.length > 0);
  const factualCases = cases.filter((item) => item.factual_correct != null);
  const guidanceSensitiveCases = dataset.cases.filter((item) => (item.forbidden_lanes || []).length > 0);
  const staleSensitiveCases = dataset.cases.filter((item) => (item.forbidden_keys || []).length > 0);
  const sourceSensitiveCases = dataset.cases.filter((item) => item.expected_source_role);
  const guidanceSensitiveIds = new Set(guidanceSensitiveCases.map((item) => item.id));
  const staleSensitiveIds = new Set(staleSensitiveCases.map((item) => item.id));
  const sourceSensitiveIds = new Set(sourceSensitiveCases.map((item) => item.id));
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

  return {
    schema_version: 1,
    benchmark: 'memory-lane-baseline',
    compiler: 'lib/search/context-compiler.js',
    k: K,
    case_count: cases.length,
    repeats,
    metrics: {
      factual_accuracy: round(mean(factualCases.map((item) => item.factual_correct ? 1 : 0))),
      guidance_leakage_rate: round(mean(cases.filter((item) => guidanceSensitiveIds.has(item.id)).map((item) => item.guidance_leak ? 1 : 0))),
      source_role_confusion_rate: round(mean(cases.filter((item) => sourceSensitiveIds.has(item.id)).map((item) => item.source_role_confusion ? 1 : 0))),
      stale_memory_leakage_rate: round(mean(cases.filter((item) => staleSensitiveIds.has(item.id)).map((item) => item.stale_memory_leak ? 1 : 0))),
      recall_at_5: round(mean(positiveCases.map((item) => item.hit ? 1 : 0))),
      mrr: round(mean(positiveCases.map((item) => item.reciprocal_rank))),
      mean_estimated_prompt_tokens: round(mean(cases.map((item) => item.estimated_prompt_tokens))),
      p95_retrieval_latency_ms: round(percentile(latencies, 0.95)),
    },
    cases,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dataset') options.datasetPath = path.resolve(argv[++i]);
    else if (argv[i] === '--repeats') options.repeats = Number(argv[++i]);
    else if (argv[i] === '--output') options.output = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  runBenchmark(options)
    .then((report) => {
      const json = JSON.stringify(report, null, 2);
      if (options.output) fs.writeFileSync(options.output, `${json}\n`);
      process.stdout.write(`${json}\n`);
    })
    .catch((error) => {
      console.error(error && error.stack ? error.stack : error);
      process.exit(1);
    });
}

module.exports = { runBenchmark, scoreCase };
