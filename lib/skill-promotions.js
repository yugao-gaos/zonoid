'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  skillIdentity,
  pathsFor,
  readVersionRecords,
  setActiveSkillVersion,
  getActiveSkillVersion,
} = require('./skill-versions');
const { readSkillEvaluationRecords } = require('./skill-evaluations');

const PROMOTION_SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROPOSAL_POLICY = {
  max_active_per_capability: 3,
  min_evidence_count: 2,
  stale_after_ms: 14 * DAY_MS,
};

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function hash(value, length = 24) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function nowIso(input) {
  return cleanString(input) || new Date().toISOString();
}

function parseTime(value) {
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function finiteNumber(value, label, fallback = null) {
  if (value == null || value === '') {
    if (fallback != null) return fallback;
    throw new Error(`${label} is required`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`);
  return number;
}

function nonNegativeInteger(value, label, fallback) {
  const number = finiteNumber(value, label, fallback);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer`);
  return number;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanString).filter(Boolean))].sort();
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
}

function readJsonl(file, idKey) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && (!idKey || typeof row[idKey] === 'string')) rows.push(row);
    } catch { /* ignore corrupt rows */ }
  }
  return rows;
}

function appendUniqueJsonl(file, record, idKey) {
  const existing = readJsonl(file, idKey).find((row) => row[idKey] === record[idKey]);
  if (existing) return { created: false, record: existing };
  appendJsonl(file, record);
  return { created: true, record };
}

function promotionPath(workspace) {
  return path.join(pathsFor(workspace).dir, 'skill-promotions.jsonl');
}

function proposalPath(workspace) {
  return path.join(pathsFor(workspace).dir, 'skill-proposals.jsonl');
}

function readPromotionRecords(workspace) {
  return readJsonl(promotionPath(workspace), 'decision_id');
}

function readSkillProposalRecords(workspace) {
  return readJsonl(proposalPath(workspace), 'proposal_record_id');
}

function versionById(workspace, versionId) {
  const id = cleanString(versionId);
  if (!id) return null;
  return readVersionRecords(workspace).find((record) => record.version_id === id) || null;
}

function resolveEvaluation(workspace, input = {}) {
  const supplied = input.evaluation;
  const evaluationId = cleanString(input.evaluation_id || input.evaluationId);
  const candidateVersionId = cleanString(input.candidate_version_id || input.version_id || (input.candidate && input.candidate.version_id));
  const activeVersionId = cleanString(input.active_version_id || input.baseline_version_id || (input.active && input.active.version_id));

  let evaluation = null;
  if (supplied && typeof supplied === 'object' && !Array.isArray(supplied)) {
    evaluation = supplied;
  } else {
    const records = readSkillEvaluationRecords(workspace);
    if (evaluationId) {
      evaluation = records.find((record) => record.evaluation_id === evaluationId) || null;
      if (!evaluation) throw new Error(`unknown skill evaluation: ${evaluationId}`);
    } else {
      if (!candidateVersionId) throw new Error('evaluation_id or candidate_version_id is required');
      const matches = records.filter((record) => (
        record.candidate_version_id === candidateVersionId
        && (!activeVersionId || record.active_version_id === activeVersionId)
      ));
      if (!matches.length) throw new Error(`no evaluation found for candidate version: ${candidateVersionId}`);
      evaluation = matches[matches.length - 1];
    }
  }

  if (!evaluation.evaluation_id) throw new Error('evaluation record requires evaluation_id');
  if (candidateVersionId && evaluation.candidate_version_id !== candidateVersionId) {
    throw new Error('candidate_version_id does not match evaluation');
  }
  if (activeVersionId && evaluation.active_version_id !== activeVersionId) {
    throw new Error('active_version_id does not match evaluation');
  }
  return evaluation;
}

