# Task: findStaleClaims

Implement `findStaleClaims(tasks, nowMs, staleMs)` in a NEW file
`bench/sandbox/stale-claims-ht.js` in the repo `__INSTALL_DIR__`.
Do NOT run `git commit`.

## Goal

The daemon sweeps for stale agent claims: tasks that are marked `in_progress` but whose agent
has stopped heartbeating. `findStaleClaims(tasks, nowMs, staleMs)` returns the ids of stale
claims, oldest heartbeat first.

`tasks` is an array of `{ id, status, agent, lastHeartbeatMs }`.

A task is a **stale claim** iff ALL of:

- `status === 'in_progress'`;
- `agent` is a non-empty string;
- its heartbeat age `nowMs - lastHeartbeatMs` is STRICTLY greater than `staleMs`; a task with
  no `lastHeartbeatMs` field (or `null`) counts as stale (it never heartbeated).

Order: ascending by `lastHeartbeatMs` (oldest first); tasks with missing/null `lastHeartbeatMs`
come first (treat as age infinity), among themselves in input order.

## Public examples

```
findStaleClaims([
  { id: 'a', status: 'in_progress', agent: 'x', lastHeartbeatMs: 1000 },
  { id: 'b', status: 'done',        agent: 'x', lastHeartbeatMs: 1000 },
  { id: 'c', status: 'in_progress', agent: 'y', lastHeartbeatMs: 9000 },
], 10000, 5000)
// ['a']   (b is not in_progress; c's age 1000 is not > 5000)
```

## Contract

- File: `bench/sandbox/stale-claims-ht.js`, exporting `module.exports = { findStaleClaims };` (CommonJS).
- Pure function: no I/O, no globals, deterministic; never throws on missing fields.
- Returns an array of id strings (possibly empty).
- Keep it tight. Create `bench/sandbox/` if it does not exist.

Write your best implementation and stop. Do not write any test files.
