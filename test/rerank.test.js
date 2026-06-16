#!/usr/bin/env node
// Plain Node test (no framework; matches test/embed.test.js style) for the cross-encoder rerank
// sidecar + client. Run: node test/rerank.test.js — exits non-zero on any failed assertion.
//
// Covers:
//   1. NULL-SAFE input guards: rerank() returns null (never throws) on empty query / empty docs.
//   2. NULL-SAFE degrade: a rerank() call before the sidecar is ready returns null (caller keeps
//      its cosine order) — never an exception.
//   3. THE DISCRIMINATING CASE (the whole point): given a query and a shortlist where exactly one
//      doc actually answers it, the cross-encoder scores that doc highest — even when a distractor
//      shares more surface words. Asserted only when the model is available; SKIPs otherwise.
'use strict';

const { rerank, rerankStatus } = require('../lib/rerank');

let pass = 0, fail = 0, skip = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };
const skipped = (label, why) => { console.log(`SKIP  ${label} (${why})`); skip++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1 + 2: null-safe guards — must return null, never throw, before the model is anywhere near ready.
  ok('empty query → null',           (await rerank('', ['a doc'])) === null);
  ok('empty docs → null',            (await rerank('a query', [])) === null);
  ok('non-array docs → null',        (await rerank('a query', null)) === null);

  // 3: discriminating ranking. The relevant doc shares FEWER query words than the distractor, so
  // only a true relevance model (cross-encoder) ranks it first — a lexical/word-overlap scorer would
  // not. Poll until the lazily-spawned sidecar finishes loading (~download+load on first run).
  const query = 'how do I get my money back for a cancelled flight';
  const docs = [
    'Refunds for cancelled flights are issued to the original payment method within 7 days.', // relevant
    'Flight cancellation is common in winter; many flights get cancelled due to snow and ice.', // shares MORE words, not relevant
    'Our loyalty program lets you earn points on every flight you book with us.',               // off-topic
  ];

  let scores = null;
  const DEADLINE = Date.now() + 180_000; // up to 3 min for first-run model download
  while (Date.now() < DEADLINE) {
    scores = await rerank(query, docs);
    if (scores) break;
    await sleep(2000); // sidecar loading — null is the expected degrade signal, retry
  }

  if (!scores) {
    skipped('cross-encoder ranks the relevant doc first', `model unavailable (status=${rerankStatus()})`);
  } else {
    ok('scores length matches docs', scores.length === docs.length);
    const argmax = scores.indexOf(Math.max(...scores));
    ok('relevant doc (index 0) ranked highest', argmax === 0);
    console.log('      scores:', scores.map((s) => s.toFixed(4)).join(', '));
  }

  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail ? 1 : 0);
})();
