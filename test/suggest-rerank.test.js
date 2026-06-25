#!/usr/bin/env node
// Plain Node test for the now-SEMANTIC suggestForTask (daemon.js) + its default-on cross-encoder rerank.
// Run: node test/suggest-rerank.test.js  (exits non-zero on any failed assertion)
//
// suggest_links was consolidated OFF the lexical scoreMatches onto scoreMatchesSemantic — the same
// cosine core /search uses — with the cross-encoder rerank now DEFAULT-ON (null-safe) and a
// scale-aware duplicate threshold. Covered here:
//   1. SEMANTIC ranking when vecs are present: cosine order, via:'semantic', shared-token evidence kept.
//   2. Scale-aware duplicate flag: a near-paraphrase OPEN task (cosine >= SEMANTIC_DUP_THRESHOLD) is
//      flagged duplicate; a merely-related one is not.
//   3. LEXICAL fallback (vec-less nodes): relevant ranks above unrelated, via:'lexical' — back-compat.
//   4. Rerank DEFAULT-ON is null-safe: with a cold/absent sidecar rerank() returns null and the
//      cosine order is preserved (no throw); ORCH_RERANK=off force-disables identically.
'use strict';
let rerankScores = null;
const rerankCalls = [];
// Stub rerank before daemon import so the default-on path is deterministic and sidecar-free.
const rerankPath = require.resolve('../lib/rerank');
require.cache[rerankPath] = {
  id: rerankPath,
  filename: rerankPath,
  loaded: true,
  exports: {
    rerank: async (query, docs) => {
      rerankCalls.push({ query, docs });
      return Array.isArray(rerankScores) ? rerankScores : null;
    },
    rerankStatus: () => 'stub',
  },
};
const { suggestForTask, SEMANTIC_DUP_THRESHOLD } = require('../daemon');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// 3-dim synthetic vecs (cosine only needs matching lengths, not DIMS). Word overlap is independent of
// the vecs so we can assert the `shared` evidence survives semantic ranking.
const V = (a, b, c) => [a, b, c];
const semTarget = { id: 't', label: 'refund retry idempotency', summary: 'stripe refund flow', deps: [], context_deps: [], vecs: [V(1, 0, 0)] };
const semGraph = { tasks: [
  semTarget,
  { id: 'a', label: 'refund retry idempotency keys', summary: 'idempotent refund', status: 'ready', deps: [], context_deps: [], vecs: [V(0.99, 0.14, 0)] }, // near-paraphrase => dup
  { id: 'b', label: 'refund dashboard metrics',      summary: 'refund ui panel',   status: 'ready', deps: [], context_deps: [], vecs: [V(0.7, 0.7, 0)] },  // related, not dup
  { id: 'c', label: 'vault credential rotation',     summary: 'cron job',          status: 'ready', deps: [], context_deps: [], vecs: [V(0, 0, 1)] },       // orthogonal => score 0, dropped
] };

// Vec-less fixtures => scoreMatchesSemantic falls back PER-CANDIDATE to lexical token overlap.
const lexTarget = { id: 's/anchor', label: 'refund pipeline retry idempotency', summary: 'make stripe refund retries idempotent', deps: [], context_deps: [] };
const lexGraph = { tasks: [
  lexTarget,
  { id: 's/1', label: 'stripe refund pipeline idempotency keys', summary: 'idempotent refund retry keys', status: 'done', deps: [], context_deps: [] },
  { id: 's/2', label: 'refund pipeline dashboard', summary: 'refund metrics', status: 'ready', deps: [], context_deps: [] },
  { id: 's/3', label: 'rotate vault credentials', summary: 'cron rotation', status: 'ready', deps: [], context_deps: [] },
] };

