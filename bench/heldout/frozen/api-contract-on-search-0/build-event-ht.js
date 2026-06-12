function buildEvent(type, payload) {
  return {
    type,
    payload,
    ts: payload._enqueueMs !== undefined ? payload._enqueueMs : Date.now(),
  };
}

module.exports = { buildEvent };
