# Bench task: v5-grounded — flatten multi-session task lists into one resolved dependency map

This is a fixed benchmark prompt. Implement exactly what is described below in the
`__INSTALL_DIR__` repo. Do NOT run `git commit`.

## Background

The daemon reads task lists from several independent session directories and assembles them into a
single in-memory dependency graph. Each session is a self-contained list of tasks. Within a session,
a task is identified by a short **local id** (the strings `"1"`, `"2"`, `"3"`, … — the ordinal the
session assigned it) and may declare which other tasks block it.

Two kinds of blocking relationship exist:

- `blockedBy` — a list of **local ids**, naming other tasks *in the same session* that must finish
  first. This is the common case.
- `sharedDeps` — an optional list of explicit `{ session, id }` references to tasks in *other*
  sessions (used when sessions cooperate). These are already given as fully-qualified pairs.

Your job: flatten all sessions into one map and resolve every blocking reference into the map's own
key space, so a downstream scheduler can walk one unified graph.

## Goal

Implement `resolveDeps(sessions)` in a NEW file `bench/sandbox/resolve-deps.js`.

Input `sessions` is an array of session objects:

```
[
  {
    session: "<session-id>",            // an opaque identifier for this session
    tasks: [
      { id: "1", title: "...", blockedBy: ["2", ...], sharedDeps?: [ { session, id }, ... ] },
      ...
    ]
  },
  ...
]
```

Return a single flat object mapping each task's **global key** to its resolved record:

```
{ [globalKey]: { title: <string>, deps: [ <globalKey>, ... ] } }
```

Rules:

1. **Global key.** Each task's global key is `` `${session}/${id}` `` — the session it came from,
   a slash, then its local id. Every task in the output is keyed this way.
2. **Resolve `blockedBy`.** Each entry is a local id; resolve it to the global key of the task it
   names. Resolve it against the tasks of the session the *referencing task itself belongs to*.
3. **Resolve `sharedDeps`.** Each `{ session, id }` resolves to that global key directly.
4. **Drop dangling references.** If a resolved dependency key does not correspond to any task that
   actually exists in the input, omit it from `deps` (do not throw, do not invent a node for it).
5. **`deps` is a sorted, de-duplicated array** of global keys (ascending string order).
6. `title` is carried through verbatim.
7. Empty input → `{}`.

## Constraints

- `bench/sandbox/resolve-deps.js` must export via `module.exports = { resolveDeps };` (CommonJS).
- Pure function: no I/O, no global state, deterministic, no side effects, no Node built-ins.
- Keep it tight (~20–35 lines). Create `bench/sandbox/` if absent.

## Acceptance check

A FIXED acceptance test **already exists** at `bench/sandbox/resolve-deps.test.js` (committed in the
repo — do **NOT** modify, move, or delete it). Implement `resolveDeps` so the test passes unchanged.
The task is DONE when this command, run from the repo root `__INSTALL_DIR__`, prints
a final line `N passed, 0 failed` and exits 0:

```
node bench/sandbox/resolve-deps.test.js
```
