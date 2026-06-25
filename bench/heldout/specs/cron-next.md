# cron-next

## Task

Implement the function `nextRun(cronExpr, afterMs)` in JavaScript.

## Specification

**Input:**
- `cronExpr` — a standard 5-field cron string `"minute hour day-of-month month day-of-week"`, fields separated by single spaces.
  - Field ranges: minute 0-59, hour 0-23, day-of-month 1-31, month 1-12, day-of-week 0-6 (0 = Sunday).
  - Each field supports: `*` (any), single values `5`, lists `1,15,30`, ranges `10-40`, steps on star `*/15`, and steps on range `10-40/15` (matches 10, 25, 40 — i.e. start, start+step, ... not exceeding end).
  - Lists may combine elements: `1,10-12,*/20` is valid (the union of all elements).
- `afterMs` — Unix epoch milliseconds (UTC).

**Output:** The SMALLEST Unix epoch ms timestamp STRICTLY GREATER than `afterMs` whose UTC wall-clock time matches the expression, with seconds and milliseconds equal to zero. All computation is in UTC — no local timezone, no DST.

**Matching rules:**
- DOM/DOW rule (standard cron semantics — read carefully): if BOTH day-of-month and day-of-week are restricted (neither is `*`), a day matches if it matches EITHER field (union). If only one is restricted, that one must match. If both are `*`, every day matches.
- Non-existent dates (e.g. Feb 30, Apr 31) never match; the search must continue into later months/years.
- Searching may cross year boundaries; assume a match exists within 5 years.
- Invalid expressions (wrong field count, out-of-range values): throw an `Error`.

## Function signature

```js
function nextRun(cronExpr, afterMs) { ... }
```

## Export

```js
module.exports = { nextRun };
```

## Notes

Write your best implementation and stop. Do not write tests.

## Artifact file

`/Users/imyu/Desktop/zonoid/bench/sandbox/cron-next-ht.js`
