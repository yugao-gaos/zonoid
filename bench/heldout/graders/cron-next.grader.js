'use strict';
// HELD-OUT grader for the cron-next candidate. The agent NEVER sees this file.
//
// Usage: node cron-next.grader.js <frozen-artifact.js>
// Tests nextRun against 13 cases. Edge cases: DOM/DOW union (7, 8), Feb 31 skip (9),
// range step (10), year rollover (11), leap year (12), invalid expr throws (13a, 13b).
// Prints JSON: { ok, pass, total, edgePass, edgeTotal, cases }
const fs = require('fs');
const path = require('path');

const artifact = process.argv[2];
if (!artifact || !fs.existsSync(artifact)) {
  console.log(JSON.stringify({ ok: false, error: 'artifact missing: ' + artifact, cases: [], pass: 0, total: 0, edgePass: 0, edgeTotal: 0 }));
  process.exit(0);
}

let nextRun, loadErr = null;
try { ({ nextRun } = require(path.resolve(artifact))); }
catch (e) { loadErr = e.message; }

const U = Date.UTC;

const specs = [
  // non-edge
  { name: 'every minute',        edge: false, expr: '* * * * *',     after: U(2026, 0, 15, 10, 30), want: U(2026, 0, 15, 10, 31) },
  { name: 'daily midnight',      edge: false, expr: '0 0 * * *',     after: U(2026, 0, 15, 10, 30), want: U(2026, 0, 16, 0, 0) },
  { name: 'same day later',      edge: false, expr: '30 14 * * *',   after: U(2026, 0, 15, 10, 0),  want: U(2026, 0, 15, 14, 30) },
  { name: 'next monday',         edge: false, expr: '0 9 * * 1',     after: U(2026, 0, 15, 10, 0),  want: U(2026, 0, 19, 9, 0) },
  { name: 'star step',           edge: false, expr: '*/15 * * * *',  after: U(2026, 0, 15, 10, 31), want: U(2026, 0, 15, 10, 45) },
  { name: 'strictly after',      edge: false, expr: '30 10 * * *',   after: U(2026, 0, 15, 10, 30), want: U(2026, 0, 16, 10, 30) },
  // edge
  { name: 'dom/dow union (dow first)', edge: true, expr: '0 0 13 * 5', after: U(2026, 1, 1, 0, 0),  want: U(2026, 1, 6, 0, 0) },
  { name: 'dom/dow union (dow before dom)', edge: true, expr: '0 0 20 * 3', after: U(2026, 5, 1, 0, 0), want: U(2026, 5, 3, 0, 0) },
  { name: 'feb 31 skip',         edge: true,  expr: '0 0 31 * *',    after: U(2026, 0, 31, 0, 0),   want: U(2026, 2, 31, 0, 0) },
  { name: 'range step',          edge: true,  expr: '10-40/15 * * * *', after: U(2026, 0, 15, 10, 26), want: U(2026, 0, 15, 10, 40) },
  { name: 'year rollover',       edge: true,  expr: '0 0 1 1 *',     after: U(2026, 0, 1, 0, 0),    want: U(2027, 0, 1, 0, 0) },
  { name: 'leap year feb 29',    edge: true,  expr: '0 0 29 2 *',    after: U(2026, 2, 1, 0, 0),    want: U(2028, 1, 29, 0, 0) },
];

const throwSpecs = [
  { name: 'invalid: out-of-range minute', expr: '60 * * * *' },
  { name: 'invalid: wrong field count',   expr: '* * *' },
];

const cases = [];
for (const s of specs) {
  let got = null, err = null;
  if (typeof nextRun !== 'function') err = loadErr || 'no nextRun export';
  else { try { got = nextRun(s.expr, s.after); } catch (e) { err = e.message; } }
  const pass = got === s.want;
  cases.push({ name: s.name, edge: s.edge, pass, want: s.want, got, err });
}
{
  // edge case 13: both invalid expressions must throw
  let pass = false, err = null;
  if (typeof nextRun !== 'function') err = loadErr || 'no nextRun export';
  else {
    pass = throwSpecs.every((t) => {
      try { nextRun(t.expr, U(2026, 0, 1, 0, 0)); return false; } catch (e) { return true; }
    });
  }
  cases.push({ name: 'invalid exprs throw', edge: true, pass, want: 'throw', got: pass ? 'throw' : 'no throw', err });
}

const pass = cases.filter((c) => c.pass).length;
const edge = cases.filter((c) => c.edge);
const edgePass = edge.filter((c) => c.pass).length;
console.log(JSON.stringify({
  ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length,
}));
