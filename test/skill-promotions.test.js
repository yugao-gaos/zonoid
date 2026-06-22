#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  recordGeneratedSkillVersion,
  setActiveSkillVersion,
  getActiveSkillVersion,
  loadManifest,
} = require('../lib/skill-versions');
const { recordSkillEvaluation } = require('../lib/skill-evaluations');
const {
  readPromotionRecords,
  readSkillProposalRecords,
  promoteSkillVersion,
  rollbackSkillPromotion,
  recordSkillProposal,
  recommendThirdPartySkill,
} = require('../lib/skill-promotions');

let pass = 0;
let fail = 0;
const tests = [];
const test = (label, fn) => tests.push({ label, fn });

function makeWorkspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-skill-promotions-')));
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  return ws;
}

function skillMd(name, body) {
  return `---\nname: ${name}\ndescription: generated skill\n---\n\n# ${name}\n\n${body}\n`;
}

function makeVersions(ws, name = 'Planner') {
  const skillPath = path.join(ws, 'skills', name.toLowerCase(), 'SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, 'original skill file\n');
  const active = recordGeneratedSkillVersion(ws, {
    target_path: skillPath,
    skill_markdown: skillMd(name, 'active behavior'),
    agent_id: 'worker-a',
    source: 'active',
    now: '2026-06-21T12:00:00.000Z',
  }).record;
  const candidate = recordGeneratedSkillVersion(ws, {
    target_path: skillPath,
    skill_markdown: skillMd(name, 'candidate behavior'),
    agent_id: 'worker-b',
    source: 'subconscious',
    now: '2026-06-21T12:01:00.000Z',
  }).record;
  setActiveSkillVersion(ws, {
    version_id: active.version_id,
    activated_by: 'test',
    now: '2026-06-21T12:02:00.000Z',
  });
  return { skillPath, active, candidate };
}

function recordEvaluation(ws, active, candidate, measurements) {
  return recordSkillEvaluation(ws, {
    active_version_id: active.version_id,
    candidate_version_id: candidate.version_id,
    metric_spec: {
      metric: 'quality',
      direction: 'max',
      guardrails: [{ metric: 'tests_passed', direction: 'max' }],
    },
    measurements,
    agent_id: 'worker-eval',
    task_key: 'codex/eval',
    now: '2026-06-21T12:03:00.000Z',
  }).record;
}

test('promotes a measured winner through the version manifest without overwriting SKILL.md', () => {
  const ws = makeWorkspace();
  const { skillPath, active, candidate } = makeVersions(ws);
  const evaluation = recordEvaluation(ws, active, candidate, {
    active: { value: 0.7, guardrails: { tests_passed: 1 } },
    candidate: { value: 0.86, guardrails: { tests_passed: 1 } },
  });

  const promoted = promoteSkillVersion(ws, {
    evaluation_id: evaluation.evaluation_id,
    agent_id: 'worker-promote',
    task_key: 'codex/promote',
    now: '2026-06-21T12:04:00.000Z',
  });
  const manifest = loadManifest(ws);
  const decisions = readPromotionRecords(ws);

  assert.equal(promoted.promoted, true);
  assert.equal(getActiveSkillVersion(ws, { target_path: skillPath }).version_id, candidate.version_id);
  assert.equal(manifest.skills[active.skill_id].active_version_id, candidate.version_id);
  assert.equal(manifest.skills[active.skill_id].activation_history.length, 2);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, 'promoted');
  assert.equal(decisions[0].prior_active_version_id, active.version_id);
  assert.equal(decisions[0].promoted_version_id, candidate.version_id);
  assert.equal(decisions[0].evaluation_id, evaluation.evaluation_id);
  assert.equal(fs.readFileSync(skillPath, 'utf8'), 'original skill file\n');
});

test('rejects a candidate with guardrail regression and leaves the active version unchanged', () => {
  const ws = makeWorkspace();
  const { skillPath, active, candidate } = makeVersions(ws);
  const evaluation = recordEvaluation(ws, active, candidate, {
    active: { value: 0.7, guardrails: { tests_passed: 1 } },
    candidate: { value: 0.95, guardrails: { tests_passed: 0 } },
  });

  const rejected = promoteSkillVersion(ws, {
    evaluation_id: evaluation.evaluation_id,
    now: '2026-06-21T12:04:00.000Z',
  });
  const decisions = readPromotionRecords(ws);

  assert.equal(rejected.promoted, false);
  assert.equal(rejected.reason, 'guardrail_regression');
  assert.equal(getActiveSkillVersion(ws, { target_path: skillPath }).version_id, active.version_id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, 'rejected');
  assert.equal(decisions[0].candidate_version_id, candidate.version_id);
});

test('rejects stale evaluations when the active version changed after measurement', () => {
  const ws = makeWorkspace();
  const { skillPath, active, candidate } = makeVersions(ws);
  const newer = recordGeneratedSkillVersion(ws, {
    target_path: skillPath,
    skill_markdown: skillMd('Planner', 'newer active behavior'),
    agent_id: 'worker-c',
    now: '2026-06-21T12:02:30.000Z',
  }).record;
  const evaluation = recordEvaluation(ws, active, candidate, {
    active: { value: 0.7, guardrails: { tests_passed: 1 } },
    candidate: { value: 0.9, guardrails: { tests_passed: 1 } },
  });
  setActiveSkillVersion(ws, {
    version_id: newer.version_id,
    activated_by: 'other-worker',
    now: '2026-06-21T12:03:30.000Z',
  });

  const rejected = promoteSkillVersion(ws, {
    evaluation_id: evaluation.evaluation_id,
    now: '2026-06-21T12:04:00.000Z',
  });

  assert.equal(rejected.promoted, false);
  assert.equal(rejected.reason, 'active_version_changed_since_evaluation');
  assert.equal(getActiveSkillVersion(ws, { target_path: skillPath }).version_id, newer.version_id);
});

