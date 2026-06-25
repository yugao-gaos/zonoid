'use strict';
const batch = require('./batch.js');

const CHUNK_SIZE = 50;

function processAll(items) {
  let processed = 0;
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    batch.submit(chunk);
    processed += chunk.length;
  }
  return processed;
}

module.exports = { processAll };
