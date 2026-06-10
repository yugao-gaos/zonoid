# Task: summarizeRuns

Implement `summarizeRuns(rows)` in a NEW file `bench/sandbox/agg-report-ht.js` in the repo
`__INSTALL_DIR__`. Do NOT run `git commit`.

## Goal

The benchmark harness emits one row per run: `{ arm: <string>, tokens: <number> }`. Build the
per-arm summary used by the report:

`summarizeRuns(rows)` returns an object keyed by arm name, each value
`{ n, mean, median }`:

- `n` — number of rows for that arm.
- `mean` — arithmetic mean of `tokens`, rounded to 2 decimal places.
- `median` — median of `tokens`: middle value for odd `n`; the average of the two middle
  values for even `n`; rounded to 2 decimal places.
- Rows whose `tokens` is not a finite number are skipped entirely (they do not count toward `n`).
- Empty input (or all rows skipped) returns `{}`.

## Public examples

```
summarizeRuns([
  { arm: 'on',  tokens: 10 },
  { arm: 'on',  tokens: 20 },
  { arm: 'off', tokens: 7 },
])
// { on: { n: 2, mean: 15, median: 15 }, off: { n: 1, mean: 7, median: 7 } }

summarizeRuns([])   // {}
```

## Contract

- File: `bench/sandbox/agg-report-ht.js`, exporting `module.exports = { summarizeRuns };` (CommonJS).
- Pure function: no I/O, no globals, deterministic.
- Keep it tight. Create `bench/sandbox/` if it does not exist.

Write your best implementation and stop. Do not write any test files.
