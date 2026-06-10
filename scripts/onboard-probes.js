#!/usr/bin/env node
'use strict';
/**
 * onboard-probes.js — onboarding-competence probe generator.
 *
 * A probe is a PROJECT-SPECIFIC question with a machine-checkable rubric. It exists to measure
 * ONBOARDING COMPETENCE: does a KB-equipped agent answer correctly where a COLD agent (no KB)
 * cannot? The hard-won v5 lesson: probes MUST be calibrated so a cold agent scores < 1.0 — if both
 * arms ace everything there is NO signal. So each probe targets a NON-OBVIOUS fact (a convention,
 * invariant, or gotcha) that is captured in a validated KB note but is NOT inferable from a quick
 * skim of the code.
 *
 * Rubric is deterministic: an answer is CORRECT iff it mentions ALL `require` concepts (case-insensitive
 * substring/alias match) AND none of the `forbid` (a confidently-wrong answer the cold agent tends to give).
 *
 * Each probe is DERIVED from a kept KB note (so the KB demonstrably carries the answer) but the probe
 * text never leaks the note — it asks the underlying project question.
 *
 *   node scripts/onboard-probes.js --notes <onboard-notes.json> [--out <probes.json>]
 *        # derive probe STUBS from kept notes (skeletons to refine), OR
 *   node scripts/onboard-probes.js --validate <probes.json>
 *        # check a (hand-calibrated) probe file's rubric shape
 *
 * Probe shape: { id, question, require:[..aliases per concept..], forbid:[..], note_ref, hint }
 *   - require: array of concept-groups; each group is an array of acceptable aliases (ANY alias in a
 *     group satisfies that concept). ALL groups must be satisfied.
 */

const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

// Derive a probe STUB from a kept note: the question is a generic "what/why" framing; require/forbid
// are left for human/agent calibration (we can't auto-guess the cold agent's wrong answer reliably).
function stubFromNote(note, i) {
  return {
    id: `p${i + 1}`,
    question: `(REFINE) Concerning this project: ${note.title}?`,
    require: [],
    forbid: [],
    note_ref: note.title,
    hint: note.summary.slice(0, 120),
  };
}

function validate(probes) {
  let ok = true;
  for (const p of probes) {
    if (!p.id || !p.question || !Array.isArray(p.require)) {
      console.error(`BAD probe (missing id/question/require): ${JSON.stringify(p).slice(0, 80)}`); ok = false; continue;
    }
    if (p.require.length === 0) { console.error(`probe ${p.id}: empty require[] — will trivially pass (no signal)`); ok = false; }
    for (const g of p.require) if (!Array.isArray(g) || g.length === 0) { console.error(`probe ${p.id}: require group must be a non-empty alias array`); ok = false; }
    if (!Array.isArray(p.forbid)) { console.error(`probe ${p.id}: forbid must be an array (may be empty)`); ok = false; }
  }
  return ok;
}

// A forbidden phrase only counts when ASSERTED, not when negated/refuted. A correct answer often
// names the wrong belief to reject it ("never forces or auto-resolves", "NOT embeddings", "unsafe
// to write"), and a naive substring match would wrongly penalize that. So we ignore an occurrence
// whose immediately-preceding ~24 chars carry a negator (not/no/never/n't/un-/rather than/without/
// instead of). Returns true iff at least one occurrence is asserted (un-negated).
const NEG_RE = /\b(not|no|never|don'?t|does\s?n'?t|is\s?n'?t|are\s?n'?t|cannot|can'?t|without|rather than|instead of|avoid|un)\s*$/i;
function assertedForbidden(answer, phrase) {
  const a = answer; // already lowercased
  const f = String(phrase).toLowerCase();
  let idx = a.indexOf(f);
  while (idx !== -1) {
    const before = a.slice(Math.max(0, idx - 24), idx);
    // also treat a directly-prefixed "un"/"in" (unsafe, insecure) as negation of the bare token
    const gluedNeg = /(?:^|[^a-z])(un|in)$/i.test(before.replace(/\s+$/, ''));
    if (!NEG_RE.test(before) && !gluedNeg) return true; // an asserted occurrence
    idx = a.indexOf(f, idx + f.length);
  }
  return false;
}

// Score one answer against one probe. Returns { correct, missing:[], hit_forbidden:[] }.
function score(probe, answer) {
  const a = String(answer || '').toLowerCase();
  const missing = [];
  for (const group of probe.require) {
    const hit = group.some((alias) => a.includes(String(alias).toLowerCase()));
    if (!hit) missing.push(group[0]);
  }
  const hitForbidden = (probe.forbid || []).filter((f) => assertedForbidden(a, f));
  return { correct: missing.length === 0 && hitForbidden.length === 0, missing, hit_forbidden: hitForbidden };
}

module.exports = { score, validate };

if (require.main === module) {
  const validatePath = arg('validate');
  if (validatePath) {
    const probes = JSON.parse(fs.readFileSync(path.resolve(validatePath), 'utf8'));
    const ok = validate(probes);
    console.log(`${probes.length} probes — ${ok ? 'OK (all rubrics well-formed)' : 'PROBLEMS (see above)'}`);
    process.exit(ok ? 0 : 1);
  }
  const notesPath = arg('notes');
  if (!notesPath) { console.error('usage: onboard-probes.js --notes <onboard-notes.json> [--out <probes.json>] | --validate <probes.json>'); process.exit(2); }
  const data = JSON.parse(fs.readFileSync(path.resolve(notesPath), 'utf8'));
  const stubs = (data.kept || []).map(stubFromNote);
  const out = arg('out');
  const json = JSON.stringify(stubs, null, 2) + '\n';
  if (out) { fs.writeFileSync(path.resolve(out), json); console.error(`wrote ${stubs.length} probe stubs -> ${out} (REFINE require/forbid before use)`); }
  else process.stdout.write(json);
}
