# Bench task: context-rich — add `summarizeRejected` to the learnings digest

This is a fixed benchmark prompt. Implement exactly what is described below in the
`__INSTALL_DIR__` repo. Do not change anything outside the files named here.
Do not run `git commit`.

## Goal

The `/learnings` endpoint in `daemon.js` returns a `rejected[]` ledger — a digested list of
approaches NOT to re-propose. It is built by the pure function `digestRejected(verdicts, failures,
labelFor)` (around line 356 of `daemon.js`), which is already exported and unit-tested in
`test/rejected-digest.test.js`. Each entry has the shape:

```
{ approach: string, reason: string, source: 'verdict' | 'failure', beatenBy?: string }
```

Add a new **pure** helper `summarizeRejected(rejected)` that takes the `rejected[]` array produced by
`digestRejected` and returns a compact derived summary object so a planner can read the gist without
walking every entry:

```
{
  total: number,        // rejected.length
  verdicts: number,     // count of entries with source === 'verdict'
  failures: number,     // count of entries with source === 'failure'
  text: string          // one-line human digest, e.g. "3 rejected: 1 verdict-loser, 2 dead-end"
}
```

`text` format, exactly:
- `"0 rejected"` when the array is empty.
- Otherwise: `"<total> rejected: <verdicts> verdict-loser, <failures> dead-end"`.
  - Use the literal words `verdict-loser` and `dead-end` (singular, not pluralized — keep it simple).
  - Example: `[{source:'verdict'},{source:'failure'},{source:'failure'}]`
    → `"3 rejected: 1 verdict-loser, 2 dead-end"`.

## Constraints

- Implement `summarizeRejected` as a pure function in `daemon.js` (no I/O, no globals), placed
  directly after `digestRejected`.
- Add it to the `module.exports` line in `daemon.js` (currently
  `module.exports = { taskTokens, harnessTranscriptForTask, digestRejected };`).
- Do **not** wire it into the `/learnings` HTTP handler or change any existing behavior — exports +
  the function only. Keep total new code under ~30 lines.
- Match the existing terse code style. Do not reformat or "improve" surrounding code.
- Do not add dependencies. Node's built-in `assert` only, if any.

## Acceptance check

Create a test file `test/summarize-rejected.test.js` following the EXACT style of
`test/rejected-digest.test.js` (plain Node, no framework, `require('../daemon.js')`, prints
`PASS`/`FAIL` lines, `process.exit(fail === 0 ? 0 : 1)`). It must assert:

1. Empty array → `{ total: 0, verdicts: 0, failures: 0, text: '0 rejected' }`.
2. `[{source:'verdict'},{source:'failure'},{source:'failure'}]` →
   `total === 3`, `verdicts === 1`, `failures === 2`, `text === '3 rejected: 1 verdict-loser, 2 dead-end'`.
3. A single verdict entry → `text === '1 rejected: 1 verdict-loser, 0 dead-end'`.

The task is DONE when both of these commands exit 0 (run from the repo root
`__INSTALL_DIR__`):

```
node test/summarize-rejected.test.js
node test/rejected-digest.test.js
```

The second command guards against regressing the existing digest. Both must print
`N passed, 0 failed` and exit 0.
