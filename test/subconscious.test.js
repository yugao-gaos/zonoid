#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const routeFactory = require('../routes/subconscious');
const overlayStore = require('../lib/overlay');
const { createSubconsciousStore } = require('../lib/subconscious');
const { TOOLS } = require('../lib/mcp-core');
const {
  recordGeneratedSkillVersion,
  setActiveSkillVersion,
  getActiveSkillVersion,
} = require('../lib/skill-versions');

let pass = 0;
let fail = 0;
const tests = [];
const test = (label, fn) => tests.push({ label, fn });

function skillMd(name, body) {
  return `---\nname: ${name}\ndescription: generated skill\n---\n\n# ${name}\n\n${body}\n`;
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

function makeCtx({ graph, workspace, store, body, gateTask, overlay, knowledgeText }) {
  const ov = overlay || { knowledge: {}, edges: [], entity_nodes: {} };
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
    knowledgeText: knowledgeText || ((item) => {
      if (typeof item === 'string') return item;
      return String((item && (item.text || item.summary || item.value || item.content)) || '');
    }),
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

test('subconscious execution brain memory and state counters are store-local', async () => {
  const ws = makeWorkspace();
  const storeA = createSubconsciousStore();
  const storeB = createSubconsciousStore();

  const eventA = storeA.recordEvent({ workspace: ws, agent_id: 'agent-a', type: 'step', text: 'a' });
  const eventB = storeB.recordEvent({ workspace: ws, agent_id: 'agent-b', type: 'step', text: 'b' });

  assert.equal(eventA.event.id, 'subevt-1');
  assert.equal(eventB.event.id, 'subevt-1');

  const permitInput = {
    workspace: ws,
    session_id: 'session-a',
    agent_id: 'agent-a',
    task_key: 'task/anchor',
    worktree: `${ws}/wt`,
    branch: 'orch/attempt/task-anchor',
    now: '2026-06-21T13:00:00.000Z',
  };
  const permitA = storeA.issueExecutionPermit(permitInput);
  const permitB = storeB.issueExecutionPermit(permitInput);

  assert.equal(permitA.execution_permit.id, 'subpermit-1');
  assert.equal(permitB.execution_permit.id, 'subpermit-1');
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

test('subconscious execution permit store issues reads and revokes scoped permits', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore();
  const issue = store.issueExecutionPermit({
    workspace: ws,
    session_id: 'session-a',
    agent_id: 'agent-a',
    foreground_agent_id: 'foreground-a',
    task_key: 'task/anchor',
    worktree: `${ws}/wt`,
    branch: 'orch/attempt/task-anchor',
    scope: 'paths',
    allowed_paths: ['src'],
    ttl_seconds: 60,
    reason: 'foreground write permit for anchored task',
    now: '2026-06-21T13:00:00.000Z',
  });

  assert.equal(issue.ok, true);
  assert.equal(issue.execution_permit.status, 'active');
  assert.equal(issue.execution_permit.session_id, 'session-a');
  assert.equal(issue.execution_permit.task_key, 'task/anchor');
  assert.equal(issue.execution_permit.allowed_paths[0], `${ws}/wt/src`);
  assert.equal(issue.execution_permit.expires_at, '2026-06-21T13:01:00.000Z');

  const read = store.readExecutionPermit({
    workspace: ws,
    session_id: 'session-a',
    agent_id: 'agent-a',
    foreground_agent_id: 'foreground-a',
    task_key: 'task/anchor',
    now: '2026-06-21T13:00:30.000Z',
  });
  assert.equal(read.valid, true);
  assert.equal(read.execution_permit.id, issue.execution_permit.id);

  const expired = store.readExecutionPermit({
    workspace: ws,
    permit_id: issue.execution_permit.id,
    session_id: 'session-a',
    agent_id: 'agent-a',
    foreground_agent_id: 'foreground-a',
    task_key: 'task/anchor',
    now: '2026-06-21T13:02:00.000Z',
  });
  assert.equal(expired.valid, false);
  assert.equal(expired.execution_permit.status, 'expired');

  const emptyRead = store.readExecutionPermit({ workspace: ws });
  assert.equal(emptyRead.ok, false);
  assert.equal(emptyRead.status, 400);

  const permitOnlyRevoke = store.revokeExecutionPermit({
    workspace: ws,
    permit_id: issue.execution_permit.id,
    reason: 'malicious revoke',
    now: '2026-06-21T13:00:35.000Z',
  });
  assert.equal(permitOnlyRevoke.ok, false);
  assert.equal(permitOnlyRevoke.status, 400);

  const revoked = store.revokeExecutionPermit({
    workspace: ws,
    permit_id: issue.execution_permit.id,
    session_id: 'session-a',
    agent_id: 'agent-a',
    foreground_agent_id: 'foreground-a',
    task_key: 'task/anchor',
    reason: 'test revoke',
    now: '2026-06-21T13:00:40.000Z',
  });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.execution_permit.status, 'revoked');
  assert.equal(revoked.execution_permit.revocation_reason, 'test revoke');
});

test('subconscious execution permit routes issue read and revoke permits', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore();
  const ov = overlayStore.EMPTY();
  ov.status['task/anchor'] = 'in_progress';
  ov.claimSessions['task/anchor'] = 'session-a';
  ov.assignee['task/anchor'] = 'agent-a';
  ov.git['task/anchor'] = { branch: 'orch/attempt/task-anchor', worktree: `${ws}/wt` };
  const ctx = makeCtx({ graph: { tasks: [] }, workspace: ws, store, body: null, overlay: ov });

  const issued = await callRoute(ctx, '/subconscious/permit', {
    workspace: ws,
    action: 'issue',
    session_id: 'session-a',
    agent_id: 'agent-a',
    task_key: 'task/anchor',
    worktree: `${ws}/wt`,
    branch: 'orch/attempt/task-anchor',
    allowed_paths: [`${ws}/wt/src`],
    now: '2026-06-21T13:10:00.000Z',
  });

  assert.equal(issued.status, 200);
  assert.equal(issued.body.valid, true);
  assert.equal(issued.body.execution_permit.task_key, 'task/anchor');

  const read = await callRoute(
    ctx,
    `/subconscious/permit?workspace=${encodeURIComponent(ws)}&session_id=session-a&task_key=task%2Fanchor&agent_id=agent-a&now=2026-06-21T13%3A10%3A30.000Z`,
    null,
    'GET'
  );
  assert.equal(read.status, 200);
  assert.equal(read.body.valid, true);
  assert.equal(read.body.execution_permit.id, issued.body.execution_permit.id);

  const revoked = await callRoute(ctx, '/subconscious/permit', {
    workspace: ws,
    action: 'revoke',
    permit_id: issued.body.execution_permit.id,
    session_id: 'session-a',
    agent_id: 'agent-a',
    task_key: 'task/anchor',
    reason: 'done',
    now: '2026-06-21T13:11:00.000Z',
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.execution_permit.status, 'revoked');
});

test('subconscious execution permit issue requires verified active claim', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore();
  const ov = overlayStore.EMPTY();
  ov.status['task/anchor'] = 'in_progress';
  ov.claimSessions['task/anchor'] = 'session-a';
  ov.assignee['task/anchor'] = 'agent-a';
  ov.git['task/anchor'] = { branch: 'orch/attempt/task-anchor', worktree: `${ws}/wt` };
  const ctx = makeCtx({ graph: { tasks: [] }, workspace: ws, store, body: null, overlay: ov });

  const wrongSession = await callRoute(ctx, '/subconscious/permit', {
    workspace: ws,
    action: 'issue',
    session_id: 'other-session',
    agent_id: 'agent-a',
    task_key: 'task/anchor',
    worktree: `${ws}/wt`,
    branch: 'orch/attempt/task-anchor',
  });
  assert.equal(wrongSession.status, 409);
  assert.match(wrongSession.body.error, /verified active claim/);

  const wrongWorktree = await callRoute(ctx, '/subconscious/permit', {
    workspace: ws,
    action: 'issue',
    session_id: 'session-a',
    agent_id: 'agent-a',
    task_key: 'task/anchor',
    worktree: `${ws}/other`,
    branch: 'orch/attempt/task-anchor',
  });
  assert.equal(wrongWorktree.status, 409);
  assert.match(wrongWorktree.body.error, /verified active claim/);

  const issued = await callRoute(ctx, '/subconscious/permit', {
    workspace: ws,
    action: 'issue',
    session_id: 'session-a',
    agent_id: 'agent-a',
    task_key: 'task/anchor',
    worktree: `${ws}/wt`,
    branch: 'orch/attempt/task-anchor',
  });
  assert.equal(issued.status, 200);
  assert.equal(issued.body.valid, true);
});

test('subconscious assignment prepare records same-node review request without visible judge task', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore();
  const ov = overlayStore.EMPTY();
  const calls = [];
  const ctx = makeCtx({
    graph: {
      tasks: [
        node('codex/parent', 'Parent task', { summary: 'parent summary' }),
        node('note:ctx', 'Context note', { kind: 'note', summary: 'context summary' }),
      ],
    },
    workspace: ws,
    store,
    body: null,
    overlay: ov,
  });
  ctx.now = () => '2026-06-21T12:00:00.000Z';
  ctx.notifyChange = (workspace) => calls.push({ fn: 'notifyChange', workspace });
  ctx.resolveRepo = (key, repoPath, overlay, workspace) => repoPath || workspace;
  ctx.git = {
    isRepo(repo) { calls.push({ fn: 'isRepo', repo }); return true; },
    isRepoAsync(repo) { calls.push({ fn: 'isRepo', repo }); return true; },
    initRepoAsync(repo) { calls.push({ fn: 'initRepo', repo }); return { initialized: false, head: 'abc123' }; },
    createWorktree(repo, key, options) {
      calls.push({ fn: 'createWorktree', repo, key, options });
      return { branch: 'orch/attempt/codex-impl', worktree: path.join(ws, 'attempt'), head: 'abc123' };
    },
    createWorktreeAsync(repo, key, options) {
      calls.push({ fn: 'createWorktree', repo, key, options });
      return { branch: 'orch/attempt/codex-impl', worktree: path.join(ws, 'attempt'), head: 'abc123' };
    },
  };

  const res = await callRoute(ctx, '/subconscious/assignment', {
    workspace: ws,
    action: 'prepare',
    task_key: 'codex/impl',
    subject: 'Implement assignment facade',
    parent_task_keys: ['codex/parent'],
    context_task_keys: ['note:ctx'],
    create_judge: true,
    repo_path: ws,
    test_cmd: 'npm test',
    base: 'orch/feature/test',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.assignment.task_key, 'codex/impl');
  assert.equal(res.body.assignment.judge_task_key, null);
  assert.equal(res.body.assignment.review_task_key, 'codex/impl');
  assert.equal(res.body.assignment.review_requested, true);
  assert.equal(res.body.assignment.review_state, 'requested');
  assert.equal(res.body.assignment.legacy_judge_task_key, 'codex/impl-judge');
  assert.equal(res.body.judge_task_key, null);
  assert.equal(res.body.review_task_key, 'codex/impl');
  assert.equal(res.body.review_requested, true);
  assert.equal(res.body.legacy_judge_task_key, 'codex/impl-judge');
  assert.equal(res.body.assignment.branch, 'orch/attempt/codex-impl');
  assert.equal(res.body.assignment.worktree, path.join(ws, 'attempt'));
  assert.equal(res.body.assignment.repo_path, ws);
  assert.equal(res.body.assignment.next_expected_worker_action, 'subconscious_assignment.accept');
  assert.deepEqual(res.body.assignment.context.parent_task_keys, ['codex/parent']);
  assert.deepEqual(res.body.assignment.context.context_task_keys, ['note:ctx']);
  assert.equal(res.body.assignment.progressive_disclosure_context.version, 1);
  assert.strictEqual(
    res.body.assignment.context.progressive_disclosure_context,
    res.body.assignment.progressive_disclosure_context
  );
  assert.equal(res.body.assignment.progressive_disclosure_context.kind, 'subconscious_progressive_disclosure_context');
  assert.equal(res.body.assignment.progressive_disclosure_context.layer1.task.key, 'codex/impl');
  assert.match(res.body.assignment.progressive_disclosure_context.layer1.next_action, /subconscious_assignment\.accept/);
  assert.deepEqual(
    res.body.assignment.progressive_disclosure_context.layer2.dependency_summaries.map((item) => [item.key, item.via, item.priority]),
    [['codex/parent', 'blocking', 1], ['note:ctx', 'context', 2]]
  );
  assert.deepEqual(
    res.body.assignment.progressive_disclosure_context.layer3.related_tasks.map((item) => item.key),
    ['codex/parent']
  );
  assert.deepEqual(
    res.body.assignment.progressive_disclosure_context.layer3.related_notes.map((item) => item.key),
    ['note:ctx']
  );
  assert.equal(ov.snapshots['codex/impl'].subject, 'Implement assignment facade');
  assert.equal(ov.snapshots['codex/impl-judge'], undefined);
  assert(ov.edges.some((e) => e.from === 'codex/parent' && e.to === 'codex/impl' && !e.kind));
  assert(ov.edges.some((e) => e.from === 'note:ctx' && e.to === 'codex/impl' && e.kind === 'context'));
  assert(!ov.edges.some((e) => e.from === 'codex/impl' && e.to === 'codex/impl-judge'));
  assert.equal(ov.repos['codex/impl'], ws);
  assert.equal(ov.repos['codex/impl-judge'], undefined);
  assert.equal(ov.reviews['codex/impl'].review_state, 'requested');
  assert.equal(ov.reviews['codex/impl'].merge_state, 'review_pending');
  assert.equal(ov.reviews['codex/impl'].legacy_judge_task_key, 'codex/impl-judge');
  assert.equal(ov.reviews['codex/impl'].review_requested_at, '2026-06-21T12:00:00.000Z');
  assert.equal(ov.config.test_cmds[ws], 'npm test');
  assert.equal(ov.git['codex/impl'].worktree, path.join(ws, 'attempt'));
  assert(calls.some((call) => call.fn === 'createWorktree' && call.key === 'codex/impl' && call.options.base === 'orch/feature/test'));
  assert(calls.some((call) => call.fn === 'notifyChange' && call.workspace === ws));
});

test('subconscious search-context returns filtered multi-step DAG and RAG envelope', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const graph = {
    tasks: [
      node('task/target', 'Agentic context target', {
        status: 'ready',
        context_deps: ['note:dag'],
        context_weights: { 'note:dag': 0.95 },
      }),
      node('note:dag', 'DAG assignment context', {
        kind: 'note',
        summary: 'Task-gated DAG context says worker assignments should receive judged context.',
      }),
      node('note:rag', 'RAG assignment context', {
        kind: 'note',
        summary: 'Broad RAG context says Subconscious should filter raw search hits before workers see them.',
      }),
    ],
  };
  const ctx = makeCtx({ graph, workspace: ws, store, body: null });

  const res = await callRoute(ctx, '/subconscious/search-context', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    intent: 'prepare worker assignment context',
    situation: 'Need DAG and RAG assignment context before worker handoff',
    include_internal: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.subconscious_context.kind, 'subconscious_agentic_search_context');
  assert.equal(res.body.human_summary, res.body.subconscious_context.human_summary);
  assert.match(res.body.subconscious_context.human_summary, /^Subconscious context brief:/);
  assert.doesNotMatch(res.body.subconscious_context.human_summary, /^For "/);
  assert.match(res.body.subconscious_context.human_summary, /foreground agent/);
  const modes = res.body.subconscious_context.search_steps.map((step) => step.mode);
  assert.equal(modes[0], 'dag_task_gated');
  assert(modes.length >= 1 && modes.length <= 4);
  assert.equal(res.body.subconscious_context.search_steps[0].gated, true);
  assert(res.body.subconscious_context.decisions.stop_reason);
  assert(res.body.context_task_keys.includes('note:dag'));
  assert(res.body.subconscious_context.context.every((item) => item.relevance_verdict === 'valuable_for_task'));
  assert.equal(res.body.internal.filtered_count, res.body.subconscious_context.filtered_count);
});

test('subconscious search-context adaptively follows task-adjacent DAG evidence within budget', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const graph = {
    tasks: [
      node('task/target', 'Adaptive target', {
        status: 'ready',
        context_deps: ['task/neighbor'],
        context_weights: { 'task/neighbor': 0.8 },
      }),
      node('task/neighbor', 'Nearby task', {
        status: 'tested',
        summary: 'Nearby task carries the vesper detail for the adaptive context loop.',
        context_deps: ['note:neighbor'],
        context_weights: { 'note:neighbor': 0.95 },
      }),
      node('note:neighbor', 'Vesper detail', {
        kind: 'note',
        summary: 'The useful context is hidden behind task-adjacent DAG expansion, not the first broad RAG probe.',
      }),
    ],
  };
  const ctx = makeCtx({ graph, workspace: ws, store, body: null });

  const res = await callRoute(ctx, '/subconscious/search-context', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    intent: 'prepare adaptive context',
    situation: 'Need neighboring implementation context',
    max_rounds: 3,
    include_internal: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const steps = res.body.subconscious_context.search_steps;
  assert.deepEqual(steps.map((step) => step.mode), ['dag_task_gated', 'rag_broad', 'dag_task_adjacent']);
  assert.equal(steps[2].task_key, 'task/neighbor');
  assert.equal(steps[2].followup_from, 'task/neighbor');
  assert(res.body.subconscious_context.context_task_keys.includes('note:neighbor'));
  assert.equal(res.body.subconscious_context.decisions.rounds, 3);
  assert.equal(res.body.subconscious_context.decisions.stop_reason, 'budget_exhausted');
});

test('subconscious search-context continues from weak task DAG to broad RAG', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const graph = {
    tasks: [
      node('task/target', 'Weak DAG target', {
        status: 'ready',
        context_deps: [],
      }),
      node('note:broad', 'Hydra broad context', {
        kind: 'note',
        summary: 'Hydra broad context is relevant only through the broad RAG pass after weak DAG evidence.',
      }),
    ],
  };
  const ctx = makeCtx({ graph, workspace: ws, store, body: null });

  const res = await callRoute(ctx, '/subconscious/search-context', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    intent: 'prepare adaptive context',
    situation: 'Need hydra broad context for assignment',
    max_rounds: 3,
    include_internal: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const steps = res.body.subconscious_context.search_steps;
  assert.equal(steps[0].mode, 'dag_task_gated');
  assert.equal(steps[1].mode, 'rag_broad');
  assert(res.body.subconscious_context.context_task_keys.includes('note:broad'));
  assert.notEqual(res.body.subconscious_context.verdict, 'abstain_no_context');
});

test('subconscious search-context adaptively follows RAG breadcrumbs', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const graph = {
    tasks: [
      node('note:clue', 'Envelope clue', {
        kind: 'note',
        summary: 'The decisive follow-up phrase is lodestar budget.',
      }),
      node('note:detail', 'Lodestar budget', {
        kind: 'note',
        summary: 'Adaptive Subconscious search should continue with budgeted follow-up retrieval before finalizing context.',
      }),
    ],
  };
  const ctx = makeCtx({ graph, workspace: ws, store, body: null });

  const res = await callRoute(ctx, '/subconscious/search-context', {
    workspace: ws,
    agent_id: 'agent-a',
    query: 'Need the envelope clue for assignment context',
    max_rounds: 3,
    include_internal: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const steps = res.body.subconscious_context.search_steps;
  assert(steps.length > 1 && steps.length <= 3);
  assert.equal(steps[0].mode, 'rag_broad');
  assert(steps.some((step) => step.mode === 'rag_followup'));
  assert(steps.some((step) => step.followup_from === 'note:clue'));
  assert(res.body.subconscious_context.context_task_keys.includes('note:detail'));
  assert.notEqual(res.body.subconscious_context.verdict, 'abstain_no_context');
});

test('subconscious search-context does not treat knowledge chunks as task-adjacent DAG follow-ups', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const ov = {
    knowledge: {},
    edges: [],
    entity_nodes: {},
  };
  const graph = {
    tasks: [
      {
        id: 'knowledge:missing-kind',
        label: 'Missing kind knowledge artifact',
        status: 'done',
        deps: [],
        context_deps: [],
        context_weights: {},
        summary: 'Adaptive context artifact is promising but has no kind and must not become task-adjacent DAG.',
      },
    ],
  };
  const ctx = makeCtx({ graph, workspace: ws, store, body: null, overlay: ov });

  const res = await callRoute(ctx, '/subconscious/search-context', {
    workspace: ws,
    agent_id: 'agent-a',
    query: 'Need adaptive context artifact',
    max_rounds: 2,
    include_internal: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const steps = res.body.subconscious_context.search_steps;
  assert(steps.some((step) => step.mode === 'rag_broad'));
  assert(!steps.some((step) =>
    step.mode === 'dag_task_adjacent' ||
    (step.task_key && step.task_key.startsWith('knowledge:'))
  ));
});

test('subconscious search-context abstains when evidence quality is insufficient', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const graph = {
    tasks: [
      node('note:unrelated', 'Completely unrelated note', {
        kind: 'note',
        summary: 'Banana invoice archive with no overlap for the requested planning context.',
      }),
    ],
  };
  const ctx = makeCtx({ graph, workspace: ws, store, body: null });

  const res = await callRoute(ctx, '/subconscious/search-context', {
    workspace: ws,
    agent_id: 'agent-a',
    query: 'Need adaptive confidence controls for assignment context',
    max_rounds: 3,
    include_internal: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.subconscious_context.verdict, 'abstain_no_context');
  assert.deepEqual(res.body.subconscious_context.context_task_keys, []);
  assert.deepEqual(res.body.subconscious_context.context_deps, []);
  assert.deepEqual(res.body.subconscious_context.context, []);
  assert.match(res.body.subconscious_context.human_summary, /^Subconscious context brief: no foreground context cleared/);
  assert.match(res.body.subconscious_context.human_summary, /Treat this as an abstain result/);
  assert(res.body.subconscious_context.decisions.stop_reason);
  assert(res.body.subconscious_context.confidence < 0.42);
});

test('subconscious assignment prepare carries and wires agentic search context envelope', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore();
  const ov = overlayStore.EMPTY();
  const calls = [];
  const graph = {
    tasks: [
      node('codex/impl', 'Implement agentic context assignment', {
        status: 'ready',
        context_deps: ['note:dag'],
        context_weights: { 'note:dag': 0.9 },
      }),
      node('note:dag', 'DAG assignment context', {
        kind: 'note',
        summary: 'Task-gated context should be selected by Subconscious before worker dispatch.',
      }),
      node('note:rag', 'RAG assignment context', {
        kind: 'note',
        summary: 'Broad search context should be filtered before entering worker handoff.',
      }),
    ],
  };
  const ctx = makeCtx({ graph, workspace: ws, store, body: null, overlay: ov });
  ctx.now = () => '2026-06-21T12:00:00.000Z';
  ctx.notifyChange = (workspace) => calls.push({ fn: 'notifyChange', workspace });
  ctx.resolveRepo = (key, repoPath, overlay, workspace) => repoPath || workspace;
  ctx.git = {
    isRepo(repo) { calls.push({ fn: 'isRepo', repo }); return true; },
    isRepoAsync(repo) { calls.push({ fn: 'isRepo', repo }); return true; },
    initRepoAsync(repo) { calls.push({ fn: 'initRepo', repo }); return { initialized: false, head: 'abc123' }; },
    createWorktree(repo, key, options) {
      calls.push({ fn: 'createWorktree', repo, key, options });
      return { branch: 'orch/attempt/codex-impl', worktree: path.join(ws, 'attempt'), head: 'abc123' };
    },
    createWorktreeAsync(repo, key, options) {
      calls.push({ fn: 'createWorktree', repo, key, options });
      return { branch: 'orch/attempt/codex-impl', worktree: path.join(ws, 'attempt'), head: 'abc123' };
    },
  };

  const res = await callRoute(ctx, '/subconscious/assignment', {
    workspace: ws,
    action: 'prepare',
    task_key: 'codex/impl',
    subject: 'Implement agentic context assignment',
    agent_id: 'dispatcher-a',
    search_context: true,
    context_query: 'Need DAG and broad RAG assignment context before worker dispatch.',
    repo_path: ws,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.assignment.agentic_search_context.kind, 'subconscious_agentic_search_context');
  assert.equal(res.body.assignment.context.agentic_search_context.kind, 'subconscious_agentic_search_context');
  const modes = res.body.assignment.context.agentic_search_context.search_steps.map((step) => step.mode);
  assert.equal(modes[0], 'dag_task_gated');
  assert(res.body.assignment.context.agentic_search_context.decisions.stop_reason);
  assert(res.body.assignment.context.context_task_keys.includes('note:dag'));
  assert(res.body.assignment.context.dependency_summaries.some((summary) => summary.key === 'note:dag' && summary.via === 'subconscious_agentic_search'));
  const progressiveContext = res.body.assignment.progressive_disclosure_context;
  assert(progressiveContext.layer2.dependency_summaries.some((summary) =>
    summary.key === 'note:dag' &&
    summary.via === 'subconscious_agentic_search' &&
    summary.priority === 1
  ));
  assert(progressiveContext.layer2.dependency_summaries.every((summary) => String(summary.summary || '').length <= 360));
  assert.equal(progressiveContext.layer3.full_trace.href, '/task/detail?key=codex%2Fimpl&include_internal=1');
  assert(ov.edges.some((edge) =>
    edge.from === 'note:dag' &&
    edge.to === 'codex/impl' &&
    edge.kind === 'context' &&
    edge.by === 'subconscious' &&
    edge.judged === true &&
    edge.origin === 'subconscious-agentic-search'
  ));
});

test('subconscious assignment read includes progressive disclosure from graph dependencies', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore();
  const ov = overlayStore.EMPTY();
  overlayStore.setGit(ov, 'codex/read', {
    branch: 'orch/attempt/codex-read',
    worktree: path.join(ws, 'attempt'),
  });
  const ctx = makeCtx({
    graph: {
      tasks: [
        node('codex/read', 'Read assignment context', {
          status: 'in_progress',
          deps: ['codex/blocker'],
          context_deps: ['note:ctx'],
          summary: 'Read route should reconstruct cheap live-agent context.',
        }),
        node('codex/blocker', 'Blocking prerequisite', { summary: 'blocking summary' }),
        node('note:ctx', 'Context note', { kind: 'note', summary: 'context summary' }),
      ],
    },
    workspace: ws,
    store,
    body: null,
    overlay: ov,
  });

  const res = await callRoute(
    ctx,
    `/subconscious/assignment?workspace=${encodeURIComponent(ws)}&task_key=codex%2Fread`,
    null,
    'GET'
  );

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.assignment.context.parent_task_keys, ['codex/blocker']);
  assert.deepEqual(res.body.assignment.context.context_task_keys, ['note:ctx']);
  assert.equal(res.body.assignment.progressive_disclosure_context.layer1.blockers[0].key, 'codex/blocker');
  assert.deepEqual(
    res.body.assignment.progressive_disclosure_context.layer2.dependency_summaries.map((item) => item.key),
    ['codex/blocker', 'note:ctx']
  );
  assert.equal(res.body.assignment.progressive_disclosure_context.layer3.prior_attempts[0].label, 'orch/attempt/codex-read');
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

test('subconscious_execution_permit MCP tool forwards issue read and revoke routes', async () => {
  const tool = TOOLS.find((candidate) => candidate.name === 'subconscious_execution_permit');
  assert(tool, 'subconscious_execution_permit tool exists');

  const calls = [];
  const issued = await tool.run({
    action: 'issue',
    workspace: '/tmp/ws',
    session_id: 'session-a',
    agent_id: 'agent-a',
    foreground_agent_id: 'foreground-a',
    task_key: 'task/anchor',
    worktree: '/tmp/ws/wt',
    branch: 'orch/attempt/task-anchor',
    allowed_paths: ['/tmp/ws/wt/src'],
    ttl_seconds: 60,
    reason: 'test permit',
  }, (method, p, body) => {
    calls.push({ method, p, body });
    return { ok: true, execution_permit: { id: 'permit-a', task_key: body.task_key } };
  });

  assert.equal(issued.execution_permit.id, 'permit-a');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].p, '/subconscious/permit');
  assert.equal(calls[0].body.action, 'issue');
  assert.equal(calls[0].body.session_id, 'session-a');
  assert.deepEqual(calls[0].body.allowed_paths, ['/tmp/ws/wt/src']);

  await tool.run({
    action: 'read',
    workspace: '/tmp/ws',
    session_id: 'session-a',
    agent_id: 'agent-a',
    task_key: 'task/anchor',
  }, (method, p, body) => {
    calls.push({ method, p, body });
    return { ok: true, execution_permit: { id: 'permit-a' } };
  });
  assert.equal(calls[1].method, 'GET');
  assert(calls[1].p.startsWith('/subconscious/permit?'));
  assert(calls[1].p.includes('session_id=session-a'));
  assert(calls[1].p.includes('agent_id=agent-a'));
  assert(calls[1].p.includes('task_key=task%2Fanchor'));
  assert.equal(calls[1].body, undefined);

  await tool.run({
    action: 'revoke',
    workspace: '/tmp/ws',
    permit_id: 'permit-a',
    session_id: 'session-a',
    agent_id: 'agent-a',
    task_key: 'task/anchor',
    reason: 'done',
  }, (method, p, body) => {
    calls.push({ method, p, body });
    return { ok: true, execution_permit: { id: body.permit_id, status: 'revoked' } };
  });
  assert.equal(calls[2].method, 'POST');
  assert.equal(calls[2].p, '/subconscious/permit');
  assert.equal(calls[2].body.action, 'revoke');
  assert.equal(calls[2].body.permit_id, 'permit-a');
  assert.equal(calls[2].body.session_id, 'session-a');
  assert.equal(calls[2].body.agent_id, 'agent-a');
  assert.equal(calls[2].body.task_key, 'task/anchor');
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
    include_internal: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.verdict, 'inject_relevant_context');
  assert.equal(res.body.internal.planner.strategy, 'task_gated_context');
  assert.equal(res.body.internal.planner.gated, true);
  assert.equal(res.body.internal.planner.searches.length, 1);
  assert.equal(res.body.internal.planner.searches[0].task_key, 'task/target');
  assert.equal(res.body.internal.recent_agent_events.length, 1);
  assert.equal(res.body.internal.recent_agent_state.event_count, 1);
  assert.equal(res.body.internal.evidence.results[0].key, 'note:direct');
  assert(res.body.internal.evidence.results.some((r) => r.key === 'note:direct'));
  assert.equal(res.body.internal.recommended_next_action, 'review_injected_context');
  assert.equal(res.body.predicted_consequence, 'using_injected_context_should_reduce_rework');
});

