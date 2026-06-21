'use strict';

const { compileSearchContext } = require('../search/context-compiler');

const DEFAULT_MAX_EVENTS = 25;
const DEFAULT_MAX_LOOP_OBSERVATIONS = 25;
const DEFAULT_MAX_SESSION_COMPANION_OBSERVATIONS = 25;
const DEFAULT_MAX_ANCHOR_OBSERVATIONS = 25;
const DEFAULT_MAX_ANCHOR_DECISIONS = 25;
const DEFAULT_MAX_IDEAS = 25;
const MAX_PLANNER_ROUNDS = 2;
let nextEventId = 1;
let nextLoopObservationId = 1;
let nextSessionCompanionObservationId = 1;
let nextAnchorObservationId = 1;
let nextAnchorDecisionId = 1;
let nextIdeaId = 1;

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

function normalizeStringArray(body, field) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, field) || body[field] == null || body[field] === '') {
    return { ok: true, value: [] };
  }
  const raw = body[field];
  const items = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(',') : null);
  if (!items) return { ok: false, error: `${field} must be an array of strings` };

  const seen = new Set();
  const value = [];
  for (const item of items) {
    if (typeof item !== 'string') return { ok: false, error: `${field} must be an array of strings` };
    const cleaned = item.trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    value.push(cleaned);
  }
  return { ok: true, value };
}

function normalizeConfidence(value) {
  if (value == null || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    return { ok: false, error: 'confidence must be a number between 0 and 1' };
  }
  return { ok: true, value: n };
}

const APPROVAL_SIGNAL_FIELDS = [
  ['high_impact', 'high_impact'],
  ['outward_facing', 'outward_facing'],
  ['irreversible', 'irreversible'],
  ['scope_expanding', 'scope_expanding'],
  ['destructive', 'destructive'],
  ['deployment', 'deployment'],
  ['api_change', 'api_change'],
  ['repeated_failure', 'repeated_failure'],
];

