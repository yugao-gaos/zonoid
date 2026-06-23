#!/usr/bin/env node
// Plain Node test for BUILD2 (unify/ready-only-via-judged): the ADOPT-HOLD that keeps a freshly
// native-adopted task OUT of `ready`/dispatch until its eager judging completes. No framework, no
// daemon spawn — matches judging-gate.test.js style.
// Run: node test/native-adopt-hold.test.js — exits non-zero on any failed assertion.
//
// P6 STRICT: the JUDGING→READY gate has NO time-based release. A node with any unjudged autowire
// candidate edge is held until the set drains (a judge verdict), full stop — there is no timeout, no
// provisional fallback. The adopt-hold term still applies for the birth tick. `provisional` is now
// always false. Recovery from a stalled judge is the drain CLI (scripts/judge-drain-once.js).
//
// WHY a predicate-replica test (not an E2E daemon spawn): the held state requires a SEEDED autowire
// candidate edge, which requires a live embed backend. In a sandbox embed is disabled → ingestNode
// seeds 0 edges → the node has no unjudged edges so the strict gate releases it, so the held branch is
// unreachable E2E without embeddings (the exact fragility judging-gate.test.js calls out). We instead
// reproduce the EXACT projection predicate buildGraph computes for newly-adopted nodes (daemon.js)
// over a synthetic overlay driven through the REAL judge/overlay helpers, and assert each branch.
//
// The predicate under test (verbatim from buildGraph, where `status` = R.effective() and `js` =
// judge.judgingState over the same overlay):
//   _adoptHold = newlyAdoptedSet.has(key) && status === 'ready';
//   _status    = (_adoptHold || (js.judging && status === 'ready')) ? 'not_ready' : status;
//   _judging   = _adoptHold || js.judging;
//   provisional = false;   // P6: no timeout fallback, so never provisional-while-released
// BUILD2's contribution is the `_adoptHold` term: a native-adopted node that effective() computed as
// `ready` is held the SAME way harness-lane nodes are, via the SAME judge.judgingState gate.
'use strict';
const ov = require('../lib/overlay');
const judge = require('../lib/judge');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const HOUR = 3600 * 1000;

// Faithful replica of buildGraph's projection override for ONE node. `adopted` = key ∈ newlyAdoptedSet
// this build; `status` = the value R.effective() memoized (BEFORE the synchronous markEagerJudge).
// Reuses the real gate (judge.judgingState) exactly as the daemon does — no logic forked here. P6: the
// gate is strict, so no timeout arg is threaded and `provisional` is always false.
function project(overlay, key, status, adopted) {
  const js = judge.judgingState(overlay, key);
  const adoptHold = adopted && status === 'ready';
  const _status = (adoptHold || (js.judging && status === 'ready')) ? 'not_ready' : status;
  const _judging = adoptHold || js.judging;
  const provisional = false;
  return { status: _status, judging: _judging, provisional };
}

// --- ADOPT-HOLD: freshly-adopted node with a fresh seeded autowire edge is held not_ready ---------
{
  const o = ov.EMPTY();
  o.epoch = 1;
  const now = 2_000_000_000_000;
  const KEY = 's/native1';
  // Birth state: ingestNode seeded ONE weight-0 unjudged autowire candidate edge + markEagerJudge
  // stamped the judgingSince anchor. effective() (blocking deps all done) computed status === 'ready'.
  o.edges.push({ from: KEY, to: 'note:n', kind: 'context', weight: 0, by: 'autowire', judged: false, score: 0.42 });
  ov.markEagerJudge(o, KEY);

  const p = project(o, KEY, 'ready', /*adopted*/ true);
  ok('ADOPT-HOLD: ready-from-deps node held at not_ready while judging', p.status === 'not_ready');
  ok('ADOPT-HOLD: projection flags judging:true', p.judging === true);
  ok('ADOPT-HOLD: provisional always false (P6: no timeout fallback)', p.provisional === false);

  // Same overlay, but the node is NOT in newlyAdoptedSet — the GENERIC strict judgingState gate ALSO
  // holds it (proving the adopt-hold and the harness-lane gate are the same boolean over the same
  // judge.judgingState — BUILD2's "SAME gate governs native-adopted tasks").
  const pGeneric = project(o, KEY, 'ready', /*adopted*/ false);
  ok('SAME GATE: non-adopted node with the same unjudged edge is held identically', pGeneric.status === 'not_ready' && pGeneric.judging === true);
}

