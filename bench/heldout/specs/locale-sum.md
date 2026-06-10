# Task: sumAmounts (amount feed → total)

Implement `sumAmounts(rows)` in a NEW file `bench/sandbox/sum-amounts-ht.js`
in the repo `__INSTALL_DIR__`. Do NOT run `git commit`.

## Goal

The billing daemon ingests a feed of line items from an upstream export and needs the grand total.
Each item carries an `amount` rendered as a **string** (the export serializes money as text, never as a
JSON number). Given the array of `rows`, return the sum of all amounts as a **Number**, rounded to 2
decimal places (standard half-up rounding at the cent).

## Row shape

```
{ amount: "<string>", currency: "<string>" }   // currency is informational; you sum across all rows
```

- `rows` is an array. It may be empty (then the total is `0`).
- A row whose `amount` is missing, empty, or not a parseable monetary value contributes `0`
  (skip it — never let one bad row throw or poison the total with `NaN`).
- Leading/trailing whitespace around an amount is insignificant.
- An amount may carry a leading currency symbol (`$`) and/or a sign (`-` for a refund/credit); strip
  the symbol, honor the sign.

## Public examples

```
sumAmounts([])                                            // 0
sumAmounts([{ amount: '12.50' }])                         // 12.5
sumAmounts([{ amount: '1234.00' }, { amount: '0.99' }])  // 1234.99
sumAmounts([{ amount: ' $19.95 ' }])                     // 19.95
sumAmounts([{ amount: '100.00' }, { amount: '-30.00' }]) // 70
sumAmounts([{ amount: '' }, { amount: '12.00' }])        // 12  (bad row skipped)
```

## Contract

- File: `bench/sandbox/sum-amounts-ht.js`, exporting `module.exports = { sumAmounts };` (CommonJS).
- Pure function: no I/O, no global state, deterministic, no Node built-ins beyond plain `Math`/`Number`.
- Always return a `Number` (never a string, never `NaN`); the empty feed returns `0`.
- Round the final total to 2 decimals.
- Keep it tight. Create `bench/sandbox/` if it does not exist.

Write your best implementation and stop. Do not write any test files.
