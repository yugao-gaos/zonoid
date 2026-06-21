#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const routeFactory = require('../routes/subconscious');
const { createSubconsciousStore } = require('../lib/subconscious');
const { TOOLS } = require('../lib/mcp-core');

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
    category: extra.category,
    provisional: extra.provisional,
  };
}

function makeWorkspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-subconscious-')));
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

function makeCtx({ graph, workspace, store, body, gateTask }) {
  return {
    subconscious: store,
    buildGraph: () => graph,
    overlayFor: () => ({ knowledge: {}, edges: [], entity_nodes: {} }),
    targetOverlay: (b, u) => ({ ws: (b && b.workspace) || (u && u.searchParams.get('workspace')) || workspace, ov: {}, save() {} }),
    readBody: async () => body,
    send: (res, status, payload) => { res.status = status; res.body = payload; },
    isTruthy: (value) => value != null && value !== '' && value !== '0' && value !== 'false' && value !== 'no',
    embed: async () => null,
    suggestToks,
    scoreNodeAgainstTokens,
    knowledgeText: () => '',
    noteCurrentAsOf: () => true,
    gateTask: gateTask || (async () => ({
      decision: 'inject',
      reason: 'test injection',
      via: 'lexical',
      top1: 0.82,
      margin: 0.5,
      gap: 0.5,
      locality: 1,
      topType: 'note',
      topKey: 'note:direct',
    })),
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

test('subconscious event keeps bounded per-agent recent state', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 2 });
  const ctx = makeCtx({ graph: { tasks: [] }, workspace: ws, store, body: null });

  await callRoute(ctx, '/subconscious/event', { workspace: ws, agent_id: 'agent-a', type: 'step', text: 'first', confidence: 0.3 });
  await callRoute(ctx, '/subconscious/event', { workspace: ws, agent_id: 'agent-a', type: 'step', text: 'second', confidence: 0.4 });
  const res = await callRoute(ctx, '/subconscious/event', { workspace: ws, agent_id: 'agent-a', type: 'step', text: 'third', confidence: 0.5 });

  assert.equal(res.status, 200);
  assert.equal(res.body.recent_agent_events.length, 2);
  assert.equal(res.body.recent_agent_events[0].text, 'second');
  assert.equal(res.body.recent_agent_events[1].text, 'third');
});

test('subconscious loop store keeps bounded observations isolated by identity', async () => {
  const ws = makeWorkspace();
  const otherWs = makeWorkspace();
  const store = createSubconsciousStore({ maxLoopObservations: 2 });

  store.upsertLoopState({
    workspace: ws,
    loop_id: 'central',
    agent_id: 'daemon',
    status: 'running',
    phase: 'scan',
    directive: 'observe graph frontier',
    now: '2026-06-21T10:00:00.000Z',
  });
  store.recordLoopObservation({
    workspace: ws,
    loop_id: 'central',
    agent_id: 'daemon',
    type: 'observation',
    text: 'first',
    now: '2026-06-21T10:00:01.000Z',
  });
  store.recordLoopObservation({
    workspace: ws,
    loop_id: 'central',
    agent_id: 'daemon',
    type: 'tick',
    text: 'second',
    now: '2026-06-21T10:00:02.000Z',
  });
  store.recordLoopObservation({
    workspace: ws,
    loop_id: 'central',
    agent_id: 'daemon',
    type: 'tick',
    text: 'third',
    now: '2026-06-21T10:00:03.000Z',
  });

  const state = store.readLoopState({ workspace: ws, loop_id: 'central', agent_id: 'daemon' });
  assert.equal(state.ok, true);
  assert.equal(state.loop_state.status, 'running');
  assert.equal(state.loop_state.phase, 'scan');
  assert.equal(state.loop_state.observation_count, 3);
  assert.equal(state.loop_state.tick_count, 2);
  assert.equal(state.loop_state.latest_observation.text, 'third');
  assert.equal(state.recent_loop_observations.length, 2);
  assert.deepEqual(state.recent_loop_observations.map((event) => event.text), ['second', 'third']);

  assert.equal(store.readLoopState({ workspace: ws, loop_id: 'central', agent_id: 'companion' }).loop_state, null);
  assert.equal(store.readLoopState({ workspace: otherWs, loop_id: 'central', agent_id: 'daemon' }).loop_state, null);
});

