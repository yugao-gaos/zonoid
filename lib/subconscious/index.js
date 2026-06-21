'use strict';

const { compileSearchContext } = require('../search/context-compiler');

const DEFAULT_MAX_EVENTS = 25;
let nextEventId = 1;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requireString(body, field) {
  const value = cleanString(body && body[field]);
  if (!value) return { ok: false, error: `${field} required` };
  return { ok: true, value };
}

function optionalString(body, field) {
  const value = cleanString(body && body[field]);
  return value || null;
}

function normalizeConfidence(value) {
  if (value == null || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    return { ok: false, error: 'confidence must be a number between 0 and 1' };
  }
  return { ok: true, value: n };
}

function agentStateKey(workspace, agentId) {
  return `${workspace}\0${agentId}`;
}

function compactResult(result) {
  const out = {
    key: result.key,
    title: result.title || result.label || result.key,
    summary: String(result.summary || '').slice(0, 240),
    kind: result.kind || 'task',
    tier: result.tier || null,
    via: result.via || null,
  };
  if (result.score != null) out.score = result.score;
  if (result.weight != null) out.weight = result.weight;
  if (result.status != null) out.status = result.status;
  if (result.inject != null) out.inject = !!result.inject;
  if (Array.isArray(result.path) && result.path.length) out.path = result.path.slice(0, 4);
  return out;
}

function riskEvent(events) {
  return events.find((event) => {
    const haystack = `${event.type || ''} ${event.text || ''}`.toLowerCase();
    return /\b(blocked|blocker|fail|failed|failure|error|risk|conflict|stuck)\b/.test(haystack);
  }) || null;
}

function confidenceFrom(searchBody, events, verdict) {
  const scores = (searchBody.results || []).map((r) => Number(r.score)).filter(Number.isFinite);
  const topScore = scores.length ? Math.max(...scores) : 0;
  const gateScore = Number.isFinite(Number(searchBody.top1)) ? Number(searchBody.top1) : 0;
  const eventScore = events.map((e) => Number(e.confidence)).filter(Number.isFinite).reduce((m, v) => Math.max(m, v), 0);
  const base = Math.max(topScore, gateScore, eventScore * 0.85);
  const clamp = (n) => Math.max(0, Math.min(1, n));
  if (verdict === 'insufficient_context') return clamp(Math.min(0.35, base || 0.2));
  if (verdict === 'recent_agent_risk') return clamp(Math.max(0.6, base || 0.6));
  if (verdict === 'inject_relevant_context') return clamp(Math.max(0.7, base || 0.7));
  return clamp(Math.max(0.5, base || 0.5));
}

function composeAskBundle(searchBody, events) {
  const results = (searchBody.results || []).slice(0, 8).map(compactResult);
  const risk = riskEvent(events);
  let verdict = 'insufficient_context';
  let prediction = null;
  let recommendedNextAction = null;

  if (risk) {
    verdict = 'recent_agent_risk';
    prediction = 'recent_event_may_affect_next_step';
    recommendedNextAction = 'account_for_recent_agent_event';
  } else if (searchBody.decision === 'inject') {
    verdict = 'inject_relevant_context';
    prediction = 'relevant_context_likely';
    recommendedNextAction = 'review_injected_context';
  } else if (results.length > 0) {
    verdict = 'context_available';
    prediction = searchBody.continue ? 'more_context_may_surface' : 'current_context_likely_enough';
    recommendedNextAction = 'review_context_then_continue';
  } else if (events.length > 0) {
    verdict = 'recent_agent_state_only';
    prediction = 'recent_events_available_without_graph_evidence';
    recommendedNextAction = 'continue_from_recent_agent_state';
  }

  return {
    verdict,
    confidence: confidenceFrom(searchBody, events, verdict),
    prediction,
    recommended_next_action: recommendedNextAction,
    evidence: {
      decision: searchBody.decision || null,
      reason: searchBody.reason || null,
      continue: !!searchBody.continue,
      results,
    },
  };
}

function createSubconsciousStore(options = {}) {
  const maxEvents = Math.max(1, Number(options.maxEvents) || DEFAULT_MAX_EVENTS);
  const agents = new Map();

  function eventsFor(workspace, agentId) {
    const key = agentStateKey(workspace, agentId);
    let entry = agents.get(key);
    if (!entry) {
      entry = { workspace, agent_id: agentId, events: [] };
      agents.set(key, entry);
    }
    return entry.events;
  }

  function recordEvent(input) {
    const workspace = cleanString(input.workspace);
    if (!workspace) return { ok: false, status: 400, error: 'workspace required' };
    const agent = requireString(input, 'agent_id');
    if (!agent.ok) return { ok: false, status: 400, error: agent.error };
    const type = requireString(input, 'type');
    if (!type.ok) return { ok: false, status: 400, error: type.error };
    const confidence = normalizeConfidence(input.confidence);
    if (!confidence.ok) return { ok: false, status: 400, error: confidence.error };

    const event = {
      id: `subevt-${nextEventId++}`,
      ts: input.now || new Date().toISOString(),
      workspace,
      agent_id: agent.value,
      task_key: optionalString(input, 'task_key'),
      type: type.value,
      text: optionalString(input, 'text'),
      payload: input.payload === undefined ? null : input.payload,
      confidence: confidence.value,
    };

    const events = eventsFor(workspace, agent.value);
    events.push(event);
    while (events.length > maxEvents) events.shift();
    return { ok: true, status: 200, event, recent_agent_events: events.slice() };
  }

  function recentEvents(workspace, agentId, limit = maxEvents) {
    const events = agents.get(agentStateKey(workspace, agentId));
    if (!events) return [];
    return events.events.slice(-Math.max(1, Number(limit) || maxEvents));
  }

  async function ask(ctx, input, req) {
    const workspace = cleanString(input.workspace);
    if (!workspace) return { ok: false, status: 400, error: 'workspace required' };
    const agent = requireString(input, 'agent_id');
    if (!agent.ok) return { ok: false, status: 400, error: agent.error };

    const intent = optionalString(input, 'intent');
    const situation = optionalString(input, 'situation') || optionalString(input, 'query');
    const query = [intent, situation].filter(Boolean).join('\n');
    if (!query) return { ok: false, status: 400, error: 'intent, situation, or query required' };

    const taskKey = optionalString(input, 'task_key');
    const k = Math.max(1, Math.min(Number(input.k) || 5, 10));
    const searchUrl = new URL('http://127.0.0.1/search');
    searchUrl.searchParams.set('workspace', workspace);
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('k', String(k));
    if (taskKey) {
      searchUrl.searchParams.set('task_key', taskKey);
      searchUrl.searchParams.set('gated', '1');
    }

    const search = await compileSearchContext(ctx, {
      req: req || { socket: { remoteAddress: 'subconscious' } },
      u: searchUrl,
    });
    if (search.status !== 200) return { ok: false, status: search.status, ...search.body };

    const recent = recentEvents(workspace, agent.value, maxEvents);
    const bundle = composeAskBundle(search.body, recent);
    return {
      ok: true,
      status: 200,
      workspace,
      agent_id: agent.value,
      task_key: taskKey,
      intent,
      query,
      ...bundle,
      recent_agent_events: recent,
    };
  }

  return { recordEvent, recentEvents, ask };
}

module.exports = {
  DEFAULT_MAX_EVENTS,
  createSubconsciousStore,
  defaultSubconsciousStore: createSubconsciousStore(),
  composeAskBundle,
};
