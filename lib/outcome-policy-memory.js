'use strict';

// Outcome-grounded guidance memory. This module deliberately does not participate in search or
// prompt compilation: it only derives temporal guidance notes from evidence already recorded by the
// recall-outcome journal, or from an explicit user correction. Consumers decide separately whether
// and where guidance is injected.

const overlayStore = require('./overlay');
const recallJournal = require('./recall-outcome-journal');

const FEATURE_ENV = 'ZONOID_OUTCOME_POLICY_MEMORY';
const MIN_POLICY_OBSERVATIONS = 3;
const GLOBAL_MIN_OBSERVATIONS = 5;
const EFFECTIVE_WIN_RATE = 0.75;
const AVOID_WIN_RATE = 0.25;

function enabled(overlay, env = process.env) {
  const configured = !!(overlay && overlay.config && overlay.config.outcome_policy_memory === true);
  const flag = String((env && env[FEATURE_ENV]) || '').trim().toLowerCase();
  return configured || flag === '1' || flag === 'true';
}

function noteKey(value) {
  if (!value) return null;
  const key = String(value);
  return key.startsWith('note:') ? key : `note:${key}`;
}

function bareNoteId(value) {
  const key = noteKey(value);
  return key ? key.slice('note:'.length) : null;
}

function safeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}

function isGuidanceSource(note) {
  if (!note || note.validTo != null) return false;
  if ((note.tags || []).includes('outcome-policy') || note.category === 'outcome-policy') return false;
  // Legacy preference notes predate memory_lane. They are the only lane-less records safe to treat
  // as guidance; every other legacy note remains unclassified and cannot become policy evidence.
  return note.memory_lane === 'guidance'
    || (note.memory_lane == null && note.category === 'preference');
}

function isSensitiveInference(note) {
  if (!note) return false;
  const text = [note.category, note.title, note.summary, ...(note.tags || [])].join(' ').toLowerCase();
  return /\b(emotion|emotional|mood|personality|psycholog(?:y|ical)?)\b/.test(text);
}

function scopeTagsFor(source) {
  const explicit = (source.tags || []).filter((tag) => String(tag).startsWith('scope:'));
  if (explicit.length) return explicit;
  return [`scope:source:${safeToken(source.id)}`];
}

function classifyEvidence(evidence, scopeTags, options = {}) {
  const minimum = Number.isFinite(options.minObservations)
    ? Math.max(MIN_POLICY_OBSERVATIONS, options.minObservations)
    : MIN_POLICY_OBSERVATIONS;
  const globalMinimum = Number.isFinite(options.globalMinObservations)
    ? Math.max(GLOBAL_MIN_OBSERVATIONS, options.globalMinObservations)
    : GLOBAL_MIN_OBSERVATIONS;
  const required = scopeTags.includes('scope:global') ? globalMinimum : minimum;
  if (!evidence || evidence.opportunities < required) return null;
  if (evidence.winRate >= EFFECTIVE_WIN_RATE) return 'effective';
  if (evidence.winRate <= AVOID_WIN_RATE) return 'avoid';
  return null;
}

function evidenceConfidence(evidence, kind) {
  if (!evidence || evidence.opportunities <= 0) return 0;
  const directionalRate = kind === 'avoid' ? 1 - evidence.winRate : evidence.winRate;
  const opportunityStrength = evidence.opportunities / (evidence.opportunities + 2);
  return Math.round(Math.min(0.99, directionalRate * opportunityStrength) * 1000) / 1000;
}

function currentPolicyFor(overlay, sourceId) {
  const sourceTag = `outcome-policy-source:${safeToken(sourceId)}`;
  return Object.values((overlay && overlay.note_nodes) || {}).find((note) =>
    note && note.validTo == null && (note.tags || []).includes(sourceTag)
  ) || null;
}

function entityKeysForSource(overlay, sourceKey) {
  const out = new Set();
  for (const edge of (overlay && overlay.edges) || []) {
    if (edge.from !== sourceKey && edge.to !== sourceKey) continue;
    const other = edge.from === sourceKey ? edge.to : edge.from;
    if (String(other || '').startsWith('entity:')) out.add(String(other));
  }
  return [...out];
}

function mirrorKnowledge(overlay, policyKey, knowledge) {
  if (!Array.isArray(knowledge) || !knowledge.length) return;
  if (!overlay.knowledge) overlay.knowledge = {};
  overlay.knowledge[policyKey] = knowledge.slice();
}