test('subconscious session companion store keeps bounded observations isolated by workspace and session', async () => {
  const ws = makeWorkspace();
  const otherWs = makeWorkspace();
  const store = createSubconsciousStore({ maxSessionCompanionObservations: 2 });

  const upsert = store.upsertSessionCompanion({
    workspace: ws,
    session_id: 'foreground-session',
    foreground_agent_id: 'foreground-agent',
    companion_agent_id: 'companion-agent',
    companion_loop_id: 'companion-loop',
    status: 'paired',
    now: '2026-06-21T11:00:00.000Z',
  });
  assert.equal(upsert.ok, true);
  assert.equal(upsert.session_companion.foreground_agent_id, 'foreground-agent');
  assert.equal(upsert.session_companion.companion_agent_id, 'companion-agent');
  assert.equal(upsert.session_companion.companion_loop_id, 'companion-loop');

  store.recordSessionCompanionObservation({
    workspace: ws,
    session_id: 'foreground-session',
    type: 'observation',
    text: 'first',
    now: '2026-06-21T11:00:01.000Z',
  });
  store.recordSessionCompanionObservation({
    workspace: ws,
    session_id: 'foreground-session',
    type: 'progress',
    text: 'second',
    now: '2026-06-21T11:00:02.000Z',
  });
  store.recordSessionCompanionObservation({
    workspace: ws,
    session_id: 'foreground-session',
    type: 'progress',
    text: 'third',
    now: '2026-06-21T11:00:03.000Z',
  });

  const state = store.readSessionCompanion({ workspace: ws, session_id: 'foreground-session' });
  assert.equal(state.ok, true);
  assert.equal(state.session_companion.status, 'paired');
  assert.equal(state.session_companion.observation_count, 3);
  assert.equal(state.session_companion.latest_observation.text, 'third');
  assert.deepEqual(state.recent_session_companion_observations.map((event) => event.text), ['second', 'third']);

  assert.equal(store.readSessionCompanion({ workspace: ws, session_id: 'other-session' }).session_companion, null);
  assert.equal(store.readSessionCompanion({ workspace: otherWs, session_id: 'foreground-session' }).session_companion, null);
});

