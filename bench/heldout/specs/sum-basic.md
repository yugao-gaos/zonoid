# Task: formatDuration (milliseconds → human-readable string)

Implement `formatDuration(ms)` in a NEW file `bench/sandbox/format-duration-ht.js`
in the repo `__INSTALL_DIR__`. Do NOT run `git commit`.

## Goal

A logging utility needs to display elapsed time in a human-readable form. Given a duration in
**milliseconds** (a non-negative integer), return a string like `"1h 2m 3s"`. Omit any component
whose value is zero, except when the total duration is zero — in that case return `"0s"`.

## Rules

- Break `ms` into whole hours, whole minutes (remainder), and whole seconds (remainder).
  Discard any sub-second portion (truncate, do not round).
- Components: `Xh`, `Ym`, `Zs` — include only non-zero components, joined by a single space.
- If all components are zero (i.e. `ms < 1000`), return `"0s"`.
- Input is always a non-negative integer (you do not need to validate).

## Public examples

```
formatDuration(0)         // "0s"
formatDuration(999)       // "0s"       (sub-second, treated as zero)
formatDuration(1000)      // "1s"
formatDuration(5000)      // "5s"
formatDuration(60000)     // "1m"
formatDuration(3661000)   // "1h 1m 1s"
```

## Edge-case tests

Your implementation must handle all of the following correctly:

- `59999`    → `"59s"`   (59 whole seconds, 999 ms sub-second portion discarded)
- `3600000`  → `"1h"`    (exactly one hour, no minutes or seconds)
- `3660000`  → `"1h 1m"` (one hour and one minute, no seconds)
- `86399000` → `"23h 59m 59s"` (one second before 24 h)
- `86400000` → `"24h"`   (24 hours exactly; hours are unbounded)
- `90061000` → `"25h 1m 1s"` (hours may exceed 23)
- `1500`     → `"1s"`    (1.5 s truncated to 1 s)
- `61001`    → `"1m 1s"` (1 min 1.001 s truncated to 1 min 1 s)

## Contract

- File: `bench/sandbox/format-duration-ht.js`, exporting `module.exports = { formatDuration };` (CommonJS).
- Pure function: no I/O, no global state, deterministic, no Node built-ins beyond plain `Math`.
- Always return a non-empty string.
- Keep it tight. Create `bench/sandbox/` if it does not exist.

Write your best implementation and stop. Do not write any test files.
