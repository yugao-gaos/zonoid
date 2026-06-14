#!/usr/bin/env node
// Plain Node test for the JUDGING→READY gate (task D) — no framework; matches judge-eager.test.js
// style. Run: node test/judging-gate.test.js — exits non-zero on any failed assertion.
//
// Lifecycle gated here: created → wiring → JUDGING → ready → claimable. A task with outstanding
// unjudged autowire candidate edges (judged:false, by:'autowire') is in the 'judging' phase and is
// NOT ready/claimable — UNTIL a configurable timeout fires, at which point it FALLS BACK to ready with
// its surviving unjudged edges FLAGGED provisional (never a permanent deadlock).
//
// Two layers under test:
//   PURE substrate (lib/overlay + lib/judge) — deterministic, always runs:
//     - markEagerJudge stamps a wall-clock judgingSince anchor (once); clearJudgingSince removes it.
//     - judgingState classifies a node: not-judging / judging-within-timeout / timed-out-provisional.
//     - judgingTimeoutMs honours config.judge.timeoutMs > env JUDGE_TIMEOUT_MS > default.
//     - a node with NO judgingSince anchor but unjudged edges is treated as timed-out (never deadlocks).
//   GATE PREDICATE — the exact boolean both callsites use (daemon.effective readiness derivation +
//     routes/overlay claim gate): `held = js.judging && !js.timedOut`. Both sites are a thin wrapper
//     over judgingState, so asserting the predicate over the lifecycle covers the gate behaviour
//     deterministically without spawning a daemon (the E2E claim harness is fragile in sandbox — see
//     the ~11-14 pre-existing daemon-spawn failures).
'use strict';
const ov = require('../lib/overlay');
const judge = require('../lib/judge');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const HOUR = 3600 * 1000;

// --- PURE: markEagerJudge stamps a judgingSince anchor; clearJudgingSince removes it -------------
{
  const o = ov.EMPTY();
  o.epoch = 1;
  ov.markEagerJudge(o, 's/1');
  ok('markEagerJudge stamps a judgingSince anchor', typeof o.judgingSince['s/1'] === 'number' && o.judgingSince['s/1'] > 0);
  const first = o.judgingSince['s/1'];
  ov.markEagerJudge(o, 's/1');   // re-mark
  ok('re-mark does NOT refresh the anchor (timeout measured from birth)', o.judgingSince['s/1'] === first);
  ok('clearJudgingSince removes the anchor (returns true)', ov.clearJudgingSince(o, 's/1') === true && !('s/1' in o.judgingSince));
  ok('clearJudgingSince on absent node returns false', ov.clearJudgingSince(o, 's/1') === false);
}

// --- PURE: judgingState — the three lifecycle branches ------------------------------------------
{
  const o = ov.EMPTY();
  const now = 1_000_000_000_000;
  // (a) no unjudged edges at all → not judging.
  o.edges = [{ from: 's/a', to: 'note:x', kind: 'context', judged: true }];
  const a = judge.judgingState(o, 's/a', now, HOUR);
  ok('no unjudged edges → judging:false', a.judging === false && a.timedOut === false);

  // (b) unjudged edge, anchor fresh (within timeout) → judging, not timed out.
  o.edges = [{ from: 's/b', to: 'note:y', kind: 'context', judged: false }];
  o.judgingSince = { 's/b': now - 60_000 };   // 1 min ago, timeout 1h
  const b = judge.judgingState(o, 's/b', now, HOUR);
  ok('fresh unjudged edge → judging:true, timedOut:false', b.judging === true && b.timedOut === false);

  // (c) unjudged edge, anchor stale (past timeout) → judging, TIMED OUT (provisional fallback).
  o.judgingSince = { 's/b': now - 2 * HOUR };   // 2h ago, timeout 1h
  const c = judge.judgingState(o, 's/b', now, HOUR);
  ok('stale unjudged edge → judging:true, timedOut:true', c.judging === true && c.timedOut === true);

  // (d) unjudged edge but NO anchor → treated as timed-out so it can never permanently deadlock.
  o.judgingSince = {};
  const d = judge.judgingState(o, 's/b', now, HOUR);
  ok('unjudged edge with no anchor → timedOut:true (never deadlocks)', d.judging === true && d.timedOut === true);

  // incoming-edge incidence also counts (gate is symmetric on either endpoint).
  o.edges = [{ from: 'note:p', to: 's/c', kind: 'context', judged: false }];
  o.judgingSince = { 's/c': now };
  const e = judge.judgingState(o, 's/c', now, HOUR);
  ok('incoming unjudged edge counts as judging', e.judging === true && e.timedOut === false);
}

