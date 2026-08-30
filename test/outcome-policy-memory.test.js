'use strict';

const assert = require('assert');
const outcomePolicy = require('../lib/outcome-policy-memory');

function overlay(enabled = true) {
  return {
    config: { outcome_policy_memory: enabled },
    note_nodes: {},
    knowledge: {},
    edges: [],
    entity_nodes: {},
    epoch: 0,
  };
}

function guidanceNote(id, extra = {}) {
  return {
    id,
    title: 'Run focused tests',
    summary: 'Run the smallest relevant test before the full suite.',
    category: 'preference',
    tags: ['scope:repo:zonoid'],
    memory_lane: 'guidance',
    source_role: 'user',
    authority: 'directive',
    confidence: 1,
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: null,
    ...extra,
  };
}

function rows(note, outcomes) {
  return outcomes.map((outcome, index) => ({
    ts: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    task_key: `task/${index + 1}`,
    recalled_note_keys: [`note:${note}`],
    outcome,
    via: 'rag',
  }));
}

function derive(ov, journalRows, taskKey) {
  return outcomePolicy.deriveFromJournal({
    overlay: ov,
    workspace: null,
    taskKey,
    rows: journalRows,
    now: '2026-08-30T12:00:00.000Z',
    env: {},
  });
}

// Default-off compatibility: sufficient evidence does nothing unless config/env explicitly enables.
{
  const ov = overlay(false);
  ov.note_nodes.source = guidanceNote('source');
  const result = derive(ov, rows('source', ['approve', 'approve', 'approve']), 'task/3');
  assert.strictEqual(result.enabled, false);
  assert.deepStrictEqual(Object.keys(ov.note_nodes), ['source']);
}

// One outcome cannot become policy, even when a caller tries to lower the configurable threshold.
{
  const ov = overlay();
  ov.note_nodes.source = guidanceNote('source');
  const result = outcomePolicy.deriveFromJournal({
    overlay: ov,
    taskKey: 'task/1',
    rows: rows('source', ['approve']),
    minObservations: 1,
    env: {},
  });
  assert.strictEqual(result.created.length, 0);
  assert(result.skipped.some((reason) => reason.includes('insufficient_or_mixed_evidence')));
}

// Three independent successful tasks produce a scoped guidance inference with explicit provenance.
{
  const ov = overlay();
  ov.note_nodes.source = guidanceNote('source');
  ov.entity_nodes.testing = { id: 'testing', name: 'testing', type: 'concept', validTo: null };
  ov.edges.push({ from: 'note:source', to: 'entity:testing', kind: 'context', relation: 'about' });
  const journal = rows('source', ['approve', 'tested', 'approve']);
  const result = derive(ov, journal, 'task/3');
  assert.strictEqual(result.created.length, 1);
  const policy = ov.note_nodes[result.created[0].id];
  assert.strictEqual(policy.memory_lane, 'guidance');
  assert.strictEqual(policy.source_role, 'system');
  assert.strictEqual(policy.authority, 'inference');
  assert(policy.confidence > 0 && policy.confidence < 1);
  assert(policy.tags.includes('policy:effective'));
  assert(policy.tags.includes('scope:repo:zonoid'));
  assert.deepStrictEqual(policy.episode, { transcript_ref: '.graph/recall-outcome-journal.jsonl' });
  assert.strictEqual((ov.knowledge[result.created[0].key] || []).length, 3);
  assert.strictEqual(ov.edges.filter((edge) => edge.from === result.created[0].key && edge.to.startsWith('task/')).length, 3);
  assert(ov.edges.some((edge) => edge.from === result.created[0].key && edge.to === 'entity:testing' && edge.relation === 'policy_scope'));
  assert(ov.edges.some((edge) => edge.from === 'note:source' && edge.to === result.created[0].key && edge.evidence === 'outcome evidence for note:source'));

  const again = derive(ov, journal, 'task/3');
  assert.strictEqual(again.created.length, 0);
  assert(again.skipped.some((reason) => reason.includes('already_current')));
}