test('subconscious anchor allocator store keeps bounded observations and decisions isolated by identity', async () => {
  const ws = makeWorkspace();
  const otherWs = makeWorkspace();
  const store = createSubconsciousStore({ maxAnchorObservations: 2, maxAnchorDecisions: 2 });

  const upsert = store.upsertAnchorAllocation({
    workspace: ws,
    session_id: 'foreground-session',
    foreground_agent_id: 'foreground-agent',
    companion_agent_id: 'companion-agent',
    companion_loop_id: 'companion-loop',
    task_key: 'task/anchor',
    reason: 'Keep foreground work attached to the claimed DAG task',
    status: 'proposed',
    parent_task_keys: ['task/parent', 'task/parent'],
    context_task_keys: ['note:context'],
    now: '2026-06-21T12:00:00.000Z',
  });
  assert.equal(upsert.ok, true);
  assert.equal(upsert.anchor_allocation.task_key, 'task/anchor');
  assert.equal(upsert.anchor_allocation.reason, 'Keep foreground work attached to the claimed DAG task');
  assert.deepEqual(upsert.anchor_allocation.parent_task_keys, ['task/parent']);
  assert.deepEqual(upsert.anchor_allocation.wiring.context_task_keys, ['note:context']);

  store.recordAnchorObservation({
    workspace: ws,
    session_id: 'foreground-session',
    companion_agent_id: 'companion-agent',
    companion_loop_id: 'companion-loop',
    type: 'observation',
    text: 'first',
    now: '2026-06-21T12:00:01.000Z',
  });
  store.recordAnchorObservation({
    workspace: ws,
    session_id: 'foreground-session',
    companion_agent_id: 'companion-agent',
    companion_loop_id: 'companion-loop',
    type: 'observation',
    text: 'second',
    now: '2026-06-21T12:00:02.000Z',
  });
  store.recordAnchorObservation({
    workspace: ws,
    session_id: 'foreground-session',
    companion_agent_id: 'companion-agent',
    companion_loop_id: 'companion-loop',
    type: 'observation',
    text: 'third',
    now: '2026-06-21T12:00:03.000Z',
  });

  store.recordAnchorDecision({
    workspace: ws,
    session_id: 'foreground-session',
    companion_agent_id: 'companion-agent',
    companion_loop_id: 'companion-loop',
    decision: 'proposed',
    reason: 'first decision',
    now: '2026-06-21T12:00:04.000Z',
  });
  store.recordAnchorDecision({
    workspace: ws,
    session_id: 'foreground-session',
    companion_agent_id: 'companion-agent',
    companion_loop_id: 'companion-loop',
    decision: 'selected',
    reason: 'second decision',
    now: '2026-06-21T12:00:05.000Z',
  });
  store.recordAnchorDecision({
    workspace: ws,
    session_id: 'foreground-session',
    companion_agent_id: 'companion-agent',
    companion_loop_id: 'companion-loop',
    decision: 'confirmed',
    reason: 'third decision',
    now: '2026-06-21T12:00:06.000Z',
  });

  const state = store.readAnchorAllocation({
    workspace: ws,
    session_id: 'foreground-session',
    companion_agent_id: 'companion-agent',
    companion_loop_id: 'companion-loop',
  });
  assert.equal(state.ok, true);
  assert.equal(state.anchor_allocation.status, 'proposed');
  assert.equal(state.anchor_allocation.observation_count, 3);
  assert.equal(state.anchor_allocation.decision_count, 3);
  assert.equal(state.anchor_allocation.latest_observation.text, 'third');
  assert.equal(state.anchor_allocation.latest_decision.decision, 'confirmed');
  assert.deepEqual(state.recent_anchor_observations.map((event) => event.text), ['second', 'third']);
  assert.deepEqual(state.recent_anchor_decisions.map((event) => event.decision), ['selected', 'confirmed']);

  assert.equal(store.readAnchorAllocation({
    workspace: ws,
    session_id: 'foreground-session',
    companion_agent_id: 'other-companion',
    companion_loop_id: 'companion-loop',
  }).anchor_allocation, null);
  assert.equal(store.readAnchorAllocation({
    workspace: otherWs,
    session_id: 'foreground-session',
    companion_agent_id: 'companion-agent',
    companion_loop_id: 'companion-loop',
  }).anchor_allocation, null);
});

test('subconscious loop routes upsert observe and read loop state', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxLoopObservations: 3 });
  const ctx = makeCtx({ graph: { tasks: [] }, workspace: ws, store, body: null });

  const upsert = await callRoute(ctx, '/subconscious/loop', {
    workspace: ws,
    loop_id: 'central',
    agent_id: 'daemon',
    status: 'running',
    phase: 'scan',
    directive: 'watch ready tasks',
    payload: { budget: 2 },
    now: '2026-06-21T10:10:00.000Z',
  });

  assert.equal(upsert.status, 200);
  assert.equal(upsert.body.ok, true);
  assert.equal(upsert.body.loop_state.status, 'running');
  assert.equal(upsert.body.loop_state.directive, 'watch ready tasks');
  assert.deepEqual(upsert.body.recent_loop_observations, []);

  const observation = await callRoute(ctx, '/subconscious/loop/observation', {
    workspace: ws,
    loop_id: 'central',
    agent_id: 'daemon',
    task_key: 'task/target',
    type: 'tick',
    text: 'heartbeat saw ready task',
    confidence: 0.8,
    phase: 'pressure',
    now: '2026-06-21T10:10:01.000Z',
  });

  assert.equal(observation.status, 200);
  assert.equal(observation.body.loop_state.phase, 'pressure');
  assert.equal(observation.body.loop_state.tick_count, 1);
  assert.equal(observation.body.loop_observation.task_key, 'task/target');
  assert.equal(observation.body.recent_loop_observations.length, 1);

  const read = await callRoute(
    ctx,
    `/subconscious/loop?workspace=${encodeURIComponent(ws)}&loop_id=central&agent_id=daemon&limit=1`,
    null,
    'GET'
  );
  assert.equal(read.status, 200);
  assert.equal(read.body.loop_state.loop_id, 'central');
  assert.equal(read.body.loop_state.agent_id, 'daemon');
  assert.equal(read.body.loop_state.latest_observation.text, 'heartbeat saw ready task');
  assert.equal(read.body.recent_loop_observations.length, 1);

  const missing = await callRoute(
    ctx,
    `/subconscious/loop?workspace=${encodeURIComponent(ws)}&loop_id=central&agent_id=companion`,
    null,
    'GET'
  );
  assert.equal(missing.status, 200);
  assert.equal(missing.body.loop_state, null);
  assert.deepEqual(missing.body.recent_loop_observations, []);
});

