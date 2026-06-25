#!/usr/bin/env node
// Plain Node test for the JUDGING→READY gate (task D / P6 STRICT) — no framework; matches
// judge-eager.test.js style. Run: node test/judging-gate.test.js — exits non-zero on any failed assert.
//
// Lifecycle gated here: created → wiring → JUDGING → ready → claimable. A task with outstanding
// unjudged autowire candidate edges (judged:false, by:'autowire') is in the 'judging' phase and is
// NOT ready/claimable.
//
// P6 INVARIANT (STRICT — no time-based release): a node with ANY unjudged autowire candidate edge is
// NOT READY until those edges are judged. There is NO timeout, NO hard ceiling, NO provisional
// fallback — the node holds until the candidate set actually drains. judgingState.timedOut is
// therefore ALWAYS false, and the projection's `provisional` flag is always false. Recovery from a
// stalled judge is the on-demand drain CLI (scripts/judge-drain-once.js), NOT a clock.
//
// Two layers under test:
//   PURE substrate (lib/overlay + lib/judge) — deterministic, always runs:
//     - judgingState classifies a node: not-judging (drained) vs judging (held, never timed-out).
//     - judgingState ignores any nowMs/timeoutMs/hardCeilingMs args (back-compat shape only).
//     - keepEdge / removeEdge drain the candidate set → judging:false → ready.
//   GATE PREDICATE — the exact boolean both callsites use (daemon.effective readiness derivation +
//     routes/overlay claim gate): `held = js.judging`. Both sites are a thin wrapper over judgingState,
//     so asserting the predicate over the lifecycle covers the gate behaviour deterministically
//     without spawning a daemon (the E2E claim harness is fragile in sandbox).
'use strict';
const ov = require('../lib/overlay');
const judge = require('../lib/judge');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const HOUR = 3600 * 1000;

// --- PURE: markEagerJudge still stamps the eager-dispatch state (the happy-path drainer trigger) ----
// (judgingSince is now a vestigial timestamp the strict gate no longer reads, but markEagerJudge is
// still the eager-judge dispatch marker — assert it remains wired.)
{
  const o = ov.EMPTY();
  o.epoch = 1;
  ov.markEagerJudge(o, 's/1');
  ok('markEagerJudge marks the node for eager dispatch', !!(o.eagerJudge && o.eagerJudge['s/1']));
  ok('clearJudgingSince removes the vestigial anchor (returns true when present)',
    (o.judgingSince && 's/1' in o.judgingSince) ? ov.clearJudgingSince(o, 's/1') === true : true);
}

// --- PURE: judgingState — STRICT two-branch classification (no timeout branch) --------------------
{
  const o = ov.EMPTY();
  const now = 1_000_000_000_000;
  // (a) no unjudged edges at all → not judging.
  o.edges = [{ from: 's/a', to: 'note:x', kind: 'context', judged: true }];
  const a = judge.judgingState(o, 's/a');
  ok('no unjudged edges → judging:false', a.judging === false && a.timedOut === false);

  // (b) unjudged edge → judging:true, timedOut ALWAYS false (held, no clock).
  o.edges = [{ from: 's/b', to: 'note:y', kind: 'context', judged: false }];
  const b = judge.judgingState(o, 's/b');
  ok('unjudged edge → judging:true, timedOut:false (held)', b.judging === true && b.timedOut === false);

  // (c) STRICT: even with an ancient anchor + ancient firstSeen + tiny timeout args, NEVER times out.
  o.judgingSince = { 's/b': now - 100 * HOUR };
  o.timestamps = { 's/b': { firstSeen: new Date(now - 100 * HOUR).toISOString() } };
  const c = judge.judgingState(o, 's/b', now, 1, 1);   // pass a 1ms timeout + 1ms ceiling — must be ignored
  ok('STRICT: ancient anchor + tiny timeout args still held (no time-release)', c.judging === true && c.timedOut === false);

  // (d) unjudged edge but NO anchor → STILL held (strict gate does not depend on an anchor).
  o.judgingSince = {};
  o.timestamps = {};
  const d = judge.judgingState(o, 's/b');
  ok('unjudged edge with no anchor → still held (judging:true, timedOut:false)', d.judging === true && d.timedOut === false);

  // incoming-edge incidence also counts (gate is symmetric on either endpoint).
  o.edges = [{ from: 'note:p', to: 's/c', kind: 'context', judged: false }];
  const e = judge.judgingState(o, 's/c');
  ok('incoming unjudged edge counts as judging', e.judging === true && e.timedOut === false);
}

