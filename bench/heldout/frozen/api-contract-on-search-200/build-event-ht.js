function buildEvent(type, payload, enqueuedAt) {
  return { type, payload, ts: enqueuedAt };
}
module.exports = { buildEvent };
