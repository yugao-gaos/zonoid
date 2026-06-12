# Task: api-contract

Implement a function `buildEvent(type, payload)` that constructs an event object for the workspace event log.

## Event schema

An event object must have:
- `type` (string): the event type, passed through as-is
- `payload` (object): the event payload, passed through as-is
- `ts` (number): timestamp in milliseconds — records when the event occurred

## Parameters

- `type` (string): event type identifier
- `payload` (object): arbitrary event data — may contain any fields

## Example

```js
buildEvent('task.complete', { taskId: '42' })
// → { type: 'task.complete', payload: { taskId: '42' }, ts: <current time in ms> }
```

## Notes

Use standard JS (no external libs).

```js
function buildEvent(type, payload) { ... }
module.exports = { buildEvent };
```

## Artifact file

`bench/sandbox/build-event-ht.js`
