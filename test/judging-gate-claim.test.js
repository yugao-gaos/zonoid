#!/usr/bin/env node
// P6 — claim-gate transition test: a node with seeded UNJUDGED autowire candidate edges is NOT
// claimable (the POST /overlay/status handler replies 409), and AFTER the edges are judged (simulating
// the eager judge / `scripts/judge-drain-once.js` drain) it becomes claimable. No framework, no daemon
// spawn. Run: node test/judging-gate-claim.test.js — exits non-zero on any failed assertion.
//
// WHY pure-substrate (not an E2E daemon spawn): a held state requires an UNJUDGED (judged:false) edge,
// and graph-store's edge serialization (lib/graph-store.js addEdge) drops the `judged` flag on the
// daemon's disk reload in a spawned sandbox — so the held branch is unreachable end-to-end without
// embeddings + reload-surviving edge meta. test/judging-gate.test.js and test/dag-only-claim-context.js
// hit the same wall and make the same choice. We replicate the EXACT claim-gate decision the route
// computes (routes/overlay.js, the JUDGING→READY arm) and assert the 409/allow transition.
'use strict';
const ov = require('../lib/overlay');
const judge = require('../lib/judge');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// EXACT replica of the claim gate in routes/overlay.js (the JUDGING→READY arm). Returns the HTTP
// outcome the handler would produce for the claim: 409 (held — refused) or 200 (allowed through the
// gate). Strict, clockless — mirrors `const _js = judge.judgingState(T.ov, b.key); if (_js.judging) 409`.
function claimOutcome(overlay, taskKey, { force = false } = {}) {
  if (!force) {
    const _js = judge.judgingState(overlay, taskKey);
    if (_js.judging) return { code: 409, error: 'task wirings not yet judged' };
  }
  return { code: 200 };
}

// --- A node with seeded unjudged autowire edges is NOT claimable (409) ----------------------------
{
  const o = ov.EMPTY();
  o.epoch = 1;
  const KEY = 's/claim1';
  // Seed two weight-0 unjudged autowire candidate edges (the whole-graph-recall birth state) + the
  // eager mark, exactly as the autowire seed callsites do.
  o.edges.push({ from: KEY, to: 'note:a', kind: 'context', weight: 0, by: 'autowire', judged: false, score: 0.41 });
  o.edges.push({ from: KEY, to: 'note:b', kind: 'context', weight: 0, by: 'autowire', judged: false, score: 0.38 });
  ov.markEagerJudge(o, KEY);

  const r0 = claimOutcome(o, KEY);
  ok('CLAIM held: a node with unjudged autowire edges is refused (409)', r0.code === 409);
  ok('CLAIM held: refusal cites the judging phase', /not yet judged/.test(r0.error || ''));

  // STRICT: no passage of "time" can release it — the gate is clockless, so a second identical check
  // still refuses (there is no timeout that could have elapsed between attempts).
  ok('CLAIM held: a later retry is STILL refused (no time-based release)', claimOutcome(o, KEY).code === 409);

  // Judge ONE of the two edges — still has an unjudged edge → STILL held.
  judge.keepEdge(o, KEY, 'note:a');
  ok('CLAIM held: still refused while ANY candidate edge remains unjudged', claimOutcome(o, KEY).code === 409);

  // Judge the SECOND edge (simulating the drain CLI finishing the node's edge-set) → set drains.
  judge.keepEdge(o, KEY, 'note:b');
  // drain sweep clears the vestigial anchor, mirroring routes/judge.js
  if (judge.unverifiedEdgesForNode(o, KEY).length === 0) ov.clearJudgingSince(o, KEY);
  const r1 = claimOutcome(o, KEY);
  ok('CLAIM allowed: after all candidate edges are judged, the claim passes the gate (200)', r1.code === 200);
}

// --- The drain can also PRUNE edges to release the node (keep is not the only exit) ---------------
{
  const o = ov.EMPTY();
  o.epoch = 1;
  const KEY = 's/claim2';
  o.edges.push({ from: KEY, to: 'note:x', kind: 'context', weight: 0, by: 'autowire', judged: false, score: 0.3 });
  ov.markEagerJudge(o, KEY);
  ok('CLAIM held: unjudged edge refuses the claim (409)', claimOutcome(o, KEY).code === 409);

  // The drain prunes the low-relevance edge (a prune verdict) → candidate set drains → claimable.
  ov.removeEdge(o, KEY, 'note:x', null, 'context');
  if (judge.unverifiedEdgesForNode(o, KEY).length === 0) ov.clearJudgingSince(o, KEY);
  ok('CLAIM allowed: a PRUNE verdict also drains the set and releases the claim (200)', claimOutcome(o, KEY).code === 200);
}

// --- force=true bypasses the gate even while judging (operator override, unchanged) ---------------
{
  const o = ov.EMPTY();
  o.epoch = 1;
  const KEY = 's/claim3';
  o.edges.push({ from: KEY, to: 'note:y', kind: 'context', weight: 0, by: 'autowire', judged: false });
  ov.markEagerJudge(o, KEY);
  ok('CLAIM force: non-forced claim is held (409)', claimOutcome(o, KEY).code === 409);
  ok('CLAIM force: a forced claim bypasses the judging gate (200)', claimOutcome(o, KEY, { force: true }).code === 200);
}

// --- A node that never had candidate edges is claimable immediately (no false hold) ---------------
{
  const o = ov.EMPTY();
  o.epoch = 1;
  const KEY = 's/claim4';
  // Only a JUDGED (kept) context edge — no unjudged candidates.
  o.edges.push({ from: KEY, to: 'note:z', kind: 'context', weight: 0.5, by: 'judge', judged: true });
  ok('CLAIM clear: a node with no unjudged candidate edge is claimable (200)', claimOutcome(o, KEY).code === 200);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