function promotionGateForEvaluation(evaluation = {}) {
  const comparison = evaluation.comparison && typeof evaluation.comparison === 'object' ? evaluation.comparison : {};
  const guardrailRegressions = Array.isArray(comparison.guardrail_regressions) ? comparison.guardrail_regressions : [];
  const missingGuardrails = Array.isArray(comparison.missing_guardrails) ? comparison.missing_guardrails : [];
  const candidateWon = comparison.candidate_outcome === 'win' && comparison.verdict === 'candidate_won';
  const noRegression = comparison.no_regression === true && guardrailRegressions.length === 0 && missingGuardrails.length === 0;

  if (!candidateWon) {
    return {
      eligible: false,
      reason: comparison.reason || 'candidate_did_not_beat_baseline',
      candidate_won: false,
      no_regression: noRegression,
    };
  }
  if (!noRegression) {
    return {
      eligible: false,
      reason: missingGuardrails.length ? 'guardrail_measurement_missing' : 'guardrail_regression',
      candidate_won: true,
      no_regression: false,
    };
  }
  return {
    eligible: true,
    reason: 'candidate_beat_baseline_with_no_guardrail_regression',
    candidate_won: true,
    no_regression: true,
  };
}

function promotionDecisionIdFor(input = {}) {
  return `skp_${hash(stableJson({
    type: input.decision_type,
    action: input.action,
    skill_id: input.skill_id,
    evaluation_id: input.evaluation_id,
    active_version_id: input.active_version_id,
    candidate_version_id: input.candidate_version_id,
    promotion_id: input.promotion_id,
    recorded_at: input.recorded_at,
  }))}`;
}

function normalizeDecisionProvenance(input = {}, now) {
  const source = input.provenance && typeof input.provenance === 'object' ? input.provenance : {};
  return {
    recorded_at: now,
    recorded_by: cleanString(source.recorded_by || input.recorded_by || input.agent_id || input.promoted_by || input.rolled_back_by) || null,
    task_key: cleanString(source.task_key || input.task_key) || null,
    source: cleanString(source.source || input.source) || null,
    run_id: cleanString(source.run_id || input.run_id) || null,
    notes: cleanString(source.notes || input.notes) || null,
  };
}

function buildPromotionDecision(input) {
  const record = {
    schema_version: PROMOTION_SCHEMA_VERSION,
    decision_type: input.decision_type,
    action: input.action,
    skill_id: input.skill_id,
    slug: input.slug || null,
    active_version_id: input.active_version_id || null,
    candidate_version_id: input.candidate_version_id || null,
    prior_active_version_id: input.prior_active_version_id || null,
    promoted_version_id: input.promoted_version_id || null,
    restored_version_id: input.restored_version_id || null,
    evaluation_id: input.evaluation_id || null,
    promotion_id: input.promotion_id || null,
    rolled_back_promotion_id: input.rolled_back_promotion_id || null,
    reason: input.reason || null,
    gate: input.gate || null,
    comparison: input.comparison || null,
    provenance: input.provenance,
    recorded_at: input.recorded_at,
  };
  record.decision_id = promotionDecisionIdFor(record);
  return record;
}

function recordPromotionDecision(workspace, decision) {
  return appendUniqueJsonl(promotionPath(workspace), decision, 'decision_id').record;
}

function rejectPromotion(workspace, input) {
  const decision = buildPromotionDecision({
    ...input,
    decision_type: 'promotion',
    action: 'rejected',
  });
  return {
    ok: true,
    promoted: false,
    reason: decision.reason,
    decision: recordPromotionDecision(workspace, decision),
  };
}

