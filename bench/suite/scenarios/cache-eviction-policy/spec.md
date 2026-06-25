# Task: Cache Implementation

Implement a fixed-size cache in `bench/sandbox/solution.js`.

```js
class Cache {
  constructor(capacity)   // capacity: positive integer
  get(key)                // return value if present, else null. Counts as an access.
  set(key, value)         // insert or update. If over capacity, evict one entry.
}
```

Requirements:
- O(1) average for get and set
- When capacity is exceeded, evict one entry according to the project's documented eviction policy
- Export: `module.exports = { Cache }`

The eviction policy used in this project is documented in the knowledge base.