// --- PURE: judgingTimeoutMs precedence (config > env > default) ----------------------------------
{
  const base = ov.EMPTY();
  delete process.env.JUDGE_TIMEOUT_MS;
  ok('default timeout = JUDGING_TIMEOUT_MS', judge.judgingTimeoutMs(base) === judge.JUDGING_TIMEOUT_MS);

  process.env.JUDGE_TIMEOUT_MS = String(5 * 60 * 1000);
  ok('env JUDGE_TIMEOUT_MS overrides default', judge.judgingTimeoutMs(ov.EMPTY()) === 5 * 60 * 1000);

  const cfg = ov.EMPTY(); cfg.config = { judge: { timeoutMs: 90 * 1000 } };
  ok('config.judge.timeoutMs overrides env', judge.judgingTimeoutMs(cfg) === 90 * 1000);
  delete process.env.JUDGE_TIMEOUT_MS;

  // non-positive / non-finite config is ignored (falls through to default).
  const bad = ov.EMPTY(); bad.config = { judge: { timeoutMs: 0 } };
  ok('config timeoutMs:0 ignored → default', judge.judgingTimeoutMs(bad) === judge.JUDGING_TIMEOUT_MS);
}

// --- GATE PREDICATE over the full lifecycle (what daemon.effective + the claim gate compute) -----
// Both callsites hold a task iff `js.judging && !js.timedOut`. We drive a node through the real
// overlay helpers (markEagerJudge seed → judge edge → drain) and assert the predicate at each step.
const held = (o, key, now, timeout) => { const j = judge.judgingState(o, key, now, timeout); return j.judging && !j.timedOut; };
const flagged = (o, key, now, timeout) => { const j = judge.judgingState(o, key, now, timeout); return j.judging && j.timedOut; };
{
  const o = ov.EMPTY();
  o.epoch = 1;
  const now = 2_000_000_000_000;
  // SEED: task born with an unjudged autowire candidate edge + eager mark (B/C path).
  o.edges.push({ from: 's/t', to: 'note:n', kind: 'context', weight: 0, by: 'autowire', judged: false, score: 0.4 });
  ov.markEagerJudge(o, 's/t');                 // stamps judgingSince anchor
  o.judgingSince['s/t'] = now - 30_000;        // pin anchor 30s ago for a deterministic clock
  ok('LIFECYCLE seed: gate HOLDS the task (judging within timeout)', held(o, 's/t', now, HOUR) === true);
  ok('LIFECYCLE seed: not yet flagged provisional', flagged(o, 's/t', now, HOUR) === false);

  // JUDGE the edge (keep) → edge.judged flips true, set drains, gate releases.
  judge.keepEdge(o, 's/t', 'note:n');
  ok('LIFECYCLE judged: edge now verified', o.edges[0].judged === true);
  ok('LIFECYCLE judged: gate RELEASES (no longer judging)', held(o, 's/t', now, HOUR) === false);
  ok('LIFECYCLE judged: not flagged provisional', flagged(o, 's/t', now, HOUR) === false);
  // anchor cleanup mirrors routes/judge.js drain sweep
  if (judge.unverifiedEdgesForNode(o, 's/t').length === 0) ov.clearJudgingSince(o, 's/t');
  ok('LIFECYCLE judged: anchor pruned on drain', !('s/t' in o.judgingSince));
}
{
  // TIMEOUT FALLBACK: a node whose judgment STALLS (edge never judged) past the timeout falls back —
  // gate releases (not held) but the node is FLAGGED provisional. Proves no permanent deadlock.
  const o = ov.EMPTY();
  o.epoch = 1;
  const now = 2_000_000_000_000;
  o.edges.push({ from: 's/stall', to: 'note:z', kind: 'context', weight: 0, by: 'autowire', judged: false });
  ov.markEagerJudge(o, 's/stall');
  o.judgingSince['s/stall'] = now - 2 * HOUR;  // 2h ago, judgment never happened
  ok('STALL: gate does NOT hold (timed out → released)', held(o, 's/stall', now, HOUR) === false);
  ok('STALL: node FLAGGED provisional (context not silently trusted)', flagged(o, 's/stall', now, HOUR) === true);
  ok('STALL: a tiny configurable timeout flips it immediately', flagged(o, 's/stall', now, 1) === true);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
