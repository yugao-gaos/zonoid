# Task: Refactor messyFunction

The file `bench/sandbox/input.js` contains a `messyFunction` that parses a CSV-like record format.
It works correctly but is hard to read: deeply nested conditionals, repeated logic, and no named helpers.

**Your task:** Refactor it into `bench/sandbox/solution.js`.

**Requirements:**
1. The refactored code must produce identical output to `messyFunction` for all valid and invalid inputs.
2. Extract **at least 2 named helper functions** (besides the main exported function).
3. No single function may exceed **20 lines** (blank lines and comment lines count).
4. Export the main function as `module.exports = { parseRecord }` (rename `messyFunction` → `parseRecord`).
5. No external dependencies — Node.js built-ins only.

**Input format** (handled by `messyFunction`, which you must preserve exactly):
- A string of semicolon-delimited fields: `"name:Alice;age:30;tags:a,b,c;active:true"`
- Each field is `key:value`. Tags field is comma-separated.
- Returns an object `{ name, age, tags, active }` with types coerced:
  - `age` → integer (NaN if invalid)
  - `tags` → array of trimmed strings (empty array if missing/blank)
  - `active` → boolean (`"true"` → true, else false)
  - Unknown keys are ignored; missing keys default to `null` for name, `NaN` for age, `[]` for tags, `false` for active.
- Returns `null` if input is not a non-empty string.

Write the refactored implementation to `bench/sandbox/solution.js`. Do not modify `bench/sandbox/input.js`.
