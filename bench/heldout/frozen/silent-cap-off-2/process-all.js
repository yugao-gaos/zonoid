'use strict';

const batch = require('./batch.js');

// processAll submits every item for processing and returns how many were actually processed.
//
// batch.submit returns one receipt per item, so its return value always *looks* fully accepted
// regardless of how many items truly reached the processing log. To guarantee every item is
// actually processed without relying on that opaque per-call capacity, we submit one item per
// call — a single item always fits, so each submit processes exactly what it was given.
function processAll(items) {
  if (!Array.isArray(items)) throw new TypeError('processAll expects an array');

  let processed = 0;
  for (const item of items) {
    const receipts = batch.submit([item]);
    processed += receipts.length;
  }
  return processed;
}

module.exports = { processAll };
