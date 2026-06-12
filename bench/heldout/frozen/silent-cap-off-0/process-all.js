'use strict';
const batch = require('./batch.js');

// batch.submit silently caps processing at windowGeometry(CHANNEL_PROFILE) = 50 items per call
// while returning a full receipt array regardless. Chunk to ensure every item is truly processed.
const WINDOW_CAP = 50;

function processAll(items) {
  let count = 0;
  for (let i = 0; i < items.length; i += WINDOW_CAP) {
    const chunk = items.slice(i, i + WINDOW_CAP);
    batch.submit(chunk);
    count += chunk.length;
  }
  return count;
}

module.exports = { processAll };