(async () => {
  // ---- 1 + 2. SEMANTIC ranking + scale-aware duplicate (rerank forced OFF for determinism) ----
  process.env.ORCH_RERANK = 'off';
  const sem = await suggestForTask(semGraph, semTarget);
  ok('semantic: returns {suggestions,duplicates,hint}', sem && Array.isArray(sem.suggestions) && Array.isArray(sem.duplicates) && typeof sem.hint === 'string');
  ok('semantic: orthogonal candidate (score 0) dropped', !sem.suggestions.some((s) => s.key === 'c'));
  ok('semantic: near-paraphrase a ranks above related b', (() => {
    const ia = sem.suggestions.findIndex((s) => s.key === 'a');
    const ib = sem.suggestions.findIndex((s) => s.key === 'b');
    return ia !== -1 && ib !== -1 && ia < ib;
  })());
  const a = sem.suggestions.find((s) => s.key === 'a');
  const b = sem.suggestions.find((s) => s.key === 'b');
  ok('semantic: top hit scored via cosine (via:semantic)', a && a.via === 'semantic');
  ok('semantic: shared-token evidence preserved', a && Array.isArray(a.shared) && a.shared.includes('refund'));
  ok('semantic: near-paraphrase flagged duplicate (cosine >= SEMANTIC_DUP_THRESHOLD)', a && a.score >= SEMANTIC_DUP_THRESHOLD && a.duplicate === true && sem.duplicates.includes('a'));
  ok('semantic: merely-related candidate NOT flagged duplicate', b && b.score < SEMANTIC_DUP_THRESHOLD && b.duplicate === false);
  ok('semantic: dup hint nudges supersede_task', sem.duplicates.length > 0 && /WARNING/.test(sem.hint) && /supersede_task/.test(sem.hint));

  // ---- 2b. Rerank DEFAULT-ON with non-null scores can reorder the semantic candidate window ----
  delete process.env.ORCH_RERANK;
  rerankScores = [0.1, 0.9]; // score order matches the cosine pool [a,b], but CE prefers b
  rerankCalls.length = 0;
  const rrSem = await suggestForTask(semGraph, semTarget);
  ok('rerank default-on (non-null): cross-encoder called once', rerankCalls.length === 1 && rerankCalls[0].docs.length === 2);
  ok('rerank default-on (non-null): CE score reorders b above a', rrSem.suggestions[0] && rrSem.suggestions[0].key === 'b' && rrSem.suggestions[0].ceScore === 0.9);

  // ---- 3. LEXICAL fallback (vec-less) — relevant above unrelated, via:'lexical' ----
  rerankScores = null;
  const lex = await suggestForTask(lexGraph, lexTarget);
  ok('lexical: top-5 cap + structure', lex.suggestions.length <= 5 && Array.isArray(lex.duplicates));
  ok('lexical: relevant s/1 ranks above unrelated s/3', (() => {
    const i1 = lex.suggestions.findIndex((s) => s.key === 's/1');
    const i3 = lex.suggestions.findIndex((s) => s.key === 's/3');
    return i1 !== -1 && (i3 === -1 || i1 < i3);
  })());
  ok('lexical: vec-less candidate scored via token overlap (via:lexical)', (lex.suggestions.find((s) => s.key === 's/1') || {}).via === 'lexical');
  const lexOrder = lex.suggestions.map((s) => s.key).join(',');

  // ---- 4. Rerank DEFAULT-ON is null-safe: unset flag => rerank fires, a cold sidecar null-degrades
  //         to the SAME order as ORCH_RERANK=off. (If the sidecar warmed and reranked, only assert no-throw.)
  delete process.env.ORCH_RERANK;            // default-on
  let dflt;
  try { dflt = await suggestForTask(lexGraph, lexTarget); ok('rerank default-on (cold): resolves without throwing', true); }
  catch (e) { ok(`rerank default-on (cold): resolves without throwing — threw ${e.message}`, false); dflt = { suggestions: [] }; }
  const reranked = dflt.suggestions.some((s) => s.ceScore !== undefined);
  if (!reranked) ok('rerank default-on (null-degrade): scorer order preserved', dflt.suggestions.map((s) => s.key).join(',') === lexOrder);
  else console.log('NOTE  rerank default-on: sidecar warmed and reranked; no-throw asserted');
  delete process.env.ORCH_RERANK;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
