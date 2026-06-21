#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  recordGeneratedSkillVersion,
  setActiveSkillVersion,
} = require('../lib/skill-versions');
const {
  compareMeasurements,
  recordSkillEvaluation,
  runSkillEvaluation,
  readSkillEvaluationRecords,
  listSkillEvaluations,
} = require('../lib/skill-evaluations');

let pass = 0;
let fail = 0;
const tests = [];
const test = (label, fn) => tests.push({ label, fn });
const near = (actual, expected) => Math.abs(actual - expected) < 1e-9;

function makeWorkspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-skill-eval-')));
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  return ws;
}

function skillMd(name, body) {
  return `---\nname: ${name}\ndescription: generated skill\n---\n\n# ${name}\n\n${body}\n`;
}

function makeVersions(ws) {
  const active = recordGeneratedSkillVersion(ws, {
    target_path: path.join(ws, 'skills', 'planner', 'SKILL.md'),
    skill_markdown: skillMd('Planner', 'active behavior'),
    agent_id: 'worker-a',
    now: '2026-06-21T12:00:00.000Z',
  }).record;
  const candidate = recordGeneratedSkillVersion(ws, {
    target_path: path.join(ws, 'skills', 'planner', 'SKILL.md'),
    skill_markdown: skillMd('Planner', 'candidate behavior'),
    agent_id: 'worker-b',
    now: '2026-06-21T12:01:00.000Z',
  }).record;
  setActiveSkillVersion(ws, {
    version_id: active.version_id,
    activated_by: 'test',
    now: '2026-06-21T12:02:00.000Z',
  });
  return { active, candidate };
}

test('compareMeasurements classifies candidate win, loss, and tie deterministically', () => {
  assert.equal(compareMeasurements(
    { metric: 'task_success', direction: 'max' },
    { value: 0.7 },
    { value: 0.9 }
  ).candidate_outcome, 'win');
  assert.equal(compareMeasurements(
    { metric: 'latency_ms', direction: 'min' },
    { value: 100 },
    { value: 130 }
  ).candidate_outcome, 'loss');
  const tied = compareMeasurements(
    { metric: 'quality', direction: 'max', tolerance: 0.02 },
    { value: 0.81 },
    { value: 0.82 }
  );
  assert.equal(tied.candidate_outcome, 'tie');
  assert.equal(tied.verdict, 'tie');
});

test('recordSkillEvaluation persists supplied measurements with dedup-safe ids', () => {
  const ws = makeWorkspace();
  const { active, candidate } = makeVersions(ws);
  const first = recordSkillEvaluation(ws, {
    candidate_version_id: candidate.version_id,
    metric_spec: { metric: 'task_success', direction: 'max' },
    measurements: {
      active: { value: 0.62 },
      candidate: { value: 0.77 },
    },
    agent_id: 'worker-eval',
    task_key: 'codex/eval',
    source: 'unit-test',
    now: '2026-06-21T12:03:00.000Z',
  });
  const duplicate = recordSkillEvaluation(ws, {
    active_version_id: active.version_id,
    candidate_version_id: candidate.version_id,
    metric_spec: { metric: 'task_success', direction: 'max' },
    measurements: {
      active: { value: 0.62 },
      candidate: { value: 0.77 },
    },
    agent_id: 'worker-other',
    now: '2026-06-21T12:04:00.000Z',
  });
  const rows = readSkillEvaluationRecords(ws);

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(first.record.evaluation_id, duplicate.record.evaluation_id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].active_version_id, active.version_id);
  assert.equal(rows[0].candidate_version_id, candidate.version_id);
  assert.equal(rows[0].comparison.candidate_outcome, 'win');
  assert.equal(rows[0].provenance.recorded_by, 'worker-eval');
  assert.equal(listSkillEvaluations(ws, { skill_id: 'skill:planner' }).length, 1);
});

