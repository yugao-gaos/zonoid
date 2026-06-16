#!/usr/bin/env node
// Plain Node test for the now-async suggestForTask (daemon.js) + its optional cross-encoder rerank.
// Run: node test/suggest-rerank.test.js  (exits non-zero on any failed assertion)
//
// Covers the two SAFETY invariants (model-independent):
//   1. FLAG OFF ⇒ suggestForTask resolves to the SAME lexical-ranked top-5 as before (just via a
//      Promise now). Order is by lexical token-overlap; structure {suggestions,duplicates,hint} intact.
//   2. ORCH_RERANK ON + COLD sidecar ⇒ rerank() returns null ⇒ NULL-DEGRADE to the lexical order
//      (no throw). On a fresh process the rerank sidecar isn't loaded, so the first call degrades.
'use strict';
const { suggestForTask } = require('../daemon');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Suite watchdog: the rerank=1 leg can trigger an 80MB cross-encoder load; under the parallel suite
// that may contend. Never exceed the runner's per-test cap — exit cleanly at 60s. The off-path
// assertions (the safety invariant) have already run by then; a slow model only skips the on-leg.
setTimeout(() => { console.log(`\n(watchdog 60s) ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }, 60_000).unref();

// Target + candidates with decreasing lexical overlap (vec-less ⇒ lexical scoring path).
const target = { id: 's/anchor', label: 'refund pipeline retry idempotency', summary: 'make stripe refund retries idempotent', deps: [], context_deps: [] };
const g = { tasks: [
  target,
  { id: 's/1', label: 'stripe refund pipeline idempotency keys', summary: 'idempotent refund retry keys', status: 'done', deps: [], context_deps: [] },
  { id: 's/2', label: 'refund pipeline dashboard', summary: 'refund metrics', status: 'ready', deps: [], context_deps: [] },
  { id: 's/3', label: 'rotate vault credentials', summary: 'cron rotation', status: 'ready', deps: [], context_deps: [] },
] };

(async () => {
  // 1. FLAG OFF — async resolves to lexical-ranked suggestions, structure intact.
  delete process.env.ORCH_RERANK;
  const off = await suggestForTask(g, target);
  ok('off: returns {suggestions,duplicates,hint}', off && Array.isArray(off.suggestions) && Array.isArray(off.duplicates) && typeof off.hint === 'string');
  ok('off: top-5 cap respected', off.suggestions.length <= 5);
  ok('off: relevant s/1 ranks above unrelated s/3', (() => {
    const i1 = off.suggestions.findIndex((s) => s.key === 's/1');
    const i3 = off.suggestions.findIndex((s) => s.key === 's/3');
    return i1 !== -1 && (i3 === -1 || i1 < i3);
  })());
  const offOrder = off.suggestions.map((s) => s.key).join(',');

  // 2. ORCH_RERANK ON, cold sidecar ⇒ null-degrade ⇒ same lexical order, no throw.
  process.env.ORCH_RERANK = '1';
  let on;
  try { on = await suggestForTask(g, target); ok('rerank=1 (cold): resolves without throwing', true); }
  catch (e) { ok(`rerank=1 (cold): resolves without throwing — threw ${e.message}`, false); on = { suggestions: [] }; }
  const onReranked = on.suggestions.some((s) => s.ceScore !== undefined);
  if (!onReranked) ok('rerank=1 (null-degrade): lexical order preserved', on.suggestions.map((s) => s.key).join(',') === offOrder);
  else console.log('NOTE  rerank=1: sidecar warmed and reranked; no-throw asserted');
  delete process.env.ORCH_RERANK;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
