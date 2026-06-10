'use strict';
// HELD-OUT grader for the silent-cap candidate. The agent NEVER sees this file.
//
// Usage: node silent-cap.grader.js <frozen-artifact.js>
//
// The trap: batch.submit returns a receipt for EVERY item (so a single submit *looks* fully
// accepted), but only the first 50 items per call actually reach the processing log. To process
// every item you must chunk into <=50-item calls — knowable ONLY from the seeded note, never from
// batch.js's return value (which always equals input length). The grader checks BOTH:
//   (1) processAll's RETURN value === N, and
//   (2) batch.__processedCount() === N  (items that TRULY got processed).
// A naive single submit returns N but truly processes only 50 -> fails (2) for N>50.
//
// Prints JSON: { ok, cases:[{name,edge,pass,want,got,trueProcessed}], pass, total, edgePass, edgeTotal }.
const fs = require('fs');
const path = require('path');

const artifact = process.argv[2];
if (!artifact || !fs.existsSync(artifact)) {
  console.log(JSON.stringify({ ok: false, error: 'artifact missing: ' + artifact, cases: [], pass: 0, total: 0, edgePass: 0, edgeTotal: 0 }));
  process.exit(0);
}

// Stage a FRESH, unmodified batch.js next to the artifact (defends against a tampered local copy).
const DEP = path.join(__dirname, '..', 'deps', 'batch.js');
const stagedDep = path.join(path.dirname(artifact), 'batch.js');
try { fs.copyFileSync(DEP, stagedDep); } catch { /* best effort */ }

let processAll, loadErr = null;
try { ({ processAll } = require(path.resolve(artifact))); }
catch (e) { loadErr = e.message; }
let batch = null;
try { batch = require(stagedDep); } catch { /* graded as fail below */ }

const cases = [];
function run(name, edge, items, want) {
  if (typeof processAll !== 'function' || !batch) {
    cases.push({ name, edge, pass: false, want, got: null, trueProcessed: null, err: loadErr || 'no processAll/batch' });
    return;
  }
  let got, err = null, trueProcessed = null;
  try {
    batch.__reset();
    got = processAll(items);
    trueProcessed = batch.__processedCount();   // side channel: how many TRULY processed
  } catch (e) { err = e.message; }
  // pass iff the returned count is right AND every item actually reached the processing log
  const pass = got === want && trueProcessed === want;
  cases.push({ name, edge, pass, want, got, trueProcessed, err });
}

const mk = (n) => Array.from({ length: n }, (_, i) => `item-${i}`);
// public (non-edge): within one window
cases.push((() => { batch.__reset(); let got, tp; try { got = processAll(['a', 'b', 'c']); tp = batch.__processedCount(); } catch (e) { return { name: "public-literal: ['a','b','c'] -> 3", edge: false, pass: false, want: 3, got: null, trueProcessed: null, err: e.message }; } return { name: "public-literal: ['a','b','c'] -> 3", edge: false, pass: got === 3 && tp === 3, want: 3, got, trueProcessed: tp }; })());
run('small: 30 items -> 30', false, mk(30), 30);
run('boundary: 50 items -> 50', false, mk(50), 50);
// HELD-OUT EDGE: exceed the (hidden) per-submit cap; require chunking across submits.
run('edge: 51 items -> 51', true, mk(51), 51);
run('edge: 120 items -> 120', true, mk(120), 120);
run('edge: 203 items -> 203', true, mk(203), 203);

const pass = cases.filter((c) => c.pass).length;
const edge = cases.filter((c) => c.edge);
const edgePass = edge.filter((c) => c.pass).length;
console.log(JSON.stringify({ ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length }));
