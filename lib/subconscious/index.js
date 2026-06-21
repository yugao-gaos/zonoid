'use strict';

const { compileSearchContext } = require('../search/context-compiler');

const DEFAULT_MAX_EVENTS = 25;
const DEFAULT_MAX_LOOP_OBSERVATIONS = 25;
const DEFAULT_MAX_SESSION_COMPANION_OBSERVATIONS = 25;
const MAX_PLANNER_ROUNDS = 2;
let nextEventId = 1;
let nextLoopObservationId = 1;
let nextSessionCompanionObservationId = 1;

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

function loopStateKey(workspace, loopId, agentId) {
  return `${workspace}\0${loopId}\0${agentId}`;
}

function sessionCompanionKey(workspace, sessionId) {
  return `${workspace}\0${sessionId}`;
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

function tokenize(value) {
  return new Set((String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []));
}

function sharedTokens(a, b) {
  const out = [];
  for (const token of a) if (b.has(token)) out.push(token);
  return out;
}

function boundedNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function riskEvent(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const haystack = `${event.type || ''} ${event.text || ''}`.toLowerCase();
    if (/\b(blocked|blocker|fail|failed|failure|error|risk|conflict|stuck)\b/.test(haystack)) return event;
  }
  return null;
}

function classifyIntent(intent, situation) {
  const text = `${intent || ''} ${situation || ''}`.toLowerCase();
  if (/\b(blocked|blocker|fail|failed|failure|error|risk|conflict|stuck|regress)\b/.test(text)) return 'risk_review';
  if (/\b(decide|choose|verdict|whether|should|recommend|next)\b/.test(text)) return 'decision_support';
  if (/\b(test|implement|code|edit|fix|build|refactor|change)\b/.test(text)) return 'implementation';
  if (/\b(context|prior|preference|constraint|remember|knowledge|search|recall)\b/.test(text)) return 'context_recall';
  return 'general';
}

function compactEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    ts: event.ts,
    task_key: event.task_key || null,
    type: event.type,
    text: event.text,
    confidence: event.confidence,
  };
}

function compactLoopObservation(observation) {
  if (!observation) return null;
  return {
    id: observation.id,
    ts: observation.ts,
    loop_id: observation.loop_id,
    agent_id: observation.agent_id,
    task_key: observation.task_key || null,
    type: observation.type,
    text: observation.text,
    confidence: observation.confidence,
  };
}

function compactLoopState(entry) {
  if (!entry) return null;
  return {
    version: 1,
    workspace: entry.workspace,
    loop_id: entry.loop_id,
    agent_id: entry.agent_id,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    status: entry.status || null,
    phase: entry.phase || null,
    directive: entry.directive || null,
    payload: entry.payload === undefined ? null : entry.payload,
    observation_count: entry.observation_count,
    tick_count: entry.tick_count,
    latest_observation: compactLoopObservation(entry.latest_observation),
  };
}

function compactSessionCompanionObservation(observation) {
  if (!observation) return null;
  return {
    id: observation.id,
    ts: observation.ts,
    session_id: observation.session_id,
    foreground_agent_id: observation.foreground_agent_id || null,
    companion_agent_id: observation.companion_agent_id,
    companion_loop_id: observation.companion_loop_id,
    task_key: observation.task_key || null,
    type: observation.type,
    text: observation.text,
    confidence: observation.confidence,
  };
}

function compactSessionCompanion(entry) {
  if (!entry) return null;
  return {
    version: 1,
    workspace: entry.workspace,
    session_id: entry.session_id,
    foreground_agent_id: entry.foreground_agent_id || null,
    companion_agent_id: entry.companion_agent_id,
    companion_loop_id: entry.companion_loop_id,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    status: entry.status || null,
    payload: entry.payload === undefined ? null : entry.payload,
    observation_count: entry.observation_count,
    latest_observation: compactSessionCompanionObservation(entry.latest_observation),
  };
}

function defaultSessionCompanionLoopId(sessionId) {
  return `session-companion:${sessionId}`;
}