test('subconscious ask returns foreground pressure from existing session anchor state', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const graph = {
    tasks: [
      node('task/anchor', 'Anchored implementation task', {
        status: 'ready',
        context_deps: ['note:direct'],
        context_weights: { 'note:direct': 0.9 },
      }),
      node('note:direct', 'Pressure context', {
        kind: 'note',
        summary: 'Review anchor context before continuing the foreground implementation.',
      }),
    ],
  };
  const ctx = makeCtx({ graph, workspace: ws, store, body: null });
  const taskIdsBefore = graph.tasks.map((task) => task.id);

  await callRoute(ctx, '/subconscious/session-companion', {
    workspace: ws,
    session_id: 'session-a',
    foreground_agent_id: 'foreground-a',
    companion_agent_id: 'companion-a',
    companion_loop_id: 'loop-a',
    status: 'paired',
  });
  await callRoute(ctx, '/subconscious/anchor', {
    workspace: ws,
    session_id: 'session-a',
    foreground_agent_id: 'foreground-a',
    companion_agent_id: 'companion-a',
    companion_loop_id: 'loop-a',
    task_key: 'task/anchor',
    reason: 'foreground session is already wired to this DAG task',
    status: 'selected',
    context_task_keys: ['note:direct'],
  });
  await callRoute(ctx, '/subconscious/event', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/anchor',
    type: 'progress',
    text: 'foreground worker finished inspection',
    confidence: 0.7,
  });

  const res = await callRoute(ctx, '/subconscious/ask', {
    workspace: ws,
    agent_id: 'agent-a',
    session_id: 'session-a',
    foreground_agent_id: 'foreground-a',
    companion_agent_id: 'companion-a',
    companion_loop_id: 'loop-a',
    task_key: 'task/anchor',
    intent: 'choose next implementation step',
    situation: 'Need pressure context before continuing implementation',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.execution_owner, 'foreground_agent');
  assert.equal(res.body.selected_task_key, 'task/anchor');
  assert.equal(res.body.next_action, 'review_context_then_work_selected_anchor');
  assert.equal(res.body.current_state.status, 'anchored');
  assert.equal(res.body.current_state.progress, 'recent foreground activity recorded');
  assert.equal(res.body.anchor.status, 'selected');
  assert.equal(res.body.anchor.allocation.task_key, 'task/anchor');
  assert.equal(res.body.identity.session_id, 'session-a');
  assert.equal(res.body.identity.foreground_agent_id, 'foreground-a');
  assert.equal(res.body.identity.companion_agent_id, 'companion-a');
  assert.match(res.body.directive, /foreground-owned work on task\/anchor/);
  assert(res.body.plan.some((step) => step.includes('task/anchor')));
  assert.equal(res.body.context_summary.anchored_task_key, 'task/anchor');
  assert.equal(res.body.context_summary.foreground_agent_id, 'foreground-a');
  assert.equal(res.body.approval_posture.requires_approval, false);
  assert.equal(res.body.execution_permit.required, true);
  assert.equal(res.body.execution_permit.status, 'required_before_write');
  assert.equal(res.body.execution_permit.can_issue, true);
  assert.equal(res.body.execution_permit.session_id, 'session-a');
  assert.equal(res.body.execution_permit.task_key, 'task/anchor');
  assert.equal(res.body.subconscious.kind, 'subconscious_agent_surface');
  assert.equal(res.body.subconscious.verdict, 'inject_relevant_context');
  assert.equal(res.body.subconscious.prediction, 'relevant_context_likely');
  assert.equal(res.body.subconscious.context.summary.anchored_task_key, 'task/anchor');
  assert.equal(res.body.subconscious.anchor.selected_task_key, 'task/anchor');
  assert.equal(res.body.subconscious.approval_posture.requires_approval, false);
  assert.equal(res.body.subconscious.execution_permit.status, 'required_before_write');
  assert.equal(res.body.planner, undefined);
  assert.equal(res.body.evidence, undefined);
  assert.equal(res.body.recent_agent_events, undefined);
  assert.equal(res.body.subconscious_pressure, undefined);
  assert.equal(res.body.internal, undefined);
  assert.equal(res.body.subconscious.context.evidence, undefined);
  assert.equal(res.body.subconscious.pressure, undefined);
  assert.deepEqual(graph.tasks.map((task) => task.id), taskIdsBefore);
});

