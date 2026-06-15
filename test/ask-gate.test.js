#!/usr/bin/env node
// Plain Node test (no framework; matches test/context-gate.test.js style) for the ask-vs-predict
// preference gate (lib/ask-gate.js). Run: node test/ask-gate.test.js — exits non-zero on any failure.
//
// Covers:
//   1. PREDICT on a confident, specific, empirical, project-local preference match.
//   2. ASK on no match / low confidence / empty / no-preference.
//   3. HARD OVERRIDE: irreversible/outward/high-impact/scope/repeated decisions ALWAYS ask, even
//      with a perfect preference match — via caller flags AND keyword heuristics on the decision.
//   4. JOURNAL: a gate verdict appends a parseable, schema-correct row to .graph/ask-journal.jsonl
//      (parallels test/gate-journal.test.js's schema assertions — this is the T3 training corpus).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { askGate, hardOverride } = require('../lib/ask-gate');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Deterministic synthetic scorer: note.vec[0] is the literal cosine we want it to get.
const fakeCosine = (_q, v) => (Array.isArray(v) ? v[0] : 0);
const fakeEmbed = async () => [1]; // non-null ⇒ semantic path engages
const semanticOpts = (over) => ({ embedQuery: fakeEmbed, cosine: fakeCosine, ...over });

