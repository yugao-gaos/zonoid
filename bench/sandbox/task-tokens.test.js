#!/usr/bin/env node
// Fixed acceptance test for bench/sandbox/task-tokens.js — DO NOT EDIT.
'use strict';
const { taskTokensFor } = require('./task-tokens.js');
let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const base = () => ({
  assignee: { 'S/1': 'w-alpha', 'S/2': 'w-bravo', 'S/3': 'w-charlie' },
  session:  { 'S/1': 'S', 'S/2': 'S', 'S/3': 'S' },
  window: {
    'S/1': { start: '2026-06-08T10:00:00.000Z', end: '2026-06-08T10:10:00.000Z' },
    'S/2': { start: '2026-06-08T10:10:00.000Z', end: '2026-06-08T10:20:00.000Z' },
    'S/3': { start: '2026-06-08T10:20:00.000Z', end: '2026-06-08T10:30:00.000Z' },
  },
  runs: [
    { session: 'S', start: '2026-06-08T10:00:30.000Z', end: '2026-06-08T10:09:30.000Z', tokens: 1000 },
    { session: 'S', start: '2026-06-08T10:10:30.000Z', end: '2026-06-08T10:19:30.000Z', tokens: 2000 },
    { session: 'S', start: '2026-06-08T10:20:30.000Z', end: '2026-06-08T10:29:30.000Z', tokens: 4000 },
  ],
  sessionTotal: { S: 7000 },
});

ok('case 1a', taskTokensFor('S/1', base()) === 1000);
ok('case 1b', taskTokensFor('S/2', base()) === 2000);
ok('case 1c', taskTokensFor('S/3', base()) === 4000);

{
  const s = base();
  const a = taskTokensFor('S/1', s), b = taskTokensFor('S/2', s), c = taskTokensFor('S/3', s);
  ok('case 2a', a !== b && b !== c && a !== c);
  ok('case 2b', a !== 7000 && b !== 7000 && c !== 7000);
}

{
  const s = base();
  s.assignee['S/9'] = 'w-delta';
  s.session['S/9'] = 'S';
  s.window['S/9'] = { start: '2026-06-08T23:00:00.000Z', end: '2026-06-08T23:05:00.000Z' };
  ok('case 3', taskTokensFor('S/9', s) === null);
}

{
  const s = base();
  s.assignee['D/1'] = 'w-echo';
  s.session['D/1'] = 'D';
  s.window['D/1'] = { start: '2026-06-08T12:00:00.000Z', end: '2026-06-08T12:05:00.000Z' };
  s.sessionTotal['D'] = 555;
  ok('case 4', taskTokensFor('D/1', s) === 555);
}

{
  const s = base();
  s.assignee = { 'T/1': 'w' }; s.session = { 'T/1': 'S' };
  s.window = { 'T/1': { start: '2026-06-08T10:00:00.000Z', end: '2026-06-08T10:10:00.000Z' } };
  s.runs = [
    { session: 'S', start: '2026-06-08T10:00:00.000Z', end: '2026-06-08T10:05:00.000Z', tokens: 11 },
    { session: 'S', start: '2026-06-08T10:05:00.000Z', end: '2026-06-08T10:10:00.000Z', tokens: 22 },
  ];
  s.sessionTotal = { S: 33 };
  ok('case 5', taskTokensFor('T/1', s) === 22);
}

{
  const s = base();
  s.assignee = { 'U/1': 'w' }; s.session = { 'U/1': 'S' };
  s.window = { 'U/1': { start: '2026-06-08T10:00:00.000Z', end: '2026-06-08T10:05:00.000Z' } };
  s.runs = [{ session: 'S', start: '2026-06-08T10:05:00.000Z', end: '2026-06-08T10:10:00.000Z', tokens: 99 }];
  s.sessionTotal = { S: 99 };
  ok('case 6', taskTokensFor('U/1', s) === 99);
}

{
  const s = base();
  s.assignee = { 'V/1': 'w' }; s.session = { 'V/1': 'S' };
  s.window = { 'V/1': { start: '2026-06-08T10:00:00.000Z' } };
  const soon = new Date(Date.now() - 1000).toISOString();
  s.runs = [{ session: 'S', start: soon, end: null, tokens: 77 }];
  s.sessionTotal = { S: 77 };
  ok('case 7', taskTokensFor('V/1', s) === 77);
}

{
  const s = base();
  s.assignee = { 'W/1': 'w', 'W/2': 'w2' }; s.session = { 'W/1': 'S', 'W/2': 'S' };
  s.window = {
    'W/1': { start: '2026-06-08T10:00:00.000Z', end: '2026-06-08T10:10:00.000Z' },
    'W/2': { start: '2026-06-08T11:00:00.000Z', end: '2026-06-08T11:10:00.000Z' },
  };
  s.runs = [{ session: 'OTHER', start: '2026-06-08T10:01:00.000Z', end: '2026-06-08T10:09:00.000Z', tokens: 4242 }];
  s.sessionTotal = { S: 4242 };
  ok('case 8', taskTokensFor('W/1', s) === null);
}

ok('case 9', taskTokensFor('zzz/0', base()) === null);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
