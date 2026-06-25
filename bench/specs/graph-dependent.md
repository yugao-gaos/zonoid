# Bench task: graph-dependent — task→transcript token correlation

This is a fixed benchmark prompt. Implement exactly what is described below in the
`__INSTALL_DIR__` repo. Do not run `git commit`.

## Background

The daemon reports, for a given task, the transcript file that holds that task's token usage. A task
is claimed by an *assignee* (a logical id), but the transcript is registered separately under a
*harness agent* record. The join from task → transcript is the hard part: sometimes the assignee
record carries the transcript path directly, sometimes only a session id, and sometimes neither — in
which case the transcript must be recovered by correlating the task's claim window against the run
windows of harness agents in the same conversation.

Your job is to implement the function that performs this task→transcript resolution and returns the
transcript path (or `null`). A subtle design choice lurks in rule 3: when the assignee record gives no
direct transcript and no usable session, you can either (a) hold out for a deterministic exact-session
match and give up otherwise, or (b) fall back to a fuzzy time-window correlation heuristic. Pick
carefully — the wrong instinct here passes the easy cases but fails the correlation cases below.

## Goal

Implement `resolveOwner(...)` in a NEW file `bench/sandbox/resolve-owner.js` that resolves a task to
its transcript path, applying these rules in order and returning the FIRST that yields a path:

1. **Direct** — the task's assignee agent has a `transcript_path` → return it.
2. **Session of assignee** — the assignee agent has a `session` and there is a known
   single-task-session transcript for that session → return it.
3. **Time-window correlation** — otherwise, among the harness agents that have a transcript and a run
   window, pick the one whose `[start,end]` run interval OVERLAPS the task's claim window with the
   LARGEST overlap, and return its `transcript_path`. Overlap = `min(ends) - max(starts)`; an overlap
   `>= 0` counts as touching. Parse ISO timestamps with `Date.parse`; a missing/unparseable claim-window
   bound widens the window (missing `start` → `-Infinity`, missing `end` → `Date.now()`) rather than
   failing the lookup.
4. If nothing matches, return `null`.

All the data you need is available in an in-memory `registry` the daemon assembles at read time, with
this shape (fields within a record may be absent):

```
{
  assignee:  { [taskKey]: agentId },                              // task -> assignee logical id
  agents:    { [agentId]: { session, transcript_path } },        // agent records
  window:    { [taskKey]: { start, end } },                      // task claim window (ISO)
  byWindow:  [ { session, transcript_path, start, end } ],       // harness agents + run windows (ISO)
  sessionTranscript: { [session]: path },                        // single-task-session transcripts only
}
```

## Constraints

- `bench/sandbox/resolve-owner.js` must export via `module.exports = { resolveOwner };` (CommonJS).
- Pure function: no I/O, no global state, deterministic, no side effects, no Node built-ins beyond
  plain `Date`.
- Keep it tight (~25–40 lines). Create `bench/sandbox/` if absent.

## Acceptance check

Create `bench/sandbox/resolve-owner.test.js` (plain Node, no framework — same style as
`test/rejected-digest.test.js`: `require('./resolve-owner.js')`, print `PASS`/`FAIL` lines, end with
`process.exit(fail === 0 ? 0 : 1)`, final line `N passed, M failed`). The test must construct the
`registry` shape above and call the function as `resolveOwner(taskKey, registry)`. It MUST assert at
minimum:

1. Direct hit: assignee agent has `transcript_path` → returns it.
2. Session-of-assignee: assignee agent has only `session`, `sessionTranscript[session]` set →
   returns that path (direct takes priority when both are present).
3. Window correlation: no assignee transcript/session; two `byWindow` entries → returns the one with
   the LARGER overlap with `window[taskKey]`.
4. Tie-break by overlap, not array order (the larger-overlap entry wins even if it is listed last).
5. Touching windows (overlap exactly 0) still count as a match.
6. Missing task-window `end` widens to now → still correlates an open-ended agent window.
7. Unknown task (no assignee, no window match) → returns `null`.
8. Empty registry
   `resolveOwner('x', { assignee:{}, agents:{}, window:{}, byWindow:[], sessionTranscript:{} })` →
   `null`.

The task is DONE when this command exits 0 (run from the repo root
`__INSTALL_DIR__`):

```
node bench/sandbox/resolve-owner.test.js
```

It must print `N passed, 0 failed` and exit 0.
