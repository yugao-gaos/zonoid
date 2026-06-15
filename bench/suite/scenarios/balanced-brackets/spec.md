# balanced-brackets

Implement `isBalanced(s)` in `bench/sandbox/solution.js`.

## Export

```js
module.exports = { isBalanced };
```

## Signature

```js
function isBalanced(s) { ... }
```

## Semantics

- `s` is a string that may contain any characters.
- Only the bracket characters `(`, `)`, `[`, `]`, `{`, `}` are significant; all other characters are ignored.
- Returns `true` if every opener has a matching closer in the correct order (properly nested), `false` otherwise.
- An empty string (or a string with no bracket characters) returns `true`.

## Examples

```js
isBalanced('')          // true
isBalanced('()')        // true
isBalanced('()[]{}'  ) // true
isBalanced('([])')      // true
isBalanced('([{}])')    // true
isBalanced('(]')        // false  — wrong closer
isBalanced('([)]')      // false  — interleaved, not nested
isBalanced('{')         // false  — unclosed opener
isBalanced('a(b[c]d)e') // true  — non-bracket chars ignored
```