function buildPlanner(input, workspace, agentId, recent, options = {}) {
  const intent = optionalString(input, 'intent');
  const situation = optionalString(input, 'situation') || optionalString(input, 'query');
  const taskKey = optionalString(input, 'task_key');
  const k = Math.max(1, Math.min(Number(input.k) || 5, 10));
  const recentRisk = riskEvent(recent);
  const intentKind = classifyIntent(intent, situation);
  const baseQuery = [intent, situation].filter(Boolean).join('\n');
  const riskText = recentRisk ? [recentRisk.type, recentRisk.text].filter(Boolean).join(': ') : '';
  const searchQuery = [baseQuery, riskText ? `recent agent risk: ${riskText}` : ''].filter(Boolean).join('\n');
  const query = searchQuery;
  const gated = !!taskKey;
  let strategy = 'broad_context_probe';

  if (taskKey && recentRisk) strategy = 'risk_aware_task_context';
  else if (taskKey) strategy = 'task_gated_context';
  else if (recentRisk) strategy = 'risk_aware_broad_context';
  else if (recent.length > 0) strategy = 'agent_state_broad_context';

  return {
    version: 1,
    strategy,
    intent_kind: intentKind,
    workspace,
    agent_id: agentId,
    task_key: taskKey,
    gated,
    k,
    query,
    max_rounds: gated ? 1 : Math.max(1, Math.min(Number(options.maxRounds) || MAX_PLANNER_ROUNDS, MAX_PLANNER_ROUNDS)),
    signals: {
      has_task_key: !!taskKey,
      recent_event_count: recent.length,
      has_recent_risk: !!recentRisk,
      risk_event_id: recentRisk ? recentRisk.id : null,
    },
    searches: [],
  };
}

function searchUrlForPlan(planner, step) {
  const searchUrl = new URL('http://127.0.0.1/search');
  searchUrl.searchParams.set('workspace', planner.workspace);
  searchUrl.searchParams.set('q', step.query);
  searchUrl.searchParams.set('k', String(planner.k));
  searchUrl.searchParams.set('round', String(step.round));
  if (step.exclude_keys && step.exclude_keys.length) searchUrl.searchParams.set('exclude_keys', step.exclude_keys.join(','));
  if (planner.task_key) {
    searchUrl.searchParams.set('task_key', planner.task_key);
    if (planner.gated) searchUrl.searchParams.set('gated', '1');
  }
  return searchUrl;
}

async function runPlannedSearches(ctx, planner, req) {
  const bodies = [];
  const seen = new Set();
  let round = 1;

  while (round <= planner.max_rounds) {
    const step = {
      round,
      strategy: planner.strategy,
      gated: planner.gated,
      task_key: planner.task_key,
      query: planner.query,
      exclude_keys: [...seen],
    };
    planner.searches.push(step);

    const search = await compileSearchContext(ctx, {
      req: req || { socket: { remoteAddress: 'subconscious' } },
      u: searchUrlForPlan(planner, step),
    });
    step.status = search.status;
    if (search.status !== 200) return { ok: false, status: search.status, body: search.body, bodies };

    bodies.push(search.body);
    for (const result of search.body.results || []) if (result && result.key) seen.add(result.key);
    if (!search.body.continue || round >= planner.max_rounds) break;
    round++;
  }

  return { ok: true, status: 200, bodies };
}

function mergeSearchBodies(bodies) {
  const merged = [];
  const byKey = new Map();
  for (const body of bodies) {
    for (const result of body.results || []) {
      if (!result || !result.key) continue;
      const existing = byKey.get(result.key);
      if (!existing) {
        const copy = { ...result };
        byKey.set(result.key, copy);
        merged.push(copy);
        continue;
      }
      const resultScore = boundedNumber(result.score, 0);
      const existingScore = boundedNumber(existing.score, 0);
      if ((result.inject && !existing.inject) || resultScore > existingScore) Object.assign(existing, result);
    }
  }

  const primary = bodies.find((body) => body.decision === 'inject') || bodies[0] || {};
  const top1 = bodies.map((body) => Number(body.top1)).filter(Number.isFinite).reduce((m, v) => Math.max(m, v), 0);
  return {
    ...primary,
    continue: bodies.some((body) => !!body.continue),
    rounds: bodies.length,
    results: merged,
    top1,
    decisions: bodies.map((body) => body.decision).filter(Boolean),
  };
}