// --- PURE: the removed timeout symbols are GONE (regression guard for P6) -------------------------
{
  ok('JUDGING_TIMEOUT_MS removed from exports', judge.JUDGING_TIMEOUT_MS === undefined);
  ok('JUDGING_HARD_CEILING_MS removed from exports', judge.JUDGING_HARD_CEILING_MS === undefined);
  ok('judgingTimeoutMs removed from exports', typeof judge.judgingTimeoutMs !== 'function');
  ok('judgingHardCeilingMs removed from exports', typeof judge.judgingHardCeilingMs !== 'function');
  // The pending-dup visibility timeout is SEPARATE and survives (its own dedicated accessor).
  ok('pendingDupTimeoutMs survives (separate concern)', typeof judge.pendingDupTimeoutMs === 'function');
}

// --- GATE PREDICATE over the full lifecycle (what daemon.effective + the claim gate compute) -----
// Both callsites hold a task iff `js.judging` (P6: no longer `&& !js.timedOut`, since timedOut is
// always false). We drive a node through the real overlay helpers and assert the predicate at each step.
const held = (o, key) => judge.judgingState(o, key).judging;
{
  const o = ov.EMPTY();
  o.epoch = 1;
  // SEED: task born with an unjudged autowire candidate edge + eager mark (B/C path).
  o.edges.push({ from: 's/t', to: 'note:n', kind: 'context', weight: 0, by: 'autowire', judged: false, score: 0.4 });
  ov.markEagerJudge(o, 's/t');
  ok('LIFECYCLE seed: gate HOLDS the task (unjudged candidate edge)', held(o, 's/t') === true);

  // JUDGE the edge (keep) → edge.judged flips true, set drains, gate releases.
  judge.keepEdge(o, 's/t', 'note:n');
  ok('LIFECYCLE judged: edge now verified', o.edges[0].judged === true);
  ok('LIFECYCLE judged: gate RELEASES (no longer judging)', held(o, 's/t') === false);
  // anchor cleanup mirrors routes/judge.js drain sweep
  if (judge.unverifiedEdgesForNode(o, 's/t').length === 0) ov.clearJudgingSince(o, 's/t');
  ok('LIFECYCLE judged: anchor pruned on drain', !('s/t' in (o.judgingSince || {})));
}
{
  const o = ov.EMPTY();
  o.epoch = 1;
  o.edges.push({ from: 's/prune', to: 'note:n', kind: 'context', weight: 0, by: 'autowire', judged: false, score: 0.4 });
  ov.markEagerJudge(o, 's/prune');
  ok('LIFECYCLE prune seed: gate HOLDS before verdict', held(o, 's/prune') === true);

  // PRUNE the edge via the same primitive routes/judge.js uses for pruneEdge verdicts.
  ov.removeEdge(o, 's/prune', 'note:n', null, 'context');
  if (judge.unverifiedEdgesForNode(o, 's/prune').length === 0) ov.clearJudgingSince(o, 's/prune');
  ok('LIFECYCLE pruned: edge gone', o.edges.length === 0);
  ok('LIFECYCLE pruned: gate clears after prune', held(o, 's/prune') === false);
}
{
  // STRICT NO-RELEASE: a node whose judgment STALLS (edge never judged) is held INDEFINITELY — there
  // is no timeout that releases it. Recovery is the drain CLI, not a clock. Proves the P6 invariant:
  // the only exit from 'judging' is an actual verdict (keep/prune), not the passage of time.
  const o = ov.EMPTY();
  o.epoch = 1;
  const now = 2_000_000_000_000;
  o.edges.push({ from: 's/stall', to: 'note:z', kind: 'context', weight: 0, by: 'autowire', judged: false });
  ov.markEagerJudge(o, 's/stall');
  o.judgingSince = { 's/stall': now - 100 * HOUR };  // ancient — under the OLD gate this would release
  o.timestamps = { 's/stall': { firstSeen: new Date(now - 100 * HOUR).toISOString() } };
  ok('STALL: gate STILL HOLDS after an arbitrarily long wait (no time-release)', held(o, 's/stall') === true);
  ok('STALL: never flagged provisional (timedOut pinned false)', judge.judgingState(o, 's/stall').timedOut === false);
  // The ONLY way out: judge the edge (the drain CLI / eager judge does exactly this).
  judge.keepEdge(o, 's/stall', 'note:z');
  ok('STALL: a verdict (what the drain CLI applies) is what releases it', held(o, 's/stall') === false);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
