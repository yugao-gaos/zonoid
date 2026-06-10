#!/usr/bin/env node
// Plain Node test for the auto-decision extractor (no framework; matches autowire.test.js style).
// Run: node test/extract-decisions.test.js — exits non-zero on any failed assertion.
//
// Covers the PRECISION gate of candidatesFromText: durable decisions/findings/constraints get
// extracted; transient chatter ("let me read…", status, greetings) does NOT. Then it reports
// precision/recall over a labeled sample of solo turns (the "measure precision" ask). The bar is
// biased toward precision (note-node noise is worse than a missed minor point), so we assert
// precision == 1.0 on the sample and recall above a floor.
'use strict';
const { candidatesFromText } = require('../scripts/extract-decisions');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Labeled sample turns. durable:true => at least one candidate SHOULD be extracted; false => none.
const SAMPLE = [
  { durable: true,  text: 'I chose POST /overlay/note over a new endpoint because it reuses the existing review gate rather than adding a second injection path.' },
  { durable: true,  text: 'Turns out the self-signed certs fail on issuer-trust, not locality — adding the cert to the system keychain is what fixes the connector.' },
  { durable: true,  text: 'We must never resurrect a canceled task: start_task uses a compare-and-set so a canceled node stays terminal unless force:true is passed.' },
  { durable: true,  text: 'Decided to dedup candidates against the live KB via /search instead of a local cache, so the extractor reflects the current graph state.' },
  { durable: true,  text: 'The root cause is that buildGraph appends note nodes after the native sync, so an early summaryFor call misses them; we moved the append before context resolution.' },
  { durable: false, text: "Let me read the relevant parts of the existing files to match style exactly." },
  { durable: false, text: "I'll run the smoke test now and check the output." },
  { durable: false, text: "Here's the diff. Looks good. Done." },
  { durable: false, text: "First I'll open daemon.js and look at the overlay endpoint." },
  { durable: false, text: "Great, all set — the branch is created and I'm ready to start." },
];

// --- per-class assertions ---
SAMPLE.forEach((s, i) => {
  const got = candidatesFromText(s.text, i).length > 0;
  if (s.durable) ok(`durable turn ${i} extracts >=1 candidate`, got);
  else ok(`chatter turn ${i} extracts 0 candidates`, !got);
});

// --- precision / recall over the sample (the "measure precision" deliverable) ---
let tp = 0, fp = 0, fn = 0;
SAMPLE.forEach((s, i) => {
  const got = candidatesFromText(s.text, i).length > 0;
  if (s.durable && got) tp++;
  else if (!s.durable && got) fp++;
  else if (s.durable && !got) fn++;
});
const precision = tp / (tp + fp || 1);
const recall = tp / (tp + fn || 1);
console.log(`\nSAMPLE PRECISION=${precision.toFixed(2)} RECALL=${recall.toFixed(2)}  (tp=${tp} fp=${fp} fn=${fn})\n`);

ok('precision == 1.0 (no chatter extracted)', precision === 1.0);
ok('recall >= 0.8 (catches most durable turns)', recall >= 0.8);

// --- candidate shape is record_decision-compatible {title, summary, knowledge[]} ---
const sample = candidatesFromText(SAMPLE[0].text, 0)[0];
ok('candidate has non-empty title', sample && typeof sample.title === 'string' && sample.title.length > 0);
ok('candidate has summary', sample && typeof sample.summary === 'string' && sample.summary.length > 0);
ok('candidate.knowledge is an array with origin tag', sample && Array.isArray(sample.knowledge) && sample.knowledge.some((k) => k.startsWith('origin:')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
