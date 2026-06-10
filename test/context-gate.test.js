#!/usr/bin/env node
// Plain Node test (no framework; matches test/search-knowledge.test.js + test/embed.test.js style)
// for the context-need gate (lib/context-gate.js). Run: node test/context-gate.test.js — exits
// non-zero on any failed assertion.
//
// Covers:
//   1. note-TYPE classifier: empirical scar-tissue vs general principle vs neutral.
//   2. ABSTAIN guards (using a deterministic injected cosine, no model needed):
//        - low confidence (top1 below cosThreshold) -> abstain
//        - diffuse match (small margin, a cluster of near-ties) -> abstain
//        - non-empirical top note (general principle) -> abstain
//   3. INJECT only on sharp + specific + empirical.
//   4. DEFAULTs: no notes / empty query -> abstain.
//   5. POSITIVE-CASE SANITY with REAL embeddings (skips if model unavailable): a hand-made sharp,
//      specific, EMPIRICAL note + a matching query -> the gate INJECTS. Proves it's not "always abstain".
'use strict';

const { gateTask, classifyNoteType } = require('../lib/context-gate');
const { embed, cosine } = require('../lib/embed');

let pass = 0, fail = 0, skip = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };
const skipped = (label, why) => { console.log(`SKIP  ${label} (${why})`); skip++; };

// A deterministic "cosine" for the synthetic tests: each note carries a literal vec[0] = the score
// we want it to get; cosine just returns it. Lets us drive the guards without the model.
const fakeCosine = (_q, v) => (Array.isArray(v) ? v[0] : 0);
const fakeEmbed = async () => [1]; // non-null ⇒ semantic path engages
const semanticOpts = (over) => ({ embedQuery: fakeEmbed, cosine: fakeCosine, ...over });