test('subconscious ask flags approval posture without scheduling side effects', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5, maxIdeas: 5 });
  const graph = {
    tasks: [
      node('task/target', 'Target task', {
        status: 'ready',
        context_deps: ['note:direct'],
        context_weights: { 'note:direct': 0.9 },
      }),
      node('note:direct', 'Deployment caution', {
        kind: 'note',
        summary: 'Production deployment changes require explicit approval before action.',
      }),
    ],
  };
  const ctx = makeCtx({ graph, workspace: ws, store, body: null });

  const res = await callRoute(ctx, '/subconscious/ask', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    intent: 'choose next implementation step',
    situation: 'Deploy a production API schema change after the same failure keeps failing.',
    approval_signals: ['deployment'],
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.execution_owner, 'foreground_agent');
  assert.equal(res.body.selected_task_key, 'task/target');
  assert.equal(res.body.next_action, 'escalate_for_approval');
  assert.equal(res.body.current_state.status, 'approval_required');
  assert.equal(res.body.approval_posture.requires_approval, true);
  assert.equal(res.body.approval_posture.escalation_required, true);
  assert(res.body.approval_posture.approval_reasons.includes('deployment'));
  assert.match(res.body.directive, /escalate for user approval/);
  assert.equal(store.readIdeas({ workspace: ws, agent_id: 'agent-a' }).recent_ideas.length, 0);
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
    include_internal: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.verdict, 'recent_agent_risk');
  assert.equal(res.body.internal.planner.strategy, 'risk_aware_task_context');
  assert.equal(res.body.internal.planner.signals.has_recent_risk, true);
  assert.equal(res.body.internal.recent_agent_state.risk_event.type, 'risk');
  assert(res.body.internal.evidence.results.some((r) => r.key === 'note:direct'));
  assert.equal(res.body.internal.recommended_next_action, 'account_for_recent_agent_event');
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
    include_internal: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.verdict, 'insufficient_context');
  assert.equal(res.body.internal.planner.strategy, 'broad_context_probe');
  assert.equal(res.body.internal.planner.gated, false);
  assert.equal(res.body.internal.recent_agent_state.event_count, 0);
  assert.equal(res.body.internal.evidence.results.length, 0);
  assert.equal(res.body.internal.recommended_next_action, null);
  assert.equal(res.body.selected_task_key, null);
  assert.equal(res.body.recommended_task_key, null);
  assert.equal(res.body.anchor.status, 'none');
  assert.match(res.body.directive, /No foreground anchor is selected/);
  assert.match(res.body.directive, /instead of fabricating or claiming blindly/);
  assert.equal(res.body.identity.session_id, null);
  assert.match(res.body.identity.missing_reasons.session_id, /not provided/);
});