test('rolls back the latest promotion to the prior active version', () => {
  const ws = makeWorkspace();
  const { skillPath, active, candidate } = makeVersions(ws);
  const evaluation = recordEvaluation(ws, active, candidate, {
    active: { value: 0.6, guardrails: { tests_passed: 1 } },
    candidate: { value: 0.8, guardrails: { tests_passed: 1 } },
  });
  const promoted = promoteSkillVersion(ws, {
    evaluation_id: evaluation.evaluation_id,
    now: '2026-06-21T12:04:00.000Z',
  });

  const rolledBack = rollbackSkillPromotion(ws, {
    promotion_id: promoted.decision.decision_id,
    agent_id: 'worker-rollback',
    task_key: 'codex/rollback',
    now: '2026-06-21T12:05:00.000Z',
  });
  const decisions = readPromotionRecords(ws);

  assert.equal(rolledBack.rolled_back, true);
  assert.equal(getActiveSkillVersion(ws, { target_path: skillPath }).version_id, active.version_id);
  assert.equal(decisions.length, 2);
  assert.equal(decisions[1].action, 'rolled_back');
  assert.equal(decisions[1].rolled_back_promotion_id, promoted.decision.decision_id);
});

test('proposal inventory dedups, caps active candidates, requires repeated evidence, and expires stale losers', () => {
  const ws = makeWorkspace();
  const policy = { max_active_per_capability: 1, min_evidence_count: 2, stale_after_ms: 1000 };
  const first = recordSkillProposal(ws, {
    capability: 'planning',
    signature: 'plan-before-edit',
    evidence_count: 2,
    policy,
    now: '2026-06-21T12:00:00.000Z',
  });
  const duplicate = recordSkillProposal(ws, {
    capability: 'planning',
    signature: 'plan-before-edit',
    evidence_count: 4,
    policy,
    now: '2026-06-21T12:00:00.100Z',
  });
  const capped = recordSkillProposal(ws, {
    capability: 'planning',
    signature: 'parallel-plan',
    evidence_count: 4,
    policy,
    now: '2026-06-21T12:00:00.200Z',
  });
  const weak = recordSkillProposal(ws, {
    capability: 'review',
    signature: 'single-observation',
    evidence_count: 1,
    policy,
    now: '2026-06-21T12:00:00.300Z',
  });
  const afterExpiry = recordSkillProposal(ws, {
    capability: 'planning',
    signature: 'budgeted-queue',
    evidence_count: 3,
    policy,
    now: '2026-06-21T12:00:02.000Z',
  });
  const records = readSkillProposalRecords(ws);

  assert.equal(first.record.status, 'active_candidate');
  assert.equal(first.record.expose_as_skill, true);
  assert.equal(duplicate.record.status, 'duplicate');
  assert.equal(duplicate.record.expose_as_skill, false);
  assert.equal(capped.record.status, 'queued_cap_reached');
  assert.equal(weak.record.status, 'needs_more_evidence');
  assert.equal(afterExpiry.expired.length, 1);
  assert.equal(afterExpiry.record.status, 'active_candidate');
  assert(records.some((record) => record.status === 'expired_non_promoted'));
});

test('third-party recommendations are user-visible by default and never mutate the active version', () => {
  const ws = makeWorkspace();
  const { skillPath, active, candidate } = makeVersions(ws, 'Third Party Planner');
  const evaluation = recordEvaluation(ws, active, candidate, {
    active: { value: 0.66, guardrails: { tests_passed: 1 } },
    candidate: { value: 0.82, guardrails: { tests_passed: 1 } },
  });

  const recommendation = recommendThirdPartySkill(ws, {
    evaluation_id: evaluation.evaluation_id,
    usage_count: 12,
    overlap_score: 0.9,
    stale: true,
    now: '2026-06-21T12:04:00.000Z',
  });
  const optInRecommendation = recommendThirdPartySkill(ws, {
    evaluation_id: evaluation.evaluation_id,
    usage_count: 12,
    overlap_score: 0.9,
    stale: true,
    policy: { automatic_cleanup: true },
    now: '2026-06-21T12:05:00.000Z',
  });
  const archiveRecommendation = recommendThirdPartySkill(ws, {
    skill_id: 'skill:unsafe-third-party',
    security_risk: true,
    now: '2026-06-21T12:06:00.000Z',
  });
  const keepRecommendation = recommendThirdPartySkill(ws, {
    skill_id: 'skill:healthy-third-party',
    usage_count: 4,
    overlap_score: 0.1,
    now: '2026-06-21T12:07:00.000Z',
  });

  assert.equal(recommendation.recommendation, 'replace');
  assert.equal(recommendation.decision.third_party.baseline_version_id, active.version_id);
  assert.equal(recommendation.user_visible, true);
  assert.equal(recommendation.applied, false);
  assert.equal(recommendation.decision.third_party.will_auto_replace, false);
  assert.equal(optInRecommendation.policy_allows_automatic_cleanup, true);
  assert.equal(optInRecommendation.user_visible, false);
  assert.equal(optInRecommendation.applied, false);
  assert.equal(archiveRecommendation.recommendation, 'archive');
  assert.equal(archiveRecommendation.user_visible, true);
  assert.equal(archiveRecommendation.applied, false);
  assert.equal(keepRecommendation.recommendation, 'keep');
  assert.equal(keepRecommendation.destructive, false);
  assert.equal(getActiveSkillVersion(ws, { target_path: skillPath }).version_id, active.version_id);
});

(async () => {
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
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