const APPROVAL_PATTERNS = [
  { reason: 'high_impact', pattern: /\b(high[- ]impact|production|prod|security|privacy|billing|payment|customer data|data loss|credentials?|secrets?|compliance|legal|cost|quota)\b/ },
  { reason: 'outward_facing', pattern: /\b(outward[- ]facing|external|public|publish|announce|notify|email|slack|webhook|customer[- ]facing|user[- ]visible|open pull request|open pr|github issue)\b/ },
  { reason: 'irreversible', pattern: /\b(irreversible|permanent|cannot be undone|can't be undone|one[- ]way|delete forever|drop (table|database)|rewrite history)\b/ },
  { reason: 'scope_expanding', pattern: /\b(scope[- ]expand|expand scope|scope expansion|out of scope|beyond scope|new feature|also build|while there|large refactor|migration)\b/ },
  { reason: 'destructive', pattern: /\b(destructive|delete|drop|truncate|purge|wipe|destroy|reset --hard|force[- ]push|rm -rf|erase)\b/ },
  { reason: 'deployment', pattern: /\b(deploy|deployment|release|rollout|ship to prod|restart (daemon|server|service)|production rollout)\b/ },
  { reason: 'api_change', pattern: /\b(api|schema|contract|protocol|endpoint|public interface)\b[\s\S]{0,50}\b(change|remove|rename|deprecat|break|breaking|expose|publish|migrat)\b|\b(change|remove|rename|deprecat|break|breaking|expose|publish|migrat)\b[\s\S]{0,50}\b(api|schema|contract|protocol|endpoint|public interface)\b/ },
  { reason: 'repeated_failure', pattern: /\b(repeated[- ]failure|repeated failure|failed again|keeps failing|same failure|third attempt|retry exhausted|repeat failure|retries exhausted)\b/ },
];

function addReason(out, seen, reason) {
  const cleaned = cleanString(reason).toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  if (!cleaned || seen.has(cleaned)) return;
  seen.add(cleaned);
  out.push(cleaned);
}

function collectExplicitApprovalSignals(input, out, seen) {
  if (input && (input.approval_required === true || input.requires_approval === true)) {
    addReason(out, seen, 'explicit_approval_required');
  }
  for (const [field, reason] of APPROVAL_SIGNAL_FIELDS) {
    if (input && input[field] === true) addReason(out, seen, reason);
  }
  const rawSignals = input && (input.approval_signals || input.approval_reasons);
  if (Array.isArray(rawSignals)) {
    for (const signal of rawSignals) addReason(out, seen, signal);
  }
}

function classifyIdeaPolicy(input = {}) {
  const reasons = [];
  const seen = new Set();
  collectExplicitApprovalSignals(input, reasons, seen);

  const text = [
    input.kind,
    input.source,
    input.title,
    input.idea,
    input.text,
    input.reason,
  ].map(cleanString).filter(Boolean).join('\n').toLowerCase();

  for (const { reason, pattern } of APPROVAL_PATTERNS) {
    if (pattern.test(text)) addReason(reasons, seen, reason);
  }

  const requiresApproval = reasons.length > 0;
  return {
    version: 1,
    disposition: requiresApproval ? 'requires_approval' : 'schedule',
    requires_approval: requiresApproval,
    approval_reasons: reasons,
    reason: requiresApproval
      ? `approval required for ${reasons.join(', ')}`
      : 'ordinary idea can be recorded as a schedulable proposal',
  };
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

function anchorAllocationKey(workspace, sessionId, companionAgentId, companionLoopId) {
  return `${workspace}\0${sessionId}\0${companionAgentId || ''}\0${companionLoopId || ''}`;
}

function ideaScheduleKey(workspace, agentId, sessionId, companionAgentId, companionLoopId) {
  return `${workspace}\0${agentId}\0${sessionId || ''}\0${companionAgentId || ''}\0${companionLoopId || ''}`;
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

function compactAnchorObservation(observation) {
  if (!observation) return null;
  return {
    id: observation.id,
    ts: observation.ts,
    session_id: observation.session_id,
    foreground_agent_id: observation.foreground_agent_id || null,
    companion_agent_id: observation.companion_agent_id || null,
    companion_loop_id: observation.companion_loop_id || null,
    task_key: observation.task_key,
    type: observation.type,
    text: observation.text,
    confidence: observation.confidence,
  };
}

function compactAnchorDecision(decision) {
  if (!decision) return null;
  return {
    id: decision.id,
    ts: decision.ts,
    session_id: decision.session_id,
    foreground_agent_id: decision.foreground_agent_id || null,
    companion_agent_id: decision.companion_agent_id || null,
    companion_loop_id: decision.companion_loop_id || null,
    task_key: decision.task_key,
    decision: decision.decision,
    reason: decision.reason,
    confidence: decision.confidence,
  };
}

function compactAnchorAllocation(entry) {
  if (!entry) return null;
  return {
    version: 1,
    workspace: entry.workspace,
    session_id: entry.session_id,
    foreground_agent_id: entry.foreground_agent_id || null,
    companion_agent_id: entry.companion_agent_id || null,
    companion_loop_id: entry.companion_loop_id || null,
    task_key: entry.task_key,
    reason: entry.reason,
    status: entry.status || null,
    parent_task_keys: entry.parent_task_keys.slice(),
    context_task_keys: entry.context_task_keys.slice(),
    wiring: {
      parent_task_keys: entry.parent_task_keys.slice(),
      context_task_keys: entry.context_task_keys.slice(),
    },
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    payload: entry.payload === undefined ? null : entry.payload,
    observation_count: entry.observation_count,
    decision_count: entry.decision_count,
    latest_observation: compactAnchorObservation(entry.latest_observation),
    latest_decision: compactAnchorDecision(entry.latest_decision),
  };
}

function compactIdeaRecord(idea) {
  if (!idea) return null;
  return {
    id: idea.id,
    ts: idea.ts,
    workspace: idea.workspace,
    agent_id: idea.agent_id,
    session_id: idea.session_id || null,
    foreground_agent_id: idea.foreground_agent_id || null,
    companion_agent_id: idea.companion_agent_id || null,
    companion_loop_id: idea.companion_loop_id || null,
    task_key: idea.task_key || null,
    source: idea.source || null,
    title: idea.title || null,
    idea: idea.idea,
    reason: idea.reason || null,
    status: idea.status,
    requires_approval: idea.requires_approval,
    approval_reasons: idea.approval_reasons.slice(),
    policy: idea.policy,
    parent_task_keys: idea.parent_task_keys.slice(),
    context_task_keys: idea.context_task_keys.slice(),
    confidence: idea.confidence,
  };
}

function compactIdeaSchedule(entry) {
  if (!entry) return null;
  return {
    version: 1,
    workspace: entry.workspace,
    agent_id: entry.agent_id,
    session_id: entry.session_id || null,
    companion_agent_id: entry.companion_agent_id || null,
    companion_loop_id: entry.companion_loop_id || null,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    idea_count: entry.idea_count,
    scheduled_count: entry.scheduled_count,
    approval_required_count: entry.approval_required_count,
    latest_idea: compactIdeaRecord(entry.latest_idea),
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

function lastTaskKey(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i] && events[i].task_key) return events[i].task_key;
  }
  return null;
}

function summarizeEvidence(results) {
  return {
    count: results.length,
    top_keys: results.slice(0, 5).map((result) => result.key).filter(Boolean),
    top_titles: results.slice(0, 3).map((result) => result.title).filter(Boolean),
  };
}

function classifyAskApprovalPosture(input, verdict) {
  const text = [
    input.intent,
    input.situation,
    input.query,
  ].map(cleanString).filter(Boolean).join('\n');
  const policy = classifyIdeaPolicy({
    ...input,
    kind: 'subconscious_pressure',
    idea: text,
    text,
  });
  return {
    disposition: policy.requires_approval ? 'requires_user_approval' : 'proceed_in_foreground',
    requires_approval: policy.requires_approval,
    escalation_required: policy.requires_approval,
    approval_reasons: policy.approval_reasons.slice(),
    reason: policy.requires_approval
      ? policy.reason
      : (verdict === 'insufficient_context'
        ? 'no approval signal detected; foreground agent should use judgment before expanding scope'
        : 'no approval signal detected; foreground agent owns execution'),
  };
}

function composePressureProtocol(input, planner, bundle, events, sessionCompanion, anchorAllocation) {
  const evidenceResults = (bundle.evidence && bundle.evidence.results) || [];
  const evidenceSummary = summarizeEvidence(evidenceResults);
  const risk = riskEvent(events);
  const selectedTaskKey = (anchorAllocation && anchorAllocation.task_key)
    || planner.task_key
    || lastTaskKey(events)
    || null;
  const approvalPosture = classifyAskApprovalPosture(input, bundle.verdict);
  let nextAction = approvalPosture.escalation_required ? 'escalate_for_approval' : bundle.recommended_next_action;
  if (!nextAction) nextAction = selectedTaskKey ? 'work_selected_anchor' : 'select_foreground_anchor';
  if (!approvalPosture.escalation_required && bundle.verdict === 'recent_agent_risk') nextAction = 'resolve_recent_risk_then_continue';
  if (!approvalPosture.escalation_required && selectedTaskKey && bundle.recommended_next_action === 'review_injected_context') {
    nextAction = 'review_context_then_work_selected_anchor';
  } else if (!approvalPosture.escalation_required && selectedTaskKey && bundle.recommended_next_action && nextAction === bundle.recommended_next_action) {
    nextAction = `${bundle.recommended_next_action}_on_selected_anchor`;
  }

  let status = 'ready';
  if (approvalPosture.escalation_required) status = 'approval_required';
  else if (bundle.verdict === 'recent_agent_risk') status = 'risk_review';
  else if (selectedTaskKey) status = 'anchored';
  else if (bundle.verdict === 'insufficient_context') status = 'needs_context';

  let directive = 'Use a foreground task anchor before editing; Subconscious is returning pressure only and will not execute implementation.';
  if (approvalPosture.escalation_required) {
    directive = 'Pause foreground execution and escalate for user approval before taking the requested outward, irreversible, high-impact, or scope-expanding action.';
  } else if (nextAction === 'resolve_recent_risk_then_continue') {
    directive = selectedTaskKey
      ? `Resolve or account for the recent risk on ${selectedTaskKey}, then continue foreground-owned execution.`
      : 'Resolve or account for the recent risk, then continue foreground-owned execution.';
  } else if (selectedTaskKey) {
    directive = `Continue foreground-owned work on ${selectedTaskKey}; review the supplied context first, then implement and verify in the foreground.`;
  }

  const progress = risk
    ? 'recent risk requires foreground attention'
    : (events.length > 0 ? 'recent foreground activity recorded' : 'no recent foreground progress recorded');
  const plan = [];
  if (approvalPosture.escalation_required) plan.push('Escalate for user approval before continuing this action.');
  if (risk) plan.push('Account for the latest risk event before adding new implementation work.');
  if (evidenceSummary.count > 0) plan.push('Review the highest-ranked context evidence.');
  plan.push(selectedTaskKey
    ? `Work the selected foreground anchor ${selectedTaskKey}.`
    : 'Use an existing foreground task anchor or ask Subconscious to choose one before making code changes.');
  plan.push('Run the relevant verification and report progress back through the foreground task flow.');

  const rationale = [];
  if (anchorAllocation && anchorAllocation.reason) rationale.push(`Anchor selected because ${anchorAllocation.reason}.`);
  else if (selectedTaskKey && planner.task_key === selectedTaskKey) rationale.push('The explicit task_key is the best available foreground anchor.');
  if (risk) rationale.push(`Recent risk event: ${risk.type}${risk.text ? ` - ${risk.text}` : ''}.`);
  if (bundle.evidence && bundle.evidence.reason) rationale.push(`Context retrieval reason: ${bundle.evidence.reason}.`);
  if (approvalPosture.escalation_required) rationale.push(`Approval posture: ${approvalPosture.reason}.`);
  if (!rationale.length) rationale.push('Subconscious found no stronger anchor than recent state and retrieved context.');

  const contextSummary = {
    text: evidenceSummary.count > 0
      ? `Using ${evidenceSummary.count} evidence item(s): ${evidenceSummary.top_keys.join(', ')}.`
      : 'No graph evidence matched the request.',
    evidence: evidenceSummary,
    recent_event_count: events.length,
    session_id: sessionCompanion ? sessionCompanion.session_id : (optionalString(input, 'session_id')),
    foreground_agent_id: sessionCompanion
      ? (sessionCompanion.foreground_agent_id || optionalString(input, 'foreground_agent_id'))
      : optionalString(input, 'foreground_agent_id'),
    companion_agent_id: sessionCompanion ? sessionCompanion.companion_agent_id : (optionalString(input, 'companion_agent_id')),
    companion_loop_id: sessionCompanion ? sessionCompanion.companion_loop_id : (optionalString(input, 'companion_loop_id')),
    anchored_task_key: anchorAllocation ? anchorAllocation.task_key : null,
    anchor_status: anchorAllocation ? anchorAllocation.status : null,
  };
  const pressure = {
    version: 1,
    execution_owner: 'foreground_agent',
    selected_task_key: selectedTaskKey,
    anchored_task_key: anchorAllocation ? anchorAllocation.task_key : null,
    current_state: {
      status,
      progress,
      verdict: bundle.verdict,
      confidence: bundle.confidence,
      recent_event_count: events.length,
      latest_event: compactEvent(events[events.length - 1]),
      risk_event: compactEvent(risk),
      session_companion: sessionCompanion || null,
      anchor_allocation: anchorAllocation || null,
    },
    next_action: nextAction,
    directive,
    plan: [...new Set(plan)],
    context_summary: contextSummary,
    rationale: rationale.join(' '),
    approval_posture: approvalPosture,
  };
  return pressure;
}

function composeAgentSurface(bundle, pressure) {
  return {
    version: 1,
    kind: 'subconscious_agent_surface',
    verdict: bundle.verdict,
    prediction: bundle.prediction,
    predicted_consequence: bundle.predicted_consequence,
    confidence: bundle.confidence,
    execution_owner: pressure.execution_owner,
    next_action: pressure.next_action,
    directive: pressure.directive,
    plan: pressure.plan,
    context: {
      summary: pressure.context_summary,
      evidence: bundle.evidence,
    },
    anchor: {
      selected_task_key: pressure.selected_task_key,
      anchored_task_key: pressure.anchored_task_key,
      allocation: pressure.current_state.anchor_allocation,
    },
    pressure,
    approval_posture: pressure.approval_posture,
    recent_agent_state: bundle.recent_agent_state,
  };
}

function createSubconsciousStore(options = {}) {
  const maxEvents = Math.max(1, Number(options.maxEvents) || DEFAULT_MAX_EVENTS);
  const maxLoopObservations = Math.max(1, Number(options.maxLoopObservations) || DEFAULT_MAX_LOOP_OBSERVATIONS);
  const maxSessionCompanionObservations = Math.max(
    1,
    Number(options.maxSessionCompanionObservations) || DEFAULT_MAX_SESSION_COMPANION_OBSERVATIONS
  );
  const maxAnchorObservations = Math.max(1, Number(options.maxAnchorObservations) || DEFAULT_MAX_ANCHOR_OBSERVATIONS);
  const maxAnchorDecisions = Math.max(1, Number(options.maxAnchorDecisions) || DEFAULT_MAX_ANCHOR_DECISIONS);
  const maxIdeas = Math.max(1, Number(options.maxIdeas) || DEFAULT_MAX_IDEAS);
  const agents = new Map();
  const loops = new Map();
  const sessionCompanions = new Map();
  const anchorAllocations = new Map();
  const ideaSchedules = new Map();

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

  function requireAnchorIdentity(input) {
    const workspace = cleanString(input && input.workspace);
    if (!workspace) return { ok: false, status: 400, error: 'workspace required' };
    const session = requireString(input, 'session_id');
    if (!session.ok) return { ok: false, status: 400, error: session.error };
    return {
      ok: true,
      workspace,
      session_id: session.value,
      companion_agent_id: optionalString(input, 'companion_agent_id'),
      companion_loop_id: optionalString(input, 'companion_loop_id'),
    };
  }

  function requireIdeaIdentity(input) {
    const workspace = cleanString(input && input.workspace);
    if (!workspace) return { ok: false, status: 400, error: 'workspace required' };
    const agent = requireString(input, 'agent_id');
    if (!agent.ok) return { ok: false, status: 400, error: agent.error };
    return {
      ok: true,
      workspace,
      agent_id: agent.value,
      session_id: optionalString(input, 'session_id'),
      companion_agent_id: optionalString(input, 'companion_agent_id'),
      companion_loop_id: optionalString(input, 'companion_loop_id'),
    };
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

  function applyAnchorAllocationInput(entry, input) {
    if (Object.prototype.hasOwnProperty.call(input, 'foreground_agent_id')) {
      entry.foreground_agent_id = optionalString(input, 'foreground_agent_id');
    }
    if (Object.prototype.hasOwnProperty.call(input, 'status')) entry.status = optionalString(input, 'status');
    if (Object.prototype.hasOwnProperty.call(input, 'payload')) entry.payload = input.payload === undefined ? null : input.payload;
  }

  function anchorAllocationFor(identity) {
    return anchorAllocations.get(anchorAllocationKey(
      identity.workspace,
      identity.session_id,
      identity.companion_agent_id,
      identity.companion_loop_id
    ));
  }

  function ideaScheduleFor(identity, now) {
    const key = ideaScheduleKey(
      identity.workspace,
      identity.agent_id,
      identity.session_id,
      identity.companion_agent_id,
      identity.companion_loop_id
    );
    let entry = ideaSchedules.get(key);
    if (!entry && now) {
      entry = {
        workspace: identity.workspace,
        agent_id: identity.agent_id,
        session_id: identity.session_id,
        companion_agent_id: identity.companion_agent_id,
        companion_loop_id: identity.companion_loop_id,
        created_at: now,
        updated_at: now,
        idea_count: 0,
        scheduled_count: 0,
        approval_required_count: 0,
        latest_idea: null,
        ideas: [],
      };
      ideaSchedules.set(key, entry);
    }
    return entry;
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

  function upsertAnchorAllocation(input) {
    const identity = requireAnchorIdentity(input);
    if (!identity.ok) return identity;
    const task = requireString(input, 'task_key');
    if (!task.ok) return { ok: false, status: 400, error: task.error };
    const reason = requireString(input, 'reason');
    if (!reason.ok) return { ok: false, status: 400, error: reason.error };
    const hasParentTaskKeys = Object.prototype.hasOwnProperty.call(input, 'parent_task_keys');
    const parentTaskKeys = normalizeStringArray(input, 'parent_task_keys');
    if (!parentTaskKeys.ok) return { ok: false, status: 400, error: parentTaskKeys.error };
    const hasContextTaskKeys = Object.prototype.hasOwnProperty.call(input, 'context_task_keys');
    const contextTaskKeys = normalizeStringArray(input, 'context_task_keys');
    if (!contextTaskKeys.ok) return { ok: false, status: 400, error: contextTaskKeys.error };

    const now = input.now || new Date().toISOString();
    const key = anchorAllocationKey(
      identity.workspace,
      identity.session_id,
      identity.companion_agent_id,
      identity.companion_loop_id
    );
    let entry = anchorAllocations.get(key);
    if (!entry) {
      entry = {
        workspace: identity.workspace,
        session_id: identity.session_id,
        foreground_agent_id: optionalString(input, 'foreground_agent_id'),
        companion_agent_id: identity.companion_agent_id,
        companion_loop_id: identity.companion_loop_id,
        task_key: task.value,
        reason: reason.value,
        status: null,
        parent_task_keys: parentTaskKeys.value,
        context_task_keys: contextTaskKeys.value,
        created_at: now,
        updated_at: now,
        payload: null,
        observation_count: 0,
        decision_count: 0,
        latest_observation: null,
        latest_decision: null,
        observations: [],
        decisions: [],
      };
      anchorAllocations.set(key, entry);
    }

    entry.task_key = task.value;
    entry.reason = reason.value;
    if (hasParentTaskKeys) entry.parent_task_keys = parentTaskKeys.value;
    if (hasContextTaskKeys) entry.context_task_keys = contextTaskKeys.value;
    applyAnchorAllocationInput(entry, input);
    entry.updated_at = now;

    return {
      ok: true,
      status: 200,
      anchor_allocation: compactAnchorAllocation(entry),
      recent_anchor_observations: entry.observations.slice(),
      recent_anchor_decisions: entry.decisions.slice(),
    };
  }

  function recordAnchorObservation(input) {
    const identity = requireAnchorIdentity(input);
    if (!identity.ok) return identity;
    const type = requireString(input, 'type');
    if (!type.ok) return { ok: false, status: 400, error: type.error };
    const confidence = normalizeConfidence(input.confidence);
    if (!confidence.ok) return { ok: false, status: 400, error: confidence.error };

    const entry = anchorAllocationFor(identity);
    if (!entry) return { ok: false, status: 404, error: 'anchor allocation not found' };
    const taskKey = optionalString(input, 'task_key');
    if (taskKey && taskKey !== entry.task_key) {
      return { ok: false, status: 400, error: 'task_key does not match anchor allocation' };
    }

    const now = input.now || new Date().toISOString();
    applyAnchorAllocationInput(entry, input);
    const observation = {
      id: `subanchor-obs-${nextAnchorObservationId++}`,
      ts: now,
      workspace: identity.workspace,
      session_id: identity.session_id,
      foreground_agent_id: entry.foreground_agent_id,
      companion_agent_id: entry.companion_agent_id,
      companion_loop_id: entry.companion_loop_id,
      task_key: entry.task_key,
      type: type.value,
      text: optionalString(input, 'text'),
      payload: input.payload === undefined ? null : input.payload,
      confidence: confidence.value,
    };

    entry.observation_count++;
    entry.latest_observation = observation;
    entry.updated_at = now;
    entry.observations.push(observation);
    while (entry.observations.length > maxAnchorObservations) entry.observations.shift();

    return {
      ok: true,
      status: 200,
      anchor_allocation: compactAnchorAllocation(entry),
      anchor_observation: observation,
      recent_anchor_observations: entry.observations.slice(),
      recent_anchor_decisions: entry.decisions.slice(),
    };
  }

  function recordAnchorDecision(input) {
    const identity = requireAnchorIdentity(input);
    if (!identity.ok) return identity;
    const decisionInput = requireString(input, 'decision');
    if (!decisionInput.ok) return { ok: false, status: 400, error: decisionInput.error };
    const confidence = normalizeConfidence(input.confidence);
    if (!confidence.ok) return { ok: false, status: 400, error: confidence.error };

    const entry = anchorAllocationFor(identity);
    if (!entry) return { ok: false, status: 404, error: 'anchor allocation not found' };
    const taskKey = optionalString(input, 'task_key');
    if (taskKey && taskKey !== entry.task_key) {
      return { ok: false, status: 400, error: 'task_key does not match anchor allocation' };
    }

    const now = input.now || new Date().toISOString();
    applyAnchorAllocationInput(entry, input);
    const decision = {
      id: `subanchor-dec-${nextAnchorDecisionId++}`,
      ts: now,
      workspace: identity.workspace,
      session_id: identity.session_id,
      foreground_agent_id: entry.foreground_agent_id,
      companion_agent_id: entry.companion_agent_id,
      companion_loop_id: entry.companion_loop_id,
      task_key: entry.task_key,
      decision: decisionInput.value,
      reason: optionalString(input, 'reason'),
      payload: input.payload === undefined ? null : input.payload,
      confidence: confidence.value,
    };

    entry.decision_count++;
    entry.latest_decision = decision;
    entry.updated_at = now;
    entry.decisions.push(decision);
    while (entry.decisions.length > maxAnchorDecisions) entry.decisions.shift();

    return {
      ok: true,
      status: 200,
      anchor_allocation: compactAnchorAllocation(entry),
      anchor_decision: decision,
      recent_anchor_observations: entry.observations.slice(),
      recent_anchor_decisions: entry.decisions.slice(),
    };
  }

  function readAnchorAllocation(input) {
    const identity = requireAnchorIdentity(input);
    if (!identity.ok) return identity;
    const entry = anchorAllocationFor(identity);
    const observationLimit = Math.max(1, Number(input.limit) || maxAnchorObservations);
    const decisionLimit = Math.max(1, Number(input.decision_limit) || maxAnchorDecisions);
    return {
      ok: true,
      status: 200,
      anchor_allocation: compactAnchorAllocation(entry),
      recent_anchor_observations: entry ? entry.observations.slice(-observationLimit) : [],
      recent_anchor_decisions: entry ? entry.decisions.slice(-decisionLimit) : [],
    };
  }

  function scheduleIdea(input) {
    const identity = requireIdeaIdentity(input);
    if (!identity.ok) return identity;
    const ideaText = cleanString(input.idea) || cleanString(input.text);
    if (!ideaText) return { ok: false, status: 400, error: 'idea required' };
    const confidence = normalizeConfidence(input.confidence);
    if (!confidence.ok) return { ok: false, status: 400, error: confidence.error };
    const parentTaskKeys = normalizeStringArray(input, 'parent_task_keys');
    if (!parentTaskKeys.ok) return { ok: false, status: 400, error: parentTaskKeys.error };
    const contextTaskKeys = normalizeStringArray(input, 'context_task_keys');
    if (!contextTaskKeys.ok) return { ok: false, status: 400, error: contextTaskKeys.error };

    const now = input.now || new Date().toISOString();
    const entry = ideaScheduleFor(identity, now);
    const policy = classifyIdeaPolicy({ ...input, idea: ideaText });
    const requiresApproval = policy.requires_approval;
    const idea = {
      id: `subidea-${nextIdeaId++}`,
      ts: now,
      workspace: identity.workspace,
      agent_id: identity.agent_id,
      session_id: identity.session_id,
      foreground_agent_id: optionalString(input, 'foreground_agent_id'),
      companion_agent_id: identity.companion_agent_id,
      companion_loop_id: identity.companion_loop_id,
      task_key: optionalString(input, 'task_key'),
      source: optionalString(input, 'source'),
      title: optionalString(input, 'title'),
      idea: ideaText,
      reason: optionalString(input, 'reason'),
      payload: input.payload === undefined ? null : input.payload,
      confidence: confidence.value,
      parent_task_keys: parentTaskKeys.value,
      context_task_keys: contextTaskKeys.value,
      policy,
      status: requiresApproval ? 'requires_approval' : 'scheduled',
      requires_approval: requiresApproval,
      approval_reasons: policy.approval_reasons.slice(),
    };

    entry.idea_count++;
    if (requiresApproval) entry.approval_required_count++;
    else entry.scheduled_count++;
    entry.latest_idea = idea;
    entry.updated_at = now;
    entry.ideas.push(idea);
    while (entry.ideas.length > maxIdeas) entry.ideas.shift();

    return {
      ok: true,
      status: 200,
      requires_approval: requiresApproval,
      scheduled: !requiresApproval,
      idea_policy: policy,
      subconscious_idea: compactIdeaRecord(idea),
      idea_schedule: compactIdeaSchedule(entry),
      recent_ideas: entry.ideas.map(compactIdeaRecord),
    };
  }

  function readIdeas(input) {
    const identity = requireIdeaIdentity(input);
    if (!identity.ok) return identity;
    const entry = ideaScheduleFor(identity, null);
    const limit = Math.max(1, Number(input.limit) || maxIdeas);
    const taskKey = optionalString(input, 'task_key');
    const ideas = entry
      ? entry.ideas.filter((idea) => !taskKey || idea.task_key === taskKey).slice(-limit).map(compactIdeaRecord)
      : [];
    return {
      ok: true,
      status: 200,
      idea_schedule: compactIdeaSchedule(entry),
      recent_ideas: ideas,
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
    const sessionId = optionalString(input, 'session_id');
    let sessionCompanion = null;
    let anchorAllocation = null;
    if (sessionId) {
      const sessionRead = readSessionCompanion({ workspace, session_id: sessionId });
      sessionCompanion = sessionRead.session_companion || null;
      const companionAgentId = optionalString(input, 'companion_agent_id')
        || (sessionCompanion && sessionCompanion.companion_agent_id)
        || null;
      const companionLoopId = optionalString(input, 'companion_loop_id')
        || (sessionCompanion && sessionCompanion.companion_loop_id)
        || null;
      const anchorRead = readAnchorAllocation({
        workspace,
        session_id: sessionId,
        companion_agent_id: companionAgentId,
        companion_loop_id: companionLoopId,
      });
      anchorAllocation = anchorRead.anchor_allocation || null;
    }
    const pressure = composePressureProtocol(input, planner, bundle, recent, sessionCompanion, anchorAllocation);
    const subconscious = composeAgentSurface(bundle, pressure);
    return {
      ok: true,
      status: 200,
      workspace,
      agent_id: agent.value,
      task_key: planner.task_key,
      intent,
      query,
      ...bundle,
      execution_owner: pressure.execution_owner,
      selected_task_key: pressure.selected_task_key,
      current_state: pressure.current_state,
      next_action: pressure.next_action,
      directive: pressure.directive,
      plan: pressure.plan,
      context_summary: pressure.context_summary,
      rationale: pressure.rationale,
      approval_posture: pressure.approval_posture,
      subconscious,
      subconscious_pressure: pressure,
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
    upsertAnchorAllocation,
    recordAnchorObservation,
    recordAnchorDecision,
    readAnchorAllocation,
    scheduleIdea,
    readIdeas,
    ask,
  };
}

module.exports = {
  DEFAULT_MAX_EVENTS,
  DEFAULT_MAX_LOOP_OBSERVATIONS,
  DEFAULT_MAX_SESSION_COMPANION_OBSERVATIONS,
  DEFAULT_MAX_ANCHOR_OBSERVATIONS,
  DEFAULT_MAX_ANCHOR_DECISIONS,
  DEFAULT_MAX_IDEAS,
  createSubconsciousStore,
  defaultSubconsciousStore: createSubconsciousStore(),
  buildPlanner,
  composeAskBundle,
  composeAgentSurface,
  classifyIdeaPolicy,
};