test('subconscious ask does not recommend RAG knowledge chunk evidence as an anchor', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const chunkBase = '59fc18e1-744e-4f7a-9093-a8e12d43087b/42';
  const ctx = makeCtx({
    graph: { tasks: [] },
    workspace: ws,
    store,
    body: null,
    overlay: {
      knowledge: {
        [chunkBase]: [{ text: 'Compact Subconscious response polish needs a real task anchor before editing.' }],
      },
      edges: [],
      entity_nodes: {},
    },
  });

  const res = await callRoute(ctx, '/subconscious/ask', {
    workspace: ws,
    agent_id: 'agent-a',
    intent: 'choose next implementation step',
    situation: 'Need compact Subconscious response polish before editing',
    include_internal: true,
  });

  assert.equal(res.status, 200);
  assert(res.body.internal.evidence.results.some((r) => r.key === `${chunkBase}#k0` && r.kind === 'knowledge'));
  assert.equal(res.body.selected_task_key, null);
  assert.equal(res.body.recommended_task_key, null);
  assert.equal(res.body.anchor.status, 'none');
  assert.match(res.body.directive, /No foreground anchor is selected/);
  assert.match(res.body.directive, /instead of fabricating or claiming blindly/);
});

test('subconscious ask ignores chunk-shaped note evidence unless it is a task node', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const chunkKey = '59fc18e1-744e-4f7a-9093-a8e12d43087b/42#k12';
  const graph = {
    tasks: [
      node(chunkKey, 'Chunk-shaped note evidence', {
        kind: 'note',
        status: 'ready',
        summary: 'Compact Subconscious response polish needs a real task anchor before editing.',
      }),
    ],
  };
  const ctx = makeCtx({ graph, workspace: ws, store, body: null });

  const res = await callRoute(ctx, '/subconscious/ask', {
    workspace: ws,
    agent_id: 'agent-a',
    intent: 'choose next implementation step',
    situation: 'Need compact Subconscious response polish before editing',
    include_internal: true,
  });

  assert.equal(res.status, 200);
  assert(res.body.internal.evidence.results.some((r) => r.key === chunkKey && r.kind === 'note'));
  assert.equal(res.body.selected_task_key, null);
  assert.equal(res.body.recommended_task_key, null);
  assert.equal(res.body.anchor.status, 'none');
  assert.match(res.body.directive, /No foreground anchor is selected/);
});

