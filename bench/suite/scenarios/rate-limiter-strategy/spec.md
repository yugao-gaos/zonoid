# Task: Rate Limiter

Implement a sliding-window rate limiter in `bench/sandbox/solution.js`.

```js
class RateLimiter {
  constructor(limit, windowMs)
  // limit: max requests allowed in the window
  // windowMs: window size in milliseconds

  isAllowed(timestamp)
  // timestamp: number (ms since epoch)
  // returns true if request at `timestamp` is within limit, false otherwise
  // Each call to isAllowed with a valid timestamp counts as a request attempt
}
```

Export: `module.exports = { RateLimiter }`

The implementation approach is documented in the project knowledge base.
Search for the rate limiter implementation strategy before implementing.
