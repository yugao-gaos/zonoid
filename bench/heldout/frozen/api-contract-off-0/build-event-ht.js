function buildEvent(type, payload) {
  return { type, payload, ts: Date.now() };
}

module.exports = { buildEvent };