function wirePolicy(overlay, policyKey, taskKeys, entityKeys, sourceKey, confidence) {
  const evidence = sourceKey ? `outcome evidence for ${sourceKey}` : 'explicit user correction';
  for (const taskKey of new Set((taskKeys || []).filter(Boolean).map(String))) {
    overlayStore.addEdge(overlay, policyKey, taskKey, null, 'context', 1, {
      origin: 'outcome-policy', judged: true, confidence, evidence,
    });
  }
  for (const entityKey of new Set((entityKeys || []).filter((key) => String(key).startsWith('entity:')))) {
    overlayStore.addEntityEdge(overlay, policyKey, String(entityKey), 'policy_scope');
  }
  if (sourceKey) {
    overlayStore.addEdge(overlay, sourceKey, policyKey, null, 'context', 1, {
      origin: 'outcome-policy-evidence', judged: true, confidence, evidence,
    });
  }
}

function createJournalPolicy(overlay, sourceKey, source, evidence, kind, scopeTags, now) {
  const confidence = evidenceConfidence(evidence, kind);
  const rate = Math.round(evidence.winRate * 100);
  const scope = scopeTags.join(', ');
  const knowledge = [
    `Source guidance: ${sourceKey}`,
    `Resolved outcomes: ${evidence.opportunities} unique tasks (${evidence.wins} wins, ${evidence.losses} losses, ${rate}% win rate).`,
    `Evidence tasks: ${evidence.recalledTaskKeys.join(', ')}`,
  ];
  const id = overlayStore.addNoteNode(overlay, {
    title: `${kind === 'effective' ? 'Effective approach' : 'Avoid repeating'} — ${source.title || source.id}`,
    summary: kind === 'effective'
      ? `Within ${scope}, outcome evidence supports continuing this guidance: ${source.summary || source.title}`
      : `Within ${scope}, outcome evidence says to avoid repeating this guidance without reevaluation: ${source.summary || source.title}`,
    category: 'outcome-policy',
    tags: [
      'outcome-policy', `policy:${kind}`, `outcome-policy-source:${safeToken(source.id)}`,
      `evidence-count:${evidence.opportunities}`, ...scopeTags,
    ],
    knowledge,
    created_by: 'outcome-policy-memory',
    valid_from: now,
    memory_lane: 'guidance',
    source_role: 'system',
    authority: 'inference',
    confidence,
    episode: { transcript_ref: '.graph/recall-outcome-journal.jsonl' },
  });
  const policyKey = `note:${id}`;
  mirrorKnowledge(overlay, policyKey, knowledge);
  wirePolicy(
    overlay,
    policyKey,
    evidence.recalledTaskKeys,
    entityKeysForSource(overlay, sourceKey),
    sourceKey,
    confidence,
  );
  overlayStore.bumpEpoch(overlay);
  return { id, key: policyKey, confidence, kind };
}

/**
 * Derive bounded policies for the guidance notes recalled by a newly-resolved task.
 * Latest-row-per-task journal semantics make repeated terminal writes idempotent evidence.
 */
function deriveFromJournal({ overlay, workspace, taskKey, rows, now, env, minObservations, globalMinObservations } = {}) {
  if (!enabled(overlay, env)) return { enabled: false, created: [], superseded: [], skipped: [] };
  const result = { enabled: true, created: [], superseded: [], skipped: [] };
  if (!overlay || !taskKey) return { ...result, skipped: ['missing_scope'] };

  const journalRows = Array.isArray(rows) ? rows : recallJournal.readRows(workspace);
  const latest = recallJournal.latestRowsByTask(journalRows);
  const resolved = latest.get(String(taskKey));
  if (!resolved || !resolved.outcome || resolved.outcome === 'pending') {
    result.skipped.push('unresolved_outcome');
    return result;
  }

  const evidenceMap = recallJournal.computeNoteUsageEvidenceFromRows(journalRows, overlay.note_nodes);
  const candidates = [...new Set((resolved.recalled_note_keys || []).map(noteKey).filter(Boolean))];
  for (const sourceKey of candidates) {
    const sourceId = bareNoteId(sourceKey);
    const source = overlay.note_nodes && overlay.note_nodes[sourceId];
    if (!isGuidanceSource(source)) { result.skipped.push(`${sourceKey}:not_guidance`); continue; }
    if (isSensitiveInference(source)) { result.skipped.push(`${sourceKey}:sensitive_inference`); continue; }

    const evidence = evidenceMap.get(sourceKey);
    const scopeTags = scopeTagsFor(source);
    const kind = classifyEvidence(evidence, scopeTags, { minObservations, globalMinObservations });
    if (!kind) { result.skipped.push(`${sourceKey}:insufficient_or_mixed_evidence`); continue; }

    const prior = currentPolicyFor(overlay, sourceId);
    const evidenceTag = `evidence-count:${evidence.opportunities}`;
    if (prior && (prior.tags || []).includes(`policy:${kind}`) && (prior.tags || []).includes(evidenceTag)) {
      result.skipped.push(`${sourceKey}:already_current`);
      continue;
    }

    const created = createJournalPolicy(
      overlay, sourceKey, source, evidence, kind, scopeTags,
      now || new Date().toISOString(),
    );
    result.created.push(created);
    if (prior) {
      const superseded = overlayStore.supersedeNote(
        overlay, prior.id, created.id, now || undefined, workspace,
      );
      if (superseded.ok) result.superseded.push({ old_key: `note:${prior.id}`, new_key: created.key, at: superseded.at });
    }
  }
  return result;
}