(async () => {
  // ---- 1. PREDICT on a confident, specific, empirical, project-local preference match ----------
  {
    // A concrete stored preference: measured + identifier + observed-on-real-data ⇒ locality >= 2,
    // empirical signature ("chose … over … because"), and shares the decision's vocabulary (high gap).
    const notes = [
      { key: 'pref', title: 'merge style preference',
        summary: 'chose squash-merge over merge-commit for orch/attempt branches because the linear history halved the bisect time (measured 12/12 attempts); always squash mergeAttempt branches',
        vec: [0.82] },
      { key: 'other', title: 'unrelated', summary: 'general note about token cost', vec: [0.30] }, // margin 0.52
    ];
    const decision = 'should I squash-merge or merge-commit this orch/attempt branch on mergeAttempt';
    const r = await askGate(decision, notes, semanticOpts());
    ok('predict on confident+specific+empirical+local preference',
       r.decision === 'predict' && r.topKey === 'pref' && r.topType === 'empirical' && r.via === 'semantic');
    ok('predict returns the matched note', r.appliedNote && r.appliedNote.key === 'pref');
  }

  // ---- 2. ASK on no match / low confidence / empty / no-preference -----------------------------
  {
    const notes = [
      { key: 'n1', title: 'vaguely related', summary: 'chose X over Y because of a measured 40% thing on real data', vec: [0.40] },
      { key: 'n2', title: 'other', summary: 'general note', vec: [0.20] },
    ];
    const r = await askGate('some unrelated pending decision', notes, semanticOpts());
    ok('ask on low confidence (top1 0.40 < 0.50)', r.decision === 'ask' && r.reason === 'low-confidence');

    const rEmpty = await askGate('', notes, semanticOpts());
    ok('ask on empty decision', rEmpty.decision === 'ask' && rEmpty.reason === 'empty-query');

    const rNone = await askGate('a real decision', [], semanticOpts());
    ok('ask on no preference notes', rNone.decision === 'ask' && rNone.reason === 'no-preference');

    // High cosine but the note is a general principle (not a concrete preference) ⇒ ask.
    const principleNotes = [
      { key: 'p1', title: 'style', summary: 'always prefer small functions as a best practice', vec: [0.80] },
      { key: 'p2', title: 'other', summary: 'unrelated', vec: [0.30] },
    ];
    const rPrin = await askGate('how should I structure this module', principleNotes, semanticOpts());
    ok('ask on non-empirical (general principle) top note', rPrin.decision === 'ask' && rPrin.reason === 'non-empirical');
  }

  // ---- 3. HARD OVERRIDE: always ask, even with a perfect match ---------------------------------
  {
    // A perfect preference match that WOULD predict — but the decision is irreversible.
    const perfect = [
      { key: 'pref', title: 'delete preference',
        summary: 'chose to delete stale worktrees automatically because the disk filled (measured 3/3 times on real data); always GC them via removeWorktree',
        vec: [0.90] },
    ];
    // 3a. keyword heuristic ("delete" / "force-push") fires the override.
    const rKw = await askGate('should I delete the orch/attempt worktree and force-push main', perfect, semanticOpts());
    ok('hard-override via keyword (delete/force-push) always asks', rKw.decision === 'ask' && rKw.reason === 'hard-override');
    ok('hard-override reports a category', typeof rKw.overrideCategory === 'string' && rKw.override === true);

    // 3b. caller flag fires the override even when the text has no trigger word.
    const rFlag = await askGate('apply the cleanup the user prefers', perfect, semanticOpts({ irreversible: true }));
    ok('hard-override via caller flag always asks', rFlag.decision === 'ask' && rFlag.reason === 'hard-override' && rFlag.overrideCategory === 'irreversible');

    // 3c. outward-facing keyword.
    ok('outward-facing keyword triggers override', hardOverride('email the customer about the launch').override === true);
    // 3d. high-impact keyword.
    ok('high-impact keyword triggers override', hardOverride('rotate the production api-key').override === true);
    // 3e. a benign decision does NOT override.
    ok('benign decision does not override', hardOverride('which variable name should I use here').override === false);
  }

  // ---- 4. JOURNAL: a verdict appends a parseable, schema-correct row ----------------------------
  // The route does the append; here we exercise the SAME append shape against a temp .graph to lock
  // the T3 training-corpus schema (ts/workspace/query/decision/reason/top1/margin/gap/locality/
  // topKey/gated/override/...). Mirrors test/gate-journal.test.js's per-field assertions.
  {
    const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ask-gate-journal-')));
    fs.mkdirSync(path.join(WS, '.graph'), { recursive: true });
    const JOURNAL = path.join(WS, '.graph', 'ask-journal.jsonl');

    const notes = [{ key: 'pref', title: 'pref', summary: 'chose A over B because measured 9/9 on real data; always pick A', vec: [0.82] },
                   { key: 'o', title: 'o', summary: 'x', vec: [0.30] }];
    const r = await askGate('which should I pick, A or B, per the measured preference', notes, semanticOpts());
    // Append exactly the row the route writes.
    const row = {
      ts: new Date().toISOString(), workspace: WS, query: 'which should I pick, A or B',
      decision: r.decision, reason: r.reason,
      top1: r.top1, margin: r.margin, gap: r.gap, locality: r.locality, tagOverlap: r.tagOverlap, sharedTags: r.sharedTags,
      topType: r.topType, topKey: r.topKey || null, via: r.via,
      override: r.override, overrideCategory: r.overrideCategory,
      embedModel: 'Xenova/all-MiniLM-L6-v2', gated: true, prefCands: notes.length,
    };
    fs.appendFileSync(JOURNAL, JSON.stringify(row) + '\n');

    ok('journal: file exists after append', fs.existsSync(JOURNAL));
    const parsed = fs.readFileSync(JOURNAL, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    ok('journal: exactly one row', parsed.length === 1);
    const jr = parsed[0];
    ok('journal row: ts is ISO', typeof jr.ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(jr.ts));
    ok('journal row: workspace present', typeof jr.workspace === 'string');
    ok('journal row: query present', typeof jr.query === 'string');
    ok('journal row: decision is ask|predict', jr.decision === 'ask' || jr.decision === 'predict');
    ok('journal row: reason present', typeof jr.reason === 'string');
    ok('journal row: top1 is a number', typeof jr.top1 === 'number');
    ok('journal row: margin/gap/locality present', typeof jr.margin === 'number' && typeof jr.gap === 'number' && typeof jr.locality === 'number');
    ok('journal row: topKey field present (null ok)', Object.prototype.hasOwnProperty.call(jr, 'topKey'));
    ok('journal row: override is boolean', typeof jr.override === 'boolean');
    ok('journal row: gated is true', jr.gated === true);
    ok('journal row: embedModel correct', jr.embedModel === 'Xenova/all-MiniLM-L6-v2');

    try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e && (e.stack || e.message)); process.exit(1); });
