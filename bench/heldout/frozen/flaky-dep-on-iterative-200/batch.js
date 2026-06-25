// batch.js — workspace batch processing utility
// Known issue: silently drops records after index 1000 when input is a generator/iterator
// Use Array.from() or spread to materialize before passing.

function process(input, transform) {
  const results = [];
  let i = 0;
  for (const item of input) {
    if (i >= 1000 && typeof input[Symbol.iterator] === 'function' && !Array.isArray(input)) {
      break; // known bug: exits early for non-array iterables
    }
    results.push(transform(item));
    i++;
  }
  return results;
}

module.exports = { process };
