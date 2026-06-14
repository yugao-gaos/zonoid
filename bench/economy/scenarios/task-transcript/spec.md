# Task: resolveOwner (task → transcript)

Implement `resolveOwner(taskKey, registry)` in a NEW file `bench/sandbox/resolve-owner-ht.js`
in the repo `__INSTALL_DIR__`. Do NOT run `git commit`.

## Goal

The daemon needs, for a given task, the transcript file that holds that task's token usage. A task
is claimed by an *assignee* (a logical agent id). Given a `taskKey` and the `registry` the daemon
assembles at read time, return the transcript path (a string) for that task, or `null` if no
transcript can be attributed to it.

## Registry shape

```
{
  assignee:  { [taskKey]: agentId },                        // task -> assignee logical id
  agents:    { [agentId]: { session, transcript_path } },   // agent records (either field may be absent)
  window:    { [taskKey]: { start, end } },                 // task claim window (ISO-8601 strings)
  byWindow:  [ { session, transcript_path, start, end } ],  // harness agent runs + their run windows (ISO)
  sessionTranscript: { [session]: path },                   // transcripts known to belong to one session
}
```

Any field within a record may be absent.

## How attribution works

Look up the task's assignee, then resolve that agent to a transcript:

- If the agent record carries a `transcript_path` directly, that is the transcript.
- Otherwise, if the agent record carries a `session`, and that session maps to a transcript via
  `sessionTranscript`, that is the transcript.

If neither route yields a transcript, return `null`.

## Public examples

```
// direct: agent record has the path
resolveOwner('T/1', {
  assignee: { 'T/1': 'a1' },
  agents:   { a1: { transcript_path: '/t/run-1.jsonl' } },
  window: {}, byWindow: [], sessionTranscript: {},
})                                                            // returns '/t/run-1.jsonl'

// session: agent record has a session that maps to a transcript
resolveOwner('T/2', {
  assignee: { 'T/2': 'a2' },
  agents:   { a2: { session: 's2' } },
  window: {}, byWindow: [],
  sessionTranscript: { s2: '/t/run-2.jsonl' },
})                                                            // returns '/t/run-2.jsonl'
```

## Contract

- File: `bench/sandbox/resolve-owner-ht.js`, exporting `module.exports = { resolveOwner };` (CommonJS).
- Pure function: no I/O, no global state, deterministic, no Node built-ins beyond plain `Date`.
- Return a transcript path string, or `null` when none is attributable.
- Keep it tight. Create `bench/sandbox/` if it does not exist.

Write your best implementation and stop. Do not write any test files.
