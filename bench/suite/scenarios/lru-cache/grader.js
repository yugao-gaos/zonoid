'use strict';
// grader.js — lru-cache correctness grader
// Usage: node grader.js <artifact-path>
// Output: JSON { ok, pass, total }

const artifactPath = process.argv[2];
let LRUCache;
try {
  ({ LRUCache } = require(artifactPath));
} catch (e) {
  console.log(JSON.stringify({ ok: false, pass: 0, total: 10, error: 'require failed: ' + e.message }));
  process.exit(0);
}

let pass = 0;
const total = 10;

function check(result, expected) {
  if (result === expected) pass++;
}

// Test 1: get miss on empty cache returns -1
{
  const c = new LRUCache(2);
  check(c.get(1), -1);
}

// Test 2: put then get hit returns value
{
  const c = new LRUCache(2);
  c.put(1, 42);
  check(c.get(1), 42);
}

// Test 3: capacity=1 — second put evicts first
{
  const c = new LRUCache(1);
  c.put(1, 1);
  c.put(2, 2);
  check(c.get(1), -1); // evicted
}

// Test 4: get updates recency — recently-got key not evicted next
{
  const c = new LRUCache(2);
  c.put(1, 1);
  c.put(2, 2);
  c.get(1);      // 1 becomes MRU; 2 is now LRU
  c.put(3, 3);   // evicts 2
  check(c.get(1), 1); // still alive
}

// Test 5: canonical LRU sequence — get(2) returns -1 after eviction
{
  const c = new LRUCache(2);
  c.put(1, 1);
  c.put(2, 2);
  c.get(1);      // 1 MRU, 2 LRU
  c.put(3, 3);   // evicts 2
  check(c.get(2), -1);
}

// Test 6: overwrite existing key updates value, does not add capacity
{
  const c = new LRUCache(2);
  c.put(1, 10);
  c.put(1, 20); // update — capacity still 1 item used
  c.put(2, 30);
  // Only 2 slots used (1 and 2), nothing should be evicted
  check(c.get(1), 20);
}

// Test 7: capacity=3 access pattern
{
  const c = new LRUCache(3);
  c.put(1, 1);
  c.put(2, 2);
  c.put(3, 3);
  c.get(1);      // order: LRU→ 2, 3, 1 ←MRU
  c.put(4, 4);   // evicts 2
  check(c.get(2), -1);
}

// Test 8: get after eviction returns -1
{
  const c = new LRUCache(2);
  c.put(1, 1);
  c.put(2, 2);
  c.put(3, 3);  // evicts 1
  check(c.get(1), -1);
}

// Test 9: large sequence — last `capacity` puts survive
{
  const cap = 10;
  const c = new LRUCache(cap);
  for (let i = 0; i < 100; i++) {
    c.put(i, i * 2);
  }
  // Keys 90..99 should survive; key 89 should not
  let allSurvive = true;
  for (let i = 90; i < 100; i++) {
    if (c.get(i) !== i * 2) allSurvive = false;
  }
  if (allSurvive) pass++;
}

// Test 10: capacity=1 update — put same key twice, get returns latest value
{
  const c = new LRUCache(1);
  c.put(5, 100);
  c.put(5, 200);
  check(c.get(5), 200);
}

const ok = pass === total;
console.log(JSON.stringify({ ok, pass, total }));
