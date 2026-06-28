#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const routeFactory = require('../routes/subconscious');
const { createSubconsciousStore } = require('../lib/subconscious');

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
  };
}

function makeWorkspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-subconscious-assignment-')));
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  return ws;
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

function makeCtx({ graph, workspace, store, body }) {
  const ov = { knowledge: {}, edges: [], entity_nodes: {} };
  return {
    subconscious: store,
    buildGraph: () => graph,
    overlayFor: () => ov,
    targetOverlay: (b, u) => ({ ws: (b && b.workspace) || (u && u.searchParams.get('workspace')) || workspace, ov, save() {} }),
    readBody: async () => body,
    send: (res, status, payload) => { res.status = status; res.body = payload; },
    isTruthy: (value) => value != null && value !== '' && value !== '0' && value !== 'false' && value !== 'no',
    embed: async () => null,
    suggestToks,
    scoreNodeAgainstTokens,
    knowledgeText: (item) => typeof item === 'string' ? item : String((item && (item.text || item.summary || item.value || item.content)) || ''),
    noteCurrentAsOf: () => true,
    gateTask: async () => ({
      decision: 'inject',
      reason: 'test injection',
      via: 'lexical',
      top1: 0.82,
      margin: 0.5,
      gap: 0.5,
      locality: 1,
      topType: 'note',
      topKey: 'note:long',
    }),
    gatedSearchCounts: new Map(),
    checkGatedRateLimit: () => false,
    EMBED_MODEL: 'test',
    workspace,
  };
}

async function callRoute(ctx, p, body, method = 'POST') {
  ctx.readBody = async () => body;
  const res = {};
  const u = new URL(`http://127.0.0.1${p}`);
  const handled = await routeFactory(ctx)(u.pathname, method, { socket: { remoteAddress: '127.0.0.1' } }, res, u);
  assert.equal(handled, true);
  return res;
}

test('subconscious search-context carries opt-in reversible context handles into context deps', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5, useGrader: false });
  const longSummary = `alpha reversible assignment context ${'retrievable worker handoff detail '.repeat(30)}tail marker`;
  const graph = {
    tasks: [
      node('task/target', 'Assignment compression target', {
        status: 'ready',
        context_deps: ['note:long'],
        context_weights: { 'note:long': 1 },
      }),
      node('note:long', 'Long assignment context note', {
        kind: 'note',
        summary: longSummary,
      }),
    ],
  };
  const ctx = makeCtx({ graph, workspace: ws, store, body: null });

  const res = await callRoute(ctx, '/subconscious/search-context', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    intent: 'prepare reversible assignment context',
    situation: 'Need alpha reversible assignment context before worker handoff',
    reversible_context: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const dep = res.body.subconscious_context.context_deps.find((item) => item.key === 'note:long');
  assert(dep, 'expected long note context dep');
  assert(dep.summary.includes('[CCR omitted '), 'expected compact delivered summary');
  assert.equal(dep.ccr.reversible, true);
  assert.equal(dep.ccr.handle.key, 'note:long');
  assert.equal(dep.ccr.handle.tool, 'search_knowledge');
  assert.equal(dep.ccr.handle.field, 'content');
});