function rankResults(results, planner, events) {
  const risk = riskEvent(events);
  const queryTokens = tokenize([
    planner.query,
    planner.intent_kind,
    risk ? `${risk.type || ''} ${risk.text || ''}` : '',
  ].join(' '));

  return (results || []).map((result, index) => {
    const compact = compactResult(result);
    const resultTokens = tokenize(`${compact.title || ''} ${compact.summary || ''} ${compact.kind || ''} ${compact.tier || ''}`);
    const shared = sharedTokens(queryTokens, resultTokens);
    const lexical = queryTokens.size && resultTokens.size
      ? shared.length / Math.sqrt(queryTokens.size * resultTokens.size)
      : 0;
    const score = boundedNumber(result.score, 0);
    const weight = boundedNumber(result.weight, 0);
    const tierBoost = {
      system: 0.18,
      dag: 0.16,
      'dag-note': 0.14,
      surrounding: 0.06,
      rag: 0,
    }[result.tier] || 0;
    const rank = Math.min(1.5,
      (score * 0.4) +
      (weight * 0.12) +
      tierBoost +
      (result.inject ? 0.25 : 0) +
      (lexical * 0.35)
    );
    compact.rank_score = Number(rank.toFixed(3));
    if (shared.length) compact.matched_terms = shared.slice(0, 5);
    return { compact, rank, index };
  }).sort((a, b) => (b.rank - a.rank) || (a.index - b.index)).map((item) => item.compact);
}

