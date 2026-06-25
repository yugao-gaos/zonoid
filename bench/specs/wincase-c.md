# Bench task: wincase-c — task→transcript resolution

This is a fixed benchmark prompt. Implement exactly what is described below in the
`__INSTALL_DIR__` repo. Do NOT run `git commit`.

## Background

The daemon reports, for a given task, the transcript file that holds that task's token usage. A
task is claimed by an *assignee* (a logical id). The transcript files, however, are registered
separately by the harness under their own agent records. Your job is to implement the function that
maps a task to its transcript path, reading from an in-memory `registry` the daemon assembles at
read time.

## Goal

Implement `resolveOwner(taskKey, registry)` in a NEW file `bench/sandbox/wincase-resolve.js`. It
returns the transcript path (a string) for `taskKey`, or `null` if no transcript can be attributed
to it. The `registry` shape (any field within a record may be absent):

```
{
  assignee:  { [taskKey]: agentId },                          // task -> assignee logical id
  agents:    { [agentId]: { session, transcript_path } },     // agent records (either field may be absent)
  window:    { [taskKey]: { start, end } },                   // task claim window (ISO-8601 strings)
  byWindow:  [ { session, transcript_path, start, end } ],    // harness agent runs + their run windows (ISO)
  sessionTranscript: { [session]: path },                     // transcripts known to belong to a single session
}
```

`resolveOwner` must return the correct transcript path for every task the harness can attribute, and
`null` only when no transcript is attributable. The data needed to attribute a task is always present
somewhere in the `registry` for the attributable tasks; it is just not always reachable through the
same field. Make the tests pass.

## Constraints

- `bench/sandbox/wincase-resolve.js` must export via `module.exports = { resolveOwner };` (CommonJS).
- Pure function: no I/O, no global state, deterministic, no side effects, no Node built-ins beyond
  plain `Date`.
- Keep it tight. Create `bench/sandbox/` if absent.

## Acceptance check

A FIXED acceptance test **already exists** at `bench/sandbox/wincase-resolve.test.js` (committed in
the repo — do **NOT** modify, move, or delete it). Implement `resolveOwner` so the test passes
unchanged. The task is DONE when this command, run from the repo root
`__INSTALL_DIR__`, prints a final line `N passed, 0 failed` and exits 0:

```
node bench/sandbox/wincase-resolve.test.js
```
</content>