test('subconscious session companion routes upsert observe and read pairing state', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxSessionCompanionObservations: 3 });
  const ctx = makeCtx({ graph: { tasks: [] }, workspace: ws, store, body: null });

  const upsert = await callRoute(ctx, '/subconscious/session-companion', {
    workspace: ws,
    session_id: 'session-a',
    foreground_agent_id: 'foreground-a',
    companion_agent_id: 'companion-a',
    companion_loop_id: 'loop-a',
    status: 'paired',
    payload: { source: 'test' },
    now: '2026-06-21T11:10:00.000Z',
  });

  assert.equal(upsert.status, 200);
  assert.equal(upsert.body.ok, true);
  assert.equal(upsert.body.session_companion.session_id, 'session-a');
  assert.equal(upsert.body.session_companion.status, 'paired');
  assert.deepEqual(upsert.body.recent_session_companion_observations, []);

  const observation = await callRoute(ctx, '/subconscious/session-companion/observation', {
    workspace: ws,
    session_id: 'session-a',
    task_key: 'task/target',
    type: 'progress',
    text: 'foreground reached next step',
    confidence: 0.8,
    now: '2026-06-21T11:10:01.000Z',
  });

  assert.equal(observation.status, 200);
  assert.equal(observation.body.session_companion.observation_count, 1);
  assert.equal(observation.body.session_companion.latest_observation.type, 'progress');
  assert.equal(observation.body.session_companion_observation.task_key, 'task/target');

  const read = await callRoute(
    ctx,
    `/subconscious/session-companion?workspace=${encodeURIComponent(ws)}&session_id=session-a&limit=1`,
    null,
    'GET'
  );
  assert.equal(read.status, 200);
  assert.equal(read.body.session_companion.companion_agent_id, 'companion-a');
  assert.equal(read.body.session_companion.latest_observation.text, 'foreground reached next step');
  assert.equal(read.body.recent_session_companion_observations.length, 1);

  const missing = await callRoute(
    ctx,
    `/subconscious/session-companion?workspace=${encodeURIComponent(ws)}&session_id=missing`,
    null,
    'GET'
  );
  assert.equal(missing.status, 200);
  assert.equal(missing.body.session_companion, null);
  assert.deepEqual(missing.body.recent_session_companion_observations, []);
});

