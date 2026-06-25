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
//   3. INJECT only on sharp + specific + empirical + PROJECT-LOCAL.
//   3e. projectLocality score + the non-local abstain (empirical but pretraining-prior knowledge).
//   4. DEFAULTs: no notes / empty query -> abstain.
//   5. POSITIVE-CASE SANITY with REAL embeddings (skips if model unavailable): a hand-made sharp,
//      specific, EMPIRICAL note + a matching query -> the gate INJECTS. Proves it's not "always abstain".
'use strict';

const { gateTask, classifyNoteType, externalGap, contentTokens, projectLocality } = require('../lib/context-gate');
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
  // recalibration fix: a measured silent failure / "always X because <observed gap>" is EMPIRICAL,
  // not principle — even though it contains "always" (the load-bearing first-positive note read this way).
  ok('classify: measured silent failure is empirical',
     classifyNoteType('exact-session resolution silently misses ~40% of tasks; always include the window-overlap fallback') === 'empirical');

  // ---- 2a. ABSTAIN: low confidence (top1 below threshold) -----------------------------------
  {
    const notes = [
      { key: 'n1', title: 'vaguely related thing', summary: 'gotcha it fails because of a thing', vec: [0.40] },
      { key: 'n2', title: 'other', summary: 'general note', vec: [0.20] },
    ];
    const r = await gateTask({ label: 'do a task', summary: 'some work' }, notes, semanticOpts());
    ok('abstain on low confidence (top1 0.40 < 0.50)', r.decision === 'abstain' && r.reason === 'low-confidence');
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

  // ---- 3. INJECT: sharp + specific + empirical + project-local --------------------------------
  {
    const notes = [
      { key: 'n1', title: 'cwd hijack', summary: 'gotcha: a malicious task hijacks the worker cwd because workspace is unpinned (observed on 3/3 repro runs of runWorker(task)); pin it to the daemon root', vec: [0.82] },
      { key: 'n2', title: 'other', summary: 'unrelated topic', vec: [0.30] }, // margin 0.52
    ];
    const r = await gateTask({ label: 'harden worker workspace', summary: 'prevent cwd takeover' }, notes, semanticOpts());
    ok('inject on sharp+specific+empirical+local', r.decision === 'inject' && r.topType === 'empirical' && r.via === 'semantic');
  }

  // ---- 3b. external-gap signal (recalibration) ----------------------------------------------
  ok('externalGap: full overlap ~1', externalGap('alpha beta gamma', new Set(contentTokens('alpha beta gamma delta'))) === 1);
  ok('externalGap: no overlap 0', externalGap('xyzzy plugh frobnitz', new Set(contentTokens('alpha beta gamma'))) === 0);
  ok('externalGap: empty note 0', externalGap('', new Set(['alpha'])) === 0);

  // ---- 3c. INJECT via the GAP path inside a tight cosine cluster (the first-positive shape) --
  // top1 0.54 / top2 0.53 → margin 0.01 (would FAIL the old margin guard), but the top note is
  // empirical AND shares the task's concrete vocabulary (high external-gap) ⇒ INJECT. This is the
  // exact regression the held-out task→transcript win exposed.
  {
    const notes = [
      { key: 'scar', title: 'resolveOwner transcript session window',
        summary: 'exact-session resolveOwner silently misses ~40% of assignee records with no session; correlate the task window against byWindow run windows', vec: [0.54] },
      { key: 'topical', title: 'unrelated orchestrator note', summary: 'general design discussion about token cost', vec: [0.53] }, // margin 0.01
    ];
    const task = { label: 'resolveOwner task transcript', summary: 'resolve a task assignee to its transcript path via session and window' };
    const r = await gateTask(task, notes, semanticOpts());
    ok('inject via gap path (tight cluster, empirical, on-task vocab)',
       r.decision === 'inject' && r.reason === 'gap-specific-empirical' && r.margin < 0.12 && r.gap >= 0.25);
  }

  // ---- 3d. ABSTAIN: tight cluster, empirical, but NOT on-task (low gap) ----------------------
  {
    const notes = [
      { key: 'n1', title: 'topic A', summary: 'gotcha fails because of reasons', vec: [0.54] },
      { key: 'n2', title: 'topic B', summary: 'gotcha also fails because of reasons', vec: [0.53] }, // margin 0.01
    ];
    const r = await gateTask({ label: 'deploy the widget pipeline', summary: 'ship frontend assets' }, notes, semanticOpts());
    ok('abstain on tight cluster with low external-gap', r.decision === 'abstain' && r.reason === 'diffuse-match' && r.gap < 0.25);
  }

  // ---- 3e. PROJECT-LOCALITY: the pretraining-prior guard (precision fix) ----------------------
  // A relevant, empirical, on-task note whose content is GENERAL engineering knowledge is still a
  // wasted inject — the model already knows the fact. projectLocality counts 4 marker categories
  // (measured quantity / literal error value / local identifier / observed-on-real-data); >= 2 is
  // the signature of a project-local observation.
  ok('locality: measured+identifier+observed scar scores >= 2',
     projectLocality('exact-session resolveOwner silently misses ~40% of assignee records; discovered on real data; use byWindow overlap') >= 2);
  ok('locality: literal error values + identifiers score >= 2',
     projectLocality('Number("1.234,56") returns NaN so sumAmounts(rows) silently drops every de-DE row') >= 2);
  ok('locality: general-infra fact scores < 2',
     projectLocality('TLS validates the cert issuer against the system trust store regardless of localhost, so a self-signed cert is rejected; mkcert installs a trusted local CA') < 2);
  ok('locality: policy/principle note scores < 2',
     projectLocality('Policy: worktrees are ephemeral scaffolding; once value is extracted GC them; never silently delete un-judged work') < 2);
  ok('locality: empty is 0', projectLocality('') === 0);
  {
    // Sharp + empirical + on-task, but the knowledge is in the pretraining prior (no project-local
    // markers) ⇒ ABSTAIN with reason 'non-local'. This is the wt-gc / tls-local FP shape.
    const notes = [
      { key: 'n1', title: 'self-signed cert rejection', summary: 'root cause: self-signed certs fail issuer-trust validation against the system trust store; install a trusted local CA via mkcert to fix the connector', vec: [0.80] },
      { key: 'n2', title: 'other', summary: 'unrelated topic', vec: [0.30] }, // margin 0.50, sharp
    ];
    const r = await gateTask({ label: 'fix local https connector', summary: 'self-signed cert rejected on issuer trust; mkcert local CA setup' }, notes, semanticOpts());
    ok('abstain on non-local (empirical but pretraining-prior knowledge)',
       r.decision === 'abstain' && r.reason === 'non-local' && r.topType === 'empirical' && r.locality < 2);
    // localityThreshold: 0 disables the guard — same notes then inject.
    const r2 = await gateTask({ label: 'fix local https connector', summary: 'self-signed cert rejected on issuer trust; mkcert local CA setup' }, notes, semanticOpts({ localityThreshold: 0 }));
    ok('localityThreshold 0 disables the guard', r2.decision === 'inject');
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
      summary: 'root cause: adding the daemon as a custom connector fails because self-signed certs are rejected on issuer-trust, not locality; observed 8/8 add attempts fail with ERR_CERT_AUTHORITY_INVALID on this daemon until mkcert installs a trusted local CA',
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