test('subconscious ask recommends a real task anchor when no session anchor is selected', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const graph = {
    tasks: [
      node('task/recommended', 'Compiler response polish', {
        status: 'ready',
        summary: 'Polish compact Subconscious response shape and response duplication.',
      }),
      node('note:context', 'Implementation context', {
        kind: 'note',
        summary: 'Compact response shape needs a real task recommendation before edits.',
      }),
    ],
  };
  const ctx = makeCtx({ graph, workspace: ws, store, body: null });

  const res = await callRoute(ctx, '/subconscious/ask', {
    workspace: ws,
    agent_id: 'agent-a',
    intent: 'choose next implementation step',
    situation: 'Need compact Subconscious response polish before editing',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.selected_task_key, null);
  assert.equal(res.body.recommended_task_key, 'task/recommended');
  assert.equal(res.body.anchor.status, 'recommended');
  assert.equal(res.body.anchor.recommendation.task_key, 'task/recommended');
  assert.match(res.body.directive, /No foreground anchor is selected/);
  assert.match(res.body.directive, /task\/recommended/);
  assert(res.body.plan.some((step) => step.includes('task/recommended')));
  assert.equal(res.body.internal, undefined);
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
    include_internal: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.verdict, 'inject_relevant_context');
  assert.equal(res.body.internal.planner.strategy, 'task_gated_context');
  assert.equal(res.body.internal.recent_agent_events.length, 0);
  assert.equal(res.body.internal.recent_agent_state.risk_event, null);
  assert.equal(res.body.internal.planner.signals.has_recent_risk, false);
});

