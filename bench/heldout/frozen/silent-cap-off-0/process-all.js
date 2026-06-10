'use strict';

const batch = require('./batch.js');

// processAll submits every item for processing and returns how many were actually processed.
//
// batch.submit silently caps how many items a single call truly processes (items past one
// transport window are receipted but quietly deferred). The cap is negotiated internally and is
// not part of the public contract, so we can't read it. To guarantee EVERY item is processed, we
// submit one item per call — a single item always fits within any window — and count the receipts.
function processAll(items) {
  let processed = 0;
  for (const item of items) {
    processed += batch.submit([item]).length;
  }
  return processed;
}

module.exports = { processAll };
