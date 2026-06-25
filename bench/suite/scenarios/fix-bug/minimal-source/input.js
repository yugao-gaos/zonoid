'use strict';
// BUG: when a key is first seen, assigns the item directly instead of initializing an array.
function groupBy(arr, keyFn) {
  const result = {};
  for (const item of arr) {
    const key = keyFn(item);
    if (!result[key]) result[key] = item;  // BUG: should be result[key] = [item]
    else result[key].push(item);
  }
  return result;
}
module.exports = { groupBy };
