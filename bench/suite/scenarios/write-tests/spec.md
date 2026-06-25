# Task: Write Tests for parseConfig

The file `bench/sandbox/input.js` contains a `parseConfig(s)` function.
Write a comprehensive test suite in `bench/sandbox/solution.js`.

The function parses a simple config format:
- Input: a multiline string. Each non-empty line is `key=value`.
- Lines starting with `#` are comments (ignored).
- Returns an object of key-value pairs (strings).
- Returns `{}` for empty/whitespace-only input.
- Throws `Error('invalid line: <line>')` for lines that are not `key=value`, not a comment, and not empty.

Your test file must:
1. `require` the function as: `const { parseConfig } = require('./input');`
2. Use Node's built-in `assert` module only (no external deps).
3. Export a `runTests()` function that runs all assertions and returns `{ pass, total }` where `total >= 8`.
4. `module.exports = { runTests }`.

Do not modify `bench/sandbox/input.js`.