test('subconscious skill proposes generated candidates without overwriting SKILL.md and lists active inventory', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const ctx = makeCtx({ graph: { tasks: [] }, workspace: ws, store, body: null });
  const skillPath = path.join(ws, 'skills', 'planner', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, 'installed skill file\n');

  const first = await callRoute(ctx, '/subconscious/skill', {
    workspace: ws,
    action: 'propose_candidate',
    target_path: skillPath,
    skill_markdown: skillMd('Planner', 'candidate behavior'),
    capability: 'planning',
    signature: 'plan-before-edit',
    evidence_count: 2,
    policy: { max_active_per_capability: 1, min_evidence_count: 2, stale_after_ms: 60_000 },
    agent_id: 'agent-skill',
    task_key: 'codex/skill',
    now: '2026-06-21T12:00:00.000Z',
  });
  const duplicate = await callRoute(ctx, '/subconscious/skill', {
    workspace: ws,
    action: 'propose_candidate',
    target_path: skillPath,
    skill_markdown: skillMd('Planner', 'duplicate candidate behavior'),
    capability: 'planning',
    signature: 'plan-before-edit',
    evidence_count: 3,
    policy: { max_active_per_capability: 1, min_evidence_count: 2, stale_after_ms: 60_000 },
    agent_id: 'agent-skill',
    task_key: 'codex/skill',
    now: '2026-06-21T12:00:01.000Z',
  });
  const listed = await callRoute(ctx, '/subconscious/skill', {
    workspace: ws,
    action: 'list_proposals',
    capability: 'planning',
    expire_stale: false,
  });

  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.proposal.status, 'active_candidate');
  assert.equal(first.body.proposal.expose_as_skill, true);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.proposal.status, 'duplicate');
  assert.equal(duplicate.body.proposal.expose_as_skill, false);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.proposals.length, 2);
  assert.equal(listed.body.active_candidates.length, 1);
  assert.equal(listed.body.active_candidates[0].candidate_version_id, first.body.version.version_id);
  assert.equal(fs.readFileSync(skillPath, 'utf8'), 'installed skill file\n');
});

