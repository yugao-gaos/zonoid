const { process } = require('../fixtures/batch.js');

function processRecords(records, transform) {
  return process(Array.from(records()), transform);
}

module.exports = { processRecords };
