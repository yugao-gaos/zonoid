'use strict';
const assert = require('assert');
const { groupBy } = require('./solution');

let pass = 0;
const total = 8;

function check(desc, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    // test failed — count not incremented
  }
}

check('basic even/odd', () => {
  assert.deepStrictEqual(
    groupBy([1, 2, 3, 4], x => x % 2 === 0 ? 'even' : 'odd'),
    { odd: [1, 3], even: [2, 4] }
  );
});

check('empty array', () => {
  assert.deepStrictEqual(groupBy([], x => x), {});
});

check('single item', () => {
  assert.deepStrictEqual(groupBy(['a'], x => x), { a: ['a'] });
});

check('all same key', () => {
  assert.deepStrictEqual(groupBy([1, 2, 3], () => 'all'), { all: [1, 2, 3] });
});

check('string keys from first char', () => {
  assert.deepStrictEqual(
    groupBy(['foo', 'bar', 'baz'], s => s[0]),
    { f: ['foo'], b: ['bar', 'baz'] }
  );
});

check('numeric keys', () => {
  assert.deepStrictEqual(
    groupBy([10, 20, 11], x => Math.floor(x / 10)),
    { 1: [10, 11], 2: [20] }
  );
});

check('preserves insertion order within groups', () => {
  assert.deepStrictEqual(
    groupBy([3, 1, 2], x => x % 2 ? 'odd' : 'even'),
    { odd: [3, 1], even: [2] }
  );
});

check('objects grouped by property', () => {
  assert.deepStrictEqual(
    groupBy(
      [{ t: 'a', v: 1 }, { t: 'b', v: 2 }, { t: 'a', v: 3 }],
      x => x.t
    ),
    { a: [{ t: 'a', v: 1 }, { t: 'a', v: 3 }], b: [{ t: 'b', v: 2 }] }
  );
});

module.exports = { run: () => ({ pass, total }) };
