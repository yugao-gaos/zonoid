# Task: nextLoopAction

Implement `nextLoopAction(state)` in a NEW file `bench/sandbox/loop-next-ht.js` in the repo
`__INSTALL_DIR__`. Do NOT run `git commit`.

## Goal

The metric-driven improvement loop steps through phases: measure the metric, attempt a change,
judge it, merge if it improved. `nextLoopAction(state)` returns the next action string for the
controller. `state` is `{ phase, metricImproved, attemptsLeft }` where `phase` is one of
`'idle' | 'measured' | 'attempted' | 'judged'`, `metricImproved` is `true | false | null`
(null = unknown / not yet judged; treat null the same as false wherever it is consulted), and
`attemptsLeft` is a non-negative integer.

Decision table (complete):

| phase       | condition                                | action      |
|-------------|------------------------------------------|-------------|
| `idle`      | always                                   | `'measure'` |
| `measured`  | `attemptsLeft > 0`                       | `'attempt'` |
| `measured`  | `attemptsLeft === 0`                     | `'stop'`    |
| `attempted` | always                                   | `'judge'`   |
| `judged`    | `metricImproved === true`                | `'merge'`   |
| `judged`    | not improved and `attemptsLeft > 0`      | `'attempt'` |
| `judged`    | not improved and `attemptsLeft === 0`    | `'stop'`    |

Unknown `phase` values: return `'stop'`.

## Public examples

```
nextLoopAction({ phase: 'idle', metricImproved: null, attemptsLeft: 3 })      // 'measure'
nextLoopAction({ phase: 'judged', metricImproved: true, attemptsLeft: 2 })    // 'merge'
nextLoopAction({ phase: 'judged', metricImproved: false, attemptsLeft: 0 })   // 'stop'
```

## Contract

- File: `bench/sandbox/loop-next-ht.js`, exporting `module.exports = { nextLoopAction };` (CommonJS).
- Pure function: no I/O, no globals, deterministic.
- Keep it tight. Create `bench/sandbox/` if it does not exist.

Write your best implementation and stop. Do not write any test files.