// --- ADOPT-HOLD IS ONE-TICK: it holds unconditionally on the BIRTH build, regardless of edge state.
// newlyAdoptedSet only contains nodes adopted in THIS build tick; the async ingest + clearJudgingSince
// (or a judge verdict) resolve on a LATER build where the node is no longer newly-adopted. So even a
// node whose edge happens to already read judged, or whose anchor is already stale, is still held for
// this one birth tick — the hold is deliberately decoupled from judging state on the birth build.
{
  const o = ov.EMPTY();
  o.epoch = 1;
  const now = 2_000_000_000_000;
  const KEY = 's/native2';
  o.edges.push({ from: KEY, to: 'note:n', kind: 'context', weight: 0, by: 'autowire', judged: true, score: 0.5 });
  // (no unjudged edge → judgingState would say judging:false, yet adopt-hold STILL holds for the tick)
  const p = project(o, KEY, 'ready', /*adopted*/ true);
  ok('BIRTH-TICK: adopt-hold holds at not_ready even if no unjudged edge yet (one-tick safety)', p.status === 'not_ready');
  ok('BIRTH-TICK: reports judging:true for the birth tick', p.judging === true);
}

// --- RELEASE: on a LATER build the node is no longer newly-adopted; once its eager edge is JUDGED
// the GENERIC judgingState gate (same gate) lets it through to ready --------------------------------
{
  const o = ov.EMPTY();
  o.epoch = 1;
  const now = 2_000_000_000_000;
  const KEY = 's/native3';
  o.edges.push({ from: KEY, to: 'note:n', kind: 'context', weight: 0, by: 'autowire', judged: false, score: 0.5 });
  ov.markEagerJudge(o, KEY);

  judge.keepEdge(o, KEY, 'note:n');            // judge keeps the edge → set drains
  // anchor cleanup mirrors the routes/judge.js drain sweep
  if (judge.unverifiedEdgesForNode(o, KEY).length === 0) ov.clearJudgingSince(o, KEY);

  const p = project(o, KEY, 'ready', /*adopted (later build)*/ false);
  ok('RELEASE: judged node (later build) falls through to ready', p.status === 'ready');
  ok('RELEASE: judging:false after drain', p.judging === false);
  ok('RELEASE: not provisional', p.provisional === false);
}

// --- STRICT NO-RELEASE: a stalled node is held INDEFINITELY (no timeout fallback). On a later build
// the generic gate STILL holds it until a verdict drains the edge — recovery is the drain CLI, not a
// clock. This is the P6 inversion of the old TIMEOUT-FALLBACK case. ----------------------------------
{
  const o = ov.EMPTY();
  o.epoch = 1;
  const now = 2_000_000_000_000;
  const KEY = 's/native4';
  o.edges.push({ from: KEY, to: 'note:z', kind: 'context', weight: 0, by: 'autowire', judged: false });
  ov.markEagerJudge(o, KEY);
  o.judgingSince[KEY] = now - 100 * HOUR;       // judgment never happened — under the OLD gate this released

  const p = project(o, KEY, 'ready', /*adopted (later build)*/ false);
  ok('STRICT: stalled node STAYS held not_ready (no time-based release)', p.status === 'not_ready');
  ok('STRICT: still reports judging:true (held until judged)', p.judging === true);
  ok('STRICT: never provisional (no timeout fallback exists)', p.provisional === false);

  // The ONLY exit is a verdict — exactly what the eager judge / drain CLI applies.
  judge.keepEdge(o, KEY, 'note:z');
  if (judge.unverifiedEdgesForNode(o, KEY).length === 0) ov.clearJudgingSince(o, KEY);
  const p2 = project(o, KEY, 'ready', /*adopted*/ false);
  ok('STRICT: a verdict (drain CLI) releases the held node to ready', p2.status === 'ready' && p2.judging === false);
}

// --- NO MANUFACTURED READINESS: adopt-hold only acts on a node deps already made ready ------------
// A freshly-adopted node whose blocking deps are NOT done has status 'not_ready' from effective().
// The adopt-hold term is gated on `status === 'ready'`, so it must NOT flip an unready node's status
// nor (since deps aren't satisfied) claim it's merely judging — it stays plainly not_ready.
{
  const o = ov.EMPTY();
  o.epoch = 1;
  const now = 2_000_000_000_000;
  const KEY = 's/native5';
  o.edges.push({ from: KEY, to: 'note:n', kind: 'context', weight: 0, by: 'autowire', judged: false, score: 0.42 });
  ov.markEagerJudge(o, KEY);

  const p = project(o, KEY, 'not_ready', /*adopted*/ true);
  ok('DEPS-GATED: adopt-hold does not manufacture readiness from a dep-blocked node', p.status === 'not_ready');
  // judging is still reported (the node IS mid-judging), but readiness is owned by deps, not the hold.
  ok('DEPS-GATED: still reports judging:true (node is genuinely mid-judging)', p.judging === true);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
