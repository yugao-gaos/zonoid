'use strict';

const path = require('path');
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
const DEFAULT_MAX_LOOP_OBSERVATIONS = 25;
const DEFAULT_MAX_SESSION_COMPANION_OBSERVATIONS = 25;
const DEFAULT_MAX_ANCHOR_OBSERVATIONS = 25;
const DEFAULT_MAX_ANCHOR_DECISIONS = 25;
const DEFAULT_MAX_IDEAS = 25;
const DEFAULT_PERMIT_TTL_MS = 60 * 60 * 1000;
const MAX_PLANNER_ROUNDS = 2;
const DEFAULT_PROPOSAL_LIST_LIMIT = 25;
const DEFAULT_SEARCH_CONTEXT_LIMIT = 5;
const DEFAULT_SEARCH_CONTEXT_MAX_ROUNDS = 4;
const MAX_SEARCH_CONTEXT_ROUNDS = 6;
const SEARCH_CONTEXT_HIGH_CONFIDENCE = 0.72;
const SEARCH_CONTEXT_MIN_FINAL_CONFIDENCE = 0.35;
const SEARCH_CONTEXT_MIN_PROMISING_QUALITY = 0.18;
const SEARCH_CONTEXT_MIN_SELECT_QUALITY = 0.22;
let nextEventId = 1;
let nextLoopObservationId = 1;
let nextSessionCompanionObservationId = 1;
let nextAnchorObservationId = 1;
let nextAnchorDecisionId = 1;
let nextIdeaId = 1;
let nextExecutionPermitId = 1;

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

function slashPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function normalizePermitPath(value) {
  const s = slashPath(value).trim();
  if (!s) return '';
  return path.posix.normalize(s);
}

function isAbsolutePermitPath(value) {
  const s = slashPath(value);
  return s.startsWith('/') || /^[A-Za-z]:\//.test(s);
}

function resolvePermitPath(value, base) {
  const s = slashPath(value).trim();
  if (!s) return '';
  if (isAbsolutePermitPath(s)) return normalizePermitPath(s);
  return normalizePermitPath(`${normalizePermitPath(base).replace(/\/+$/, '')}/${s}`);
}

function isUnderPermitPath(target, dir) {
  const t = normalizePermitPath(target);
  const d = normalizePermitPath(dir).replace(/\/+$/, '');
  return !!(t && d && (t === d || t.startsWith(`${d}/`)));
}

function parseTimeMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function executionPermitStatus(permit, nowMs = Date.now()) {
  if (!permit) return 'missing';
  if (permit.status === 'revoked') return 'revoked';
  const expiresMs = parseTimeMs(permit.expires_at);
  if (expiresMs != null && expiresMs <= nowMs) return 'expired';
  return permit.status || 'active';
}