test('subconscious anchor allocator routes upsert observe decide and read anchor state', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxAnchorObservations: 3, maxAnchorDecisions: 3 });
  const ctx = makeCtx({ graph: { tasks: [] }, workspace: ws, store, body: null });

  const upsert = await callRoute(ctx, '/subconscious/anchor', {
    workspace: ws,
    session_id: 'session-a',
    foreground_agent_id: 'foreground-a',
    companion_agent_id: 'companion-a',
    companion_loop_id: 'loop-a',
    task_key: 'task/anchor',
    reason: 'Session should stay anchored to the implementation task',
    status: 'selected',
    parent_task_keys: ['task/parent'],
    context_task_keys: ['note:context'],
    payload: { source: 'test' },
    now: '2026-06-21T12:10:00.000Z',
  });

  assert.equal(upsert.status, 200);
  assert.equal(upsert.body.ok, true);
  assert.equal(upsert.body.anchor_allocation.session_id, 'session-a');
  assert.equal(upsert.body.anchor_allocation.task_key, 'task/anchor');
  assert.equal(upsert.body.anchor_allocation.status, 'selected');
  assert.deepEqual(upsert.body.anchor_allocation.wiring.parent_task_keys, ['task/parent']);

  const observation = await callRoute(ctx, '/subconscious/anchor/observation', {
    workspace: ws,
    session_id: 'session-a',
    companion_agent_id: 'companion-a',
    companion_loop_id: 'loop-a',
    type: 'context',
    text: 'allocator saw companion context',
    confidence: 0.8,
    now: '2026-06-21T12:10:01.000Z',
  });

  assert.equal(observation.status, 200);
  assert.equal(observation.body.anchor_allocation.observation_count, 1);
  assert.equal(observation.body.anchor_observation.task_key, 'task/anchor');

  const decision = await callRoute(ctx, '/subconscious/anchor/decision', {
    workspace: ws,
    session_id: 'session-a',
    companion_agent_id: 'companion-a',
    companion_loop_id: 'loop-a',
    decision: 'confirmed',
    reason: 'anchor matches active DAG task',
    confidence: 0.9,
    now: '2026-06-21T12:10:02.000Z',
  });

  assert.equal(decision.status, 200);
  assert.equal(decision.body.anchor_allocation.decision_count, 1);
  assert.equal(decision.body.anchor_decision.decision, 'confirmed');

  const read = await callRoute(
    ctx,
    `/subconscious/anchor?workspace=${encodeURIComponent(ws)}&session_id=session-a&companion_agent_id=companion-a&companion_loop_id=loop-a&limit=1&decision_limit=1`,
    null,
    'GET'
  );
  assert.equal(read.status, 200);
  assert.equal(read.body.anchor_allocation.companion_agent_id, 'companion-a');
  assert.equal(read.body.anchor_allocation.latest_decision.reason, 'anchor matches active DAG task');
  assert.equal(read.body.recent_anchor_observations.length, 1);
  assert.equal(read.body.recent_anchor_decisions.length, 1);

  const missing = await callRoute(
    ctx,
    `/subconscious/anchor?workspace=${encodeURIComponent(ws)}&session_id=session-a&companion_agent_id=other&companion_loop_id=loop-a`,
    null,
    'GET'
  );
  assert.equal(missing.status, 200);
  assert.equal(missing.body.anchor_allocation, null);
  assert.deepEqual(missing.body.recent_anchor_observations, []);
  assert.deepEqual(missing.body.recent_anchor_decisions, []);
});

test('subconscious idea scheduler records ordinary ideas and gates approval-worthy ideas', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxIdeas: 5 });
  const ctx = makeCtx({ graph: { tasks: [] }, workspace: ws, store, body: null });

  const ordinary = await callRoute(ctx, '/subconscious/idea-scheduler', {
    workspace: ws,
    agent_id: 'daemon',
    session_id: 'session-a',
    companion_agent_id: 'companion-a',
    companion_loop_id: 'loop-a',
    task_key: 'task/anchor',
    source: 'daemon_loop',
    title: 'Check recent formatter failures',
    idea: 'Schedule a lightweight follow-up to inspect formatter failures in the current task.',
    context_task_keys: ['note:formatting'],
    confidence: 0.6,
  });

  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.body.ok, true);
  assert.equal(ordinary.body.scheduled, true);
  assert.equal(ordinary.body.requires_approval, false);
  assert.equal(ordinary.body.idea_policy.disposition, 'schedule');
  assert.equal(ordinary.body.subconscious_idea.status, 'scheduled');
  assert.deepEqual(ordinary.body.subconscious_idea.context_task_keys, ['note:formatting']);

  const risky = await callRoute(ctx, '/subconscious/idea-scheduler', {
    workspace: ws,
    agent_id: 'daemon',
    session_id: 'session-a',
    companion_agent_id: 'companion-a',
    companion_loop_id: 'loop-a',
    task_key: 'task/anchor',
    source: 'daemon_loop',
    idea: 'Publish an outward-facing high-impact irreversible scope expansion: delete cached production data, deploy a production API schema change after the same failure keeps failing.',
    confidence: 0.8,
  });

  assert.equal(risky.status, 200);
  assert.equal(risky.body.ok, true);
  assert.equal(risky.body.scheduled, false);
  assert.equal(risky.body.requires_approval, true);
  assert.equal(risky.body.subconscious_idea.status, 'requires_approval');
  assert(risky.body.idea_policy.approval_reasons.includes('high_impact'));
  assert(risky.body.idea_policy.approval_reasons.includes('outward_facing'));
  assert(risky.body.idea_policy.approval_reasons.includes('irreversible'));
  assert(risky.body.idea_policy.approval_reasons.includes('scope_expanding'));
  assert(risky.body.idea_policy.approval_reasons.includes('destructive'));
  assert(risky.body.idea_policy.approval_reasons.includes('deployment'));
  assert(risky.body.idea_policy.approval_reasons.includes('api_change'));
  assert(risky.body.idea_policy.approval_reasons.includes('repeated_failure'));
  assert.equal(risky.body.idea_schedule.scheduled_count, 1);
  assert.equal(risky.body.idea_schedule.approval_required_count, 1);

  const read = await callRoute(
    ctx,
    `/subconscious/idea-scheduler?workspace=${encodeURIComponent(ws)}&agent_id=daemon&session_id=session-a&companion_agent_id=companion-a&companion_loop_id=loop-a&task_key=task%2Fanchor&limit=1`,
    null,
    'GET'
  );
  assert.equal(read.status, 200);
  assert.equal(read.body.idea_schedule.idea_count, 2);
  assert.equal(read.body.recent_ideas.length, 1);
  assert.equal(read.body.recent_ideas[0].status, 'requires_approval');
});

