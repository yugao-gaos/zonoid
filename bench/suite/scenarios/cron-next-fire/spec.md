# cron-next-fire

Implement `nextFire(cronExpr, fromTime)` in `bench/sandbox/solution.js`.

## Signature

```js
module.exports = { nextFire };
```

## Parameters

- `cronExpr` — a standard 5-field cron string: `"min hour dom month dow"`
  - `min`: 0–59
  - `hour`: 0–23
  - `dom` (day-of-month): 1–31
  - `month`: 1–12
  - `dow` (day-of-week): 0–6 (0 = Sunday, 6 = Saturday)
- `fromTime` — a `Date` object representing the lower bound (exclusive)

## Return value

The next `Date` strictly after `fromTime` when the cron expression fires, with seconds set to 0.

## Field syntax (all fields support these forms)

- `*` — every value in the valid range
- `*/step` — every `step`-th value starting from the field minimum (e.g. `*/15` on minutes = 0, 15, 30, 45)
- `a-b` — inclusive range
- `a,b,c` — comma-separated list of values (each item may itself be a range or step)
- Combinations: `1,3-5,*/10`

## DOM + DOW semantics

If **both** `dom` and `dow` are non-`*`, a timestamp matches if the day-of-month **or** the day-of-week matches (standard cron OR semantics).

If only one is non-`*`, only that field is checked.

## Error handling

Throw a `TypeError` (or any `Error`) for:
- Wrong number of fields (not exactly 5)
- Any field value out of its valid range after expansion

## Examples

```js
// Every minute
nextFire('* * * * *', new Date('2024-01-15T10:30:45Z'))
// → 2024-01-15T10:31:00.000Z

// Daily at 09:15, already past today's fire
nextFire('15 9 * * *', new Date('2024-01-15T09:20:00Z'))
// → 2024-01-16T09:15:00.000Z
```
