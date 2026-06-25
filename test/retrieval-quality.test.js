#!/usr/bin/env node
// Deterministic regression guard for retrieval-bench scoring against the current /search compiler.
// No live daemon: local fixture graphs are passed through compileSearchContext, the same route
// implementation used by routes/graph.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { compileSearchContext } = require('../lib/search/context-compiler');
const rb = require('../scripts/retrieval-bench');

let pass = 0, fail = 0;
const tests = [];
const test = (label, fn) => tests.push({ label, fn });
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

function node(id, label, extra = {}) {
  return {
    id,
    label,
    status: extra.status || 'done',
    deps: extra.deps || [],
    context_deps: extra.context_deps || [],
    context_weights: extra.context_weights || {},
    summary: extra.summary || `${label} summary`,
    kind: extra.kind,
    provisional: extra.provisional,
    vec: extra.vec,
  };
}

function suggestToks(s) {
  return new Set((String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []));
}

function scoreNodeAgainstTokens(item, qt) {
  const xt = suggestToks(`${item.label || ''} ${item.summary || ''}`);
  const shared = [...qt].filter((token) => xt.has(token));
  const score = qt.size && xt.size ? shared.length / Math.sqrt(qt.size * xt.size) : 0;
  return { shared, score };
}

function noteCurrentAsOf(item, asOf) {
  if (!asOf || (item.kind || 'task') !== 'note') return true;
  const t = Date.parse(asOf);
  if (Number.isNaN(t)) return true;
  if (item.validFrom && Date.parse(item.validFrom) > t) return false;
  if (item.validTo && Date.parse(item.validTo) <= t) return false;
  return true;
}

function makeWorkspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-retrieval-quality-')));
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  return ws;
}

function makeCtx(graph, workspace, options = {}) {
  return {
    buildGraph: (ws) => {
      if (ws !== workspace) throw new Error(`unexpected workspace ${ws}`);
      return graph;
    },
    overlayFor: () => options.overlay || { knowledge: {}, edges: [], entity_nodes: {} },
    isTruthy: (value) => value != null && value !== '' && value !== '0' && value !== 'false' && value !== 'no',
    embed: options.embed || (async () => null),
    suggestToks,
    scoreNodeAgainstTokens,
    knowledgeText: (item) => String((item && (item.value || item.text || item.summary)) || ''),
    noteCurrentAsOf,
    gateTask: async () => ({ decision: 'abstain', reason: 'test', via: 'lexical', top1: 0, margin: 0, gap: 0, locality: 0, topType: null }),
    gatedSearchCounts: new Map(),
    checkGatedRateLimit: () => false,
    EMBED_MODEL: 'test',
    workspace,
  };
}

async function runSearch(graph, params = {}, options = {}) {
  const workspace = options.workspace || makeWorkspace();
  const u = new URL('http://127.0.0.1/search');
  if (params.workspace !== false) u.searchParams.set('workspace', params.workspace || workspace);
  if (!('rerank' in params)) u.searchParams.set('rerank', '0');
  for (const [key, value] of Object.entries(params)) {
    if (key === 'workspace') continue;
    u.searchParams.set(key, value);
  }
  const result = await compileSearchContext(makeCtx(graph, workspace, options), {
    req: { socket: { remoteAddress: '127.0.0.1' } },
    u,
  });
  return { ...result, workspace };
}

test('compiler-backed search ranks the relevant fixture and benchmark scoring passes', async () => {
  const graph = {
    tasks: [
      node('note:semantic', '[ingest] Compiler semantic sentinel', {
        kind: 'note',
        summary: 'deterministic current search compiler fixture',
        vec: [1, 0],
      }),
      node('note:noise', '[ingest] Billing refund sentinel', {
        kind: 'note',
        summary: 'idempotency and payment gateway detail',
        vec: [0, 1],
      }),
    ],
  };

  const { status, body } = await runSearch(graph, { q: 'compiler semantic sentinel', k: '3' }, {
    embed: async () => [1, 0],
  });

  ok('compileSearchContext returns HTTP 200', status === 200);
  ok('relevant fixture is top result', body.results[0] && body.results[0].key === 'note:semantic');
  ok('result came through current RAG tier', body.results[0] && body.results[0].tier === 'rag');
  ok('semantic vector path is visible', body.results[0] && /semantic/.test(body.results[0].via || ''));

  const resultKeys = body.results.map((r) => rb.titleKey(r.title));
  const relevantKeys = [rb.titleKey('[ingest] Compiler semantic sentinel')];
  const scored = rb.scoreCase(resultKeys, relevantKeys, 3);
  ok('scoreCase gives full recall/MRR for compiler result', scored.recall === 1 && scored.mrr === 1);
});

