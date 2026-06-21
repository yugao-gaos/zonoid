'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  skillIdentity,
  pathsFor,
  readVersionRecords,
  getActiveSkillVersion,
} = require('./skill-versions');

const EVALUATION_SCHEMA_VERSION = 1;

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

function finiteNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a finite number`);
  return n;
}

function normalizeDirection(value, label) {
  if (value !== 'min' && value !== 'max') throw new Error(`${label} direction must be "min" or "max"`);
  return value;
}

function normalizeTolerance(value, label) {
  if (value == null || value === '') return 0;
  const n = finiteNumber(value, `${label} tolerance`);
  if (n < 0) throw new Error(`${label} tolerance must be >= 0`);
  return n;
}

function normalizeMetricSpec(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('metric spec must be an object');
  const metric = cleanString(input.metric || input.name);
  if (!metric) throw new Error('metric spec requires metric');
  const spec = {
    metric,
    direction: normalizeDirection(input.direction, `metric ${metric}`),
    tolerance: normalizeTolerance(input.tolerance, `metric ${metric}`),
    guardrails: [],
  };
  const unit = cleanString(input.unit);
  if (unit) spec.unit = unit;

  if (input.guardrails != null) {
    if (!Array.isArray(input.guardrails)) throw new Error('metric guardrails must be an array');
    spec.guardrails = input.guardrails.map((guardrail, index) => {
      if (!guardrail || typeof guardrail !== 'object' || Array.isArray(guardrail)) {
        throw new Error(`guardrail ${index + 1} must be an object`);
      }
      const guardMetric = cleanString(guardrail.metric || guardrail.name);
      if (!guardMetric) throw new Error(`guardrail ${index + 1} requires metric`);
      const out = {
        metric: guardMetric,
        direction: normalizeDirection(guardrail.direction, `guardrail ${guardMetric}`),
        tolerance: normalizeTolerance(guardrail.tolerance, `guardrail ${guardMetric}`),
      };
      const guardUnit = cleanString(guardrail.unit);
      if (guardUnit) out.unit = guardUnit;
      return out;
    });
  }

  return spec;
}

function normalizeGuardrails(input, label) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  for (const key of Object.keys(source).sort()) {
    const metric = cleanString(key);
    if (!metric) continue;
    out[metric] = finiteNumber(source[key], `${label} guardrail ${metric}`);
  }
  return out;
}

function normalizeSample(input, label) {
  const measurement = normalizeMeasurement(input, label);
  const caseId = cleanString(input && input.case_id);
  const out = {
    value: measurement.value,
    guardrails: measurement.guardrails,
  };
  if (caseId) out.case_id = caseId;
  return out;
}

function normalizeMeasurement(input, label = 'measurement') {
  if (typeof input === 'number') return { value: finiteNumber(input, label), guardrails: {} };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${label} must be a number or object`);
  const out = {
    value: finiteNumber(input.value, `${label}.value`),
    guardrails: normalizeGuardrails(input.guardrails, label),
  };
  if (input.sample_count != null) {
    const sampleCount = finiteNumber(input.sample_count, `${label}.sample_count`);
    if (!Number.isInteger(sampleCount) || sampleCount < 0) throw new Error(`${label}.sample_count must be a non-negative integer`);
    out.sample_count = sampleCount;
  }
  if (Array.isArray(input.samples)) out.samples = input.samples.map((sample, index) => normalizeSample(sample, `${label}.samples[${index}]`));
  return out;
}

function compareValue(metric, activeValue, candidateValue) {
  const delta = candidateValue - activeValue;
  let result = 'tie';
  if (metric.direction === 'max') {
    if (candidateValue > activeValue + metric.tolerance) result = 'better';
    else if (candidateValue < activeValue - metric.tolerance) result = 'worse';
  } else if (candidateValue < activeValue - metric.tolerance) result = 'better';
  else if (candidateValue > activeValue + metric.tolerance) result = 'worse';

  return {
    metric: metric.metric,
    direction: metric.direction,
    tolerance: metric.tolerance,
    active_value: activeValue,
    candidate_value: candidateValue,
    delta,
    result,
  };
}

