#!/usr/bin/env node
'use strict';
/**
 * onboard-probes.js — onboarding-competence probe SCHEMA + validator.
 *
 * A probe poses a REALISTIC project scenario/task whose correct resolution requires project
 * knowledge, and carries a plain-English RUBRIC describing what a functionally-correct answer must
 * conclude or do. Grading is APPLIED-CORRECTNESS by an LLM judge (see onboard-harness.js) — there is
 * deliberately NO require/forbid keyword scorer here. (The v1 harness graded by substring-matching
 * the answer against the notes' own keywords; that was circular — it measured note-recall, not
 * competence, and pinned cold-rate to exactly 0. This rewrite removes that mechanism entirely.)
 *
 * Two probe kinds:
 *   kind:"project"  — correct resolution depends on a NON-OBVIOUS project fact (a KB note should
 *                     help here). The scenario must NOT quote/paraphrase the note; it stands alone
 *                     as a real situation derived from the codebase.
 *   kind:"control"  — a VALIDITY control: solvable from general engineering knowledge with NO project
 *                     KB. A valid harness MUST show a cold agent passing the controls while failing
 *                     the project probes — i.e. cold-rate strictly between 0 and 1. If cold-rate is
 *                     0 or 1 across the board the harness is STILL broken (see onboard-harness guard).
 *
 * Probe shape: { id, kind:"project"|"control", scenario, rubric, retrieval_query }
 *   - scenario        : the task/question shown to BOTH arms (no note wording leaked).
 *   - rubric          : plain-English PASS/FAIL criteria; given to the judge, NEVER to the answerer.
 *   - retrieval_query : lexical query the KB arm sends to GET /search to pull [ingest] notes.
 *
 *   node scripts/onboard-probes.js --validate <probes.json>   # check probe-file shape
 */

const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function validate(probes) {
  let ok = true;
  if (!Array.isArray(probes)) { console.error('probes file must be a JSON array'); return false; }
  const seen = new Set();
  for (const p of probes) {
    const id = p && p.id;
    if (!id) { console.error(`BAD probe (missing id): ${JSON.stringify(p).slice(0, 80)}`); ok = false; continue; }
    if (seen.has(id)) { console.error(`probe ${id}: duplicate id`); ok = false; }
    seen.add(id);
    if (p.kind !== 'project' && p.kind !== 'control') { console.error(`probe ${id}: kind must be "project" or "control"`); ok = false; }
    if (typeof p.scenario !== 'string' || p.scenario.trim().length < 20) { console.error(`probe ${id}: scenario must be a non-trivial string`); ok = false; }
    if (typeof p.rubric !== 'string' || p.rubric.trim().length < 20) { console.error(`probe ${id}: rubric must be a non-trivial string`); ok = false; }
    if (p.kind === 'project' && (typeof p.retrieval_query !== 'string' || !p.retrieval_query.trim())) {
      console.error(`probe ${id}: project probe needs a retrieval_query (KB arm searches with it)`); ok = false;
    }
    // Guard against the old circular shape sneaking back in.
    if ('require' in p || 'forbid' in p) { console.error(`probe ${id}: legacy require/forbid keyword fields are not allowed (grading is LLM applied-correctness)`); ok = false; }
  }
  const nProject = probes.filter((p) => p.kind === 'project').length;
  const nControl = probes.filter((p) => p.kind === 'control').length;
  if (nControl < 3) { console.error(`only ${nControl} control probe(s); need >=3 for a valid cold-rate validity check`); ok = false; }
  if (nProject < 1) { console.error('no project probes'); ok = false; }
  if (ok) console.error(`shape OK: ${nProject} project + ${nControl} control = ${probes.length} probes`);
  return ok;
}

module.exports = { validate };

if (require.main === module) {
  const validatePath = arg('validate');
  if (!validatePath) { console.error('usage: onboard-probes.js --validate <probes.json>'); process.exit(2); }
  const probes = JSON.parse(fs.readFileSync(path.resolve(validatePath), 'utf8'));
  const ok = validate(probes);
  console.log(`${probes.length} probes — ${ok ? 'OK (well-formed)' : 'PROBLEMS (see above)'}`);
  process.exit(ok ? 0 : 1);
}
