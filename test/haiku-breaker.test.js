#!/usr/bin/env node
// Plain Node test (no framework; matches test/embed.test.js style) for the Haiku-fallback circuit
// breaker (lib/haiku-breaker.js). Pure logic — clock injected, no real waits, no network.
// Run: node test/haiku-breaker.test.js — exits non-zero on any failed assertion.
'use strict';

const { createBreaker } = require('../lib/haiku-breaker');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Fake clock + transition recorder shared by each scenario.
function rig(opts = {}) {
  let t = 0;
  const transitions = [];
  const b = createBreaker({
    threshold: 4, windowMs: 60_000, cooldownMs: 300_000,
    now: () => t,
    onTransition: (state, why) => transitions.push({ state, why }),
    ...opts,
  });
  return { b, transitions, tick: (ms) => { t += ms; }, time: () => t };
}

// ---- closed: attempts under the threshold all pass ------------------------------------------
{
  const { b } = rig();
  const allowed = [b.allow(), b.allow(), b.allow(), b.allow()];
  ok('closed: first 4 attempts in 60s allowed', allowed.every(Boolean));
  ok('closed: state stays closed at threshold', b.getState() === 'closed');
}

// ---- open: the 5th attempt within 60s opens the breaker and is itself skipped ---------------
{
  const { b, transitions, tick } = rig();
  for (let i = 0; i < 4; i++) { b.allow(); tick(1000); }
  const fifth = b.allow();
  ok('open: 5th attempt within window is skipped', fifth === false);
  ok('open: state is open', b.getState() === 'open');
  ok('open: exactly one transition fired', transitions.length === 1 && transitions[0].state === 'open');
  // While open, attempts are skipped and fire NO further transitions (one log per transition only).
  tick(10_000);
  ok('open: subsequent attempt skipped', b.allow() === false);
  ok('open: no repeat transition while open', transitions.length === 1);
}

// ---- window pruning: spread attempts never open it -------------------------------------------
{
  const { b, tick } = rig();
  let allAllowed = true;
  // 12 attempts at 20s spacing → never more than 3 inside any 60s window.
  for (let i = 0; i < 12; i++) { if (!b.allow()) allAllowed = false; tick(20_000); }
  ok('pruning: slow steady attempts never open the breaker', allAllowed && b.getState() === 'closed');
}

// ---- half-open: cool-down elapses → exactly one probe ----------------------------------------
{
  const { b, transitions, tick } = rig();
  for (let i = 0; i < 5; i++) b.allow();           // opens on the 5th
  tick(299_999);
  ok('half-open: attempt just before cool-down still skipped', b.allow() === false);
  tick(1);                                          // cool-down (300s) elapsed
  ok('half-open: first attempt after cool-down is the probe', b.allow() === true);
  ok('half-open: state is half-open', b.getState() === 'half-open');
  ok('half-open: second attempt during probe is skipped', b.allow() === false);
  ok('half-open: transitions = open, half-open',
    transitions.map((x) => x.state).join(',') === 'open,half-open');

  // probe SUCCESS → closed, attempts allowed again
  b.success();
  ok('probe success: state closed', b.getState() === 'closed');
  ok('probe success: attempts allowed again', b.allow() === true);
  ok('probe success: transition log ends closed',
    transitions.map((x) => x.state).join(',') === 'open,half-open,closed');
}

// ---- half-open: probe failure re-opens with a fresh cool-down --------------------------------
{
  const { b, transitions, tick } = rig();
  for (let i = 0; i < 5; i++) b.allow();           // open
  tick(300_000);
  b.allow();                                        // probe
  b.failure();                                      // probe fails
  ok('probe failure: state re-opens', b.getState() === 'open');
  tick(299_999);
  ok('probe failure: cool-down restarted (still skipped at 299.999s)', b.allow() === false);
  tick(1);
  ok('probe failure: next probe allowed after fresh cool-down', b.allow() === true);
  ok('probe failure: transition sequence open,half-open,open,half-open',
    transitions.map((x) => x.state).join(',') === 'open,half-open,open,half-open');
}

// ---- verdicts outside half-open are no-ops ---------------------------------------------------
{
  const { b, transitions } = rig();
  b.allow();
  b.success();
  b.failure();
  ok('closed: success()/failure() are no-ops', b.getState() === 'closed' && transitions.length === 0);
}

// ---- re-close then re-open: window starts fresh after a successful probe ---------------------
{
  const { b, tick } = rig();
  for (let i = 0; i < 5; i++) b.allow();           // open
  tick(300_000);
  b.allow(); b.success();                           // probe closes it; window starts empty
  const allowed = [b.allow(), b.allow(), b.allow(), b.allow()];
  ok('re-closed: fresh window allows attempts up to threshold again', allowed.every(Boolean));
  ok('re-closed: next attempt within window re-opens', b.allow() === false && b.getState() === 'open');
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