function promoteSkillVersion(workspace, input = {}) {
  const recordedAt = nowIso(input.now);
  const evaluation = resolveEvaluation(workspace, input);
  const active = versionById(workspace, evaluation.active_version_id);
  const candidate = versionById(workspace, evaluation.candidate_version_id);
  if (!active) throw new Error(`unknown evaluated active version: ${evaluation.active_version_id}`);
  if (!candidate) throw new Error(`unknown evaluated candidate version: ${evaluation.candidate_version_id}`);
  if (active.version_id === candidate.version_id) throw new Error('candidate_version_id must differ from active_version_id');
  if (active.skill_id !== candidate.skill_id || active.skill_id !== evaluation.skill_id) {
    throw new Error('evaluation versions must belong to the same skill');
  }

  const currentActive = getActiveSkillVersion(workspace, { skill_id: evaluation.skill_id });
  const baseDecision = {
    skill_id: evaluation.skill_id,
    slug: evaluation.slug || candidate.slug || active.slug || evaluation.skill_id.slice('skill:'.length),
    active_version_id: active.version_id,
    candidate_version_id: candidate.version_id,
    evaluation_id: evaluation.evaluation_id,
    comparison: evaluation.comparison || null,
    recorded_at: recordedAt,
    provenance: normalizeDecisionProvenance(input, recordedAt),
  };

  if (!currentActive) {
    return rejectPromotion(workspace, {
      ...baseDecision,
      reason: 'active_version_missing',
      gate: { eligible: false, reason: 'active_version_missing' },
    });
  }
  if (currentActive.version_id !== active.version_id) {
    return rejectPromotion(workspace, {
      ...baseDecision,
      reason: 'active_version_changed_since_evaluation',
      gate: { eligible: false, reason: 'active_version_changed_since_evaluation', current_active_version_id: currentActive.version_id },
    });
  }

  const gate = promotionGateForEvaluation(evaluation);
  if (!gate.eligible) {
    return rejectPromotion(workspace, {
      ...baseDecision,
      reason: gate.reason,
      gate,
    });
  }

  const activated = setActiveSkillVersion(workspace, {
    skill_id: evaluation.skill_id,
    version_id: candidate.version_id,
    activated_by: cleanString(input.promoted_by || input.agent_id || input.recorded_by) || null,
    task_key: cleanString(input.task_key) || null,
    reason: `promotion:${evaluation.evaluation_id}`,
    now: recordedAt,
  });
  const decision = buildPromotionDecision({
    ...baseDecision,
    decision_type: 'promotion',
    action: 'promoted',
    prior_active_version_id: active.version_id,
    promoted_version_id: candidate.version_id,
    reason: gate.reason,
    gate,
  });

  return {
    ok: true,
    promoted: true,
    active_version: activated.active_version,
    manifest: activated.manifest,
    decision: recordPromotionDecision(workspace, decision),
  };
}

function latestPromotionsById(workspace) {
  const records = readPromotionRecords(workspace);
  const rolledBack = new Set(records
    .filter((record) => record.action === 'rolled_back' && record.rolled_back_promotion_id)
    .map((record) => record.rolled_back_promotion_id));
  return records.filter((record) => record.action === 'promoted' && !rolledBack.has(record.decision_id));
}

function resolvePromotionForRollback(workspace, input = {}) {
  const promotionId = cleanString(input.promotion_id || input.decision_id);
  const promotions = latestPromotionsById(workspace);
  if (promotionId) {
    const promotion = promotions.find((record) => record.decision_id === promotionId) || null;
    if (!promotion) throw new Error(`unknown active promotion decision: ${promotionId}`);
    return promotion;
  }

  const identity = input.skill_id || input.identity || input.key || input.skill_path || input.target_path || input.path || input.name || input.skill_name || input.title
    ? skillIdentity(input)
    : null;
  const filtered = identity ? promotions.filter((record) => record.skill_id === identity.skill_id) : promotions;
  if (!filtered.length) throw new Error('no promotion available to roll back');
  return filtered[filtered.length - 1];
}

function rollbackSkillPromotion(workspace, input = {}) {
  const recordedAt = nowIso(input.now);
  const promotion = resolvePromotionForRollback(workspace, input);
  if (!promotion.prior_active_version_id || !promotion.promoted_version_id) {
    throw new Error('promotion decision does not include rollback version ids');
  }
  const prior = versionById(workspace, promotion.prior_active_version_id);
  if (!prior) throw new Error(`unknown rollback version: ${promotion.prior_active_version_id}`);

  const currentActive = getActiveSkillVersion(workspace, { skill_id: promotion.skill_id });
  const force = input.force === true;
  const baseDecision = {
    decision_type: 'rollback',
    skill_id: promotion.skill_id,
    slug: promotion.slug || promotion.skill_id.slice('skill:'.length),
    active_version_id: currentActive ? currentActive.version_id : null,
    prior_active_version_id: promotion.prior_active_version_id,
    promoted_version_id: promotion.promoted_version_id,
    restored_version_id: promotion.prior_active_version_id,
    promotion_id: promotion.decision_id,
    rolled_back_promotion_id: promotion.decision_id,
    recorded_at: recordedAt,
    provenance: normalizeDecisionProvenance(input, recordedAt),
  };

  if (!currentActive) {
    const decision = buildPromotionDecision({
      ...baseDecision,
      action: 'rollback_rejected',
      reason: 'active_version_missing',
    });
    return {
      ok: true,
      rolled_back: false,
      reason: decision.reason,
      decision: recordPromotionDecision(workspace, decision),
    };
  }
  if (!force && currentActive.version_id !== promotion.promoted_version_id) {
    const decision = buildPromotionDecision({
      ...baseDecision,
      action: 'rollback_rejected',
      reason: 'active_version_changed_since_promotion',
    });
    return {
      ok: true,
      rolled_back: false,
      reason: decision.reason,
      decision: recordPromotionDecision(workspace, decision),
    };
  }

  const restored = setActiveSkillVersion(workspace, {
    skill_id: promotion.skill_id,
    version_id: promotion.prior_active_version_id,
    activated_by: cleanString(input.rolled_back_by || input.agent_id || input.recorded_by) || null,
    task_key: cleanString(input.task_key) || null,
    reason: `rollback:${promotion.decision_id}`,
    now: recordedAt,
  });
  const decision = buildPromotionDecision({
    ...baseDecision,
    action: 'rolled_back',
    reason: 'restored_prior_active_version',
  });

  return {
    ok: true,
    rolled_back: true,
    active_version: restored.active_version,
    manifest: restored.manifest,
    decision: recordPromotionDecision(workspace, decision),
  };
}

