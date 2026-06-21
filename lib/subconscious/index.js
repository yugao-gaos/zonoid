'use strict';

const { compileSearchContext } = require('../search/context-compiler');
const {
  recordGeneratedSkillVersion,
} = require('../skill-versions');
const {
  recordSkillEvaluation,
} = require('../skill-evaluations');
const {
  promoteSkillVersion,
  rollbackSkillPromotion,
  recordSkillProposal,
  expireStaleSkillProposals,
  recommendThirdPartySkill,
  readSkillProposalRecords,
  readPromotionRecords,
} = require('../skill-promotions');

const DEFAULT_MAX_EVENTS = 25;
const MAX_PLANNER_ROUNDS = 2;
const DEFAULT_PROPOSAL_LIST_LIMIT = 25;
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

function positiveLimit(value, fallback = DEFAULT_PROPOSAL_LIST_LIMIT) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(n), 100));
}

function latestBy(records, idKey) {
  const latest = new Map();
  for (const record of records || []) {
    if (record && typeof record[idKey] === 'string') latest.set(record[idKey], record);
  }
  return [...latest.values()];
}

function newestFirst(records) {
  return records.slice().sort((a, b) => String(b.recorded_at || '').localeCompare(String(a.recorded_at || '')));
}

function hasCandidateMarkdown(input = {}) {
  return !!cleanString(input.skill_markdown || input.markdown || input.content);
}

function skillActionError(error) {
  return { ok: false, status: 400, error: error && error.message ? error.message : String(error) };
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

  function proposeSkillCandidate(workspace, input = {}) {
    let version = null;
    let candidateVersionId = cleanString(input.candidate_version_id || input.version_id);
    if (hasCandidateMarkdown(input)) {
      const recorded = recordGeneratedSkillVersion(workspace, input);
      version = recorded;
      candidateVersionId = recorded.record.version_id;
    }
    if (!candidateVersionId) throw new Error('skill markdown or candidate_version_id is required');

    const proposal = recordSkillProposal(workspace, {
      ...input,
      candidate_version_id: candidateVersionId,
      capability: cleanString(input.capability || input.area) || (version && version.record.skill_id) || input.skill_id,
      signature: cleanString(input.signature || input.capability_signature || input.overlap_signature)
        || (version && version.record.body_hash)
        || candidateVersionId,
    });

    return {
      ok: true,
      status: 200,
      workspace,
      action: 'propose_candidate',
      ...(version ? {
        version_created: version.created,
        version: version.record,
        manifest: version.manifest,
      } : {}),
      proposal: proposal.record,
      expired: proposal.expired,
      active_candidates_for_capability: proposal.active_candidates_for_capability,
    };
  }

  function listSkillProposalInventory(workspace, input = {}) {
    const expired = input.expire_stale === false ? [] : expireStaleSkillProposals(workspace, input).expired;
    const capability = cleanString(input.capability || input.area);
    const status = cleanString(input.status);
    const limit = positiveLimit(input.limit);
    let proposals = latestBy(readSkillProposalRecords(workspace), 'proposal_id');
    if (capability) proposals = proposals.filter((record) => record.capability === capability || record.area === capability);
    if (status) proposals = proposals.filter((record) => record.status === status);
    proposals = newestFirst(proposals);
    const activeCandidates = proposals.filter((record) => record.status === 'active_candidate' && record.active_candidate === true);

    return {
      ok: true,
      status: 200,
      workspace,
      action: 'list_proposals',
      proposals: proposals.slice(0, limit),
      active_candidates: activeCandidates.slice(0, limit),
      expired,
    };
  }

  function listThirdPartyRecommendations(workspace, input = {}) {
    const limit = positiveLimit(input.limit);
    const skillId = cleanString(input.skill_id);
    const recommendation = cleanString(input.recommendation);
    let records = readPromotionRecords(workspace).filter((record) => record.decision_type === 'third_party_recommendation');
    if (skillId) records = records.filter((record) => record.skill_id === skillId);
    if (recommendation) records = records.filter((record) => record.action === recommendation);
    records = newestFirst(records);
    return {
      ok: true,
      status: 200,
      workspace,
      action: 'list_third_party_recommendations',
      recommendations: records.slice(0, limit),
    };
  }

  function skill(input = {}) {
    const workspace = cleanString(input.workspace);
    if (!workspace) return { ok: false, status: 400, error: 'workspace required' };
    const action = requireString(input, 'action');
    if (!action.ok) return { ok: false, status: 400, error: action.error };

    try {
      if (action.value === 'propose_candidate') return proposeSkillCandidate(workspace, input);
      if (action.value === 'record_evaluation') {
        const recorded = recordSkillEvaluation(workspace, {
          ...input,
          active_version_id: cleanString(input.active_version_id || input.baseline_version_id) || input.active_version_id,
          candidate_version_id: cleanString(input.candidate_version_id || input.version_id) || input.candidate_version_id,
        });
        return { ok: true, status: 200, workspace, action: action.value, evaluation_created: recorded.created, evaluation: recorded.record };
      }
      if (action.value === 'promote_winner') {
        const promoted = promoteSkillVersion(workspace, input);
        return { status: 200, workspace, action: action.value, ...promoted };
      }
      if (action.value === 'rollback_promotion') {
        const rolledBack = rollbackSkillPromotion(workspace, input);
        return { status: 200, workspace, action: action.value, ...rolledBack };
      }
      if (action.value === 'list_proposals') return listSkillProposalInventory(workspace, input);
      if (action.value === 'recommend_third_party') {
        const recommendation = recommendThirdPartySkill(workspace, input);
        return { status: 200, workspace, action: action.value, ...recommendation };
      }
      if (action.value === 'list_third_party_recommendations') return listThirdPartyRecommendations(workspace, input);
      return { ok: false, status: 400, error: `unknown skill action: ${action.value}` };
    } catch (error) {
      return skillActionError(error);
    }
  }

  return { recordEvent, recentEvents, ask, skill };
}

module.exports = {
  DEFAULT_MAX_EVENTS,
  createSubconsciousStore,
  defaultSubconsciousStore: createSubconsciousStore(),
  buildPlanner,
  composeAskBundle,
};