(async () => {
  // ---- 1. note-TYPE classifier --------------------------------------------------------------
  ok('classify: gotcha is empirical', classifyNoteType('gotcha: the migration fails on the down step because the FK is dropped first') === 'empirical');
  ok('classify: decision-with-reason is empirical', classifyNoteType('chose Postgres over Mongo because we need transactional joins') === 'empirical');
  ok('classify: root-cause is empirical', classifyNoteType('root cause: self-signed certs fail on issuer-trust, not locality') === 'empirical');
  ok('classify: version-pin is empirical', classifyNoteType('pin transformers to version 2.17.2; 3.x breaks the ONNX loader') === 'empirical');
  ok('classify: general principle is principle', classifyNoteType('always prefer composition over inheritance as a best practice') === 'principle');
  ok('classify: bare statement is neutral', classifyNoteType('the dashboard lives at localhost 8787') === 'neutral');
  ok('classify: empty is neutral', classifyNoteType('') === 'neutral');

  // ---- 2a. ABSTAIN: low confidence (top1 below threshold) -----------------------------------
  {
    const notes = [
      { key: 'n1', title: 'vaguely related thing', summary: 'gotcha it fails because of a thing', vec: [0.40] },
      { key: 'n2', title: 'other', summary: 'general note', vec: [0.20] },
    ];
    const r = await gateTask({ label: 'do a task', summary: 'some work' }, notes, semanticOpts());
    ok('abstain on low confidence (top1 0.40 < 0.55)', r.decision === 'abstain' && r.reason === 'low-confidence');
  }

  // ---- 2b. ABSTAIN: diffuse match (high top1 but tiny margin — a cluster of near-ties) -------
  {
    const notes = [
      { key: 'n1', title: 'topic A', summary: 'gotcha fails because reasons', vec: [0.70] },
      { key: 'n2', title: 'topic B', summary: 'gotcha also fails because reasons', vec: [0.66] }, // margin 0.04
    ];
    const r = await gateTask({ label: 'do a task', summary: 'work' }, notes, semanticOpts());
    ok('abstain on diffuse match (margin 0.04 < 0.12)', r.decision === 'abstain' && r.reason === 'diffuse-match');
  }

  // ---- 2c. ABSTAIN: high+sharp but the top note is a GENERAL PRINCIPLE -----------------------
  {
    const notes = [
      { key: 'n1', title: 'style guidance', summary: 'always prefer small functions; best practice', vec: [0.80] },
      { key: 'n2', title: 'other', summary: 'unrelated', vec: [0.30] }, // margin 0.50, sharp
    ];
    const r = await gateTask({ label: 'refactor module', summary: 'split functions' }, notes, semanticOpts());
    ok('abstain on non-empirical top note (principle)', r.decision === 'abstain' && r.reason === 'non-empirical' && r.topType === 'principle');
  }

  // ---- 3. INJECT: sharp + specific + empirical ----------------------------------------------
  {
    const notes = [
      { key: 'n1', title: 'cwd hijack', summary: 'gotcha: a malicious task hijacks the worker cwd because workspace is unpinned; pin it to the daemon root', vec: [0.82] },
      { key: 'n2', title: 'other', summary: 'unrelated topic', vec: [0.30] }, // margin 0.52
    ];
    const r = await gateTask({ label: 'harden worker workspace', summary: 'prevent cwd takeover' }, notes, semanticOpts());
    ok('inject on sharp+specific+empirical', r.decision === 'inject' && r.topType === 'empirical' && r.via === 'semantic');
  }

  // ---- 4. DEFAULTS: empty query / no notes --------------------------------------------------
  {
    const r1 = await gateTask({ label: '', summary: '' }, [{ vec: [0.99], summary: 'gotcha fails because' }], semanticOpts());
    ok('abstain on empty query', r1.decision === 'abstain' && r1.reason === 'empty-query');
    const r2 = await gateTask({ label: 'a task' }, [], semanticOpts());
    ok('abstain on no notes', r2.decision === 'abstain' && r2.reason === 'no-notes');
  }

  // ---- 5. POSITIVE-CASE SANITY with REAL embeddings -----------------------------------------
  // The whole point of step 4 of the task: a sharp, specific, EMPIRICAL note + a matching query ⇒
  // the gate INJECTS. Distractor notes are topically nearby but not the answer.
  const vProbe = await embed('hello world');
  if (!Array.isArray(vProbe)) {
    skipped('POSITIVE: real-embedding sharp+specific+empirical note triggers inject', 'model unavailable');
  } else {
    const empiricalNote = {
      key: 'scar', title: 'self-signed cert add-connector failure',
      summary: 'root cause: adding the daemon as a custom connector fails because self-signed certs are rejected on issuer-trust, not locality; mkcert installs a trusted local CA and fixes it',
    };
    const distractors = [
      { key: 'd1', title: 'dashboard url', summary: 'the orchestrator dashboard is served at localhost 8787 over http' },
      { key: 'd2', title: 'general tls advice', summary: 'always use TLS in production as a best practice' },
      { key: 'd3', title: 'unrelated', summary: 'quarterly corporate income tax filing deadline reminder' },
    ];
    const notes = [];
    for (const n of [empiricalNote, ...distractors]) notes.push({ ...n, vec: await embed(`${n.title} ${n.summary}`) });

    const task = { label: 'fix custom connector setup', summary: 'the daemon connector wont add because of a certificate trust error' };
    const r = await gateTask(task, notes, { embedQuery: embed, cosine });
    ok('POSITIVE: real-embedding sharp+specific+empirical note triggers inject',
       r.decision === 'inject' && r.topKey === 'scar' && r.topType === 'empirical' && r.via === 'semantic');

    // And a query that is only TOPICALLY near the notes (no sharp specific scar applies) abstains.
    const vagueTask = { label: 'set up the project', summary: 'general getting started and configuration' };
    const r2 = await gateTask(vagueTask, notes, { embedQuery: embed, cosine });
    ok('POSITIVE-control: a vague topical query abstains (not always-inject)', r2.decision === 'abstain');
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  process.exit(fail === 0 ? 0 : 1);
})();
