# lru-cache

Implement an LRU (Least Recently Used) cache in `bench/sandbox/solution.js`.

## Export

```js
module.exports = { LRUCache };
```

## Class interface

```js
class LRUCache {
  constructor(capacity) { ... }  // capacity: positive integer
  get(key) { ... }               // returns value or -1
  put(key, value) { ... }        // inserts or updates
}
```

## Semantics

- `get(key)` — if `key` exists, return its value and mark it as most-recently-used. If absent, return `-1`.
- `put(key, value)` — insert or update the entry. After insertion, if the cache exceeds `capacity`, evict the **least-recently-used** entry. Updating an existing key counts as a use (moves it to most-recently-used).

## Complexity requirement

Both `get` and `put` must run in **O(1)** time.

## Example

```js
const cache = new LRUCache(2);
cache.put(1, 1);   // cache: {1=1}
cache.put(2, 2);   // cache: {1=1, 2=2}
cache.get(1);      // returns 1, marks 1 as MRU → {2=2, 1=1}
cache.put(3, 3);   // evicts 2 (LRU) → {1=1, 3=3}
cache.get(2);      // returns -1 (evicted)
cache.get(3);      // returns 3
```