function normalizeProposalPolicy(input = {}) {
  const policy = input.policy && typeof input.policy === 'object' ? input.policy : input;
  return {
    max_active_per_capability: nonNegativeInteger(
      policy.max_active_per_capability,
      'max_active_per_capability',
      DEFAULT_PROPOSAL_POLICY.max_active_per_capability
    ),
    min_evidence_count: nonNegativeInteger(
      policy.min_evidence_count,
      'min_evidence_count',
      DEFAULT_PROPOSAL_POLICY.min_evidence_count
    ),
    stale_after_ms: nonNegativeInteger(
      policy.stale_after_ms,
      'stale_after_ms',
      DEFAULT_PROPOSAL_POLICY.stale_after_ms
    ),
  };
}

function proposalRecordIdFor(input = {}) {
  return `spp_${hash(stableJson({
    type: input.record_type,
    proposal_id: input.proposal_id,
    status: input.status,
    recorded_at: input.recorded_at,
    duplicate_of: input.duplicate_of || null,
  }))}`;
}

function proposalIdFor(input = {}) {
  const hasStableKey = input.proposal_key || input.key || input.candidate_version_id || input.title;
  return `spc_${hash(stableJson({
    key: input.proposal_key || input.key || null,
    candidate_version_id: input.candidate_version_id || null,
    capability: input.capability,
    signature: input.signature,
    title: input.title || null,
    sighting: hasStableKey ? null : input.recorded_at || null,
  }))}`;
}

function latestProposalStates(records) {
  const latest = new Map();
  for (const record of records) latest.set(record.proposal_id, record);
  return [...latest.values()];
}

function isActiveProposal(record, now) {
  if (!record || record.status !== 'active_candidate' || record.active_candidate !== true) return false;
  const expiresAt = parseTime(record.expires_at);
  const asOf = parseTime(now);
  return !expiresAt || !asOf || expiresAt > asOf;
}

function isExpirableActiveProposal(record) {
  return record && record.status === 'active_candidate' && record.active_candidate === true;
}

function buildProposalRecord(input) {
  const record = {
    schema_version: PROMOTION_SCHEMA_VERSION,
    record_type: 'skill_proposal',
    proposal_id: input.proposal_id,
    capability: input.capability,
    area: input.area || input.capability,
    signature: input.signature,
    overlap_keys: input.overlap_keys || [],
    candidate_version_id: input.candidate_version_id || null,
    status: input.status,
    reason: input.reason || null,
    duplicate_of: input.duplicate_of || null,
    active_candidate: input.active_candidate === true,
    expose_as_skill: input.expose_as_skill === true,
    evidence_count: input.evidence_count,
    min_evidence_count: input.min_evidence_count,
    max_active_per_capability: input.max_active_per_capability,
    recorded_at: input.recorded_at,
    expires_at: input.expires_at || null,
    provenance: input.provenance,
  };
  record.proposal_record_id = proposalRecordIdFor(record);
  return record;
}

function expireStaleSkillProposals(workspace, input = {}) {
  const recordedAt = nowIso(input.now);
  const records = readSkillProposalRecords(workspace);
  const states = latestProposalStates(records);
  const expired = [];
  for (const state of states) {
    if (!isExpirableActiveProposal(state)) continue;
    const expiresAt = parseTime(state.expires_at);
    const asOf = parseTime(recordedAt);
    if (!expiresAt || !asOf || expiresAt > asOf) continue;
    const record = buildProposalRecord({
      ...state,
      status: 'expired_non_promoted',
      reason: 'stale_candidate_not_promoted',
      active_candidate: false,
      expose_as_skill: false,
      recorded_at: recordedAt,
      provenance: normalizeDecisionProvenance(input, recordedAt),
    });
    expired.push(appendUniqueJsonl(proposalPath(workspace), record, 'proposal_record_id').record);
  }
  return { ok: true, expired };
}