test('subconscious skill records metrics, promotes measured winner, and rolls back via manifest', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const ctx = makeCtx({ graph: { tasks: [] }, workspace: ws, store, body: null });
  const skillPath = path.join(ws, 'skills', 'planner', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, 'installed skill file\n');
  const active = recordGeneratedSkillVersion(ws, {
    target_path: skillPath,
    skill_markdown: skillMd('Planner', 'active behavior'),
    agent_id: 'fixture',
    now: '2026-06-21T12:00:00.000Z',
  }).record;
  setActiveSkillVersion(ws, {
    version_id: active.version_id,
    activated_by: 'fixture',
    now: '2026-06-21T12:00:01.000Z',
  });
  const candidate = await callRoute(ctx, '/subconscious/skill', {
    workspace: ws,
    action: 'propose_candidate',
    target_path: skillPath,
    skill_markdown: skillMd('Planner', 'candidate behavior'),
    capability: 'planning',
    signature: 'winner',
    evidence_count: 2,
    agent_id: 'agent-skill',
    now: '2026-06-21T12:00:02.000Z',
  });

  const evaluated = await callRoute(ctx, '/subconscious/skill', {
    workspace: ws,
    action: 'record_evaluation',
    baseline_version_id: active.version_id,
    candidate_version_id: candidate.body.version.version_id,
    metric_spec: {
      metric: 'quality',
      direction: 'max',
      guardrails: [{ metric: 'tests_passed', direction: 'max' }],
    },
    measurements: {
      active: { value: 0.7, guardrails: { tests_passed: 1 } },
      candidate: { value: 0.9, guardrails: { tests_passed: 1 } },
    },
    agent_id: 'agent-eval',
    task_key: 'codex/eval',
    now: '2026-06-21T12:00:03.000Z',
  });
  const promoted = await callRoute(ctx, '/subconscious/skill', {
    workspace: ws,
    action: 'promote_winner',
    evaluation_id: evaluated.body.evaluation.evaluation_id,
    agent_id: 'agent-promote',
    task_key: 'codex/promote',
    now: '2026-06-21T12:00:04.000Z',
  });
  assert.equal(evaluated.status, 200);
  assert.equal(evaluated.body.evaluation.comparison.verdict, 'candidate_won');
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.promoted, true);
  assert.equal(getActiveSkillVersion(ws, { target_path: skillPath }).version_id, candidate.body.version.version_id);

  const rolledBack = await callRoute(ctx, '/subconscious/skill', {
    workspace: ws,
    action: 'rollback_promotion',
    promotion_id: promoted.body.decision.decision_id,
    agent_id: 'agent-rollback',
    task_key: 'codex/rollback',
    now: '2026-06-21T12:00:05.000Z',
  });

  assert.equal(rolledBack.status, 200);
  assert.equal(rolledBack.body.rolled_back, true);
  assert.equal(getActiveSkillVersion(ws, { target_path: skillPath }).version_id, active.version_id);
  assert.equal(fs.readFileSync(skillPath, 'utf8'), 'installed skill file\n');
});

test('subconscious skill records third-party recommendations without applying cleanup', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const ctx = makeCtx({ graph: { tasks: [] }, workspace: ws, store, body: null });
  const skillPath = path.join(ws, 'skills', 'third-party-planner', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, 'third-party installed skill file\n');
  const active = recordGeneratedSkillVersion(ws, {
    target_path: skillPath,
    skill_markdown: skillMd('Third Party Planner', 'baseline behavior'),
    agent_id: 'fixture',
    now: '2026-06-21T12:00:00.000Z',
  }).record;
  const candidate = recordGeneratedSkillVersion(ws, {
    target_path: skillPath,
    skill_markdown: skillMd('Third Party Planner', 'replacement behavior'),
    agent_id: 'fixture',
    now: '2026-06-21T12:00:01.000Z',
  }).record;
  setActiveSkillVersion(ws, {
    version_id: active.version_id,
    activated_by: 'fixture',
    now: '2026-06-21T12:00:02.000Z',
  });
  const evaluated = await callRoute(ctx, '/subconscious/skill', {
    workspace: ws,
    action: 'record_evaluation',
    baseline_version_id: active.version_id,
    candidate_version_id: candidate.version_id,
    metric_spec: { metric: 'quality', direction: 'max' },
    measurements: {
      active: { value: 0.62 },
      candidate: { value: 0.82 },
    },
    now: '2026-06-21T12:00:03.000Z',
  });
  const recommendation = await callRoute(ctx, '/subconscious/skill', {
    workspace: ws,
    action: 'recommend_third_party',
    evaluation_id: evaluated.body.evaluation.evaluation_id,
    usage_count: 3,
    overlap_score: 0.9,
    stale: true,
    now: '2026-06-21T12:00:04.000Z',
  });
  const listed = await callRoute(ctx, '/subconscious/skill', {
    workspace: ws,
    action: 'list_third_party_recommendations',
  });

  assert.equal(recommendation.status, 200);
  assert.equal(recommendation.body.recommendation, 'replace');
  assert.equal(recommendation.body.user_visible, true);
  assert.equal(recommendation.body.applied, false);
  assert.equal(recommendation.body.decision.third_party.will_auto_replace, false);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.recommendations.length, 1);
  assert.equal(listed.body.recommendations[0].decision_id, recommendation.body.decision.decision_id);
  assert.equal(getActiveSkillVersion(ws, { target_path: skillPath }).version_id, active.version_id);
  assert.equal(fs.readFileSync(skillPath, 'utf8'), 'third-party installed skill file\n');
});

// ---------------------------------------------------------------------------------------------------
// LLM-GRADER integration tests (task #4). The grader is the ADDITIVE controller layer; these assert
// the four BINDING constraints: (a) the loop invokes the grader and respects continue/nextQuery/kept/
// aggregate; (b) the returned set is never fewer/worse than the single-shot + structural FLOOR; (c)
// grader `abstain` keeps the floor (never empties); (d) the round cap holds. All use a MOCKED backend
// (zero network) injected via ctx.graderBackend, enabled per-request with use_grader:true.
// ---------------------------------------------------------------------------------------------------

// Build a mock grader backend that returns a scripted JSON verdict per call (round-indexed). Records
// every call so tests can assert the loop invoked it and what candidates/intent it saw.
function mockGraderBackend(scripts, log) {
  let call = 0;
  return {
    async complete({ prompt, system }) {
      const idx = call;
      call += 1;
      if (log) log.push({ call: idx, prompt, system });
      const script = typeof scripts === 'function' ? scripts(idx, prompt) : (scripts[idx] || scripts[scripts.length - 1]);
      const verdict = typeof script === 'function' ? script(prompt) : script;
      return { text: JSON.stringify(verdict) };
    },
  };
}

// Shared graph fixture with a guaranteed heuristic FLOOR: a task-gated DAG context note (always
// selected as structural evidence) plus a couple of broad notes the grader can keep/add.
function graderGraph() {
  return {
    tasks: [
      node('task/target', 'Grader integration target', {
        status: 'ready',
        context_deps: ['note:dag'],
        context_weights: { 'note:dag': 0.95 },
      }),
      node('note:dag', 'DAG floor context', {
        kind: 'note',
        summary: 'Task-gated DAG floor context is the guaranteed structural floor for worker assignment.',
      }),
      node('note:broad', 'Broad RAG context', {
        kind: 'note',
        summary: 'Broad RAG assignment context the grader may keep or add on top of the floor.',
      }),
    ],
  };
}

test('grader integration: loop invokes grader and respects continue/nextQuery/kept/aggregate', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const log = [];
  const ctx = makeCtx({ graph: graderGraph(), workspace: ws, store, body: null });
  // Round 1: continue with a reformulated query; round 2: stop, keep the DAG floor note, aggregate.
  ctx.graderBackend = mockGraderBackend([
    { continue: true, nextQuery: 'reformulated intent-driven query', kept: ['note:dag'], abstain: false, aggregate: 'partial' },
    { continue: false, nextQuery: null, kept: ['note:dag'], abstain: false, aggregate: 'final aggregate summary' },
  ], log);

  const res = await callRoute(ctx, '/subconscious/search-context', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    intent: 'prepare worker assignment context',
    situation: 'Need DAG and RAG assignment context before worker handoff',
    use_grader: true,
    max_rounds: 4,
    include_internal: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  // (a) the grader was invoked.
  assert(log.length >= 1, 'grader backend was called at least once');
  assert.equal(res.body.subconscious_context.grader.enabled, true);
  assert(res.body.subconscious_context.grader.rounds >= 1);
  // it respected nextQuery — a later search step carries the grader's reformulated query.
  const steps = res.body.subconscious_context.search_steps;
  assert(steps.some((s) => s.grader_reformulated === true && s.query === 'reformulated intent-driven query'),
    'a follow-up step used the grader reformulated query');
  // it respected kept — the kept DAG note is in the returned context.
  assert(res.body.context_task_keys.includes('note:dag'));
  // it respected aggregate — the final aggregate is surfaced.
  assert.equal(res.body.subconscious_context.grader.aggregate, 'final aggregate summary');
  assert.equal(res.body.grader.aggregate, 'final aggregate summary');
  // it respected continue:false — the loop stopped on the grader's terminal verdict.
  assert(['grader_stop', 'grader_fallback_stop', 'budget_exhausted', 'grader_round_cap'].includes(res.body.subconscious_context.decisions.stop_reason));
});