function confidenceFrom(searchBody, events, verdict, rankedResults = null) {
  const sourceResults = rankedResults || searchBody.results || [];
  const scores = sourceResults
    .flatMap((r) => [Number(r.score), Number(r.rank_score)])
    .filter(Number.isFinite);
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

function summarizeRecentState(events) {
  const risk = riskEvent(events);
  return {
    event_count: events.length,
    latest_event: compactEvent(events[events.length - 1]),
    risk_event: compactEvent(risk),
    task_keys: [...new Set(events.map((event) => event.task_key).filter(Boolean))].slice(-5),
    types: [...new Set(events.map((event) => event.type).filter(Boolean))].slice(-5),
  };
}

function composeAskBundle(searchBody, events, planner = {}) {
  const results = rankResults(searchBody.results || [], planner, events).slice(0, 8);
  const risk = riskEvent(events);
  const hasInjectedEvidence = results.some((result) => result.inject);
  let verdict = 'insufficient_context';
  let prediction = null;
  let predictedConsequence = 'next_action_has_low_context_support';
  let recommendedNextAction = null;

  if (risk) {
    verdict = 'recent_agent_risk';
    prediction = 'recent_event_may_affect_next_step';
    predictedConsequence = 'continuing_without_accounting_for_recent_risk_may_repeat_or_compound_it';
    recommendedNextAction = 'account_for_recent_agent_event';
  } else if (hasInjectedEvidence) {
    verdict = 'inject_relevant_context';
    prediction = 'relevant_context_likely';
    predictedConsequence = 'using_injected_context_should_reduce_rework';
    recommendedNextAction = 'review_injected_context';
  } else if (results.length > 0) {
    verdict = 'context_available';
    prediction = searchBody.continue ? 'more_context_may_surface' : 'current_context_likely_enough';
    predictedConsequence = searchBody.continue ? 'another_internal_round_may_improve_context' : 'current_context_is_probably_sufficient';
    recommendedNextAction = 'review_context_then_continue';
  } else if (events.length > 0) {
    verdict = 'recent_agent_state_only';
    prediction = 'recent_events_available_without_graph_evidence';
    predictedConsequence = 'next_step_depends_on_recent_agent_state_not_graph_memory';
    recommendedNextAction = 'continue_from_recent_agent_state';
  }

  return {
    verdict,
    confidence: confidenceFrom(searchBody, events, verdict, results),
    prediction,
    predicted_consequence: predictedConsequence,
    recommended_next_action: recommendedNextAction,
    strategy: planner.strategy || null,
    planner: {
      version: planner.version || 1,
      strategy: planner.strategy || null,
      intent_kind: planner.intent_kind || null,
      gated: !!planner.gated,
      task_key: planner.task_key || null,
      k: planner.k || null,
      query: planner.query || searchBody.query || '',
      rounds: searchBody.rounds || 1,
      signals: planner.signals || {},
      searches: (planner.searches || []).map((step) => ({
        round: step.round,
        strategy: step.strategy,
        gated: !!step.gated,
        task_key: step.task_key || null,
        query: step.query,
        exclude_keys: step.exclude_keys || [],
        status: step.status || null,
      })),
    },
    recent_agent_state: summarizeRecentState(events),
    evidence: {
      decision: searchBody.decision || null,
      reason: searchBody.reason || null,
      continue: !!searchBody.continue,
      rounds: searchBody.rounds || 1,
      results,
    },
  };
}

function createSubconsciousStore(options = {}) {
  const maxEvents = Math.max(1, Number(options.maxEvents) || DEFAULT_MAX_EVENTS);
  const maxLoopObservations = Math.max(1, Number(options.maxLoopObservations) || DEFAULT_MAX_LOOP_OBSERVATIONS);
  const maxSessionCompanionObservations = Math.max(
    1,
    Number(options.maxSessionCompanionObservations) || DEFAULT_MAX_SESSION_COMPANION_OBSERVATIONS
  );
  const agents = new Map();
  const loops = new Map();
  const sessionCompanions = new Map();

  function eventsFor(workspace, agentId) {
    const key = agentStateKey(workspace, agentId);
    let entry = agents.get(key);
    if (!entry) {
      entry = { workspace, agent_id: agentId, events: [] };
      agents.set(key, entry);
    }
    return entry.events;
  }

  function loopFor(workspace, loopId, agentId, now) {
    const key = loopStateKey(workspace, loopId, agentId);
    let entry = loops.get(key);
    if (!entry) {
      entry = {
        workspace,
        loop_id: loopId,
        agent_id: agentId,
        created_at: now,
        updated_at: now,
        status: null,
        phase: null,
        directive: null,
        payload: null,
        observation_count: 0,
        tick_count: 0,
        latest_observation: null,
        observations: [],
      };
      loops.set(key, entry);
    }
    return entry;
  }

  function requireLoopIdentity(input) {
    const workspace = cleanString(input && input.workspace);
    if (!workspace) return { ok: false, status: 400, error: 'workspace required' };
    const loop = requireString(input, 'loop_id');
    if (!loop.ok) return { ok: false, status: 400, error: loop.error };
    const agent = requireString(input, 'agent_id');
    if (!agent.ok) return { ok: false, status: 400, error: agent.error };
    return { ok: true, workspace, loop_id: loop.value, agent_id: agent.value };
  }

  function requireSessionCompanionIdentity(input) {
    const workspace = cleanString(input && input.workspace);
    if (!workspace) return { ok: false, status: 400, error: 'workspace required' };
    const session = requireString(input, 'session_id');
    if (!session.ok) return { ok: false, status: 400, error: session.error };
    return { ok: true, workspace, session_id: session.value };
  }

  function applyLoopStateInput(entry, input) {
    if (Object.prototype.hasOwnProperty.call(input, 'status')) entry.status = optionalString(input, 'status');
    if (Object.prototype.hasOwnProperty.call(input, 'phase')) entry.phase = optionalString(input, 'phase');
    if (Object.prototype.hasOwnProperty.call(input, 'directive')) entry.directive = optionalString(input, 'directive');
    if (Object.prototype.hasOwnProperty.call(input, 'payload')) entry.payload = input.payload === undefined ? null : input.payload;
  }

  function applySessionCompanionInput(entry, input) {
    if (Object.prototype.hasOwnProperty.call(input, 'foreground_agent_id')) {
      entry.foreground_agent_id = optionalString(input, 'foreground_agent_id');
    }
    if (Object.prototype.hasOwnProperty.call(input, 'companion_agent_id')) {
      const companion = optionalString(input, 'companion_agent_id');
      if (companion) entry.companion_agent_id = companion;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'companion_loop_id')) {
      entry.companion_loop_id = optionalString(input, 'companion_loop_id') || defaultSessionCompanionLoopId(entry.session_id);
    }
    if (Object.prototype.hasOwnProperty.call(input, 'status')) entry.status = optionalString(input, 'status');
    if (Object.prototype.hasOwnProperty.call(input, 'payload')) entry.payload = input.payload === undefined ? null : input.payload;
  }

  function sessionCompanionFor(identity, input, now) {
    const key = sessionCompanionKey(identity.workspace, identity.session_id);
    let entry = sessionCompanions.get(key);
    if (!entry) {
      const companion = requireString(input, 'companion_agent_id');
      if (!companion.ok) return companion;
      entry = {
        workspace: identity.workspace,
        session_id: identity.session_id,
        foreground_agent_id: optionalString(input, 'foreground_agent_id'),
        companion_agent_id: companion.value,
        companion_loop_id: optionalString(input, 'companion_loop_id') || defaultSessionCompanionLoopId(identity.session_id),
        created_at: now,
        updated_at: now,
        status: null,
        payload: null,
        observation_count: 0,
        latest_observation: null,
        observations: [],
      };
      sessionCompanions.set(key, entry);
    }
    return { ok: true, entry };
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

  function upsertLoopState(input) {
    const identity = requireLoopIdentity(input);
    if (!identity.ok) return identity;
    const now = input.now || new Date().toISOString();
    const entry = loopFor(identity.workspace, identity.loop_id, identity.agent_id, now);
    applyLoopStateInput(entry, input);
    entry.updated_at = now;
    return {
      ok: true,
      status: 200,
      loop_state: compactLoopState(entry),
      recent_loop_observations: entry.observations.slice(),
    };
  }

  function recordLoopObservation(input) {
    const identity = requireLoopIdentity(input);
    if (!identity.ok) return identity;
    const type = requireString(input, 'type');
    if (!type.ok) return { ok: false, status: 400, error: type.error };
    const confidence = normalizeConfidence(input.confidence);
    if (!confidence.ok) return { ok: false, status: 400, error: confidence.error };

    const now = input.now || new Date().toISOString();
    const entry = loopFor(identity.workspace, identity.loop_id, identity.agent_id, now);
    applyLoopStateInput(entry, input);

    const observation = {
      id: `subloop-${nextLoopObservationId++}`,
      ts: now,
      workspace: identity.workspace,
      loop_id: identity.loop_id,
      agent_id: identity.agent_id,
      task_key: optionalString(input, 'task_key'),
      type: type.value,
      text: optionalString(input, 'text'),
      payload: input.payload === undefined ? null : input.payload,
      confidence: confidence.value,
    };

    entry.observation_count++;
    if (type.value === 'tick') entry.tick_count++;
    entry.latest_observation = observation;
    entry.updated_at = now;
    entry.observations.push(observation);
    while (entry.observations.length > maxLoopObservations) entry.observations.shift();

    return {
      ok: true,
      status: 200,
      loop_state: compactLoopState(entry),
      loop_observation: observation,
      recent_loop_observations: entry.observations.slice(),
    };
  }

  function readLoopState(input) {
    const identity = requireLoopIdentity(input);
    if (!identity.ok) return identity;
    const entry = loops.get(loopStateKey(identity.workspace, identity.loop_id, identity.agent_id));
    const limit = Math.max(1, Number(input.limit) || maxLoopObservations);
    return {
      ok: true,
      status: 200,
      loop_state: compactLoopState(entry),
      recent_loop_observations: entry ? entry.observations.slice(-limit) : [],
    };
  }

  function upsertSessionCompanion(input) {
    const identity = requireSessionCompanionIdentity(input);
    if (!identity.ok) return identity;
    const now = input.now || new Date().toISOString();
    const existing = sessionCompanions.get(sessionCompanionKey(identity.workspace, identity.session_id));
    const ensured = existing
      ? { ok: true, entry: existing }
      : sessionCompanionFor(identity, input, now);
    if (!ensured.ok) return { ok: false, status: 400, error: ensured.error };

    const entry = ensured.entry;
    applySessionCompanionInput(entry, input);
    entry.updated_at = now;
    return {
      ok: true,
      status: 200,
      session_companion: compactSessionCompanion(entry),
      recent_session_companion_observations: entry.observations.slice(),
    };
  }

  function recordSessionCompanionObservation(input) {
    const identity = requireSessionCompanionIdentity(input);
    if (!identity.ok) return identity;
    const type = requireString(input, 'type');
    if (!type.ok) return { ok: false, status: 400, error: type.error };
    const confidence = normalizeConfidence(input.confidence);
    if (!confidence.ok) return { ok: false, status: 400, error: confidence.error };

    const now = input.now || new Date().toISOString();
    const ensured = sessionCompanionFor(identity, input, now);
    if (!ensured.ok) return { ok: false, status: 400, error: ensured.error };

    const entry = ensured.entry;
    applySessionCompanionInput(entry, input);

    const observation = {
      id: `subcomp-${nextSessionCompanionObservationId++}`,
      ts: now,
      workspace: identity.workspace,
      session_id: identity.session_id,
      foreground_agent_id: entry.foreground_agent_id,
      companion_agent_id: entry.companion_agent_id,
      companion_loop_id: entry.companion_loop_id,
      task_key: optionalString(input, 'task_key'),
      type: type.value,
      text: optionalString(input, 'text'),
      payload: input.payload === undefined ? null : input.payload,
      confidence: confidence.value,
    };

    entry.observation_count++;
    entry.latest_observation = observation;
    entry.updated_at = now;
    entry.observations.push(observation);
    while (entry.observations.length > maxSessionCompanionObservations) entry.observations.shift();

    return {
      ok: true,
      status: 200,
      session_companion: compactSessionCompanion(entry),
      session_companion_observation: observation,
      recent_session_companion_observations: entry.observations.slice(),
    };
  }

  function readSessionCompanion(input) {
    const identity = requireSessionCompanionIdentity(input);
    if (!identity.ok) return identity;
    const entry = sessionCompanions.get(sessionCompanionKey(identity.workspace, identity.session_id));
    const limit = Math.max(1, Number(input.limit) || maxSessionCompanionObservations);
    return {
      ok: true,
      status: 200,
      session_companion: compactSessionCompanion(entry),
      recent_session_companion_observations: entry ? entry.observations.slice(-limit) : [],
    };
  }

  async function ask(ctx, input, req) {
    const workspace = cleanString(input.workspace);
    if (!workspace) return { ok: false, status: 400, error: 'workspace required' };
    const agent = requireString(input, 'agent_id');
    if (!agent.ok) return { ok: false, status: 400, error: agent.error };

    const intent = optionalString(input, 'intent');
    const situation = optionalString(input, 'situation') || optionalString(input, 'query');
    const recent = recentEvents(workspace, agent.value, maxEvents);
    const planner = buildPlanner(input, workspace, agent.value, recent);
    const query = planner.query || [intent, situation].filter(Boolean).join('\n');
    if (!query) return { ok: false, status: 400, error: 'intent, situation, or query required' };

    const searches = await runPlannedSearches(ctx, planner, req);
    if (!searches.ok) return { ok: false, status: searches.status, ...searches.body };

    const searchBody = mergeSearchBodies(searches.bodies);
    const bundle = composeAskBundle(searchBody, recent, planner);
    return {
      ok: true,
      status: 200,
      workspace,
      agent_id: agent.value,
      task_key: planner.task_key,
      intent,
      query,
      ...bundle,
      recent_agent_events: recent,
    };
  }

  return {
    recordEvent,
    recentEvents,
    upsertLoopState,
    recordLoopObservation,
    readLoopState,
    upsertSessionCompanion,
    recordSessionCompanionObservation,
    readSessionCompanion,
    ask,
  };
}

module.exports = {
  DEFAULT_MAX_EVENTS,
  DEFAULT_MAX_LOOP_OBSERVATIONS,
  DEFAULT_MAX_SESSION_COMPANION_OBSERVATIONS,
  createSubconsciousStore,
  defaultSubconsciousStore: createSubconsciousStore(),
  buildPlanner,
  composeAskBundle,
};
