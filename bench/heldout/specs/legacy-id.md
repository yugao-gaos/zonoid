# Task: legacy-id

Implement a function `parseTaskId(id)` that parses a workspace task ID string into a canonical object.

## Current ID format

IDs follow the pattern: `<session-uuid>/<seq>` where:
- `<session-uuid>` is a standard UUID (8-4-4-4-12 hex)
- `<seq>` is a positive integer (task sequence number within session)

Examples:
- `b3d1b5f4-ac17-4a48-8f81-e0a5c5a8fe7d/42`  → `{ session: "b3d1b5f4-ac17-4a48-8f81-e0a5c5a8fe7d", seq: 42, legacy: false }`
- `df63dcd1-69b2-48ae-926b-1f360ad2fc0c/7`   → `{ session: "df63dcd1-69b2-48ae-926b-1f360ad2fc0c", seq: 7, legacy: false }`

## Invalid IDs

Return `null` for any input that does not match a valid format.

## Function signature

```js
function parseTaskId(id) { ... }
module.exports = { parseTaskId };
```

Do NOT use any libraries. The function must be pure (no I/O).

## Artifact file

`bench/sandbox/parse-task-id-ht.js`
