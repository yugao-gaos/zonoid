'use strict';
// HELD-OUT grader for the locale-sum candidate. The agent NEVER sees this file.
//
// Usage: node locale-sum.grader.js <frozen-artifact.js>
// Builds the amount feed PROGRAMMATICALLY (same shape family as the real upstream export). The PROSE
// SPEC the agent saw showed ONLY en-US amounts ("12.50", "$19.95", "-30.00"). The real feed mixes in
// rows rendered in de-DE / European locale convention (comma decimal, dot thousands: "1.234,56" = 1234.56,
// "99,90" = 99.90). A spec-faithful en-US parser (Number()/parseFloat after stripping $ and sign)
// silently mis-parses every European row -> NaN-skipped (contributes 0) or truncated -> WRONG total.
// Those European rows are the held-out EDGE cases. The only cheap path to them is the seeded empirical
// note ("the export feed mixes en-US and de-DE decimal formats").
//
// Grading is by TEST ROW, not one grand total: each case asks sumAmounts over a single feed and checks
// the returned total. en-US-only cases are non-edge (both arms should pass). Cases whose feed contains a
// European-formatted amount are edge. Prints JSON: { ok, cases, pass, total, edgePass, edgeTotal }.
const fs = require('fs');
const path = require('path');

const artifact = process.argv[2];
if (!artifact || !fs.existsSync(artifact)) {
  console.log(JSON.stringify({ ok: false, error: 'artifact missing: ' + artifact, cases: [], pass: 0, total: 0, edgePass: 0, edgeTotal: 0 }));
  process.exit(0);
}
let sumAmounts, loadErr = null;
try { ({ sumAmounts } = require(path.resolve(artifact))); }
catch (e) { loadErr = e.message; }

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Each spec entry: { name, edge, rows, want }. `rows` is the feed passed to sumAmounts.
const specs = [
  // ---- non-edge: pure en-US (a spec-faithful impl should get these) -------------------------
  { name: 'empty feed', edge: false, rows: [], want: 0 },
  { name: 'single plain', edge: false, rows: [{ amount: '12.50' }], want: 12.5 },
  { name: 'two plain', edge: false, rows: [{ amount: '1234.00' }, { amount: '0.99' }], want: 1234.99 },
  { name: 'symbol + whitespace', edge: false, rows: [{ amount: ' $19.95 ' }], want: 19.95 },
  { name: 'signed refund', edge: false, rows: [{ amount: '100.00' }, { amount: '-30.00' }], want: 70 },
  { name: 'bad row skipped', edge: false, rows: [{ amount: '' }, { amount: '12.00' }, { amount: null }], want: 12 },
  { name: 'en-US many', edge: false, rows: [
      { amount: '5.00' }, { amount: '7.25' }, { amount: '$3.10' }, { amount: '-1.35' }, { amount: '0.00' },
    ], want: r2(5 + 7.25 + 3.10 - 1.35) },

  // ---- EDGE: de-DE / European-formatted amounts mixed into the feed -------------------------
  { name: 'de-DE decimal comma', edge: true, rows: [{ amount: '99,90' }], want: 99.9 },
  { name: 'de-DE thousands dot + comma', edge: true, rows: [{ amount: '1.234,56' }], want: 1234.56 },
  { name: 'de-DE with symbol', edge: true, rows: [{ amount: '$2.500,00' }], want: 2500 },
  { name: 'de-DE signed', edge: true, rows: [{ amount: '-1.000,50' }], want: -1000.5 },
  { name: 'mixed feed en-US + de-DE', edge: true, rows: [
      { amount: '10.00' },        // en-US 10.00
      { amount: '1.500,25' },     // de-DE 1500.25
      { amount: '99,90' },        // de-DE 99.90
      { amount: '$4.50' },        // en-US 4.50
    ], want: r2(10 + 1500.25 + 99.90 + 4.50) },
  { name: 'de-DE large thousands', edge: true, rows: [{ amount: '1.234.567,89' }], want: 1234567.89 },
  { name: 'de-DE small cents', edge: true, rows: [{ amount: '0,05' }, { amount: '0,07' }], want: 0.12 },
  { name: 'realistic batch', edge: true, rows: [
      { amount: '250.00' },       // en-US 250
      { amount: '2.499,99' },     // de-DE 2499.99
      { amount: ' 19.95 ' },      // en-US 19.95
      { amount: '49,90' },        // de-DE 49.90
      { amount: '-100.00' },      // en-US -100
      { amount: '1.000,00' },     // de-DE 1000
    ], want: r2(250 + 2499.99 + 19.95 + 49.90 - 100 + 1000) },
];

const cases = [];
for (const s of specs) {
  let got = null, err = null;
  if (typeof sumAmounts !== 'function') err = loadErr || 'no sumAmounts export';
  else { try { got = sumAmounts(s.rows); } catch (e) { err = e.message; } }
  const pass = typeof got === 'number' && !Number.isNaN(got) && Math.abs(got - s.want) < 0.005;
  cases.push({ name: s.name, edge: s.edge, pass, want: s.want, got, err });
}

const pass = cases.filter((c) => c.pass).length;
const edge = cases.filter((c) => c.edge);
const edgePass = edge.filter((c) => c.pass).length;
console.log(JSON.stringify({
  ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length,
}));