function compactExecutionPermit(permit, nowMs = Date.now()) {
  if (!permit) return null;
  const status = executionPermitStatus(permit, nowMs);
  return {
    version: 1,
    id: permit.id,
    workspace: permit.workspace,
    session_id: permit.session_id,
    agent_id: permit.agent_id || null,
    foreground_agent_id: permit.foreground_agent_id || null,
    task_key: permit.task_key,
    worktree: permit.worktree,
    branch: permit.branch,
    scope: permit.scope,
    allowed_paths: permit.allowed_paths.slice(),
    status,
    issued_at: permit.issued_at,
    expires_at: permit.expires_at,
    revoked_at: permit.revoked_at || null,
    revocation_reason: permit.revocation_reason || null,
    reason: permit.reason || null,
  };
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
  if (result.search_mode != null) out.search_mode = result.search_mode;
  if (result.followup_from != null) out.followup_from = result.followup_from;
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
  const requestedMaxRounds = Number(options.maxRounds);
  const defaultMaxRounds = Math.max(1, Number(options.defaultMaxRounds) || MAX_PLANNER_ROUNDS);
  const maxRoundsCap = Math.max(1, Number(options.maxRoundsCap) || MAX_PLANNER_ROUNDS);
  const maxRounds = Math.max(1, Math.min(
    Number.isFinite(requestedMaxRounds) && requestedMaxRounds > 0 ? requestedMaxRounds : defaultMaxRounds,
    maxRoundsCap
  ));
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
    max_rounds: maxRounds,
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
  const stepTaskKey = Object.prototype.hasOwnProperty.call(step, 'task_key') ? step.task_key : planner.task_key;
  const stepGated = Object.prototype.hasOwnProperty.call(step, 'gated') ? step.gated : planner.gated;
  searchUrl.searchParams.set('workspace', planner.workspace);
  searchUrl.searchParams.set('q', step.query);
  searchUrl.searchParams.set('k', String(planner.k));
  searchUrl.searchParams.set('round', String(step.round));
  if (step.exclude_keys && step.exclude_keys.length) searchUrl.searchParams.set('exclude_keys', step.exclude_keys.join(','));
  if (stepTaskKey) {
    searchUrl.searchParams.set('task_key', stepTaskKey);
    if (stepGated) searchUrl.searchParams.set('gated', '1');
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

function isAgenticTaskContextTier(result) {
  const tier = result && result.tier;
  return tier === 'dag' || tier === 'dag-note' || tier === 'surrounding';
}

function evidenceQualityForResult(result) {
  if (!result) return 0;
  const rank = boundedNumber(result.rank_score, 0);
  const lexical = boundedNumber(result.lexical_score, 0);
  if (result.tier === 'system') return Math.max(0.8, rank, lexical);
  if (isAgenticTaskContextTier(result)) {
    const structural = Math.min(0.34, (result.inject ? 0.18 : 0) + (boundedNumber(result.weight, 0.5) * 0.15));
    return Math.max(lexical, structural, Math.min(rank, 0.42));
  }
  return Math.max(rank, lexical * 0.7, result.followup_from ? Math.min(0.5, rank + 0.08) : 0);
}

function confidenceFromAgenticSelection(filtered) {
  const selected = filtered && Array.isArray(filtered.selected) ? filtered.selected : [];
  const rejected = filtered && Array.isArray(filtered.rejected) ? filtered.rejected : [];
  const clamp = (n) => Math.max(0, Math.min(1, n));
  if (!selected.length) {
    const rejectedQuality = rejected.map(evidenceQualityForResult).reduce((m, v) => Math.max(m, v), 0);
    return clamp(Math.min(0.35, rejectedQuality * 1.2 || 0.2));
  }
  const topQuality = selected.map(evidenceQualityForResult).reduce((m, v) => Math.max(m, v), 0);
  const breadthBoost = Math.min(0.16, Math.max(0, selected.length - 1) * 0.04);
  const gateBoost = selected.some((result) => result.inject && !isAgenticTaskContextTier(result)) ? 0.08 : 0;
  return clamp((topQuality * 1.6) + breadthBoost + gateBoost);
}

function summarizeAgenticSearchState(bodies, planner, events) {
  const searchBody = mergeSearchBodies(bodies);
  const filtered = filterAgenticContextResults(searchBody, events, planner);
  const ranked = rankResults(searchBody.results || [], planner, events);
  const evidenceQuality = ranked.map(evidenceQualityForResult).reduce((m, v) => Math.max(m, v), 0);
  const confidence = confidenceFromAgenticSelection(filtered);
  return {
    searchBody,
    filtered,
    ranked,
    evidence_quality: Number(evidenceQuality.toFixed(3)),
    confidence: Number(confidence.toFixed(3)),
    selected_count: filtered.selected.length,
  };
}

function followupQueryForResult(planner, result) {
  const title = cleanString(result && (result.title || result.key));
  const summary = cleanString(result && result.summary);
  return [
    planner.query,
    title ? `follow-up evidence title: ${title}` : '',
    summary ? `follow-up evidence summary: ${summary}` : '',
  ].filter(Boolean).join('\n').slice(0, 1200);
}

function chooseAgenticFollowup(planner, state, expandedTaskKeys, followedEvidenceKeys, round) {
  const candidates = (state.ranked || [])
    .filter((result) => result && result.key && !followedEvidenceKeys.has(result.key))
    .filter((result) => evidenceQualityForResult(result) >= SEARCH_CONTEXT_MIN_PROMISING_QUALITY);

  const taskCandidate = candidates.find((result) =>
    isAgenticTaskFollowupCandidate(result) &&
    result.key !== planner.task_key &&
    !expandedTaskKeys.has(result.key)
  );
  if (taskCandidate) {
    expandedTaskKeys.add(taskCandidate.key);
    followedEvidenceKeys.add(taskCandidate.key);
    return {
      round,
      strategy: 'task_adjacent_followup',
      mode: 'dag_task_adjacent',
      gated: true,
      task_key: taskCandidate.key,
      query: followupQueryForResult(planner, taskCandidate),
      followup_from: taskCandidate.key,
    };
  }

  const ragCandidate = candidates[0] || null;
  if (!ragCandidate) return null;
  followedEvidenceKeys.add(ragCandidate.key);
  return {
    round,
    strategy: 'broad_rag_followup',
    mode: 'rag_followup',
    gated: false,
    task_key: null,
    query: followupQueryForResult(planner, ragCandidate),
    followup_from: ragCandidate.key,
  };
}

function isAgenticTaskFollowupCandidate(result) {
  const kind = cleanString(result && result.kind).toLowerCase();
  const key = cleanString(result && result.key);
  return kind === 'task' && isTaskKey(key) && !key.includes(':');
}

function agenticStopReason(state, planner, stepCount) {
  if (stepCount >= planner.max_rounds) return 'budget_exhausted';
  if (state.selected_count > 0 && state.confidence >= SEARCH_CONTEXT_HIGH_CONFIDENCE) return 'confidence_high';
  if (state.evidence_quality < SEARCH_CONTEXT_MIN_PROMISING_QUALITY) return 'insufficient_evidence_quality';
  return null;
}

async function runAgenticContextSearches(ctx, planner, req, events = []) {
  const bodies = [];
  const seen = new Set();
  const expandedTaskKeys = new Set(planner.task_key ? [planner.task_key] : []);
  const followedEvidenceKeys = new Set();
  let lastState = null;
  let lastNewCount = 0;

  async function runStep(step) {
    step.exclude_keys = [...followedEvidenceKeys];
    planner.searches.push(step);
    const seenBefore = seen.size;
    const search = await compileSearchContext(ctx, {
      req: req || { socket: { remoteAddress: 'subconscious' } },
      u: searchUrlForPlan(planner, step),
    });
    step.status = search.status;
    if (search.status !== 200) return { ok: false, status: search.status, body: search.body, bodies };
    for (const result of search.body.results || []) {
      if (!result) continue;
      result.search_mode = step.mode || null;
      if (step.followup_from) result.followup_from = step.followup_from;
    }
    bodies.push(search.body);
    for (const result of search.body.results || []) if (result && result.key) seen.add(result.key);
    lastNewCount = Math.max(0, seen.size - seenBefore);
    lastState = summarizeAgenticSearchState(bodies, planner, events);
    step.result_count = Array.isArray(search.body.results) ? search.body.results.length : 0;
    step.new_result_count = lastNewCount;
    step.decision = search.body.decision || null;
    step.continue_signal = !!search.body.continue;
    step.evidence_quality = lastState.evidence_quality;
    step.confidence = lastState.confidence;
    step.selected_count = lastState.selected_count;
    return { ok: true, state: lastState };
  }

  function shouldContinue() {
    const stepCount = planner.searches.length;
    const stop = agenticStopReason(lastState, planner, stepCount);
    if (stop) {
      planner.stop_reason = stop;
      return false;
    }
    const next = chooseAgenticFollowup(planner, lastState, expandedTaskKeys, followedEvidenceKeys, stepCount + 1);
    if (!next) {
      planner.stop_reason = lastNewCount === 0 && stepCount > 1
        ? 'results_saturated'
        : (lastState && lastState.evidence_quality >= SEARCH_CONTEXT_MIN_PROMISING_QUALITY
        ? 'results_saturated'
        : 'insufficient_evidence_quality');
      return false;
    }
    planner.next_step = next;
    return true;
  }

  if (planner.task_key) {
    const dag = await runStep({
      round: 1,
      strategy: 'task_gated_dag',
      mode: 'dag_task_gated',
      gated: true,
      task_key: planner.task_key,
      query: planner.query,
    });
    if (!dag.ok) return dag;
    const stopAfterDag = agenticStopReason(lastState, planner, planner.searches.length);
    if (stopAfterDag === 'confidence_high' || stopAfterDag === 'budget_exhausted') {
      planner.stop_reason = stopAfterDag;
      return { ok: true, status: 200, bodies };
    }

    const initialBroad = {
      round: planner.searches.length + 1,
      strategy: 'broad_rag_context',
      mode: 'rag_broad',
      gated: false,
      task_key: null,
      query: planner.query,
    };
    const rag = await runStep({
      ...initialBroad,
    });
    if (!rag.ok) return rag;
  } else {
    const broad = await runStep({
      round: 1,
      strategy: 'broad_rag_context',
      mode: 'rag_broad',
      gated: false,
      task_key: null,
      query: planner.query,
    });
    if (!broad.ok) return broad;
  }

  while (shouldContinue()) {
    const next = planner.next_step;
    planner.next_step = null;
    const followup = await runStep(next);
    if (!followup.ok) return followup;
  }

  if (!planner.stop_reason) planner.stop_reason = 'completed';
  if (lastState) {
    planner.evidence_quality = lastState.evidence_quality;
    planner.confidence = lastState.confidence;
    planner.selected_count = lastState.selected_count;
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
      if (
        (result.inject && !existing.inject) ||
        (result.followup_from && !existing.followup_from) ||
        resultScore > existingScore
      ) Object.assign(existing, result);
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
  const searchQueries = (planner.searches || [])
    .map((step) => step && step.query)
    .filter(Boolean)
    .join(' ');
  const queryTokens = tokenize([
    planner.query,
    searchQueries,
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
      (result.followup_from ? 0.08 : 0) +
      (lexical * 0.35)
    );
    compact.rank_score = Number(rank.toFixed(3));
    compact.lexical_score = Number(lexical.toFixed(3));
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
        mode: step.mode || null,
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

function filterAgenticContextResults(searchBody, events, planner = {}) {
  const ranked = rankResults(searchBody.results || [], planner, events);
  const selected = [];
  const rejected = [];
  for (const result of ranked) {
    const quality = evidenceQualityForResult(result);
    const valuable = result.tier === 'system'
      || quality >= SEARCH_CONTEXT_MIN_SELECT_QUALITY
      || (result.inject === true && quality >= SEARCH_CONTEXT_MIN_PROMISING_QUALITY);
    const item = {
      ...result,
      evidence_quality: Number(quality.toFixed(3)),
      relevance_verdict: valuable ? 'valuable_for_task' : 'low_value_for_task',
      relevance_reason: valuable
        ? (result.inject && !isAgenticTaskContextTier(result) ? 'cleared context injection gate' : 'met Subconscious evidence-quality threshold')
        : 'below Subconscious relevance threshold for this task query',
    };
    if (valuable) selected.push(item);
    else rejected.push(item);
  }
  return { selected, rejected };
}

function contextDependencyFromResult(result) {
  return {
    task_key: result.key,
    key: result.key,
    title: result.title || result.key,
    summary: String(result.summary || '').slice(0, 240),
    kind: result.kind || 'task',
    tier: result.tier || null,
    via: result.via || null,
    search_mode: result.search_mode || null,
    followup_from: result.followup_from || null,
    relevance_score: result.rank_score == null ? null : result.rank_score,
    evidence_quality: result.evidence_quality == null ? null : result.evidence_quality,
    relevance_verdict: result.relevance_verdict || 'valuable_for_task',
    reason: result.relevance_reason || null,
  };
}

function composeSearchContextEnvelope(searchBody, events, planner = {}, limit = DEFAULT_SEARCH_CONTEXT_LIMIT) {
  const filtered = filterAgenticContextResults(searchBody, events, planner);
  const max = Math.max(1, Math.min(Number(limit) || DEFAULT_SEARCH_CONTEXT_LIMIT, 20));
  const confidence = confidenceFromAgenticSelection(filtered);
  const selectedEvidenceQuality = filtered.selected.map(evidenceQualityForResult).reduce((m, v) => Math.max(m, v), 0);
  const hasSufficientContext = filtered.selected.length > 0 && confidence >= SEARCH_CONTEXT_MIN_FINAL_CONFIDENCE;
  const selected = hasSufficientContext ? filtered.selected.slice(0, max) : [];
  const verdict = selected.length ? 'relevant_context' : 'abstain_no_context';
  const envelope = {
    version: 1,
    kind: 'subconscious_agentic_search_context',
    query: planner.query || searchBody.query || '',
    verdict,
    prediction: selected.length ? 'selected_context_likely_relevant' : 'no_context_cleared_relevance_judgment',
    confidence: Number(confidence.toFixed(3)),
    search_steps: (planner.searches || []).map((step) => ({
      round: step.round,
      strategy: step.strategy,
      mode: step.mode || null,
      gated: !!step.gated,
      task_key: step.task_key || null,
      query: step.query,
      followup_from: step.followup_from || null,
      exclude_keys: step.exclude_keys || [],
      status: step.status || null,
      result_count: step.result_count == null ? null : step.result_count,
      new_result_count: step.new_result_count == null ? null : step.new_result_count,
      evidence_quality: step.evidence_quality == null ? null : step.evidence_quality,
      confidence: step.confidence == null ? null : step.confidence,
      selected_count: step.selected_count == null ? null : step.selected_count,
      continue_signal: step.continue_signal == null ? null : !!step.continue_signal,
    })),
    context_task_keys: selected.map((result) => result.key).filter(Boolean),
    context_deps: selected.map(contextDependencyFromResult),
    context: selected,
    filtered_count: filtered.rejected.length + (hasSufficientContext ? 0 : filtered.selected.length),
    decisions: {
      search_decisions: searchBody.decisions || (searchBody.decision ? [searchBody.decision] : []),
      gate_decision: searchBody.decision || null,
      gate_reason: searchBody.reason || null,
      stop_reason: planner.stop_reason || null,
      evidence_quality: Number(selectedEvidenceQuality.toFixed(3)),
      min_final_confidence: SEARCH_CONTEXT_MIN_FINAL_CONFIDENCE,
      continue: false,
      rounds: searchBody.rounds || 1,
    },
  };
  if (planner.task_key) envelope.task_key = planner.task_key;
  return envelope;
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

function isTruthyInput(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'yes';
}

function shouldIncludeInternal(input) {
  return isTruthyInput(input && (input.include_internal || input.debug || input.internal));
}

function isTaskKey(key) {
  return !!key && !String(key).startsWith('note:') && !String(key).startsWith('system:');
}

const NON_TASK_ANCHOR_KINDS = new Set([
  'note',
  'system',
  'knowledge',
  'source_doc',
  'source_section',
  'source_chunk',
  'knowledge_cluster',
  'entity',
  'gate',
]);

function taskKeyOf(task) {
  return cleanString(task && (task.id || task.key || task.task_key));
}

function selectableStatus(status) {
  return !['done', 'canceled', 'failed'].includes(cleanString(status).toLowerCase());
}

function isSelectableGraphTaskAnchor(task, key) {
  const kind = cleanString(task && task.kind).toLowerCase();
  return isTaskKey(key) && !NON_TASK_ANCHOR_KINDS.has(kind) && selectableStatus(task && task.status);
}

function statusRank(status) {
  const normalized = cleanString(status).toLowerCase();
  if (normalized === 'ready') return 0;
  if (normalized === 'in_progress') return 1;
  if (normalized === 'tested') return 2;
  if (normalized === 'not_ready') return 3;
  return 4;
}

function graphTasks(ctx) {
  if (!ctx || typeof ctx.buildGraph !== 'function') return [];
  try {
    const graph = ctx.buildGraph();
    return graph && Array.isArray(graph.tasks) ? graph.tasks : [];
  } catch (err) {
    return [];
  }
}

function recommendTaskAnchor(ctx, planner, bundle) {
  if (planner.task_key) return null;

  const graphCandidates = new Map();
  for (const task of graphTasks(ctx)) {
    const key = taskKeyOf(task);
    if (isSelectableGraphTaskAnchor(task, key) && !graphCandidates.has(key)) graphCandidates.set(key, task);
  }

  const evidenceResults = (bundle.evidence && bundle.evidence.results) || [];
  const evidenceRank = new Map();
  evidenceResults.forEach((result, index) => {
    if (graphCandidates.has(result.key) && !evidenceRank.has(result.key)) evidenceRank.set(result.key, index);
    if (Array.isArray(result.path)) {
      for (const key of result.path) {
        if (graphCandidates.has(key) && !evidenceRank.has(key)) evidenceRank.set(key, index);
      }
    }
  });

  const queryTokens = tokenize(planner.query);
  const candidates = [];
  for (const [key, task] of graphCandidates) {
    const taskTokens = tokenize(`${task.label || ''} ${task.summary || ''} ${task.status || ''}`);
    const shared = sharedTokens(queryTokens, taskTokens);
    const lexical = queryTokens.size && taskTokens.size
      ? shared.length / Math.sqrt(queryTokens.size * taskTokens.size)
      : 0;
    const evidenceIndex = evidenceRank.has(key) ? evidenceRank.get(key) : null;
    const evidenceBoost = evidenceIndex == null ? 0 : Math.max(0.1, 0.6 - (evidenceIndex * 0.08));
    const rank = evidenceBoost + lexical + (1 / (10 + statusRank(task.status)));
    candidates.push({
      task_key: key,
      status: task.status || null,
      label: task.label || key,
      summary: String(task.summary || '').slice(0, 160),
      source: evidenceIndex == null ? 'graph_task' : 'search_evidence',
      reason: evidenceIndex == null
        ? 'available graph task best matches the request'
        : 'search evidence points at this available graph task',
      confidence: Number(Math.min(1, rank).toFixed(3)),
      rank,
    });
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => (b.rank - a.rank) || (statusRank(a.status) - statusRank(b.status)) || a.task_key.localeCompare(b.task_key));
  const { rank, ...top } = candidates[0];
  return top;
}

function identityBinding(input, agentId, sessionCompanion) {
  const requestedSessionId = optionalString(input, 'session_id');
  const requestedForegroundAgentId = optionalString(input, 'foreground_agent_id');
  const requestedCompanionAgentId = optionalString(input, 'companion_agent_id');
  const requestedCompanionLoopId = optionalString(input, 'companion_loop_id');
  const sessionId = (sessionCompanion && sessionCompanion.session_id) || requestedSessionId || null;
  const foregroundAgentId = (sessionCompanion && sessionCompanion.foreground_agent_id) || requestedForegroundAgentId || null;
  const companionAgentId = (sessionCompanion && sessionCompanion.companion_agent_id) || requestedCompanionAgentId || null;
  const companionLoopId = (sessionCompanion && sessionCompanion.companion_loop_id) || requestedCompanionLoopId || null;
  const sources = {
    agent_id: 'request',
    session_id: sessionCompanion && sessionCompanion.session_id ? 'session_companion' : (requestedSessionId ? 'request' : null),
    foreground_agent_id: sessionCompanion && sessionCompanion.foreground_agent_id ? 'session_companion' : (requestedForegroundAgentId ? 'request' : null),
    companion_agent_id: sessionCompanion && sessionCompanion.companion_agent_id ? 'session_companion' : (requestedCompanionAgentId ? 'request' : null),
    companion_loop_id: sessionCompanion && sessionCompanion.companion_loop_id ? 'session_companion' : (requestedCompanionLoopId ? 'request' : null),
  };
  return {
    agent_id: agentId,
    session_id: sessionId,
    foreground_agent_id: foregroundAgentId,
    companion_agent_id: companionAgentId,
    companion_loop_id: companionLoopId,
    sources,
    missing_reasons: {
      session_id: sessionId ? null : 'session_id was not provided',
      foreground_agent_id: foregroundAgentId ? null : 'foreground_agent_id was not provided and no session companion is bound',
      companion_agent_id: companionAgentId ? null : 'companion_agent_id was not provided and no session companion is bound',
      companion_loop_id: companionLoopId ? null : 'companion_loop_id was not provided and no session companion is bound',
    },
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

function composePressureProtocol(input, planner, bundle, events, identity, anchorAllocation, anchorRecommendation) {
  const evidenceResults = (bundle.evidence && bundle.evidence.results) || [];
  const evidenceSummary = summarizeEvidence(evidenceResults);
  const risk = riskEvent(events);
  const explicitTaskKey = planner.task_key || null;
  const recentTaskKey = lastTaskKey(events);
  const selectedTaskKey = (anchorAllocation && anchorAllocation.task_key) || explicitTaskKey || recentTaskKey || null;
  const selectedSource = anchorAllocation
    ? 'stored_anchor'
    : (explicitTaskKey ? 'request_task_key' : (recentTaskKey ? 'recent_agent_event' : null));
  const recommendedTaskKey = selectedTaskKey ? null : ((anchorRecommendation && anchorRecommendation.task_key) || null);
  const approvalPosture = classifyAskApprovalPosture(input, bundle.verdict);
  let nextAction = approvalPosture.escalation_required ? 'escalate_for_approval' : bundle.recommended_next_action;
  if (!nextAction) nextAction = selectedTaskKey ? 'work_selected_anchor' : (recommendedTaskKey ? 'confirm_recommended_anchor' : 'select_foreground_anchor');
  if (!approvalPosture.escalation_required && bundle.verdict === 'recent_agent_risk') nextAction = 'resolve_recent_risk_then_continue';
  if (!approvalPosture.escalation_required && selectedTaskKey && bundle.recommended_next_action === 'review_injected_context') {
    nextAction = 'review_context_then_work_selected_anchor';
  } else if (!approvalPosture.escalation_required && selectedTaskKey && bundle.recommended_next_action && nextAction === bundle.recommended_next_action) {
    nextAction = `${bundle.recommended_next_action}_on_selected_anchor`;
  } else if (!approvalPosture.escalation_required && recommendedTaskKey && bundle.recommended_next_action === 'review_injected_context') {
    nextAction = 'review_context_then_confirm_recommended_anchor';
  } else if (!approvalPosture.escalation_required && recommendedTaskKey && bundle.recommended_next_action && nextAction === bundle.recommended_next_action) {
    nextAction = `${bundle.recommended_next_action}_before_confirming_recommended_anchor`;
  }

  let status = 'ready';
  if (approvalPosture.escalation_required) status = 'approval_required';
  else if (bundle.verdict === 'recent_agent_risk') status = 'risk_review';
  else if (selectedTaskKey) status = 'anchored';
  else if (recommendedTaskKey) status = 'anchor_recommended';
  else if (bundle.verdict === 'insufficient_context') status = 'needs_context';

  let directive = 'No foreground anchor is selected. Select an existing task anchor before editing; if none is available, ask for one instead of fabricating or claiming blindly. Subconscious is returning pressure only and will not execute implementation.';
  if (approvalPosture.escalation_required) {
    directive = 'Pause foreground execution and escalate for user approval before taking the requested outward, irreversible, high-impact, or scope-expanding action.';
  } else if (nextAction === 'resolve_recent_risk_then_continue') {
    directive = selectedTaskKey
      ? `Resolve or account for the recent risk on ${selectedTaskKey}, then continue foreground-owned execution.`
      : (recommendedTaskKey
        ? `Resolve or account for the recent risk, then confirm recommended task anchor ${recommendedTaskKey} before editing.`
        : 'Resolve or account for the recent risk. No foreground anchor is selected; select an existing task anchor before editing.');
  } else if (selectedTaskKey) {
    directive = `Continue foreground-owned work on ${selectedTaskKey}; review the supplied context first, then implement and verify in the foreground.`;
  } else if (recommendedTaskKey) {
    directive = `No foreground anchor is selected. Recommended existing task anchor: ${recommendedTaskKey}. Confirm or allocate that anchor in the foreground task flow before editing.`;
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
    : (recommendedTaskKey
      ? `Confirm whether ${recommendedTaskKey} is the foreground anchor before making code changes.`
      : 'Select an existing foreground task anchor before making code changes; ask for one if none exists.'));
  plan.push('Run the relevant verification and report progress back through the foreground task flow.');

  const rationale = [];
  if (anchorAllocation && anchorAllocation.reason) rationale.push(`Anchor selected because ${anchorAllocation.reason}.`);
  else if (selectedTaskKey && planner.task_key === selectedTaskKey) rationale.push('The explicit task_key is the best available foreground anchor.');
  else if (selectedTaskKey && recentTaskKey === selectedTaskKey) rationale.push('The latest recent foreground event supplies the current task anchor.');
  else if (recommendedTaskKey && anchorRecommendation) rationale.push(`Recommended ${recommendedTaskKey} because ${anchorRecommendation.reason}.`);
  if (risk) rationale.push(`Recent risk event: ${risk.type}${risk.text ? ` - ${risk.text}` : ''}.`);
  if (bundle.evidence && bundle.evidence.reason) rationale.push(`Context retrieval reason: ${bundle.evidence.reason}.`);
  if (approvalPosture.escalation_required) rationale.push(`Approval posture: ${approvalPosture.reason}.`);
  if (!rationale.length) rationale.push('Subconscious found no selected or recommended anchor in request, recent state, or retrieved context.');

  const contextSummary = {
    text: evidenceSummary.count > 0
      ? `Using ${evidenceSummary.count} evidence item(s): ${evidenceSummary.top_keys.join(', ')}.`
      : 'No graph evidence matched the request.',
    evidence: evidenceSummary,
    recent_event_count: events.length,
    session_id: identity.session_id,
    foreground_agent_id: identity.foreground_agent_id,
    companion_agent_id: identity.companion_agent_id,
    companion_loop_id: identity.companion_loop_id,
    identity_missing_reasons: identity.missing_reasons,
    selected_task_key: selectedTaskKey,
    recommended_task_key: recommendedTaskKey,
    anchored_task_key: anchorAllocation ? anchorAllocation.task_key : null,
    anchor_status: anchorAllocation ? anchorAllocation.status : null,
  };
  const anchor = {
    status: selectedTaskKey ? 'selected' : (recommendedTaskKey ? 'recommended' : 'none'),
    selected_task_key: selectedTaskKey,
    recommended_task_key: recommendedTaskKey,
    source: selectedSource || (recommendedTaskKey ? (anchorRecommendation && anchorRecommendation.source) : null),
    reason: selectedTaskKey
      ? (selectedSource === 'stored_anchor'
        ? 'stored session anchor allocation'
        : (selectedSource === 'request_task_key' ? 'explicit task_key on request' : 'latest recent foreground task event'))
      : (recommendedTaskKey
        ? (anchorRecommendation && anchorRecommendation.reason)
        : 'no request task_key, stored anchor, recent task event, or available graph task matched'),
    allocation: anchorAllocation || null,
    recommendation: anchorRecommendation || null,
  };
  const pressure = {
    version: 1,
    execution_owner: 'foreground_agent',
    selected_task_key: selectedTaskKey,
    recommended_task_key: recommendedTaskKey,
    anchored_task_key: anchorAllocation ? anchorAllocation.task_key : null,
    current_state: {
      status,
      progress,
      verdict: bundle.verdict,
      confidence: bundle.confidence,
      recent_event_count: events.length,
      latest_event: compactEvent(events[events.length - 1]),
      risk_event: compactEvent(risk),
    },
    identity,
    anchor,
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
    current_state: pressure.current_state,
    context: {
      summary: pressure.context_summary,
    },
    anchor: pressure.anchor,
    identity: pressure.identity,
    approval_posture: pressure.approval_posture,
    execution_permit: pressure.execution_permit || null,
  };
}

function composeInternalDebug(bundle, pressure, recent, sessionCompanion, anchorAllocation) {
  return {
    planner: bundle.planner,
    strategy: bundle.strategy,
    recommended_next_action: bundle.recommended_next_action,
    recent_agent_state: bundle.recent_agent_state,
    recent_agent_events: recent,
    evidence: bundle.evidence,
    pressure,
    session_companion: sessionCompanion || null,
    anchor_allocation: anchorAllocation || null,
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
  const executionPermits = new Map();

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

  function normalizePermitScope(input) {
    const scope = cleanString(input && (input.scope || input.allowed_scope)) || 'worktree';
    if (!['worktree', 'repo', 'paths'].includes(scope)) {
      return { ok: false, status: 400, error: 'scope must be "worktree", "repo", or "paths"' };
    }
    return { ok: true, value: scope };
  }

  function normalizePermitAllowedPaths(input, worktree) {
    const source = Object.prototype.hasOwnProperty.call(input || {}, 'allowed_paths')
      ? { allowed_paths: input.allowed_paths }
      : { allowed_paths: input && input.allowedPaths };
    const raw = normalizeStringArray(source, 'allowed_paths');
    if (!raw.ok) return { ok: false, status: 400, error: raw.error };

    const base = normalizePermitPath(worktree);
    const paths = raw.value.length ? raw.value : [base];
    const seen = new Set();
    const value = [];
    for (const item of paths) {
      const resolved = resolvePermitPath(item, base);
      if (!resolved) continue;
      if (!isUnderPermitPath(resolved, base)) {
        return { ok: false, status: 400, error: `allowed_paths must stay inside worktree: ${item}` };
      }
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      value.push(resolved);
    }
    return { ok: true, value: value.length ? value : [base] };
  }

  function permitExpiresAt(input, nowMs) {
    const explicit = cleanString(input && input.expires_at);
    if (explicit) {
      const parsed = parseTimeMs(explicit);
      if (parsed == null) return { ok: false, status: 400, error: 'expires_at must be an ISO timestamp' };
      return { ok: true, value: new Date(parsed).toISOString() };
    }
    const ttlRaw = input && (input.ttl_ms != null ? input.ttl_ms : (input.ttl_seconds != null ? Number(input.ttl_seconds) * 1000 : null));
    const ttl = ttlRaw == null || ttlRaw === '' ? DEFAULT_PERMIT_TTL_MS : Number(ttlRaw);
    if (!Number.isFinite(ttl)) return { ok: false, status: 400, error: 'ttl_ms or ttl_seconds must be numeric' };
    return { ok: true, value: new Date(nowMs + Math.max(0, ttl)).toISOString() };
  }

  function permitMatches(permit, input) {
    if (!permit) return false;
    const permitId = optionalString(input, 'permit_id') || optionalString(input, 'id');
    if (permitId && permit.id !== permitId) return false;
    const workspace = optionalString(input, 'workspace');
    if (workspace && permit.workspace !== workspace) return false;
    const sessionId = optionalString(input, 'session_id');
    if (sessionId && permit.session_id !== sessionId) return false;
    const taskKey = optionalString(input, 'task_key');
    if (taskKey && permit.task_key !== taskKey) return false;
    const agentId = optionalString(input, 'agent_id');
    if (agentId && permit.agent_id && permit.agent_id !== agentId) return false;
    const foregroundAgentId = optionalString(input, 'foreground_agent_id');
    if (foregroundAgentId && permit.foreground_agent_id && permit.foreground_agent_id !== foregroundAgentId) return false;
    return true;
  }

  function sortedPermits(input) {
    return [...executionPermits.values()]
      .filter((permit) => permitMatches(permit, input || {}))
      .sort((a, b) => String(b.issued_at || '').localeCompare(String(a.issued_at || '')));
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

  function issueExecutionPermit(input) {
    const workspace = cleanString(input && input.workspace);
    if (!workspace) return { ok: false, status: 400, error: 'workspace required' };
    const session = requireString(input, 'session_id');
    if (!session.ok) return { ok: false, status: 400, error: session.error };
    const task = requireString(input, 'task_key');
    if (!task.ok) return { ok: false, status: 400, error: task.error };
    const worktree = requireString(input, 'worktree');
    if (!worktree.ok) return { ok: false, status: 400, error: worktree.error };
    const branch = requireString(input, 'branch');
    if (!branch.ok) return { ok: false, status: 400, error: branch.error };
    const scope = normalizePermitScope(input);
    if (!scope.ok) return scope;

    const normalizedWorktree = normalizePermitPath(worktree.value);
    const allowedPaths = normalizePermitAllowedPaths(input || {}, normalizedWorktree);
    if (!allowedPaths.ok) return allowedPaths;

    const nowMs = input && input.now ? parseTimeMs(input.now) : Date.now();
    const issuedAt = new Date(nowMs == null ? Date.now() : nowMs).toISOString();
    const expiresAt = permitExpiresAt(input || {}, nowMs == null ? Date.now() : nowMs);
    if (!expiresAt.ok) return expiresAt;

    const permit = {
      id: `subpermit-${nextExecutionPermitId++}`,
      version: 1,
      workspace,
      session_id: session.value,
      agent_id: optionalString(input, 'agent_id'),
      foreground_agent_id: optionalString(input, 'foreground_agent_id'),
      task_key: task.value,
      worktree: normalizedWorktree,
      branch: branch.value,
      scope: scope.value,
      allowed_paths: allowedPaths.value,
      status: 'active',
      issued_at: issuedAt,
      expires_at: expiresAt.value,
      revoked_at: null,
      revocation_reason: null,
      reason: optionalString(input, 'reason'),
      payload: input && input.payload === undefined ? null : input.payload,
    };
    executionPermits.set(permit.id, permit);
    const executionPermit = compactExecutionPermit(permit, nowMs == null ? Date.now() : nowMs);
    return {
      ok: true,
      status: 200,
      action: 'issue',
      execution_permit: executionPermit,
      permit: executionPermit,
      valid: executionPermit.status === 'active',
    };
  }

  function readExecutionPermit(input = {}) {
    const nowMs = input.now ? parseTimeMs(input.now) : Date.now();
    const permits = sortedPermits(input);
    const compact = permits.map((permit) => compactExecutionPermit(permit, nowMs == null ? Date.now() : nowMs));
    const permit = compact[0] || null;
    return {
      ok: true,
      status: 200,
      action: 'read',
      valid: !!(permit && permit.status === 'active'),
      reason: permit
        ? (permit.status === 'active' ? 'active execution permit found' : `execution permit is ${permit.status}`)
        : 'no execution permit found for session/task',
      execution_permit: permit,
      permit,
      recent_execution_permits: compact,
    };
  }

  function revokeExecutionPermit(input = {}) {
    const permits = sortedPermits(input);
    const permit = permits[0] || null;
    if (!permit) return { ok: false, status: 404, error: 'execution permit not found' };
    const nowMs = input.now ? parseTimeMs(input.now) : Date.now();
    const revokedAt = new Date(nowMs == null ? Date.now() : nowMs).toISOString();
    permit.status = 'revoked';
    permit.revoked_at = revokedAt;
    permit.revocation_reason = optionalString(input, 'reason') || 'revoked by Subconscious permit API';
    const executionPermit = compactExecutionPermit(permit, nowMs == null ? Date.now() : nowMs);
    return {
      ok: true,
      status: 200,
      action: 'revoke',
      valid: false,
      execution_permit: executionPermit,
      permit: executionPermit,
    };
  }

  function executionPermit(input = {}) {
    const action = cleanString(input.action) || 'issue';
    if (action === 'issue') return issueExecutionPermit(input);
    if (action === 'read') return readExecutionPermit(input);
    if (action === 'revoke') return revokeExecutionPermit(input);
    return { ok: false, status: 400, error: 'action must be "issue", "read", or "revoke"' };
  }

  function executionPermitRequirement({ workspace, session_id: sessionId, agent_id: agentId, foreground_agent_id: foregroundAgentId, task_key: taskKey }) {
    const missing = [];
    if (!sessionId) missing.push('session_id');
    if (!taskKey) missing.push('task_key');
    const read = sessionId && taskKey
      ? readExecutionPermit({ workspace, session_id: sessionId, agent_id: agentId, foreground_agent_id: foregroundAgentId, task_key: taskKey })
      : { valid: false, execution_permit: null, reason: `missing ${missing.join(', ')}` };
    return {
      version: 1,
      required: true,
      status: read.valid ? 'satisfied' : 'required_before_write',
      can_issue: !!(workspace && sessionId && taskKey),
      session_id: sessionId || null,
      agent_id: agentId || null,
      foreground_agent_id: foregroundAgentId || null,
      task_key: taskKey || null,
      permit_id: read.execution_permit ? read.execution_permit.id : null,
      permit_status: read.execution_permit ? read.execution_permit.status : null,
      reason: read.reason,
      missing,
      permit: read.execution_permit || null,
    };
  }

  async function searchContext(ctx, input, req) {
    const workspace = cleanString(input.workspace);
    if (!workspace) return { ok: false, status: 400, error: 'workspace required' };
    const agent = requireString(input, 'agent_id');
    if (!agent.ok) return { ok: false, status: 400, error: agent.error };

    const intent = optionalString(input, 'intent');
    const situation = optionalString(input, 'situation') || optionalString(input, 'query');
    const recent = recentEvents(workspace, agent.value, maxEvents);
    const planner = buildPlanner(input, workspace, agent.value, recent, {
      maxRounds: input.max_rounds,
      defaultMaxRounds: DEFAULT_SEARCH_CONTEXT_MAX_ROUNDS,
      maxRoundsCap: MAX_SEARCH_CONTEXT_ROUNDS,
    });
    const query = planner.query || [intent, situation].filter(Boolean).join('\n');
    if (!query) return { ok: false, status: 400, error: 'intent, situation, or query required' };

    const searches = await runAgenticContextSearches(ctx, planner, req, recent);
    if (!searches.ok) return { ok: false, status: searches.status, ...searches.body };

    const searchBody = mergeSearchBodies(searches.bodies);
    const envelope = composeSearchContextEnvelope(searchBody, recent, planner, input.k || DEFAULT_SEARCH_CONTEXT_LIMIT);
    const out = {
      ok: true,
      status: 200,
      workspace,
      agent_id: agent.value,
      task_key: planner.task_key,
      query,
      verdict: envelope.verdict,
      prediction: envelope.prediction,
      confidence: envelope.confidence,
      context_task_keys: envelope.context_task_keys,
      context_deps: envelope.context_deps,
      subconscious_context: envelope,
    };
    if (shouldIncludeInternal(input)) {
      out.internal = {
        planner: envelope.search_steps,
        recent_agent_state: summarizeRecentState(recent),
        decisions: envelope.decisions,
        filtered_count: envelope.filtered_count,
      };
    }
    return out;
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
    const identity = identityBinding(input, agent.value, sessionCompanion);
    const anchorRecommendation = recommendTaskAnchor(ctx, planner, bundle);
    const pressure = composePressureProtocol(input, planner, bundle, recent, identity, anchorAllocation, anchorRecommendation);
    pressure.execution_permit = executionPermitRequirement({
      workspace,
      session_id: identity.session_id,
      agent_id: identity.agent_id,
      foreground_agent_id: identity.foreground_agent_id,
      task_key: pressure.selected_task_key,
    });
    const subconscious = composeAgentSurface(bundle, pressure);
    const out = {
      ok: true,
      status: 200,
      workspace,
      agent_id: agent.value,
      task_key: planner.task_key,
      intent,
      query,
      verdict: bundle.verdict,
      prediction: bundle.prediction,
      predicted_consequence: bundle.predicted_consequence,
      confidence: bundle.confidence,
      execution_owner: pressure.execution_owner,
      selected_task_key: pressure.selected_task_key,
      recommended_task_key: pressure.recommended_task_key,
      current_state: pressure.current_state,
      next_action: pressure.next_action,
      directive: pressure.directive,
      plan: pressure.plan,
      context_summary: pressure.context_summary,
      anchor: pressure.anchor,
      identity: pressure.identity,
      rationale: pressure.rationale,
      approval_posture: pressure.approval_posture,
      execution_permit: pressure.execution_permit,
      subconscious,
    };
    if (shouldIncludeInternal(input)) {
      out.internal = composeInternalDebug(bundle, pressure, recent, sessionCompanion, anchorAllocation);
    }
    return out;
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
    issueExecutionPermit,
    readExecutionPermit,
    revokeExecutionPermit,
    executionPermit,
    searchContext,
    ask,
    skill,
  };
}

module.exports = {
  DEFAULT_MAX_EVENTS,
  DEFAULT_MAX_LOOP_OBSERVATIONS,
  DEFAULT_MAX_SESSION_COMPANION_OBSERVATIONS,
  DEFAULT_MAX_ANCHOR_OBSERVATIONS,
  DEFAULT_MAX_ANCHOR_DECISIONS,
  DEFAULT_MAX_IDEAS,
  DEFAULT_PERMIT_TTL_MS,
  createSubconsciousStore,
  defaultSubconsciousStore: createSubconsciousStore(),
  buildPlanner,
  composeAskBundle,
  composeAgentSurface,
  composeSearchContextEnvelope,
  classifyIdeaPolicy,
  compactExecutionPermit,
};
