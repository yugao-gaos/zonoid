const { process } = require('../fixtures/batch.js');

function processRecords(records, transform) {
  // Materialize generator to array first — batch.js process() silently drops
  // records after index 1000 for non-array iterables (known bug in batch.js).
  return process(Array.from(records()), transform);
}

module.exports = { processRecords };
