# interval-merge

## Task

Implement the function `mergeIntervals(intervals)` in JavaScript.

## Specification

**Input:** `intervals` — an array of `[start, end]` pairs, where `start` and `end` are numbers. The array may be unsorted. Values may be negative.

**Output:** A new array of merged, non-overlapping intervals sorted by start value.

**Merging rules:**
- Two intervals overlap if one starts before or at the point the other ends.
- Touching intervals (e.g. `[1, 3]` and `[3, 5]`) are considered overlapping and must be merged into a single interval.
- Fully contained intervals (e.g. `[2, 3]` inside `[1, 10]`) are absorbed into the containing interval.

**Edge cases:**
- Empty array input → return `[]`
- Single interval → return it (wrapped in an array) unchanged
- Input is not necessarily sorted — sort before merging

## Function signature

```js
function mergeIntervals(intervals) { ... }
```

## Export

```js
module.exports = { mergeIntervals };
```

## Artifact file

`bench/sandbox/merge-intervals-ht.js`
