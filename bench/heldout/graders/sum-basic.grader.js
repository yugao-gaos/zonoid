'use strict';
// HELD-OUT grader for sum-basic (formatDuration). The agent NEVER sees this file.
// Usage: node sum-basic.grader.js <frozen-artifact.js>
// Prints JSON: { ok, cases, pass, total, edgePass, edgeTotal }
const fs = require('fs');
const path = require('path');

const artifact = process.argv[2];
if (!artifact || !fs.existsSync(artifact)) {
  console.log(JSON.stringify({ ok: false, error: 'artifact missing: ' + artifact, cases: [], pass: 0, total: 0, edgePass: 0, edgeTotal: 0 }));
  process.exit(0);
}
let formatDuration, loadErr = null;
try { ({ formatDuration } = require(path.resolve(artifact))); }
catch (e) { loadErr = e.message; }

const specs = [
  // non-edge: from the public examples in the spec
  { name: 'zero ms', edge: false, input: 0, want: '0s' },
  { name: 'sub-second', edge: false, input: 999, want: '0s' },
  { name: 'exactly 1s', edge: false, input: 1000, want: '1s' },
  { name: '5s', edge: false, input: 5000, want: '5s' },
  { name: '1m', edge: false, input: 60000, want: '1m' },
  { name: '1h 1m 1s', edge: false, input: 3661000, want: '1h 1m 1s' },
  // edge-cases from spec
  { name: '59s (59999ms truncated)', edge: true, input: 59999, want: '59s' },
  { name: '1h exactly', edge: true, input: 3600000, want: '1h' },
  { name: '1h 1m no seconds', edge: true, input: 3660000, want: '1h 1m' },
  { name: '23h 59m 59s', edge: true, input: 86399000, want: '23h 59m 59s' },
  { name: '24h (unbounded hours)', edge: true, input: 86400000, want: '24h' },
  { name: '25h 1m 1s', edge: true, input: 90061000, want: '25h 1m 1s' },
  { name: '1.5s truncated to 1s', edge: true, input: 1500, want: '1s' },
  { name: '1m 1s truncated', edge: true, input: 61001, want: '1m 1s' },
];

const cases = [];
for (const s of specs) {
  let got = null, err = null;
  if (typeof formatDuration !== 'function') err = loadErr || 'no formatDuration export';
  else { try { got = formatDuration(s.input); } catch (e) { err = e.message; } }
  const pass = got === s.want;
  cases.push({ name: s.name, edge: s.edge, pass, want: s.want, got, err });
}

const pass = cases.filter((c) => c.pass).length;
const edge = cases.filter((c) => c.edge);
const edgePass = edge.filter((c) => c.pass).length;
console.log(JSON.stringify({
  ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length,
}));
