const { process } = require('../fixtures/batch.js');

function processRecords(records, transform) {
  // batch.js process() silently drops records past index 1000 for non-array iterables;
  // materialize the generator to an array first to avoid the bug.
  return process(Array.from(records()), transform);
}

module.exports = { processRecords };