function compareMeasurements(metricSpec, activeMeasurement, candidateMeasurement) {
  const spec = normalizeMetricSpec(metricSpec);
  const active = normalizeMeasurement(activeMeasurement, 'active measurement');
  const candidate = normalizeMeasurement(candidateMeasurement, 'candidate measurement');
  const primary = compareValue(spec, active.value, candidate.value);
  const guardrails = [];
  const guardrailRegressions = [];
  const missingGuardrails = [];

  for (const guardrail of spec.guardrails) {
    const activeHas = Object.prototype.hasOwnProperty.call(active.guardrails, guardrail.metric);
    const candidateHas = Object.prototype.hasOwnProperty.call(candidate.guardrails, guardrail.metric);
    const item = {
      metric: guardrail.metric,
      direction: guardrail.direction,
      tolerance: guardrail.tolerance,
      active_value: activeHas ? active.guardrails[guardrail.metric] : null,
      candidate_value: candidateHas ? candidate.guardrails[guardrail.metric] : null,
      result: 'missing',
    };
    if (activeHas && candidateHas) {
      const compared = compareValue(guardrail, active.guardrails[guardrail.metric], candidate.guardrails[guardrail.metric]);
      Object.assign(item, compared);
      if (compared.result === 'worse') guardrailRegressions.push(item);
    } else {
      missingGuardrails.push(item);
    }
    guardrails.push(item);
  }

  const noRegression = guardrailRegressions.length === 0 && missingGuardrails.length === 0;
  let candidateOutcome = 'tie';
  let verdict = 'tie';
  let reason = 'primary_tie';
  if (missingGuardrails.length) {
    candidateOutcome = 'loss';
    verdict = 'active_won';
    reason = 'guardrail_measurement_missing';
  } else if (guardrailRegressions.length) {
    candidateOutcome = 'loss';
    verdict = 'active_won';
    reason = 'guardrail_regression';
  } else if (primary.result === 'better') {
    candidateOutcome = 'win';
    verdict = 'candidate_won';
    reason = 'primary_better';
  } else if (primary.result === 'worse') {
    candidateOutcome = 'loss';
    verdict = 'active_won';
    reason = 'primary_worse';
  }

  return {
    metric: spec.metric,
    direction: spec.direction,
    candidate_outcome: candidateOutcome,
    verdict,
    reason,
    no_regression: noRegression,
    primary,
    guardrails,
    guardrail_regressions: guardrailRegressions,
    missing_guardrails: missingGuardrails,
  };
}

function evaluationPath(workspace) {
  return path.join(pathsFor(workspace).dir, 'evaluations.jsonl');
}

function readSkillEvaluationRecords(workspace) {
  let raw;
  try { raw = fs.readFileSync(evaluationPath(workspace), 'utf8'); } catch { return []; }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === 'object' && typeof record.evaluation_id === 'string') records.push(record);
    } catch { /* ignore partial/corrupt rows */ }
  }
  return records;
}

function versionById(workspace, versionId) {
  return readVersionRecords(workspace).find((record) => record.version_id === versionId) || null;
}

function hasIdentityInput(input) {
  return !!(input.skill_id || input.identity || input.key || input.skill_path || input.target_path || input.path || input.name || input.skill_name || input.title);
}