function currentCorrectionFor(overlay, slotTag) {
  return Object.values((overlay && overlay.note_nodes) || {}).find((note) =>
    note && note.validTo == null && (note.tags || []).includes('policy:correction')
      && (note.tags || []).includes(slotTag)
  ) || null;
}

/** Record an explicit user correction as task/entity-scoped guidance, never as global policy. */
function recordCorrection({ overlay, workspace, taskKey, correction, scope, sessionId, transcriptRef, entityKeys, now, env } = {}) {
  if (!enabled(overlay, env)) return { enabled: false, created: null, skipped: 'feature_disabled' };
  const text = String(correction || '').trim();
  if (!text) return { enabled: true, created: null, skipped: 'missing_correction' };
  if (!taskKey && !(Array.isArray(entityKeys) && entityKeys.length)) {
    return { enabled: true, created: null, skipped: 'unscoped_correction' };
  }

  const requestedScope = String(scope || '').trim().toLowerCase();
  if (requestedScope === 'global' || requestedScope === 'scope:global') {
    return { enabled: true, created: null, skipped: 'one_off_global_policy' };
  }
  const anchor = taskKey
    ? `task:${safeToken(taskKey)}`
    : `entity:${safeToken(entityKeys[0])}`;
  const scopeName = safeToken(scope || 'default');
  if (!scopeName) return { enabled: true, created: null, skipped: 'missing_scope' };
  // The anchor is part of the slot. A correction called "tests" for task A must not supersede an
  // unrelated "tests" correction for task B and thereby become accidental global guidance.
  const slotTag = `correction-slot:${anchor}:${scopeName}`;
  const prior = currentCorrectionFor(overlay, slotTag);
  if (prior && String(prior.summary || '').trim() === text) {
    return { enabled: true, created: null, current: `note:${prior.id}`, skipped: 'already_current' };
  }

  const at = now || new Date().toISOString();
  const knowledge = [
    `Explicit user correction${taskKey ? ` for ${taskKey}` : ''}.`,
    transcriptRef ? `Correction source: ${transcriptRef}` : 'Correction source: guidance resolution.',
  ];
  const episode = {};
  if (sessionId) episode.session_id = String(sessionId);
  if (transcriptRef) episode.transcript_ref = String(transcriptRef);
  const id = overlayStore.addNoteNode(overlay, {
    title: `User correction — ${anchor} — ${scopeName}`,
    summary: text,
    category: 'outcome-policy',
    tags: ['outcome-policy', 'policy:correction', slotTag, `scope:${anchor}`, `policy-scope:${scopeName}`],
    knowledge,
    created_by: 'user-correction',
    valid_from: at,
    memory_lane: 'guidance',
    source_role: 'user',
    authority: 'directive',
    confidence: 1,
    episode: Object.keys(episode).length ? episode : null,
  });
  const key = `note:${id}`;
  mirrorKnowledge(overlay, key, knowledge);
  wirePolicy(overlay, key, taskKey ? [taskKey] : [], entityKeys || [], null, 1);
  overlayStore.bumpEpoch(overlay);

  let superseded = null;
  if (prior) {
    const replacement = overlayStore.supersedeNote(overlay, prior.id, id, at, workspace);
    if (replacement.ok) superseded = { old_key: `note:${prior.id}`, new_key: key, at: replacement.at };
  }
  return { enabled: true, created: { id, key, confidence: 1, kind: 'correction' }, superseded };
}

module.exports = {
  FEATURE_ENV,
  MIN_POLICY_OBSERVATIONS,
  GLOBAL_MIN_OBSERVATIONS,
  EFFECTIVE_WIN_RATE,
  AVOID_WIN_RATE,
  enabled,
  deriveFromJournal,
  recordCorrection,
  classifyEvidence,
  evidenceConfidence,
  isSensitiveInference,
};