// New evidence versions the policy; a later contradictory evidence majority soft-supersedes it.
{
  const ov = overlay();
  ov.note_nodes.source = guidanceNote('source');
  const firstRows = rows('source', ['approve', 'approve', 'approve']);
  const first = derive(ov, firstRows, 'task/3');
  const firstId = first.created[0].id;

  const secondRows = rows('source', ['approve', 'approve', 'approve', 'tested']);
  const second = derive(ov, secondRows, 'task/4');
  assert.strictEqual(second.created.length, 1);
  assert.strictEqual(second.superseded[0].old_key, `note:${firstId}`);
  assert(ov.note_nodes[firstId].validTo);
  assert.strictEqual(ov.note_nodes[second.created[0].id].supersedes, firstId);

  const flippedRows = rows('source', [
    'approve', 'approve', 'approve',
    'failed', 'failed', 'failed', 'failed', 'failed', 'failed', 'failed', 'failed', 'failed', 'failed',
  ]);
  const flipped = derive(ov, flippedRows, 'task/13');
  assert.strictEqual(flipped.created.length, 1);
  assert.strictEqual(flipped.created[0].kind, 'avoid');
  assert(ov.note_nodes[flipped.created[0].id].tags.includes('policy:avoid'));
  assert.strictEqual(Object.values(ov.note_nodes).filter((note) => note.category === 'outcome-policy' && !note.validTo).length, 1);
}

// Emotion/personality inference is out of scope even with strong outcome correlation.
{
  const ov = overlay();
  ov.note_nodes.source = guidanceNote('source', { title: 'Infer user mood', tags: ['emotion', 'scope:repo:zonoid'] });
  const result = derive(ov, rows('source', ['approve', 'approve', 'approve']), 'task/3');
  assert.strictEqual(result.created.length, 0);
  assert(result.skipped.includes('note:source:sensitive_inference'));
}

// Three global-tagged observations remain below the stricter five-outcome global evidence floor.
{
  const ov = overlay();
  ov.note_nodes.source = guidanceNote('source', { tags: ['scope:global'] });
  const result = derive(ov, rows('source', ['approve', 'approve', 'approve']), 'task/3');
  assert.strictEqual(result.created.length, 0);
}

// Explicit corrections are user directives, require a concrete scope, and supersede by slot.
{
  const ov = overlay();
  const first = outcomePolicy.recordCorrection({
    overlay: ov,
    taskKey: 'task/42',
    correction: 'Use the repository test command before reporting completion.',
    scope: 'tests',
    sessionId: 'session-1',
    transcriptRef: 'guidance:g-1',
    now: '2026-08-30T12:00:00.000Z',
    env: {},
  });
  const note = ov.note_nodes[first.created.id];
  assert.strictEqual(note.memory_lane, 'guidance');
  assert.strictEqual(note.source_role, 'user');
  assert.strictEqual(note.authority, 'directive');
  assert.strictEqual(note.confidence, 1);
  assert.deepStrictEqual(note.episode, { session_id: 'session-1', transcript_ref: 'guidance:g-1' });
  assert(ov.edges.some((edge) => edge.from === first.created.key && edge.to === 'task/42'));

  const second = outcomePolicy.recordCorrection({
    overlay: ov,
    taskKey: 'task/42',
    correction: 'Run the focused test and then the full suite before completion.',
    scope: 'tests',
    now: '2026-08-30T13:00:00.000Z',
    env: {},
  });
  assert.strictEqual(second.superseded.old_key, first.created.key);
  assert(ov.note_nodes[first.created.id].validTo);

  const otherTask = outcomePolicy.recordCorrection({
    overlay: ov,
    taskKey: 'task/99',
    correction: 'Use the repository test command before reporting completion.',
    scope: 'tests',
    env: {},
  });
  assert.strictEqual(otherTask.superseded, null);
  assert.strictEqual(ov.note_nodes[second.created.id].validTo, null);

  const unscoped = outcomePolicy.recordCorrection({ overlay: ov, correction: 'Always do this.', env: {} });
  assert.strictEqual(unscoped.skipped, 'unscoped_correction');
  const global = outcomePolicy.recordCorrection({ overlay: ov, taskKey: 'task/42', correction: 'Always do this.', scope: 'global', env: {} });
  assert.strictEqual(global.skipped, 'one_off_global_policy');
}

console.log('outcome-policy-memory: all tests passed');