function resolveVersions(workspace, input = {}) {
  const candidateVersionId = cleanString(input.candidate_version_id || (input.candidate && input.candidate.version_id));
  if (!candidateVersionId) throw new Error('candidate_version_id is required');
  const candidate = versionById(workspace, candidateVersionId);
  if (!candidate) throw new Error(`unknown candidate version: ${candidateVersionId}`);

  let activeVersionId = cleanString(input.active_version_id || (input.active && input.active.version_id));
  const explicitActiveVersionId = !!activeVersionId;
  let active = activeVersionId ? versionById(workspace, activeVersionId) : null;
  if (explicitActiveVersionId && !active) throw new Error(`unknown active version: ${activeVersionId}`);
  if (!active) active = getActiveSkillVersion(workspace, { skill_id: candidate.skill_id });
  if (!active) throw new Error('active_version_id is required when the skill has no active version');
  activeVersionId = active.version_id;

  if (activeVersionId === candidateVersionId) throw new Error('candidate_version_id must differ from active_version_id');
  if (active.skill_id !== candidate.skill_id) throw new Error('candidate_version_id and active_version_id must belong to the same skill');
  if (hasIdentityInput(input) && skillIdentity(input).skill_id !== candidate.skill_id) {
    throw new Error('requested skill identity does not match evaluated versions');
  }

  return {
    skill_id: candidate.skill_id,
    slug: candidate.slug || candidate.skill_id.slice('skill:'.length),
    active,
    candidate,
  };
}

function normalizeProvenance(input, now) {
  const source = input.provenance && typeof input.provenance === 'object' ? input.provenance : {};
  return {
    recorded_at: now,
    recorded_by: cleanString(source.recorded_by || input.recorded_by || input.agent_id) || null,
    task_key: cleanString(source.task_key || input.task_key) || null,
    source: cleanString(source.source || input.source) || null,
    run_id: cleanString(source.run_id || input.run_id) || null,
    notes: cleanString(source.notes || input.notes) || null,
  };
}

function evaluationIdFor(input = {}) {
  const seed = {
    skill_id: input.skill_id,
    active_version_id: input.active_version_id,
    candidate_version_id: input.candidate_version_id,
    evaluation_type: input.evaluation_type,
    case_ids: input.case_ids || [],
    metric_spec: input.metric_spec,
    measurements: input.measurements,
  };
  return `ske_${hash(stableJson(seed))}`;
}

function recordSkillEvaluation(workspace, input = {}) {
  const versions = resolveVersions(workspace, input);
  const metricSpec = normalizeMetricSpec(input.metric_spec || input.metric || input.spec);
  const measurements = input.measurements && typeof input.measurements === 'object' ? input.measurements : {};
  const activeInput = hasOwn(input, 'active_measurement') ? input.active_measurement : measurements.active;
  const candidateInput = hasOwn(input, 'candidate_measurement') ? input.candidate_measurement : measurements.candidate;
  const activeMeasurement = normalizeMeasurement(activeInput, 'active measurement');
  const candidateMeasurement = normalizeMeasurement(candidateInput, 'candidate measurement');
  const comparison = compareMeasurements(metricSpec, activeMeasurement, candidateMeasurement);
  const now = cleanString(input.now) || new Date().toISOString();
  const evaluationType = cleanString(input.evaluation_type) || 'supplied_measurements';
  const caseIds = Array.isArray(input.case_ids) ? input.case_ids.map(cleanString).filter(Boolean) : [];
  const normalizedMeasurements = { active: activeMeasurement, candidate: candidateMeasurement };
  const record = {
    schema_version: EVALUATION_SCHEMA_VERSION,
    evaluation_id: evaluationIdFor({
      skill_id: versions.skill_id,
      active_version_id: versions.active.version_id,
      candidate_version_id: versions.candidate.version_id,
      evaluation_type: evaluationType,
      case_ids: caseIds,
      metric_spec: metricSpec,
      measurements: normalizedMeasurements,
    }),
    skill_id: versions.skill_id,
    slug: versions.slug,
    active_version_id: versions.active.version_id,
    candidate_version_id: versions.candidate.version_id,
    evaluation_type: evaluationType,
    case_ids: caseIds,
    metric_spec: metricSpec,
    measurements: normalizedMeasurements,
    comparison,
    provenance: normalizeProvenance(input, now),
    created_at: now,
  };

  const existing = readSkillEvaluationRecords(workspace).find((item) => item.evaluation_id === record.evaluation_id);
  if (existing) return { ok: true, created: false, record: existing };

  fs.mkdirSync(pathsFor(workspace).dir, { recursive: true });
  fs.appendFileSync(evaluationPath(workspace), JSON.stringify(record) + '\n');
  return { ok: true, created: true, record };
}

