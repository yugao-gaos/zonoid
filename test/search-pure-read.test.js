#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compileSearchContext } = require('../lib/search/context-compiler');
const telemetry = require('../lib/search/search-telemetry');

let pass = 0;
let fail = 0;
const tests = [];
const test = (label, fn) => tests.push({ label, fn });

function makeWorkspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-search-pure-read-')));
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  return ws;
}

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
  const t = Date.parse(asOf);
  if (Number.isNaN(t)) return true;
  if (item.validFrom && Date.parse(item.validFrom) > t) return false;
  if (item.validTo && Date.parse(item.validTo) <= t) return false;
  return true;
}

function makeUrl(workspace, params = {}) {
  const u = new URL('http://127.0.0.1/search');
  u.searchParams.set('workspace', workspace);
  u.searchParams.set('rerank', '0');
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
  return u;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('compileSearchContext reads a snapshot and enqueues telemetry without direct journal writes', async () => {
  const workspace = makeWorkspace();
  const graph = {
    tasks: [
      node('task/target', 'Pure read target', {
        status: 'ready',
        context_deps: ['note:direct'],
        context_weights: { 'note:direct': 0.8 },
        provisional: false,
      }),
      node('note:direct', 'Direct telemetry note', {
        kind: 'note',
        summary: 'direct telemetry recall evidence',
      }),
      node('note:rag', 'Telemetry search candidate', {
        kind: 'note',
        summary: 'telemetry recall search candidate',
      }),
    ],
  };
  const overlay = { knowledge: {}, edges: [], entity_nodes: {} };
  const events = [];
  let snapshotCalls = 0;
  let buildGraphCalls = 0;
  let gateCalls = 0;

  const ctx = {
    readGraphSnapshot: (ws) => {
      assert.equal(ws, workspace);
      snapshotCalls++;
      return { graph, overlay };
    },
    buildGraph: () => {
      buildGraphCalls++;
      throw new Error('buildGraph must not be called when readGraphSnapshot exists');
    },
    overlayFor: () => {
      throw new Error('overlayFor must not be called when snapshot supplies overlay');
    },
    enqueueSearchTelemetry: (event) => events.push(event),
    isTruthy: (value) => value != null && value !== '' && value !== '0' && value !== 'false' && value !== 'no',
    embed: async () => null,
    suggestToks,
    scoreNodeAgainstTokens,
    knowledgeText: () => '',
    noteCurrentAsOf,
    gateTask: async () => {
      gateCalls++;
      return { decision: 'abstain', reason: 'test', via: 'lexical', top1: 0, margin: 0, gap: 0, locality: 0, topType: null };
    },
    gatedSearchCounts: new Map(),
    checkGatedRateLimit: () => false,
    EMBED_MODEL: 'test-model',
  };

  const result = await compileSearchContext(ctx, {
    req: { socket: { remoteAddress: '127.0.0.1' } },
    u: makeUrl(workspace, { q: 'telemetry recall', task_key: 'task/target', k: '5' }),
  });

  assert.equal(result.status, 200);
  assert.equal(snapshotCalls, 1);
  assert.equal(buildGraphCalls, 0);
  assert.equal(gateCalls, 0, 'shadow gate should move to telemetry, not the read path');
  assert(Array.isArray(result.body.results), 'compatible payload has results array');
  assert(result.body.results.some((item) => item.key === 'note:direct'));
  assert.equal(events.length, 1);
  assert.equal(events[0].workspace, workspace);
  assert.equal(events[0].taskKey, 'task/target');
  assert.equal(events[0].gate.runGate, true);
  assert(events[0].results.some((item) => item.key === 'note:direct'));
  assert.equal(fs.existsSync(path.join(workspace, '.graph', 'recall-outcome-journal.jsonl')), false);
  assert.equal(fs.existsSync(path.join(workspace, '.graph', 'gate-journal.jsonl')), false);
});

test('search telemetry writer records recall and gate journals from the queued outcome', async () => {
  const workspace = makeWorkspace();
  let gateCalls = 0;
  const event = {
    workspace,
    query: 'telemetry recall',
    taskKey: 'task/target',
    round: 2,
    embedModel: 'test-model',
    results: [
      { key: 'note:direct', kind: 'note', tier: 'dag' },
      { key: 'task/other', kind: 'task', tier: 'rag' },
    ],
    gate: {
      gated: false,
      runGate: true,
      input: { label: 'telemetry recall', tags: [] },
      candidates: [{ key: 'note:direct', score: 0.7 }],
      gateVia: 'semantic',
      kbMeta: { kbCands: 1 },
      taskMeta: { qWords: 2 },
    },
  };
  const ctx = {
    gateTask: async (input, cands, opts) => {
      gateCalls++;
      assert.equal(input.label, 'telemetry recall');
      assert.equal(cands.length, 1);
      assert.equal(opts.via, 'semantic');
      return {
        decision: 'inject',
        reason: 'test',
        via: 'semantic',
        top1: 0.7,
        margin: 0.2,
        gap: 0.1,
        locality: 0.5,
        topType: 'note',
        topKey: 'note:direct',
      };
    },
  };

  await telemetry.writeSearchTelemetry(ctx, event);

  assert.equal(gateCalls, 1);
  const recallRows = readJsonl(path.join(workspace, '.graph', 'recall-outcome-journal.jsonl'));
  const gateRows = readJsonl(path.join(workspace, '.graph', 'gate-journal.jsonl'));
  assert.equal(recallRows.length, 1);
  assert.equal(recallRows[0].task_key, 'task/target');
  assert.deepEqual(recallRows[0].recalled_note_keys, ['note:direct']);
  assert.equal(recallRows[0].via, 'dag');
  assert.equal(gateRows.length, 1);
  assert.equal(gateRows[0].decision, 'inject');
  assert.equal(gateRows[0].topKey, 'note:direct');
  assert.equal(gateRows[0].kbCands, 1);
  assert.equal(gateRows[0].qWords, 2);
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
