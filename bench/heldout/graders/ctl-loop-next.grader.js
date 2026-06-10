'use strict';
// HELD-OUT grader for the ctl-loop-next CONTROL candidate. The agent NEVER sees this file.
// CONTROL: the spec contains the COMPLETE decision table — nothing external is needed. The
// related graph note (metric-loop architecture blueprint) is decorative for this task.
// "Edge" rows are the trickier spec-stated combinations (null handling, zero boundary, unknown
// phase); both arms are expected to pass them.
const fs = require('fs');
const path = require('path');

const artifact = process.argv[2];
if (!artifact || !fs.existsSync(artifact)) {
  console.log(JSON.stringify({ ok: false, error: 'artifact missing: ' + artifact, cases: [], pass: 0, total: 0, edgePass: 0, edgeTotal: 0 }));
  process.exit(0);
}
let nextLoopAction, loadErr = null;
try { ({ nextLoopAction } = require(path.resolve(artifact))); } catch (e) { loadErr = e.message; }

const specs = [
  { name: 'idle -> measure', edge: false, s: { phase: 'idle', metricImproved: null, attemptsLeft: 3 }, want: 'measure' },
  { name: 'measured with attempts -> attempt', edge: false, s: { phase: 'measured', metricImproved: null, attemptsLeft: 1 }, want: 'attempt' },
  { name: 'attempted -> judge', edge: false, s: { phase: 'attempted', metricImproved: null, attemptsLeft: 1 }, want: 'judge' },
  { name: 'judged improved -> merge', edge: false, s: { phase: 'judged', metricImproved: true, attemptsLeft: 2 }, want: 'merge' },
  { name: 'judged not improved with attempts -> attempt', edge: false, s: { phase: 'judged', metricImproved: false, attemptsLeft: 2 }, want: 'attempt' },
  { name: 'measured zero attempts -> stop', edge: true, s: { phase: 'measured', metricImproved: null, attemptsLeft: 0 }, want: 'stop' },
  { name: 'judged not improved zero attempts -> stop', edge: true, s: { phase: 'judged', metricImproved: false, attemptsLeft: 0 }, want: 'stop' },
  { name: 'judged null improved treated as false (attempts) -> attempt', edge: true, s: { phase: 'judged', metricImproved: null, attemptsLeft: 1 }, want: 'attempt' },
  { name: 'judged null improved zero attempts -> stop', edge: true, s: { phase: 'judged', metricImproved: null, attemptsLeft: 0 }, want: 'stop' },
  { name: 'judged improved zero attempts -> merge', edge: true, s: { phase: 'judged', metricImproved: true, attemptsLeft: 0 }, want: 'merge' },
  { name: 'unknown phase -> stop', edge: true, s: { phase: 'weird', metricImproved: true, attemptsLeft: 5 }, want: 'stop' },
  { name: 'idle improved ignored -> measure', edge: true, s: { phase: 'idle', metricImproved: true, attemptsLeft: 0 }, want: 'measure' },
];

const cases = [];
for (const sp of specs) {
  let got = null, err = null;
  if (typeof nextLoopAction !== 'function') err = loadErr || 'no nextLoopAction export';
  else { try { got = nextLoopAction({ ...sp.s }); } catch (e) { err = e.message; } }
  cases.push({ name: sp.name, edge: sp.edge, pass: got === sp.want, want: sp.want, got, err });
}

const pass = cases.filter((c) => c.pass).length;
const edge = cases.filter((c) => c.edge);
const edgePass = edge.filter((c) => c.pass).length;
console.log(JSON.stringify({ ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length }));
