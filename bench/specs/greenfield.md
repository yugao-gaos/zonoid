# Bench task: greenfield — standalone `parseDuration` pure function

This is a fixed benchmark prompt. Implement exactly what is described below in the
`__INSTALL_DIR__` repo. This task is fully self-contained: it depends only on the
filesystem and Node's standard library — no knowledge of the rest of the repo is needed. Do not run
`git commit`.

## Goal

Implement a standalone pure function `parseDuration(input)` in a NEW file
`bench/sandbox/parse-duration.js` that converts a human duration string into a number of
**milliseconds**.

Supported syntax:
- A string of one or more `<number><unit>` segments, optionally separated by spaces.
- Units (case-insensitive): `ms` (milliseconds), `s` (seconds), `m` (minutes), `h` (hours),
  `d` (days). Note `ms` must be matched before `m`.
- Numbers are non-negative integers or decimals (e.g. `1`, `30`, `1.5`). No sign, no exponent.
- Segments accumulate: `"1h30m"` → `3600000 + 1800000 = 5400000`. `"1.5h"` → `5400000`.
  `"500ms"` → `500`. `"2d"` → `172800000`.

Conversion factors: `ms=1`, `s=1000`, `m=60000`, `h=3600000`, `d=86400000`.

Error handling:
- For any invalid input — empty/whitespace-only string, non-string argument, an unknown unit, a
  number with no unit, or any leftover/unparseable characters — **throw** an `Error` (any message).
- Valid input always returns a finite non-negative `number`.

## Constraints

- `bench/sandbox/parse-duration.js` must export the function via
  `module.exports = { parseDuration };` (CommonJS, to match the repo).
- Pure function: no I/O, no global state, no dependencies beyond Node built-ins.
- Keep it tight (the implementation should be roughly 15–30 lines).
- Create the `bench/sandbox/` directory if it does not exist.

## Acceptance check

Create a test file `bench/sandbox/parse-duration.test.js` (plain Node, no framework — same style as
`test/rejected-digest.test.js`: `require('./parse-duration.js')`, print `PASS`/`FAIL` lines, end with
`process.exit(fail === 0 ? 0 : 1)`). It must assert at minimum:

1. `parseDuration('500ms') === 500`
2. `parseDuration('2s') === 2000`
3. `parseDuration('1.5h') === 5400000`
4. `parseDuration('1h30m') === 5400000`
5. `parseDuration('2d') === 172800000`
6. Case-insensitive: `parseDuration('1H') === 3600000`
7. Spaces tolerated: `parseDuration('1h 30m') === 5400000`
8. Throws on empty string `''`.
9. Throws on unknown unit, e.g. `'5x'`.
10. Throws on a bare number with no unit, e.g. `'10'`.
11. Throws on non-string input, e.g. `parseDuration(null)`.

The task is DONE when this command exits 0 (run from the repo root
`__INSTALL_DIR__`):

```
node bench/sandbox/parse-duration.test.js
```

It must print `N passed, 0 failed` and exit 0.