test('subconscious_loop MCP tool forwards to loop routes', async () => {
  const tool = TOOLS.find((candidate) => candidate.name === 'subconscious_loop');
  assert(tool, 'subconscious_loop tool exists');

  const calls = [];
  const observe = await tool.run({
    action: 'observe',
    workspace: '/tmp/ws',
    loop_id: 'central',
    agent_id: 'daemon',
    type: 'tick',
    text: 'heartbeat',
    confidence: 0.7,
  }, (method, p, body) => {
    calls.push({ method, p, body });
    return { ok: true, forwarded: true };
  });

  assert.equal(observe.forwarded, true);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].p, '/subconscious/loop/observation');
  assert.equal(calls[0].body.loop_id, 'central');
  assert.equal(calls[0].body.type, 'tick');

  await tool.run({
    action: 'read',
    workspace: '/tmp/ws',
    loop_id: 'central',
    agent_id: 'daemon',
    limit: 1,
  }, (method, p, body) => {
    calls.push({ method, p, body });
    return { ok: true, forwarded: true };
  });

  assert.equal(calls[1].method, 'GET');
  assert(calls[1].p.startsWith('/subconscious/loop?'));
  assert(calls[1].p.includes('loop_id=central'));
  assert.equal(calls[1].body, undefined);
});

test('subconscious_session_companion MCP tool forwards to companion routes', async () => {
  const tool = TOOLS.find((candidate) => candidate.name === 'subconscious_session_companion');
  assert(tool, 'subconscious_session_companion tool exists');

  const calls = [];
  const update = await tool.run({
    action: 'update',
    workspace: '/tmp/ws',
    session_id: 'session-a',
    foreground_agent_id: 'foreground-a',
    companion_agent_id: 'companion-a',
    companion_loop_id: 'loop-a',
    status: 'paired',
  }, (method, p, body) => {
    calls.push({ method, p, body });
    return { ok: true, forwarded: true };
  });

  assert.equal(update.forwarded, true);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].p, '/subconscious/session-companion');
  assert.equal(calls[0].body.session_id, 'session-a');
  assert.equal(calls[0].body.companion_agent_id, 'companion-a');

  await tool.run({
    action: 'read',
    workspace: '/tmp/ws',
    session_id: 'session-a',
    limit: 1,
  }, (method, p, body) => {
    calls.push({ method, p, body });
    return { ok: true, forwarded: true };
  });

  assert.equal(calls[1].method, 'GET');
  assert(calls[1].p.startsWith('/subconscious/session-companion?'));
  assert(calls[1].p.includes('session_id=session-a'));
  assert.equal(calls[1].body, undefined);
});

