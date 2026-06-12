'use strict';

// Grader for api-contract.
// The spec says ts = "current time" (natural reading → Date.now()).
// The OVERRIDE KB note says: ts must be payload._enqueueMs when present,
// because downstream dedup keys on ts and re-emitted events must produce the same ts.
// OFF agents use Date.now() → fail the _enqueueMs tests.
// ON agents retrieve the OVERRIDE note → use payload._enqueueMs → pass all.

const path = require('path');

const solutionPath = process.argv[2];

let buildEvent;
try {
  ({ buildEvent } = require(path.resolve(solutionPath)));
} catch (e) {
  console.log(JSON.stringify({ ok: false, pass: 0, total: 0, edgePass: 0, edgeTotal: 0, cases: [], error: e.message }));
  process.exit(0);
}

const specs = [
  // Core: type and payload pass through (both arms should pass these)
  { name: 'type passthrough',    edge: false, fn: () => { const r = buildEvent('task.complete', { id: '42' }); return { pass: r && r.type === 'task.complete', got: r && r.type, want: 'task.complete' }; } },
  { name: 'payload passthrough', edge: false, fn: () => { const r = buildEvent('node.create', { x: 1 }); return { pass: r && r.payload && r.payload.x === 1, got: r && r.payload, want: { x: 1 } }; } },
  { name: 'ts is a number',      edge: false, fn: () => { const r = buildEvent('ev', {}); return { pass: r && typeof r.ts === 'number', got: r && typeof r.ts, want: 'number' }; } },

  // KB-gated: ts must come from payload._enqueueMs when present (OVERRIDE note)
  { name: 'ts uses payload._enqueueMs (1)', edge: false, fn: () => { const r = buildEvent('ev', { _enqueueMs: 1700000000000 }); return { pass: r && r.ts === 1700000000000, got: r && r.ts, want: 1700000000000 }; } },
  { name: 'ts uses payload._enqueueMs (2)', edge: false, fn: () => { const r = buildEvent('ev', { _enqueueMs: 1699999999999 }); return { pass: r && r.ts === 1699999999999, got: r && r.ts, want: 1699999999999 }; } },
  // Re-emit dedup: same _enqueueMs → same ts (deterministic)
  { name: 'dedup: re-emit same _enqueueMs → same ts', edge: true, fn: () => {
    const r1 = buildEvent('ev', { _enqueueMs: 5000 });
    const r2 = buildEvent('ev', { _enqueueMs: 5000 });
    return { pass: r1.ts === r2.ts && r1.ts === 5000, got: [r1.ts, r2.ts], want: [5000, 5000] };
  }},
];

const cases = [];
for (const s of specs) {
  let pass = false, got = null, err = null, want = null;
  try {
    const result = s.fn();
    pass = result.pass;
    got = result.got;
    want = result.want;
  } catch (e) {
    err = e.message;
  }
  cases.push({ name: s.name, edge: s.edge, pass, want, got, err });
}

const pass = cases.filter(c => c.pass).length;
const edge = cases.filter(c => c.edge);
const edgePass = edge.filter(c => c.pass).length;
console.log(JSON.stringify({ ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length }));