test('task_key search uses structural compiler context, not benchmark lexical fixtures', async () => {
  const graph = {
    tasks: [
      node('task/target', 'Target retrieval task', {
        status: 'ready',
        deps: ['task/blocker'],
        context_deps: ['note:direct'],
        context_weights: { 'note:direct': 0.8 },
        provisional: false,
      }),
      node('task/blocker', 'Blocking prerequisite'),
      node('note:direct', 'Direct compiler context', { kind: 'note' }),
      node('note:rag', 'Lexical-only distractor', {
        kind: 'note',
        summary: 'billing refund sentinel tokens',
      }),
    ],
  };

  const { status, body } = await runSearch(graph, {
    q: 'billing refund sentinel',
    task_key: 'task/target',
    k: '5',
  });

  const keys = new Set(body.results.map((r) => r.key));
  ok('task_key compiler search returns HTTP 200', status === 200);
  ok('blocking dependency is included structurally', keys.has('task/blocker'));
  ok('direct note context is included structurally', keys.has('note:direct'));
  ok('resolved task context does not fall through to RAG', !body.results.some((r) => r.tier === 'rag'));
});

test('current /search compiler rejects missing workspace', async () => {
  const { status, body } = await runSearch({ tasks: [] }, { q: 'anything', k: '1', workspace: false });
  ok('missing workspace returns 400', status === 400 && body && body.error === 'workspace required');
});

test('held-out benchmark scoring helpers still enforce thresholds', async () => {
  const posTitles = ['Winner note A', 'Winner note B'];
  const posKeys = posTitles.map((t) => rb.titleKey(t));
  const forbidden = rb.collectPositiveTitles([
    { relevant_titles: posTitles },
    { relevant_titles: ['Other winner'] },
  ]);
  ok('collectPositiveTitles returns title keys', forbidden.length === 3 && forbidden.every((k) => k === rb.titleKey(k)));

  const hit = rb.scoreCase(posKeys, posKeys, 5);
  ok('scoreCase hits relevant in top-k', hit.recall === 1 && hit.mrr === 1);

  const clean = rb.scoreNegativeCase(['generic algo note'], forbidden, 5);
  ok('scoreNegativeCase clean when no forbidden hit', clean.recall === 1 && !clean.contaminated);

  const dirty = rb.scoreNegativeCase([rb.titleKey(posTitles[0]), 'other'], forbidden, 5);
  ok('scoreNegativeCase contaminated when forbidden in top-k', dirty.recall === 0 && dirty.contaminated);

  const queryRows = [
    { k: { [rb.PRIMARY_K]: { recall: 1, mrr: 1 } } },
    { k: { [rb.PRIMARY_K]: { recall: 0.5, mrr: 0.5 } } },
  ];
  const agg = rb.aggregateCandidateRecall(queryRows, rb.PRIMARY_K);
  ok('aggregateCandidateRecall mean', Math.abs(agg.recall - 0.75) < 1e-9 && agg.num_queries === 2);

  const mockSc = {
    candidates: [
      { id: 'task-transcript', negative: false, aggregate: { [rb.PRIMARY_K]: { recall: 0.8 } }, queries: [] },
      { id: 'interval-merge', negative: true, aggregate: { [rb.PRIMARY_K]: { recall: 1 } }, queries: [{ contaminated: false }] },
    ],
  };
  ok('checkHeldoutThresholds pass', rb.checkHeldoutThresholds(mockSc, rb.PRIMARY_K).length === 0);
  mockSc.candidates[0].aggregate[rb.PRIMARY_K].recall = 0.5;
  ok('checkHeldoutThresholds fails low recall', rb.checkHeldoutThresholds(mockSc, rb.PRIMARY_K).some((v) => v.includes('task-transcript')));
});

(async () => {
  for (const { label, fn } of tests) {
    try {
      await fn();
      console.log(`PASS  ${label}`);
      pass++;
    } catch (err) {
      console.log(`FAIL  ${label}`);
      console.error(err && err.stack ? err.stack : err);
      fail++;
    }
  }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