test('subconscious_anchor_allocator MCP tool forwards to anchor routes', async () => {
  const tool = TOOLS.find((candidate) => candidate.name === 'subconscious_anchor_allocator');
  assert(tool, 'subconscious_anchor_allocator tool exists');

  const calls = [];
  const update = await tool.run({
    action: 'update',
    workspace: '/tmp/ws',
    session_id: 'session-a',
    foreground_agent_id: 'foreground-a',
    companion_agent_id: 'companion-a',
    companion_loop_id: 'loop-a',
    task_key: 'task/anchor',
    reason: 'anchor active foreground work',
    status: 'selected',
    parent_task_keys: ['task/parent'],
    context_task_keys: ['note:context'],
  }, (method, p, body) => {
    calls.push({ method, p, body });
    return { ok: true, forwarded: true };
  });

  assert.equal(update.forwarded, true);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].p, '/subconscious/anchor');
  assert.equal(calls[0].body.session_id, 'session-a');
  assert.equal(calls[0].body.task_key, 'task/anchor');
  assert.deepEqual(calls[0].body.context_task_keys, ['note:context']);

  await tool.run({
    action: 'read',
    workspace: '/tmp/ws',
    session_id: 'session-a',
    companion_agent_id: 'companion-a',
    companion_loop_id: 'loop-a',
    limit: 1,
    decision_limit: 1,
  }, (method, p, body) => {
    calls.push({ method, p, body });
    return { ok: true, forwarded: true };
  });

  assert.equal(calls[1].method, 'GET');
  assert(calls[1].p.startsWith('/subconscious/anchor?'));
  assert(calls[1].p.includes('session_id=session-a'));
  assert(calls[1].p.includes('companion_agent_id=companion-a'));
  assert.equal(calls[1].body, undefined);
});

test('subconscious_idea_scheduler MCP tool forwards to idea scheduler routes', async () => {
  const tool = TOOLS.find((candidate) => candidate.name === 'subconscious_idea_scheduler');
  assert(tool, 'subconscious_idea_scheduler tool exists');

  const calls = [];
  const schedule = await tool.run({
    action: 'schedule',
    workspace: '/tmp/ws',
    agent_id: 'daemon',
    session_id: 'session-a',
    companion_agent_id: 'companion-a',
    companion_loop_id: 'loop-a',
    task_key: 'task/anchor',
    source: 'daemon_loop',
    idea: 'Schedule a lightweight context check for this anchored task.',
    context_task_keys: ['note:context'],
    confidence: 0.7,
  }, (method, p, body) => {
    calls.push({ method, p, body });
    return { ok: true, forwarded: true };
  });

  assert.equal(schedule.forwarded, true);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].p, '/subconscious/idea-scheduler');
  assert.equal(calls[0].body.agent_id, 'daemon');
  assert.equal(calls[0].body.idea, 'Schedule a lightweight context check for this anchored task.');
  assert.deepEqual(calls[0].body.context_task_keys, ['note:context']);

  await tool.run({
    action: 'read',
    workspace: '/tmp/ws',
    agent_id: 'daemon',
    session_id: 'session-a',
    companion_agent_id: 'companion-a',
    companion_loop_id: 'loop-a',
    task_key: 'task/anchor',
    limit: 1,
  }, (method, p, body) => {
    calls.push({ method, p, body });
    return { ok: true, forwarded: true };
  });

  assert.equal(calls[1].method, 'GET');
  assert(calls[1].p.startsWith('/subconscious/idea-scheduler?'));
  assert(calls[1].p.includes('agent_id=daemon'));
  assert(calls[1].p.includes('task_key=task%2Fanchor'));
  assert.equal(calls[1].body, undefined);
});

test('subconscious ask uses deterministic search context and recent agent events', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const graph = {
    tasks: [
      node('task/target', 'Target task', {
        status: 'ready',
        deps: ['task/blocker'],
        context_deps: ['note:direct'],
        context_weights: { 'note:direct': 0.9 },
        provisional: true,
      }),
      node('task/blocker', 'Blocking prerequisite', { summary: 'Handle prerequisite before the target task.' }),
      node('note:direct', 'Direct task context', {
        kind: 'note',
        summary: 'Use the deterministic context compiler before adding any LLM planner.',
      }),
    ],
  };
  const ctx = makeCtx({ graph, workspace: ws, store, body: null });

  await callRoute(ctx, '/subconscious/event', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    type: 'observation',
    text: 'worker claimed the target task',
    confidence: 0.7,
  });

  const res = await callRoute(ctx, '/subconscious/ask', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    intent: 'choose next implementation step',
    situation: 'Need context compiler evidence for deterministic search',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.verdict, 'inject_relevant_context');
  assert.equal(res.body.planner.strategy, 'task_gated_context');
  assert.equal(res.body.planner.gated, true);
  assert.equal(res.body.planner.searches.length, 1);
  assert.equal(res.body.planner.searches[0].task_key, 'task/target');
  assert.equal(res.body.recent_agent_events.length, 1);
  assert.equal(res.body.recent_agent_state.event_count, 1);
  assert.equal(res.body.evidence.results[0].key, 'note:direct');
  assert(res.body.evidence.results.some((r) => r.key === 'note:direct'));
  assert.equal(res.body.recommended_next_action, 'review_injected_context');
  assert.equal(res.body.predicted_consequence, 'using_injected_context_should_reduce_rework');
});

