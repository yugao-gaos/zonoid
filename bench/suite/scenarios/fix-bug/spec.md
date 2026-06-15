# Task: Fix the Bug

The file `bench/sandbox/input.js` contains a `groupBy(arr, keyFn)` function that has a bug.
The test file at `bench/sandbox/tests.js` contains tests that expose the bug.

Fix the bug in `groupBy` and write the corrected version to `bench/sandbox/solution.js`.

`groupBy(arr, keyFn)`:
- Takes an array and a key function
- Returns an object where each key maps to an array of elements from `arr` for which `keyFn(elem)` returns that key
- Example: `groupBy([1,2,3,4], x => x % 2 === 0 ? 'even' : 'odd')` → `{ odd: [1,3], even: [2,4] }`

Do not modify `bench/sandbox/tests.js`. Export: `module.exports = { groupBy }`.