function caseIdFor(testCase, index) {
  if (testCase && typeof testCase === 'object') {
    const id = cleanString(testCase.id || testCase.key || testCase.name);
    if (id) return id;
  }
  return String(index + 1);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aggregateSamples(samples) {
  if (!samples.length) throw new Error('at least one sample is required');
  const guardrailKeys = [...new Set(samples.flatMap((sample) => Object.keys(sample.guardrails || {})))].sort();
  const guardrails = {};
  for (const key of guardrailKeys) {
    const values = samples.map((sample) => sample.guardrails[key]).filter(Number.isFinite);
    if (values.length === samples.length) guardrails[key] = average(values);
  }
  return {
    value: average(samples.map((sample) => sample.value)),
    guardrails,
    sample_count: samples.length,
    samples,
  };
}

function runSkillEvaluation(workspace, input = {}) {
  const cases = Array.isArray(input.cases) ? input.cases : [];
  if (!cases.length) throw new Error('cases must be a non-empty array');
  const evaluate = input.evaluate || input.score;
  if (typeof evaluate !== 'function') throw new Error('evaluate function is required');
  const versions = resolveVersions(workspace, input);
  const activeSamples = [];
  const candidateSamples = [];
  const caseIds = cases.map(caseIdFor);

  cases.forEach((testCase, index) => {
    const case_id = caseIds[index];
    activeSamples.push(normalizeSample({
      ...normalizeMeasurement(evaluate({
        role: 'active',
        version: versions.active,
        test_case: testCase,
        index,
        skill_id: versions.skill_id,
      }), `active sample ${case_id}`),
      case_id,
    }, `active sample ${case_id}`));
    candidateSamples.push(normalizeSample({
      ...normalizeMeasurement(evaluate({
        role: 'candidate',
        version: versions.candidate,
        test_case: testCase,
        index,
        skill_id: versions.skill_id,
      }), `candidate sample ${case_id}`),
      case_id,
    }, `candidate sample ${case_id}`));
  });

  return recordSkillEvaluation(workspace, {
    active_version_id: versions.active.version_id,
    candidate_version_id: versions.candidate.version_id,
    metric_spec: input.metric_spec || input.metric || input.spec,
    evaluation_type: cleanString(input.evaluation_type) || 'deterministic_cases',
    case_ids: caseIds,
    measurements: {
      active: aggregateSamples(activeSamples),
      candidate: aggregateSamples(candidateSamples),
    },
    provenance: input.provenance,
    agent_id: input.agent_id,
    recorded_by: input.recorded_by,
    task_key: input.task_key,
    source: input.source,
    run_id: input.run_id,
    notes: input.notes,
    now: input.now,
  });
}

function listSkillEvaluations(workspace, input = {}) {
  const identity = hasIdentityInput(input) ? skillIdentity(input).skill_id : null;
  const activeVersionId = cleanString(input.active_version_id);
  const candidateVersionId = cleanString(input.candidate_version_id);
  return readSkillEvaluationRecords(workspace).filter((record) => {
    if (identity && record.skill_id !== identity) return false;
    if (activeVersionId && record.active_version_id !== activeVersionId) return false;
    if (candidateVersionId && record.candidate_version_id !== candidateVersionId) return false;
    return true;
  });
}

module.exports = {
  EVALUATION_SCHEMA_VERSION,
  evaluationPath,
  normalizeMetricSpec,
  normalizeMeasurement,
  compareMeasurements,
  evaluationIdFor,
  recordSkillEvaluation,
  runSkillEvaluation,
  readSkillEvaluationRecords,
  listSkillEvaluations,
};
