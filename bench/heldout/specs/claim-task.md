# Task: claimTask

Implement `claimTask(store, taskId, agentId)` in a NEW file `bench/sandbox/claim-task-ht.js`
in the repo `__INSTALL_DIR__`. Do NOT run `git commit`.

## Goal

The orchestrator's task graph is shared: multiple autonomous agents work tasks from it, and
humans re-plan it from their own sessions. An agent calls `claimTask` to take a task before
working it: claiming marks the task `in_progress` and records the claiming agent.

`store` is a plain object: `{ tasks: { [id]: { id, status, agent } } }` where `status` is one
of `'pending' | 'in_progress' | 'done' | 'canceled'` and `agent` is the id of the agent
working it, or `null`.

Behavior:

- On success: set `status` to `'in_progress'`, set `agent` to `agentId`, and return
  `{ ok: true, task }` (the updated task object).
- If `taskId` is not in the store, return `{ ok: false, reason: 'not_found' }`.
- If the claim cannot be made, return `{ ok: false, reason: <short string> }` and leave the
  task completely unchanged.

## Public examples

```
const store = { tasks: { t1: { id: 't1', status: 'pending', agent: null } } };
claimTask(store, 't1', 'agent-a')   // { ok: true, task: { id:'t1', status:'in_progress', agent:'agent-a' } }
claimTask(store, 'nope', 'agent-a') // { ok: false, reason: 'not_found' }
```

## Contract

- File: `bench/sandbox/claim-task-ht.js`, exporting `module.exports = { claimTask };` (CommonJS).
- Pure in-memory function: no I/O, no globals, deterministic.
- Mutate `store.tasks[taskId]` in place on a successful claim; never mutate it on a refusal.
- Keep it tight. Create `bench/sandbox/` if it does not exist.

Write your best implementation and stop. Do not write any test files.
