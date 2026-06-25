#!/usr/bin/env node
'use strict';

let mod;
try {
  mod = require(process.argv[2]);
} catch (e) {
  console.log(JSON.stringify({ ok: false, pass: 0, total: 0, edgePass: 0, edgeTotal: 0, cases: [], error: e.message }));
  process.exit(0);
}

const { parseTaskId } = mod;

const specs = [
  // Standard current format (non-edge)
  { name: 'uuid/seq basic',         edge: false, input: 'b3d1b5f4-ac17-4a48-8f81-e0a5c5a8fe7d/42', want: { session: 'b3d1b5f4-ac17-4a48-8f81-e0a5c5a8fe7d', seq: 42, legacy: false } },
  { name: 'uuid/seq short seq',     edge: false, input: 'df63dcd1-69b2-48ae-926b-1f360ad2fc0c/1',  want: { session: 'df63dcd1-69b2-48ae-926b-1f360ad2fc0c', seq: 1, legacy: false } },
  { name: 'uuid/seq zero-uuid',     edge: false, input: '00000000-0000-0000-0000-000000000000/999', want: { session: '00000000-0000-0000-0000-000000000000', seq: 999, legacy: false } },
  // LEGACY format (requires KB note)
  { name: 'legacy short-hex/5',     edge: true,  input: 'a3f9c812/5',   want: { session: 'legacy/a3f9c812', seq: 5, legacy: true } },
  { name: 'legacy short-hex/100',   edge: true,  input: 'ff001234/100', want: { session: 'legacy/ff001234', seq: 100, legacy: true } },
  { name: 'legacy short-hex/1',     edge: true,  input: 'deadbeef/1',   want: { session: 'legacy/deadbeef', seq: 1, legacy: true } },
  // Invalid
  { name: 'invalid: no slash',      edge: false, input: 'notanid',       want: null },
  { name: 'invalid: empty string',  edge: false, input: '',              want: null },
  { name: 'invalid: non-hex seg',   edge: false, input: 'xyz/abc',       want: null },
  { name: 'invalid: negative seq',  edge: false, input: 'b3d1b5f4-ac17-4a48-8f81-e0a5c5a8fe7d/-1', want: null },
];

const cases = [];
for (const s of specs) {
  let got = undefined, err = null;
  try {
    got = parseTaskId(s.input);
  } catch (e) {
    err = e.message;
    got = null;
  }
  const pass = JSON.stringify(got) === JSON.stringify(s.want);
  cases.push({ name: s.name, edge: s.edge, pass, want: s.want, got: got === undefined ? null : got, err });
}

const pass = cases.filter(c => c.pass).length;
const edge = cases.filter(c => c.edge);
const edgePass = edge.filter(c => c.pass).length;
console.log(JSON.stringify({ ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length }));
