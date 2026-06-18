#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compileSearchContext } = require('../lib/search/context-compiler');

let pass = 0;
let fail = 0;
const tests = [];
const test = (label, fn) => tests.push({ label, fn });

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
  if (!item.validFrom) return true;
  const t = Date.parse(asOf);
  if (Number.isNaN(t)) return true;
  if (Date.parse(item.validFrom) > t) return false;
  if (item.validTo && Date.parse(item.validTo) <= t) return false;
  return true;
}

function makeWorkspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-context-compiler-')));
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  return ws;
}

function makeCtx(graph, workspace) {
  return {
    buildGraph: () => graph,
    overlayFor: () => ({ knowledge: {}, edges: [], entity_nodes: {} }),
    isTruthy: (value) => value != null && value !== '' && value !== '0' && value !== 'false' && value !== 'no',
    embed: async () => null,
    suggestToks,
    scoreNodeAgainstTokens,
    knowledgeText: () => '',
    noteCurrentAsOf,
    gateTask: async () => ({ decision: 'abstain', reason: 'test', via: 'lexical', top1: 0, margin: 0, gap: 0, locality: 0, topType: null }),
    gatedSearchCounts: new Map(),
    checkGatedRateLimit: () => false,
    EMBED_MODEL: 'test',
    workspace,
  };
}

async function runSearch(graph, params) {
  const workspace = makeWorkspace();
  const u = new URL('http://127.0.0.1/search');
  u.searchParams.set('workspace', workspace);
  for (const [key, value] of Object.entries(params || {})) u.searchParams.set(key, value);
  const result = await compileSearchContext(makeCtx(graph, workspace), {
    req: { socket: { remoteAddress: '127.0.0.1' } },
    u,
  });
  assert.equal(result.status, 200);
  return result.body;
}

test('task_key search returns structural task context nodes', async () => {
  const graph = {
    tasks: [
      node('task/target', 'Target task', {
        status: 'ready',
        deps: ['task/blocker'],
        context_deps: ['note:direct'],
        context_weights: { 'note:direct': 0.9 },
        provisional: false,
      }),
      node('task/blocker', 'Blocking prerequisite'),
      node('note:direct', 'Direct task context', {
        kind: 'note',
        context_deps: ['note:support'],
        context_weights: { 'note:support': 0.7 },
      }),
      node('note:support', 'Support note', { kind: 'note' }),
      node('task/sibling', 'Sibling wired task', {
        context_deps: ['note:direct'],
        context_weights: { 'note:direct': 0.8 },
      }),
    ],
  };

  const body = await runSearch(graph, { q: 'unrelated query', task_key: 'task/target', k: '3' });
  const byKey = new Map(body.results.map((item) => [item.key, item]));

  assert(byKey.has('task/blocker'));
  assert.equal(byKey.get('task/blocker').tier, 'dag');
  assert.equal(byKey.get('task/blocker').via, 'blocking');
  assert.equal(byKey.get('note:direct').tier, 'dag');
  assert.equal(byKey.get('note:direct').weight, 0.9);
  assert.equal(byKey.get('note:support').tier, 'dag-note');
  assert.equal(byKey.get('task/sibling').tier, 'surrounding');
  assert.equal(body.results.some((item) => item.tier === 'rag'), false);
});

test('conversational query promotes a wired neighbor through activation', async () => {
  const graph = {
    tasks: [
      node('note:anchor', 'Alpha anchor retrieval', {
        kind: 'note',
        summary: 'alpha anchor retrieval seed',
        context_deps: ['note:neighbor'],
        context_weights: { 'note:neighbor': 1 },
      }),
      node('note:neighbor', 'Wired neighbor', {
        kind: 'note',
        summary: 'graph-only context with no alpha token',
      }),
      node('note:loose', 'Alpha loose match', {
        kind: 'note',
        summary: 'alpha standalone hit',
      }),
    ],
  };

  const body = await runSearch(graph, { q: 'alpha anchor', k: '5' });
  const neighbor = body.results.find((item) => item.key === 'note:neighbor');

  assert(neighbor, 'expected wired neighbor in conversational results');
  assert(neighbor.graphActivation > 0, 'expected activation metadata on wired neighbor');
  assert((neighbor.path || []).some((part) => part.startsWith('activation:')));
});

(async () => {
  const oldRerank = process.env.ORCH_RERANK;
  process.env.ORCH_RERANK = '0';
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
  if (oldRerank == null) delete process.env.ORCH_RERANK;
  else process.env.ORCH_RERANK = oldRerank;
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
