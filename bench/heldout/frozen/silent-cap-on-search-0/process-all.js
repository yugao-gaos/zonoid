'use strict';

const batch = require('./batch.js');

const CHUNK_SIZE = 50; // batch.submit silently drops items beyond its 50-item window cap

function processAll(items) {
  let count = 0;
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    batch.submit(chunk);
    count += chunk.length;
  }
  return count;
}

module.exports = { processAll };
