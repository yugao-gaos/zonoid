'use strict';

const batch = require('./batch.js');

// batch.submit only truly processes the first `cap` items of any single call (the rest are
// receipted but silently deferred), and the receipt array length never reveals this. The cap is
// not part of the public contract, so we can't read it. To guarantee EVERY item is processed for
// any cap >= 1, we keep each call within the smallest safe window: one item per submit.
function processAll(items) {
  if (!Array.isArray(items)) throw new TypeError('processAll expects an array');
  let processed = 0;
  for (const item of items) {
    batch.submit([item]);
    processed += 1;
  }
  return processed;
}

module.exports = { processAll };