function normalizeProposalInput(workspace, input = {}, policy, recordedAt) {
  const candidateVersionId = cleanString(input.candidate_version_id || input.version_id);
  const version = candidateVersionId ? versionById(workspace, candidateVersionId) : null;
  if (candidateVersionId && !version) throw new Error(`unknown candidate version: ${candidateVersionId}`);
  const capability = cleanString(input.capability || input.area || input.skill_id || (version && version.skill_id));
  if (!capability) throw new Error('proposal capability or candidate_version_id is required');
  const signature = cleanString(input.signature || input.capability_signature || input.overlap_signature || candidateVersionId);
  if (!signature) throw new Error('proposal signature or candidate_version_id is required');
  const evidence = Array.isArray(input.evidence) ? input.evidence.length : null;
  const evidenceCount = nonNegativeInteger(
    hasOwn(input, 'evidence_count') ? input.evidence_count : evidence,
    'evidence_count',
    0
  );
  const staleAfter = policy.stale_after_ms;
  const expiresAt = cleanString(input.expires_at)
    || new Date((parseTime(recordedAt) || Date.now()) + staleAfter).toISOString();

  return {
    proposal_key: cleanString(input.proposal_key || input.key) || null,
    title: cleanString(input.title || input.name) || null,
    candidate_version_id: candidateVersionId || null,
    capability,
    area: cleanString(input.area) || capability,
    signature,
    overlap_keys: normalizeStringArray(input.overlap_keys || input.overlaps || []),
    evidence_count: evidenceCount,
    promotion_outcome: cleanString(input.promotion_outcome || input.evaluation_outcome),
    expires_at: expiresAt,
  };
}

function overlapsProposal(a, b) {
  if (a.capability !== b.capability) return false;
  if (a.signature && a.signature === b.signature) return true;
  const aKeys = new Set(a.overlap_keys || []);
  return (b.overlap_keys || []).some((key) => aKeys.has(key));
}

function recordSkillProposal(workspace, input = {}) {
  const recordedAt = nowIso(input.now);
  const policy = normalizeProposalPolicy(input);
  const expired = expireStaleSkillProposals(workspace, { now: recordedAt, ...input }).expired;
  const proposal = normalizeProposalInput(workspace, input, policy, recordedAt);
  proposal.proposal_id = proposalIdFor({ ...proposal, recorded_at: recordedAt });

  const states = latestProposalStates(readSkillProposalRecords(workspace));
  const active = states.filter((state) => isActiveProposal(state, recordedAt));
  const duplicate = active.find((state) => overlapsProposal(proposal, state));
  const activeForCapability = active.filter((state) => state.capability === proposal.capability);

  let status = 'active_candidate';
  let reason = 'candidate_admitted_to_budgeted_queue';
  let duplicateOf = null;
  let activeCandidate = true;
  let exposeAsSkill = true;
  if (proposal.promotion_outcome && proposal.promotion_outcome !== 'win') {
    status = 'not_promoted';
    reason = 'measured_candidate_did_not_win';
    activeCandidate = false;
    exposeAsSkill = false;
  } else if (duplicate) {
    status = 'duplicate';
    reason = 'duplicate_or_overlapping_capability';
    duplicateOf = duplicate.proposal_id;
    activeCandidate = false;
    exposeAsSkill = false;
  } else if (proposal.evidence_count < policy.min_evidence_count) {
    status = 'needs_more_evidence';
    reason = 'insufficient_repeated_evidence';
    activeCandidate = false;
    exposeAsSkill = false;
  } else if (activeForCapability.length >= policy.max_active_per_capability) {
    status = 'queued_cap_reached';
    reason = 'active_candidate_cap_reached';
    activeCandidate = false;
    exposeAsSkill = false;
  }

  const record = buildProposalRecord({
    ...proposal,
    status,
    reason,
    duplicate_of: duplicateOf,
    active_candidate: activeCandidate,
    expose_as_skill: exposeAsSkill,
    min_evidence_count: policy.min_evidence_count,
    max_active_per_capability: policy.max_active_per_capability,
    recorded_at: recordedAt,
    provenance: normalizeDecisionProvenance(input, recordedAt),
  });

  return {
    ok: true,
    record: appendUniqueJsonl(proposalPath(workspace), record, 'proposal_record_id').record,
    expired,
    active_candidates_for_capability: activeForCapability.length + (activeCandidate ? 1 : 0),
  };
}

