const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEGACY_PREFIX_RE = /^[0-9a-f]{8}$/;
const SEQ_RE = /^[1-9]\d*$/;

function parseTaskId(id) {
  if (typeof id !== 'string') return null;

  const slash = id.indexOf('/');
  if (slash === -1) return null;

  const prefix = id.slice(0, slash);
  const seqStr = id.slice(slash + 1);

  if (!SEQ_RE.test(seqStr)) return null;
  const seq = parseInt(seqStr, 10);

  if (UUID_RE.test(prefix)) {
    return { session: prefix, seq, legacy: false };
  }

  if (LEGACY_PREFIX_RE.test(prefix)) {
    return { session: `legacy/${prefix}`, seq, legacy: true };
  }

  return null;
}

module.exports = { parseTaskId };
