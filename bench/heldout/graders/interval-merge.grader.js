'use strict';
// HELD-OUT grader for the interval-merge candidate. The agent NEVER sees this file.
//
// Usage: node interval-merge.grader.js <frozen-artifact.js>
// Tests mergeIntervals against 10 cases. Edge cases: touching intervals (cases 2, 10),
// negative numbers (case 9), touching chain (case 10).
// Prints JSON: { ok, pass, total, edgePass, edgeTotal, cases }
const fs = require('fs');
const path = require('path');

const artifact = process.argv[2];
if (!artifact || !fs.existsSync(artifact)) {
  console.log(JSON.stringify({ ok: false, error: 'artifact missing: ' + artifact, cases: [], pass: 0, total: 0, edgePass: 0, edgeTotal: 0 }));
  process.exit(0);
}

let mergeIntervals, loadErr = null;
try { ({ mergeIntervals } = require(path.resolve(artifact))); }
catch (e) { loadErr = e.message; }

function eq(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Array.isArray(a[i]) || !Array.isArray(b[i])) return false;
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

const specs = [
  // non-edge
  { name: 'basic overlap',       edge: false, input: [[1,3],[2,6],[8,10],[15,18]], want: [[1,6],[8,10],[15,18]] },
  { name: 'touching intervals',  edge: true,  input: [[1,3],[3,5]],               want: [[1,5]] },
  { name: 'no overlap',          edge: false, input: [[1,2],[3,4],[5,6]],          want: [[1,2],[3,4],[5,6]] },
  { name: 'fully contained',     edge: false, input: [[1,10],[2,3],[4,5]],         want: [[1,10]] },
  { name: 'empty input',         edge: false, input: [],                           want: [] },
  { name: 'single interval',     edge: false, input: [[2,4]],                      want: [[2,4]] },
  { name: 'unsorted input',      edge: false, input: [[5,7],[1,3],[2,4]],          want: [[1,4],[5,7]] },
  { name: 'all overlapping',     edge: false, input: [[1,4],[2,5],[3,6]],          want: [[1,6]] },
  { name: 'negative numbers',    edge: true,  input: [[-3,-1],[-2,0],[1,2]],       want: [[-3,0],[1,2]] },
  { name: 'touching chain',      edge: true,  input: [[1,2],[2,3],[3,4]],          want: [[1,4]] },
];

const cases = [];
for (const s of specs) {
  let got = null, err = null;
  if (typeof mergeIntervals !== 'function') err = loadErr || 'no mergeIntervals export';
  else { try { got = mergeIntervals(s.input); } catch (e) { err = e.message; } }
  const pass = eq(got, s.want);
  cases.push({ name: s.name, edge: s.edge, pass, want: s.want, got, err });
}

const pass = cases.filter((c) => c.pass).length;
const edge = cases.filter((c) => c.edge);
const edgePass = edge.filter((c) => c.pass).length;
console.log(JSON.stringify({
  ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length,
}));
