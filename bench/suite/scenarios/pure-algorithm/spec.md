# Task: Implement MedianFinder

Implement a `MedianFinder` class in `bench/sandbox/solution.js` that supports:

- `addNum(num)` — add a number to the data structure. O(log n).
- `findMedian()` — return the median of all added numbers. O(1).

**Requirements:**
- `findMedian()` returns a number (integer or float).
- If the count of numbers is odd, return the middle element.
- If the count is even, return the average of the two middle elements.
- No external dependencies. Use only Node.js built-ins.

**Export format:**
```js
module.exports = { MedianFinder };
```

**Example:**
```js
const mf = new MedianFinder();
mf.addNum(1);
mf.addNum(2);
console.log(mf.findMedian()); // 1.5
mf.addNum(3);
console.log(mf.findMedian()); // 2
```

Write the implementation to `bench/sandbox/solution.js`. Do not write any test harness in that file — only the class and its export.