test('grader integration: returned set is never fewer/worse than the single-shot + structural floor', async () => {
  const ws = makeWorkspace();
  const graph = graderGraph();

  // Baseline: heuristic path (grader off) — capture the floor it produces.
  const baseStore = createSubconsciousStore({ maxEvents: 5 });
  const baseCtx = makeCtx({ graph, workspace: ws, store: baseStore, body: null });
  const baseRes = await callRoute(baseCtx, '/subconscious/search-context', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    intent: 'prepare worker assignment context',
    situation: 'Need DAG and RAG assignment context before worker handoff',
    max_rounds: 4,
  });
  const floorKeys = new Set(baseRes.body.context_task_keys);
  assert(floorKeys.size >= 1, 'baseline floor is non-empty for a retrieval intent');

  // Grader path with the SAME inputs — grader keeps only the DAG note and abstains on the rest.
  const gradeStore = createSubconsciousStore({ maxEvents: 5 });
  const gradeCtx = makeCtx({ graph, workspace: ws, store: gradeStore, body: null });
  gradeCtx.graderBackend = mockGraderBackend([
    { continue: false, nextQuery: null, kept: ['note:dag'], abstain: false, aggregate: 'kept floor note' },
  ]);
  const gradeRes = await callRoute(gradeCtx, '/subconscious/search-context', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    intent: 'prepare worker assignment context',
    situation: 'Need DAG and RAG assignment context before worker handoff',
    use_grader: true,
    max_rounds: 4,
  });

  // (b) superset-or-equal: every floor key is still present with the grader on.
  const gradedKeys = new Set(gradeRes.body.context_task_keys);
  for (const key of floorKeys) {
    assert(gradedKeys.has(key), `grader output preserves floor key ${key}`);
  }
  assert(gradedKeys.size >= floorKeys.size, 'grader output is superset-or-equal in size to the floor');
  assert.notEqual(gradeRes.body.subconscious_context.verdict, 'abstain_no_context');
  assert.equal(gradeRes.body.subconscious_context.grader.floor_size, floorKeys.size);
});

test('grader integration: grader abstain keeps the floor (does not empty the result)', async () => {
  const ws = makeWorkspace();
  const graph = graderGraph();

  // Baseline floor (heuristic).
  const baseStore = createSubconsciousStore({ maxEvents: 5 });
  const baseCtx = makeCtx({ graph, workspace: ws, store: baseStore, body: null });
  const baseRes = await callRoute(baseCtx, '/subconscious/search-context', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    intent: 'prepare worker assignment context',
    situation: 'Need DAG and RAG assignment context before worker handoff',
    max_rounds: 4,
  });
  const floorKeys = new Set(baseRes.body.context_task_keys);
  assert(floorKeys.size >= 1);

  // Grader ABSTAINS on every round (kept empty, abstain true) — meaning "nothing to ADD beyond floor".
  const gradeStore = createSubconsciousStore({ maxEvents: 5 });
  const gradeCtx = makeCtx({ graph, workspace: ws, store: gradeStore, body: null });
  gradeCtx.graderBackend = mockGraderBackend([
    { continue: false, nextQuery: null, kept: [], abstain: true, aggregate: '' },
  ]);
  const gradeRes = await callRoute(gradeCtx, '/subconscious/search-context', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    intent: 'prepare worker assignment context',
    situation: 'Need DAG and RAG assignment context before worker handoff',
    use_grader: true,
    max_rounds: 4,
  });

  // (c) abstain must NOT empty the result — the floor is still returned in full.
  assert.notEqual(gradeRes.body.subconscious_context.verdict, 'abstain_no_context');
  const gradedKeys = new Set(gradeRes.body.context_task_keys);
  for (const key of floorKeys) {
    assert(gradedKeys.has(key), `floor key ${key} survives grader abstain`);
  }
  assert(gradeRes.body.context_task_keys.length >= floorKeys.size);
  assert.equal(gradeRes.body.subconscious_context.grader.added_beyond_floor, 0);
});

test('grader integration: round cap holds even when the grader always asks to continue', async () => {
  const ws = makeWorkspace();
  const store = createSubconsciousStore({ maxEvents: 5 });
  const log = [];
  const ctx = makeCtx({ graph: graderGraph(), workspace: ws, store, body: null });
  // The grader ALWAYS wants another round — only the hard cap can stop the loop.
  ctx.graderBackend = mockGraderBackend(
    () => ({ continue: true, nextQuery: 'keep going forever', kept: ['note:dag'], abstain: false, aggregate: 'loop' }),
    log
  );

  const res = await callRoute(ctx, '/subconscious/search-context', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    intent: 'prepare worker assignment context',
    situation: 'Need DAG and RAG assignment context',
    use_grader: true,
    grader_max_rounds: 2,
    max_rounds: 6,
    include_internal: true,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  // (d) the cap holds: grader rounds never exceed the configured grader_max_rounds.
  assert(res.body.subconscious_context.grader.rounds <= 2, `grader rounds (${res.body.subconscious_context.grader.rounds}) within cap 2`);
  // and the planner search rounds never exceed the hard planner budget.
  assert(res.body.subconscious_context.search_steps.length <= 6);
  assert(['grader_round_cap', 'budget_exhausted'].includes(res.body.subconscious_context.decisions.stop_reason),
    `stop reason ${res.body.subconscious_context.decisions.stop_reason} is a cap`);
  // floor still preserved despite the runaway grader.
  assert(res.body.context_task_keys.includes('note:dag'));
});

test('grader integration: backend failure degrades cleanly to the heuristic floor (no abstain-below-floor)', async () => {
  const ws = makeWorkspace();
  const graph = graderGraph();

  // Floor baseline.
  const baseStore = createSubconsciousStore({ maxEvents: 5 });
  const baseCtx = makeCtx({ graph, workspace: ws, store: baseStore, body: null });
  const baseRes = await callRoute(baseCtx, '/subconscious/search-context', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    intent: 'prepare worker assignment context',
    situation: 'Need DAG and RAG assignment context before worker handoff',
    max_rounds: 4,
  });
  const floorKeys = new Set(baseRes.body.context_task_keys);

  // A backend that THROWS — gradeSearchRound returns its conservative fallback (stop, abstain). Because
  // abstain is additive, the floor must still be returned (clean degrade to single-shot).
  const gradeStore = createSubconsciousStore({ maxEvents: 5 });
  const gradeCtx = makeCtx({ graph, workspace: ws, store: gradeStore, body: null });
  gradeCtx.graderBackend = { async complete() { throw new Error('mock backend down'); } };
  const gradeRes = await callRoute(gradeCtx, '/subconscious/search-context', {
    workspace: ws,
    agent_id: 'agent-a',
    task_key: 'task/target',
    intent: 'prepare worker assignment context',
    situation: 'Need DAG and RAG assignment context before worker handoff',
    use_grader: true,
    max_rounds: 4,
  });

  assert.equal(gradeRes.status, 200);
  assert.notEqual(gradeRes.body.subconscious_context.verdict, 'abstain_no_context');
  const gradedKeys = new Set(gradeRes.body.context_task_keys);
  for (const key of floorKeys) {
    assert(gradedKeys.has(key), `floor key ${key} survives grader backend failure`);
  }
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