test('recordSkillEvaluation rejects an explicit unknown active version without falling back', () => {
  const ws = makeWorkspace();
  const { candidate } = makeVersions(ws);

  assert.throws(() => recordSkillEvaluation(ws, {
    active_version_id: 'skv_missing_active',
    candidate_version_id: candidate.version_id,
    metric_spec: { metric: 'task_success', direction: 'max' },
    measurements: {
      active: { value: 0.62 },
      candidate: { value: 0.77 },
    },
  }), /unknown active version: skv_missing_active/);
  assert.equal(readSkillEvaluationRecords(ws).length, 0);
});

test('recordSkillEvaluation rejects an explicit unknown candidate version without persisting', () => {
  const ws = makeWorkspace();
  const { active } = makeVersions(ws);

  assert.throws(() => recordSkillEvaluation(ws, {
    active_version_id: active.version_id,
    candidate_version_id: 'skv_missing_candidate',
    metric_spec: { metric: 'task_success', direction: 'max' },
    measurements: {
      active: { value: 0.62 },
      candidate: { value: 0.77 },
    },
  }), /unknown candidate version: skv_missing_candidate/);
  assert.equal(readSkillEvaluationRecords(ws).length, 0);
});

test('recordSkillEvaluation accepts zero-valued supplied measurements', () => {
  const ws = makeWorkspace();
  const { candidate } = makeVersions(ws);
  const result = recordSkillEvaluation(ws, {
    candidate_version_id: candidate.version_id,
    metric_spec: { metric: 'failure_count', direction: 'min' },
    active_measurement: 1,
    candidate_measurement: 0,
  });

  assert.equal(result.created, true);
  assert.equal(result.record.measurements.candidate.value, 0);
  assert.equal(result.record.comparison.candidate_outcome, 'win');
});

test('guardrails require no regression before a candidate can win', () => {
  const ok = compareMeasurements(
    {
      metric: 'quality', direction: 'max',
      guardrails: [{ metric: 'tests_passed', direction: 'max' }],
    },
    { value: 0.7, guardrails: { tests_passed: 1 } },
    { value: 0.8, guardrails: { tests_passed: 1 } }
  );
  const regressed = compareMeasurements(
    {
      metric: 'quality', direction: 'max',
      guardrails: [{ metric: 'tests_passed', direction: 'max' }],
    },
    { value: 0.7, guardrails: { tests_passed: 1 } },
    { value: 0.8, guardrails: { tests_passed: 0 } }
  );

  assert.equal(ok.candidate_outcome, 'win');
  assert.equal(ok.no_regression, true);
  assert.equal(regressed.candidate_outcome, 'loss');
  assert.equal(regressed.reason, 'guardrail_regression');
  assert.equal(regressed.no_regression, false);
  assert.equal(regressed.guardrail_regressions[0].metric, 'tests_passed');
});

test('runSkillEvaluation records deterministic case-based measurements', () => {
  const ws = makeWorkspace();
  const { active, candidate } = makeVersions(ws);
  const cases = [
    { id: 'simple', active: 0.6, candidate: 0.8 },
    { id: 'edge', active: 0.7, candidate: 0.9 },
  ];

  const result = runSkillEvaluation(ws, {
    active_version_id: active.version_id,
    candidate_version_id: candidate.version_id,
    metric_spec: { metric: 'quality', direction: 'max' },
    cases,
    evaluate: ({ role, test_case }) => ({ value: test_case[role] }),
    agent_id: 'worker-runner',
    run_id: 'run-1',
    now: '2026-06-21T12:05:00.000Z',
  });
  const row = readSkillEvaluationRecords(ws)[0];

  assert.equal(result.created, true);
  assert.equal(row.evaluation_type, 'deterministic_cases');
  assert.deepEqual(row.case_ids, ['simple', 'edge']);
  assert(near(row.measurements.active.value, 0.65));
  assert(near(row.measurements.candidate.value, 0.85));
  assert.equal(row.measurements.candidate.sample_count, 2);
  assert.equal(row.measurements.candidate.samples[1].case_id, 'edge');
  assert.equal(row.comparison.candidate_outcome, 'win');
  assert.equal(row.provenance.run_id, 'run-1');
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
