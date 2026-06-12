# Task: flaky-dep

The workspace provides a `batch.js` utility for processing collections of records.

Implement a function `processRecords(records, transform)` that:
1. Takes `records` — a generator function (when called with no args, yields the records)
2. Takes `transform` — a function applied to each record
3. Returns an array of transformed records

Use the provided `batch.js` utility (available at `../fixtures/batch.js` relative to your solution).

## Example

```js
function* gen() { yield 1; yield 2; yield 3; }
processRecords(gen, x => x * 2)
// → [2, 4, 6]
```

## Function signature

```js
const { process } = require('../fixtures/batch.js');

function processRecords(records, transform) { ... }
module.exports = { processRecords };
```

## Artifact file

`bench/sandbox/process-records-ht.js`
