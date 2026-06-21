#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const routeFactory = require('../routes/subconscious');
const { createSubconsciousStore } = require('../lib/subconscious');
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

async function callRoute(ctx, p, body) {
  ctx.readBody = async () => body;
  const res = {};
  const handled = await routeFactory(ctx)(p, 'POST', { socket: { remoteAddress: '127.0.0.1' } }, res, new URL(`http://127.0.0.1${p}`));
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
