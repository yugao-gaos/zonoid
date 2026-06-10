'use strict';
// HELD-OUT grader for the silent-cap candidate. The agent NEVER sees this file.
//
// Usage: node silent-cap.grader.js <frozen-artifact.js>
// It loads the agent's frozen process-all.js (which requires ./batch.js relative to ITSELF, so the
// grader stages a fresh batch.js next to the artifact), runs cases, and prints a JSON verdict:
//   { ok, cases:[{name,edge,pass,want,got}], pass, total, edgePass, edgeTotal }
// `ok` (== solved) is true iff ALL cases pass. Edge cases are tracked separately.
'use strict';
const fs = require('fs');
const path = require('path');

const artifact = process.argv[2];
if (!artifact || !fs.existsSync(artifact)) {
  console.log(JSON.stringify({ ok: false, error: 'artifact missing: ' + artifact, cases: [], pass: 0, total: 0, edgePass: 0, edgeTotal: 0 }));
  process.exit(0);
}

// Stage a fresh batch.js next to the artifact so its `require('./batch.js')` resolves to the real,
// unmodified dependency (defends against an agent that tampered with its local batch.js copy).
const DEP = path.join(__dirname, '..', 'deps', 'batch.js');
const stagedDep = path.join(path.dirname(artifact), 'batch.js');
try { fs.copyFileSync(DEP, stagedDep); } catch (e) { /* best effort */ }

let processAll, loadErr = null;
try { ({ processAll } = require(path.resolve(artifact))); }
catch (e) { loadErr = e.message; }

const cases = [];
function run(name, edge, n, want) {
  if (typeof processAll !== 'function') { cases.push({ name, edge, pass: false, want, got: null, err: loadErr || 'no processAll export' }); return; }
  let got, err = null;
  try {
    // reset the dependency's receipt sequence if it exposes the hook (deterministic counts)
    try { const b = require(stagedDep); if (b.__reset) b.__reset(); } catch {}
    got = processAll(Array.from({ length: n }, (_, i) => `item-${i}`));
  } catch (e) { err = e.message; }
  // public example uses explicit values; emulate by special-case for the 3-item literal
  cases.push({ name, edge, pass: got === want, want, got, err });
}

// public (non-edge) cases — small, within one window
run('public: 3 items -> 3', false, 3, 3);
run('small: 30 items -> 30', false, 30, 30);
run('boundary: 50 items -> 50', false, 50, 50);
// HELD-OUT EDGE cases — exceed the (hidden) per-submit cap; require chunking across submits.
run('edge: 51 items -> 51', true, 51, 51);
run('edge: 120 items -> 120', true, 120, 120);
run('edge: 203 items -> 203', true, 203, 203);

// special public literal example from the spec, to mirror the exact prose
if (typeof processAll === 'function') {
  let got, err = null;
  try { const b = require(stagedDep); if (b.__reset) b.__reset(); got = processAll(['a', 'b', 'c']); } catch (e) { err = e.message; }
  cases.unshift({ name: "public-literal: ['a','b','c'] -> 3", edge: false, pass: got === 3, want: 3, got, err });
}

const pass = cases.filter((c) => c.pass).length;
const edge = cases.filter((c) => c.edge);
const edgePass = edge.filter((c) => c.pass).length;
console.log(JSON.stringify({
  ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length,
}));