function normalizeThirdPartyPolicy(input = {}) {
  const policy = input.policy && typeof input.policy === 'object' ? input.policy : {};
  return {
    automatic_cleanup: policy.automatic_cleanup === true || input.automatic_cleanup === true,
  };
}

function normalizeThirdPartySignals(input = {}) {
  return {
    usage_count: nonNegativeInteger(input.usage_count, 'usage_count', 0),
    overlap_score: finiteNumber(input.overlap_score, 'overlap_score', 0),
    security_risk: input.security_risk === true || input.security === 'risk',
    stale: input.stale === true || input.freshness === 'stale',
  };
}

function recommendThirdPartySkill(workspace, input = {}) {
  const recordedAt = nowIso(input.now);
  const policy = normalizeThirdPartyPolicy(input);
  const signals = normalizeThirdPartySignals(input);
  let evaluation = null;
  let gate = null;
  if (input.evaluation || input.evaluation_id || input.candidate_version_id || input.version_id) {
    evaluation = resolveEvaluation(workspace, input);
    gate = promotionGateForEvaluation(evaluation);
  }

  let recommendation = 'keep';
  const reasons = [];
  if (gate && gate.eligible) {
    recommendation = 'replace';
    reasons.push('challenger_beat_third_party_baseline');
  } else if (gate) {
    reasons.push(gate.reason);
  }

  if (recommendation === 'keep' && signals.security_risk) {
    recommendation = 'archive';
    reasons.push('security_risk');
  } else if (recommendation === 'keep' && signals.stale && signals.overlap_score >= 0.8 && signals.usage_count === 0) {
    recommendation = 'archive';
    reasons.push('stale_unused_overlap');
  } else if (recommendation === 'keep' && signals.stale) {
    recommendation = 'update';
    reasons.push('stale_third_party_skill');
  }
  if (!reasons.length) reasons.push('third_party_baseline_still_preferred');

  const destructive = recommendation === 'archive' || recommendation === 'replace' || recommendation === 'delete';
  const decision = buildPromotionDecision({
    decision_type: 'third_party_recommendation',
    action: recommendation,
    skill_id: cleanString(input.skill_id) || (evaluation && evaluation.skill_id) || null,
    slug: cleanString(input.slug) || (evaluation && evaluation.slug) || null,
    active_version_id: evaluation ? evaluation.active_version_id : cleanString(input.baseline_version_id) || null,
    candidate_version_id: evaluation ? evaluation.candidate_version_id : cleanString(input.candidate_version_id) || null,
    evaluation_id: evaluation ? evaluation.evaluation_id : null,
    reason: reasons.join(','),
    gate,
    comparison: evaluation ? evaluation.comparison || null : null,
    recorded_at: recordedAt,
    provenance: normalizeDecisionProvenance(input, recordedAt),
  });
  decision.third_party = {
    baseline_version_id: decision.active_version_id,
    recommendation,
    reasons,
    signals,
    destructive,
    user_visible: destructive && !policy.automatic_cleanup,
    policy_allows_automatic_cleanup: policy.automatic_cleanup,
    applied: false,
    will_auto_delete: false,
    will_auto_replace: false,
  };

  return {
    ok: true,
    recommendation,
    reasons,
    destructive,
    user_visible: decision.third_party.user_visible,
    policy_allows_automatic_cleanup: policy.automatic_cleanup,
    applied: false,
    decision: recordPromotionDecision(workspace, decision),
  };
}

module.exports = {
  PROMOTION_SCHEMA_VERSION,
  DEFAULT_PROPOSAL_POLICY,
  promotionPath,
  proposalPath,
  readPromotionRecords,
  readSkillProposalRecords,
  promotionGateForEvaluation,
  promoteSkillVersion,
  rollbackSkillPromotion,
  recordSkillProposal,
  expireStaleSkillProposals,
  recommendThirdPartySkill,
};
