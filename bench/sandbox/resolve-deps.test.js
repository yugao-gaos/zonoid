#!/usr/bin/env node
// Fixed acceptance test for bench/sandbox/resolve-deps.js — DO NOT EDIT.
'use strict';
const { resolveDeps } = require('./resolve-deps.js');
let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- Single session, local blockedBy. Superficial path. -------------------------------------
{
  const out = resolveDeps([
    { session: 'A', tasks: [
      { id: '1', title: 'root', blockedBy: [] },
      { id: '2', title: 'mid',  blockedBy: ['1'] },
      { id: '3', title: 'leaf', blockedBy: ['2'] },
    ] },
  ]);
  ok('1a keys namespaced',   eq(Object.keys(out).sort(), ['A/1', 'A/2', 'A/3']));
  ok('1b local dep resolved', eq(out['A/2'].deps, ['A/1']));
  ok('1c title carried',      out['A/3'].title === 'leaf');
  ok('1d root no deps',       eq(out['A/1'].deps, []));
}

// ---- Two sessions with COLLIDING local ids. The trap. ---------------------------------------
// Both A and B contain a task "1" and a task "2". Local blockedBy in each must resolve to that
// SESSION's own task, never the other session's same-numbered task.
{
  const out = resolveDeps([
    { session: 'A', tasks: [
      { id: '1', title: 'A-one', blockedBy: [] },
      { id: '2', title: 'A-two', blockedBy: ['1'] },
    ] },
    { session: 'B', tasks: [
      { id: '1', title: 'B-one', blockedBy: [] },
      { id: '2', title: 'B-two', blockedBy: ['1'] },
    ] },
  ]);
  ok('2a all four survive', eq(Object.keys(out).sort(), ['A/1', 'A/2', 'B/1', 'B/2']));
  ok('2b A-two -> A/1',     eq(out['A/2'].deps, ['A/1']));
  ok('2c B-two -> B/1',     eq(out['B/2'].deps, ['B/1']));
  ok('2d titles distinct',  out['A/1'].title === 'A-one' && out['B/1'].title === 'B-one');
  // The collapse signature: a raw-id keying drops two tasks and cross-wires deps.
  ok('2e no collision loss', Object.keys(out).length === 4);
}

// ---- Cross-session shared dep (Agent Teams) given as {session,id}. ---------------------------
// sharedDeps are ALREADY namespaced pairs; they must resolve verbatim to `${session}/${id}`.
{
  const out = resolveDeps([
    { session: 'A', tasks: [
      { id: '1', title: 'A-one', blockedBy: [] },
    ] },
    { session: 'B', tasks: [
      { id: '1', title: 'B-one', blockedBy: [], sharedDeps: [{ session: 'A', id: '1' }] },
    ] },
  ]);
  ok('3a shared resolves cross-session', eq(out['B/1'].deps, ['A/1']));
}

// ---- Mixed: local blockedBy + sharedDeps on the same task, colliding ids across sessions. ----
{
  const out = resolveDeps([
    { session: 'A', tasks: [
      { id: '1', title: 'A-one', blockedBy: [] },
      { id: '2', title: 'A-two', blockedBy: ['1'] },
    ] },
    { session: 'B', tasks: [
      { id: '1', title: 'B-one', blockedBy: [] },
      { id: '2', title: 'B-two', blockedBy: ['1'], sharedDeps: [{ session: 'A', id: '2' }] },
    ] },
  ]);
  // B/2 depends on its OWN B/1 (local) AND on A/2 (shared). Deduped + sorted.
  ok('4a mixed deps', eq(out['B/2'].deps, ['A/2', 'B/1']));
  ok('4b A/2 unaffected', eq(out['A/2'].deps, ['A/1']));
}

// ---- Unresolvable references are dropped, not crashed-on, not invented. ----------------------
{
  const out = resolveDeps([
    { session: 'A', tasks: [
      { id: '1', title: 'A-one', blockedBy: ['9'] },                       // local 9 absent
      { id: '2', title: 'A-two', blockedBy: [], sharedDeps: [{ session: 'Z', id: '1' }] }, // session Z absent
    ] },
  ]);
  ok('5a missing local dropped',  eq(out['A/1'].deps, []));
  ok('5b missing shared dropped', eq(out['A/2'].deps, []));
}

// ---- Dedup + sort of resolved deps. ----------------------------------------------------------
{
  const out = resolveDeps([
    { session: 'A', tasks: [
      { id: '1', title: 'x', blockedBy: [] },
      { id: '2', title: 'y', blockedBy: [] },
      { id: '3', title: 'z', blockedBy: ['2', '1', '2'], sharedDeps: [{ session: 'A', id: '1' }] },
    ] },
  ]);
  ok('6a deduped+sorted', eq(out['A/3'].deps, ['A/1', 'A/2']));
}

// ---- Empty input. ----------------------------------------------------------------------------
ok('7 empty', eq(resolveDeps([]), {}));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
