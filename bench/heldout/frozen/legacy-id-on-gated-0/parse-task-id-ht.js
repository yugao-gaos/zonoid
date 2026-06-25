const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseTaskId(id) {
  if (typeof id !== 'string') return null;
  const slash = id.indexOf('/');
  if (slash === -1) return null;
  const session = id.slice(0, slash);
  const seqStr = id.slice(slash + 1);
  if (!UUID_RE.test(session)) return null;
  if (!/^[1-9][0-9]*$/.test(seqStr)) return null;
  return { session, seq: parseInt(seqStr, 10), legacy: false };
}

module.exports = { parseTaskId };
