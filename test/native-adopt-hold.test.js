#!/usr/bin/env node
// Plain Node test for BUILD2 (unify/ready-only-via-judged): the ADOPT-HOLD that keeps a freshly
// native-adopted task OUT of `ready`/dispatch until its eager judging completes (or the judging
// timeout fires). No framework, no daemon spawn — matches judging-gate.test.js style.
// Run: node test/native-adopt-hold.test.js — exits non-zero on any failed assertion.
//
// WHY a predicate-replica test (not an E2E daemon spawn): the held state requires a SEEDED autowire
// candidate edge, which requires a live embed backend. In a sandbox embed is disabled → ingestNode
// seeds 0 edges → clearJudgingSince releases the hold immediately, so the held branch is unreachable
// E2E without embeddings (the exact fragility judging-gate.test.js calls out). We instead reproduce
// the EXACT projection predicate buildGraph computes for newly-adopted nodes (daemon.js ~L1529-1531)
// over a synthetic overlay driven through the REAL judge/overlay helpers, and assert each branch.
//
// The predicate under test (verbatim from buildGraph, where `status` = R.effective() and `js` =
// judge.judgingState over the same overlay):
//   _adoptHold = newlyAdoptedSet.has(key) && status === 'ready';
//   _status    = (_adoptHold || (js.judging && !js.timedOut && status === 'ready')) ? 'not_ready' : status;
//   _judging   = _adoptHold || (js.judging && !js.timedOut);
//   provisional = js.judging && js.timedOut;
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
// Reuses the real gate (judge.judgingState) exactly as the daemon does — no logic forked here.
function project(overlay, key, status, adopted, now, timeout) {
  const js = judge.judgingState(overlay, key, now, timeout);
  const adoptHold = adopted && status === 'ready';
  const _status = (adoptHold || (js.judging && !js.timedOut && status === 'ready')) ? 'not_ready' : status;
  const _judging = adoptHold || (js.judging && !js.timedOut);
  const provisional = js.judging && js.timedOut;
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
  o.judgingSince[KEY] = now - 30_000;          // anchor 30s ago, well within the 1h timeout

  const p = project(o, KEY, 'ready', /*adopted*/ true, now, HOUR);
  ok('ADOPT-HOLD: ready-from-deps node held at not_ready while judging', p.status === 'not_ready');
  ok('ADOPT-HOLD: projection flags judging:true', p.judging === true);
  ok('ADOPT-HOLD: not yet provisional (within timeout)', p.provisional === false);

  // Same overlay, but the node is NOT in newlyAdoptedSet AND has no fresh anchor effect — the GENERIC
  // judgingState gate ALSO holds it (proving the adopt-hold and the harness-lane gate are the same
  // boolean over the same judge.judgingState — BUILD2's "SAME gate governs native-adopted tasks").
  const pGeneric = project(o, KEY, 'ready', /*adopted*/ false, now, HOUR);
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
  const p = project(o, KEY, 'ready', /*adopted*/ true, now, HOUR);
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
  o.judgingSince[KEY] = now - 30_000;

  judge.keepEdge(o, KEY, 'note:n');            // judge keeps the edge → set drains
  // anchor cleanup mirrors the routes/judge.js drain sweep
  if (judge.unverifiedEdgesForNode(o, KEY).length === 0) ov.clearJudgingSince(o, KEY);

  const p = project(o, KEY, 'ready', /*adopted (later build)*/ false, now, HOUR);
  ok('RELEASE: judged node (later build) falls through to ready', p.status === 'ready');
  ok('RELEASE: judging:false after drain', p.judging === false);
  ok('RELEASE: not provisional', p.provisional === false);
}

// --- TIMEOUT FALLBACK: a stalled node never deadlocks — on a later build the generic gate falls back
// to ready and flags the surviving unjudged edge provisional ----------------------------------------
{
  const o = ov.EMPTY();
  o.epoch = 1;
  const now = 2_000_000_000_000;
  const KEY = 's/native4';
  o.edges.push({ from: KEY, to: 'note:z', kind: 'context', weight: 0, by: 'autowire', judged: false });
  ov.markEagerJudge(o, KEY);
  o.judgingSince[KEY] = now - 2 * HOUR;         // judgment never happened, 2h past a 1h timeout

  const p = project(o, KEY, 'ready', /*adopted (later build)*/ false, now, HOUR);
  ok('TIMEOUT: stalled node FALLS BACK to ready (no permanent deadlock)', p.status === 'ready');
  ok('TIMEOUT: released (not held)', p.judging === false);
  ok('TIMEOUT: surviving unjudged edge FLAGGED provisional', p.provisional === true);
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
  o.judgingSince[KEY] = now - 30_000;

  const p = project(o, KEY, 'not_ready', /*adopted*/ true, now, HOUR);
  ok('DEPS-GATED: adopt-hold does not manufacture readiness from a dep-blocked node', p.status === 'not_ready');
  // judging is still reported (the node IS mid-judging), but readiness is owned by deps, not the hold.
  ok('DEPS-GATED: still reports judging:true (node is genuinely mid-judging)', p.judging === true);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