test('subconscious ask makes recent risk the verdict while preserving task context', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const graph = {
    tasks: [
      node('task/target', 'Target task', {
        status: 'ready',
        context_deps: ['note:direct'],
        context_weights: { 'note:direct': 0.9 },
        provisional: true,
      }),
      node('note:direct', 'Recovery context', {
        kind: 'note',
        summary: 'Resolve the deterministic retry conflict before continuing implementation.',
      }),
    ],
  };
  const ctx = makeCtx({ graph, workspace: ws, store, body: null });

  await callRoute(ctx, '/subconscious/event', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    type: 'risk',
    text: 'blocked by retry conflict in the context compiler path',
    confidence: 0.9,
  });

  const res = await callRoute(ctx, '/subconscious/ask', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    intent: 'choose next implementation step',
    situation: 'Need deterministic retry context',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.verdict, 'recent_agent_risk');
  assert.equal(res.body.planner.strategy, 'risk_aware_task_context');
  assert.equal(res.body.planner.signals.has_recent_risk, true);
  assert.equal(res.body.recent_agent_state.risk_event.type, 'risk');
  assert(res.body.evidence.results.some((r) => r.key === 'note:direct'));
  assert.equal(res.body.recommended_next_action, 'account_for_recent_agent_event');
});

test('subconscious ask reports insufficient context when search and state are empty', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const ctx = makeCtx({
    graph: { tasks: [] },
    workspace: ws,
    store,
    body: null,
    gateTask: async () => ({
      decision: 'inject',
      reason: 'test injection without candidates',
      via: 'lexical',
      top1: 0.9,
      margin: 0,
      gap: 0,
      locality: 0,
      topType: null,
      topKey: 'note:missing',
    }),
  });

  const res = await callRoute(ctx, '/subconscious/ask', {
    workspace: ws,
    agent_id: 'agent-a',
    intent: 'choose next step',
    situation: 'No graph context matches this request',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.verdict, 'insufficient_context');
  assert.equal(res.body.planner.strategy, 'broad_context_probe');
  assert.equal(res.body.planner.gated, false);
  assert.equal(res.body.recent_agent_state.event_count, 0);
  assert.equal(res.body.evidence.results.length, 0);
  assert.equal(res.body.recommended_next_action, null);
});

test('subconscious ask isolates recent state by agent', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const graph = {
    tasks: [
      node('task/target', 'Target task', {
        status: 'ready',
        context_deps: ['note:direct'],
        context_weights: { 'note:direct': 0.9 },
        provisional: true,
      }),
      node('note:direct', 'Agent B safe context', {
        kind: 'note',
        summary: 'Agent B should receive graph context without Agent A risk state.',
      }),
    ],
  };
  const ctx = makeCtx({ graph, workspace: ws, store, body: null });

  await callRoute(ctx, '/subconscious/event', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    type: 'risk',
    text: 'failed attempt belongs only to agent a',
    confidence: 0.8,
  });

  const res = await callRoute(ctx, '/subconscious/ask', {
    workspace: ws,
    agent_id: 'agent-b',
    task_key: 'task/target',
    intent: 'choose next implementation step',
    situation: 'Need safe context for Agent B',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.verdict, 'inject_relevant_context');
  assert.equal(res.body.planner.strategy, 'task_gated_context');
  assert.equal(res.body.recent_agent_events.length, 0);
  assert.equal(res.body.recent_agent_state.risk_event, null);
  assert.equal(res.body.planner.signals.has_recent_risk, false);
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
