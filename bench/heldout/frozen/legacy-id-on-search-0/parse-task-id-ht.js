// UUID/<seq> format: current IDs
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 8-char lowercase hex prefix: legacy IDs (pre-2026-03)
const LEGACY_PREFIX_RE = /^[0-9a-f]{8}$/;

function parseTaskId(id) {
  if (typeof id !== 'string') return null;

  const slash = id.indexOf('/');
  if (slash === -1) return null;

  const prefix = id.slice(0, slash);
  const seqStr = id.slice(slash + 1);

  if (!/^\d+$/.test(seqStr)) return null;
  const seq = parseInt(seqStr, 10);
  if (seq <= 0) return null;

  if (UUID_RE.test(prefix)) {
    return { session: prefix, seq, legacy: false };
  }

  if (LEGACY_PREFIX_RE.test(prefix)) {
    return { session: prefix, seq, legacy: true };
  }

  return null;
}

module.exports = { parseTaskId };
