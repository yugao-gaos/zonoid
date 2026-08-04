#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const routeFactory = require('../routes/subconscious');
const graphRouteFactory = require('../routes/graph');
const overlayStore = require('../lib/overlay');
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

function makeCtx({ graph, workspace, store, body, overlay, overrides }) {
  const ov = overlay || overlayStore.EMPTY();
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
    ...(overrides || {}),
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

async function callGraphRoute(ctx, p, body, method = 'POST') {
  ctx.readBody = async () => body;
  const res = {};
  const u = new URL(`http://127.0.0.1${p}`);
  const handled = await graphRouteFactory(ctx)(u.pathname, method, { socket: { remoteAddress: '127.0.0.1' } }, res, u);
  assert.equal(handled, true);
  return res;
}

test('subconscious search-context carries default reversible context handles into context deps', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5, useGrader: false });
  const longSummary = `alpha reversible assignment context ${'retrievable worker handoff detail '.repeat(30)}tail marker`;
  const shortSummary = 'alpha reversible assignment short context';
  const graph = {
    tasks: [
      node('task/target', 'Assignment compression target', {
        status: 'ready',
        context_deps: ['note:long', 'note:short'],
        context_weights: { 'note:long': 1, 'note:short': 0.9 },
      }),
      node('note:long', 'Long assignment context note', {
        kind: 'note',
        summary: longSummary,
      }),
      node('note:short', 'Short assignment context note', {
        kind: 'note',
        summary: shortSummary,
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
  const shortDep = res.body.subconscious_context.context_deps.find((item) => item.key === 'note:short');
  assert(shortDep, 'expected short note context dep');
  assert.equal(shortDep.summary, shortSummary);
  assert.equal(shortDep.ccr, null);
  assert.equal(res.body.subconscious_context.context[0].ccr.handle.key, 'note:long');
  assert.equal(res.body.subconscious_context.context[1].ccr, undefined);
  assert.equal(res.body.subconscious_context.decisions.context_compression.compressed_entries, 1);
  assert(res.body.subconscious_context.decisions.context_compression.before_tokens > res.body.subconscious_context.decisions.context_compression.after_tokens);
  assert.equal(res.body.subconscious_context.briefing.kind, 'subconscious_compact_briefing');
  assert(res.body.subconscious_context.briefing.human_summary.includes('Subconscious context brief'));
  assert(res.body.subconscious_context.briefing.ccr_handles.some((handle) => handle.key === 'note:long'));
  assert(res.body.subconscious_context.briefing.metrics.saved_tokens > 0);
  assert.equal(res.body.subconscious_context.retrieve_more.route, 'POST /context/resolve');
  assert.equal(res.body.subconscious_context.retrieve_more.handle_count, 1);

  const resolveRes = await callGraphRoute(ctx, '/context/resolve', {
    workspace: ws,
    handle: dep.ccr.handle,
  });
  assert.equal(resolveRes.status, 200);
  assert.equal(resolveRes.body.ok, true);
  assert.equal(resolveRes.body.key, 'note:long');
  assert.equal(resolveRes.body.content, longSummary);
});

test('assignment prepare rejects ambiguous named multi-repo fallback before worktree creation', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5, useGrader: false });
  const ov = overlayStore.EMPTY();
  let createCalls = 0;
  const graph = { tasks: [node('task/target', 'Cross repo target', { status: 'ready' })] };
  const ctx = makeCtx({
    graph,
    workspace: ws,
    store,
    body: null,
    overlay: ov,
    overrides: {
      resolveRepoTarget: async () => ({
        ok: false,
        status: 409,
        code: 'ambiguous_repo_target',
        error: 'workspace contains multiple Git repositories; pass repo_path',
      }),
      git: {
        createWorktreeAsync: async () => { createCalls++; return {}; },
      },
    },
  });

  const res = await callRoute(ctx, '/subconscious/assignment', {
    action: 'prepare',
    workspace: ws,
    task_key: 'task/target',
  });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ambiguous_repo_target');
  assert.equal(createCalls, 0);
  assert.equal(ov.repos['task/target'], undefined);
});

test('assignment prepare persists and exposes canonical target provenance', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5, useGrader: false });
  const ov = overlayStore.EMPTY();
  const target = {
    provenance: 'workspace',
    repo_path: ws,
    canonical_path: ws,
    git_common_dir: path.join(ws, '.git'),
  };
  const graph = { tasks: [node('task/target', 'Canonical target', { status: 'ready' })] };
  const ctx = makeCtx({
    graph,
    workspace: ws,
    store,
    body: null,
    overlay: ov,
    overrides: {
      resolveRepoTarget: async () => ({ ok: true, repo: ws, target }),
      notifyChange() {},
      git: {
        isRepoAsync: async () => true,
        createWorktreeAsync: async () => ({ branch: 'orch/attempt/task-target', worktree: path.join(ws, 'attempt'), head: 'abc123' }),
      },
    },
  });

  const res = await callRoute(ctx, '/subconscious/assignment', {
    action: 'prepare',
    workspace: ws,
    task_key: 'task/target',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.target, target);
  assert.deepEqual(res.body.assignment.target, target);
  assert.deepEqual(ov.git['task/target'].target, target);
  assert.equal(ov.repos['task/target'], ws);
});
