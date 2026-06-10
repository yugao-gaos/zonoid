#!/usr/bin/env node
// Plain Node test (no framework; matches test/search-knowledge.test.js style) for local-embedding
// semantic retrieval. Run: node test/embed.test.js — exits non-zero on any failed assertion.
//
// Covers:
//   1. embed() returns a 384-length vector for real text (or SKIPs cleanly if the model can't load).
//   2. cosine(v,v) ≈ 1; cosine(unrelated, unrelated) is clearly lower.
//   3. search_knowledge HYBRID fallback: a node WITHOUT a vector is still scored (lexically) and
//      surfaces — retrieval never drops an item just because it lacks an embedding.
//   4. THE DISCRIMINATING CASE (the whole point): a semantically-relevant note phrased in DIFFERENT
//      words than the query outranks a note that shares query WORDS but is about something else.
//      Pure lexical can't do this; semantic cosine can. Asserted only when the model is available.
//
// The hybrid scorer here mirrors the /search handler in daemon.js (semantic cosine when both query
// and item have a vector, else lexical scoreNodeAgainstTokens) — same offline-replica approach the
// other retrieval tests use.
'use strict';

const { scoreNodeAgainstTokens, suggestToks } = require('../daemon');
const { embed, cosine, DIMS } = require('../lib/embed');

let pass = 0, fail = 0, skip = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };
const skipped = (label, why) => { console.log(`SKIP  ${label} (${why})`); skip++; };

// Hybrid scorer = exact mirror of the /search handler's scoreHybrid.
const scoreHybrid = (qvec, qt, vec, lexNode) =>
  (qvec && Array.isArray(vec))
    ? { score: cosine(qvec, vec), via: 'semantic' }
    : { score: scoreNodeAgainstTokens(lexNode, qt).score, via: 'lexical' };

(async () => {
  // ---- cosine: pure-math, no model needed --------------------------------------------------
  const a = [1, 0, 0, 0], b = [1, 0, 0, 0], c = [0, 1, 0, 0];
  ok('cosine(identical)≈1', Math.abs(cosine(a, b) - 1) < 1e-9);
  ok('cosine(orthogonal)≈0', Math.abs(cosine(a, c)) < 1e-9);
  ok('cosine(empty/mismatch)=0', cosine([], []) === 0 && cosine([1, 2], [1, 2, 3]) === 0);

  // ---- embed: needs the model. embed() returns null if it can't load (by contract). ---------
  const vHello = await embed('hello world');
  const modelUp = Array.isArray(vHello);
  if (!modelUp) {
    skipped('embed returns 384-length vector', 'model unavailable — embed() returned null (expected fallback path)');
    skipped('cosine(identical text)≈1', 'model unavailable');
    skipped('cosine(semantically unrelated) is low', 'model unavailable');
    skipped('DISCRIMINATING: semantic match outranks lexical-overlap-only', 'model unavailable');
  } else {
    ok('embed returns 384-length vector', vHello.length === DIMS && DIMS === 384);
    ok('embed returns plain floats', vHello.every((x) => typeof x === 'number' && Number.isFinite(x)));

    const vHello2 = await embed('hello world');
    ok('cosine(identical text)≈1', Math.abs(cosine(vHello, vHello2) - 1) < 1e-3);

    const vCat = await embed('a fluffy domestic cat purring on a sofa');
    const vTax = await embed('quarterly corporate income tax filing deadline');
    const simRel = cosine(vCat, vCat);
    const simUnrel = cosine(vCat, vTax);
    ok('cosine(self)≈1 for sentence', Math.abs(simRel - 1) < 1e-3);
    ok('cosine(semantically unrelated) is low', simUnrel < 0.4);

    // ---- THE DISCRIMINATING CASE ----------------------------------------------------------
    // Query is about authentication token expiry. One note means exactly that but uses DIFFERENT
    // words (no shared tokens with the query). The other note SHARES surface words ("token",
    // "expire") but is about a totally different domain (a vending-machine coin token). Lexical
    // overlap favors the irrelevant note; semantic meaning favors the relevant one.
    const query = 'why are users getting logged out unexpectedly after a while';
    const relevant = {   // same MEANING, different WORDS — minimal lexical overlap with the query
      label: 'session credential lifetime',
      summary: 'the JWT bearer signature has a short validity period, so the browser must refresh it or the API rejects subsequent calls',
    };
    const distractor = { // shares surface words with NEITHER meaning but overlaps the *relevant note* lexically while being irrelevant to the query
      label: 'arcade machine token jam',
      summary: 'when a user inserts a bent coin token the credential slot jams and the machine logs an error after a while',
    };
    const qvec = await embed(query);
    const relVec = await embed(`${relevant.label} ${relevant.summary}`);
    const disVec = await embed(`${distractor.label} ${distractor.summary}`);

    // Sanity: the distractor genuinely out-overlaps the relevant note LEXICALLY (so the test is real).
    const qt = suggestToks(query);
    const relLex = scoreNodeAgainstTokens(relevant, qt).score;
    const disLex = scoreNodeAgainstTokens(distractor, qt).score;
    ok('precondition: distractor lexically >= relevant (lexical alone would mis-rank)', disLex >= relLex);

    // Hybrid (semantic) ranking: the relevant note must win.
    const relScore = scoreHybrid(qvec, qt, relVec, relevant);
    const disScore = scoreHybrid(qvec, qt, disVec, distractor);
    ok('DISCRIMINATING: semantic match outranks lexical-overlap-only', relScore.via === 'semantic' && relScore.score > disScore.score);
  }

  // ---- HYBRID FALLBACK: a node WITHOUT a vector still scores (lexically) and surfaces -------
  // Mirror the handler: one note has a vector (semantic path), one has none (lexical path). Both
  // must be rankable in the same pass — the vectorless one is NOT dropped.
  {
    const qt = suggestToks('database migration rollback');
    const withVec = { label: 'schema change safety', summary: 'always test the down migration', vec: modelUp ? await embed('schema change safety always test the down migration') : null };
    const noVec = { label: 'database migration rollback runbook', summary: 'steps to roll back a failed database migration', vec: null };
    const qvec = modelUp ? await embed('database migration rollback') : null;

    const sWith = scoreHybrid(qvec, qt, withVec.vec, withVec);
    const sNo = scoreHybrid(qvec, qt, noVec.vec, noVec);
    ok('vectorless node falls back to lexical (via=lexical)', sNo.via === 'lexical');
    ok('vectorless node still scores > 0 (not dropped)', sNo.score > 0);
    if (modelUp) ok('vector-bearing node uses semantic path (via=semantic)', sWith.via === 'semantic');
    else skipped('vector-bearing node uses semantic path', 'model unavailable — both fall back to lexical');
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  process.exit(fail === 0 ? 0 : 1);
})();
