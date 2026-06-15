'use strict';
// grader.js — cache-eviction-policy correctness grader
// Usage: node grader.js <artifact-path>
// Output: JSON { ok, pass, total }
//
// Tests 1-8:  basic correctness (both LRU and CLOCK implementations pass)
// Tests 9-14: eviction-order divergence tests — CLOCK passes, LRU fails

const artifactPath = process.argv[2];
let Cache;
try {
  ({ Cache } = require(artifactPath));
} catch (e) {
  console.log(JSON.stringify({ ok: false, pass: 0, total: 14, error: 'require failed: ' + e.message }));
  process.exit(0);
}

if (!Cache) {
  console.log(JSON.stringify({ ok: false, pass: 0, total: 14, error: 'Cache not exported' }));
  process.exit(0);
}

let pass = 0;
const total = 14;

function check(result, expected, label) {
  if (result === expected) {
    pass++;
  }
}

// ── Tests 1-8: basic correctness ─────────────────────────────────────────────

// Test 1: get miss on empty cache returns null
{
  const c = new Cache(2);
  check(c.get('x'), null, 'T1');
}

// Test 2: set then get returns the value
{
  const c = new Cache(2);
  c.set('a', 42);
  check(c.get('a'), 42, 'T2');
}

// Test 3: capacity=1 — second set evicts first
{
  const c = new Cache(1);
  c.set('a', 1);
  c.set('b', 2);
  check(c.get('a'), null, 'T3');
}

// Test 4: capacity=1 — second set, new key is accessible
{
  const c = new Cache(1);
  c.set('a', 1);
  c.set('b', 99);
  check(c.get('b'), 99, 'T4');
}

// Test 5: set updates existing key's value, no eviction
{
  const c = new Cache(2);
  c.set('a', 1);
  c.set('a', 99);
  check(c.get('a'), 99, 'T5');
}

// Test 6: get miss returns null (key never set)
{
  const c = new Cache(3);
  c.set('a', 1);
  c.set('b', 2);
  check(c.get('z'), null, 'T6');
}

// Test 7: fill to capacity then get all keys present
{
  const c = new Cache(3);
  c.set('a', 10);
  c.set('b', 20);
  c.set('c', 30);
  check(c.get('b'), 20, 'T7');
}

// Test 8: evicted entry returns null; surviving entries return values
// Insert 3 entries (cap=2); first inserted entry should be gone
{
  const c = new Cache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3); // one of 'a' or 'b' evicted
  const surviving = c.get('b') !== null || c.get('c') !== null;
  check(surviving, true, 'T8');
}

// ── Tests 9-14: CLOCK divergence (LRU fails, CLOCK passes) ──────────────────
//
// Pattern: fill cap=3 with [A,B,C]; access in reverse insertion order (C,B,A)
// so all refbits=1 and LRU order is C(LRU)→B→A(MRU). Then add D.
//
// CLOCK: sweeps A(rb1→0), B(rb1→0), C(rb1→0), then evicts A (first rb=0 found).
//        Result: cache={B,C,D}
// LRU:   evicts C (least recently used).
//        Result: cache={A,B,D}

// Test 9: after divergence — evicted-by-CLOCK key (A) returns null
// CLOCK: get(A) = null (A evicted)
// LRU:   get(A) = 1   (A survived)
{
  const c = new Cache(3);
  c.set('A', 1); c.set('B', 2); c.set('C', 3);
  c.get('C'); c.get('B'); c.get('A');
  c.set('D', 4);
  check(c.get('A'), null, 'T9');
}

// Test 10: after divergence — surviving-in-CLOCK key (C) returns value
// CLOCK: get(C) = 3   (C survived)
// LRU:   get(C) = null (C evicted)
{
  const c = new Cache(3);
  c.set('A', 1); c.set('B', 2); c.set('C', 3);
  c.get('C'); c.get('B'); c.get('A');
  c.set('D', 4);
  check(c.get('C'), 3, 'T10');
}

// Tests 11-12: second eviction after accessing C (which sets C.refbit=1 in CLOCK).
//
// After T9 setup (set D), CLOCK state: [D(rb=0,s0), B(rb=0,s1), C(rb=0,s2)], hand=1
// get(C): CLOCK sets C.rb=1. LRU: C not in cache, no change. LRU state={A,B,D}, order B→A→D.
// set(E): CLOCK: hand=1(B.rb=0→evict B), E in slot1, hand=2. Cache={D,E,C(rb=1)}.
//         LRU: evict B (LRU). Cache={A,D,E}.

// Test 11: A — evicted by CLOCK (during set D), survived in LRU
// CLOCK: get(A) = null
// LRU:   get(A) = 1
{
  const c = new Cache(3);
  c.set('A', 1); c.set('B', 2); c.set('C', 3);
  c.get('C'); c.get('B'); c.get('A');
  c.set('D', 4);
  c.get('C');      // CLOCK: C.rb=1; LRU: miss (C not in cache)
  c.set('E', 5);
  check(c.get('A'), null, 'T11');
}

// Test 12: C — survived in CLOCK (protected by refbit), evicted by LRU (at set D)
// CLOCK: get(C) = 3
// LRU:   get(C) = null
{
  const c = new Cache(3);
  c.set('A', 1); c.set('B', 2); c.set('C', 3);
  c.get('C'); c.get('B'); c.get('A');
  c.set('D', 4);
  c.get('C');
  c.set('E', 5);
  check(c.get('C'), 3, 'T12');
}

// Tests 13-14: third eviction (set F) after the above.
//
// After T11/12 state:
//   CLOCK: [D(rb=0,s0), E(rb=0,s1), C(rb=1,s2)], hand=2
//   LRU:   cache={A,D,E}, order A→D→E
// set(F): CLOCK: hand=2(C.rb=1→0,adv), hand=0(D.rb=0→evict D). F in slot0, hand=1.
//                Cache={F(rb=0), E(rb=0), C(rb=0)}.
//         LRU: evict A (LRU). Cache={D,E,F}.

// Test 13: D — evicted by CLOCK at set(F), survived in LRU
// CLOCK: get(D) = null
// LRU:   get(D) = 4
{
  const c = new Cache(3);
  c.set('A', 1); c.set('B', 2); c.set('C', 3);
  c.get('C'); c.get('B'); c.get('A');
  c.set('D', 4);
  c.get('C');
  c.set('E', 5);
  c.set('F', 6);
  check(c.get('D'), null, 'T13');
}

// Test 14: C — survived through two rounds of CLOCK (refbit saved it at set E, cleared at set F)
// CLOCK: get(C) = 3
// LRU:   get(C) = null (evicted at set D)
{
  const c = new Cache(3);
  c.set('A', 1); c.set('B', 2); c.set('C', 3);
  c.get('C'); c.get('B'); c.get('A');
  c.set('D', 4);
  c.get('C');
  c.set('E', 5);
  c.set('F', 6);
  check(c.get('C'), 3, 'T14');
}

console.log(JSON.stringify({ ok: pass === total, pass, total }));
