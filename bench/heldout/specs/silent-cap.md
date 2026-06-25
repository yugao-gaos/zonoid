# Task: processAll

Implement a function `processAll(items)` in a NEW file `bench/sandbox/process-all.js` in the
repo `__INSTALL_DIR__`. Do NOT run `git commit`.

## Goal

`processAll(items)` takes an array of items, submits ALL of them for processing through the
provided batch client, and returns the **total number of items actually processed** (a number).

## The batch client

A module `batch.js` sits next to your file at `bench/sandbox/batch.js`. Require it as
`const batch = require('./batch.js');`. It exposes:

- `batch.submit(items)` — enqueues a list of items for processing and returns an array of
  **receipt ids**, one per item in the call.

Your `processAll` must ensure **every** item in the input actually gets processed, and return the
count of items that were actually processed.

## Public example

```
processAll(['a', 'b', 'c'])   // returns 3
```

## Contract

- File: `bench/sandbox/process-all.js`, exporting `module.exports = { processAll };` (CommonJS).
- Use `batch.submit` to do the processing — do not invent your own processing path.
- Return a number (the count of items processed).
- Keep it tight. Create `bench/sandbox/` if it does not exist. Do NOT modify `batch.js`.

Write your best implementation and stop. Do not write any test files.
