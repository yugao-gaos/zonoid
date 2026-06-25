# Bench task: v4-hard — per-conversation token attribution under a shared session

This is a fixed benchmark prompt. Implement exactly what is described below in the
`__INSTALL_DIR__` repo. Do NOT run `git commit`.

## Background

A long-running conversation (one harness *session*) spawns several short-lived worker agents over
its lifetime. Each worker claims one task and does its work, then exits. The harness writes ONE
transcript file per worker run, each tagged with the run's wall-clock window `[startedAt, endedAt]`
(ISO-8601). The conversation as a whole also has a session-level rollup transcript that sums every
worker's tokens for the whole session.

We want a per-task token total: given a task, how many tokens did the worker that actually ran it
burn? The join is the hard part. A task records its *assignee* — but the assignee is a **logical
worker name** chosen at claim time, while the transcript files are registered by the harness under
**opaque, randomly-generated run ids** that never equal the logical name. So you cannot look a task's
transcript up by its assignee id. You only have, per run, the session it belonged to and the
`[startedAt, endedAt]` window it occupied.

Your job: implement the resolver that returns the token total for ONE task, reading from an in-memory
`state` object the daemon assembles at read time.

## Goal

Implement `taskTokensFor(taskKey, state)` in a NEW file `bench/sandbox/task-tokens.js`. It returns the
integer token total attributable to `taskKey`, or `null` if it cannot be determined. The `state` shape
(any field within a record may be absent):

```
{
  assignee:   { [taskKey]: logicalWorkerId },       // task -> logical worker name (NOT a run id)
  window:     { [taskKey]: { start, end } },         // task claim window (ISO-8601 strings)
  session:    { [taskKey]: sessionId },              // which session the task ran under
  runs: [                                            // every worker run the harness recorded
    { session, start, end, tokens }                  // run window (ISO) + that run's token total (int)
  ],
  sessionTotal: { [sessionId]: tokens },             // session-wide rollup total (sum of all runs in it)
}
```

Resolution rules, applied IN ORDER, returning the first that yields a number:

1. **Window correlation** — among `runs` IN THE SAME SESSION as the task, pick the run whose
   `[start, end]` interval overlaps the task's claim window `window[taskKey]` with the LARGEST overlap,
   and return that run's `tokens`. Overlap = `min(ends) - max(starts)`; an overlap `>= 0` counts as
   touching (a zero-length touch still matches). Parse ISO timestamps with `Date.parse`. A missing or
   unparseable claim-window bound widens the window rather than failing the lookup: missing `start` →
   `-Infinity`, missing `end` → `Date.now()`. Ties (equal overlap) are broken by picking the run that
   appears LATER in the `runs` array.
2. **Session rollup fallback** — if no run correlates, the session rollup
   `sessionTotal[session[taskKey]]` is available as a fallback source for the total. Decide for
   yourself when this fallback is appropriate to apply.
3. If neither yields a number, return `null`.

## Constraints

- `bench/sandbox/task-tokens.js` must export via `module.exports = { taskTokensFor };` (CommonJS).
- Pure function: no I/O, no global state, deterministic, no side effects, no Node built-ins beyond
  plain `Date`.
- Keep it tight (~25–45 lines). Create `bench/sandbox/` if absent.

## Acceptance check

A FIXED acceptance test **already exists** at `bench/sandbox/task-tokens.test.js` (committed in the
repo — do **NOT** modify, move, or delete it). Implement `taskTokensFor` so the test passes
unchanged. The task is DONE when this command, run from the repo root
`__INSTALL_DIR__`, prints a final line `N passed, 0 failed` and exits 0:

```
node bench/sandbox/task-tokens.test.js
```

For reference, the test is (already on disk — shown so you can see the cases):

```js
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
```
