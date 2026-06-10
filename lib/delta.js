// "What changed since T" delta — the read-only change sensor for the nightly-QA loop. Everything
// here is DERIVED from timestamps the daemon already records (overlay.timestamps firstSeen/
// lastChanged, note_nodes created_at, and any timestamp a verdict knowledge item happens to carry):
// no new persisted state, no graph mutation. Pure on (tasks, overlay, sinceMs) ⇒ unit-testable.
'use strict';

// Parse + validate the `since` query param. Returns { ok:true, ms } or { ok:false, error } —
// the route turns the latter into a 400 (a delta without a baseline instant is meaningless).
function parseSince(since) {
  if (!since || typeof since !== 'string') return { ok: false, error: 'since (ISO-8601 timestamp) required' };
  const ms = Date.parse(since);
  if (Number.isNaN(ms)) return { ok: false, error: `unparseable since timestamp: ${since}` };
  return { ok: true, ms };
}

// Best-effort timestamp extraction from a knowledge item / its parsed value. Verdicts are agent-
// written free-form objects with NO enforced timestamp field, so we probe the common spellings.
// Returns { ms, iso } or null — a timestamp-less verdict is NOT derivable and gets omitted from
// the delta (we never invent one; see the route comment).
const TS_FIELDS = ['at', 'ts', 'time', 'timestamp', 'merged_at', 'measured_at', 'recorded_at'];
function itemTimestamp(item, value) {
  for (const src of [item, value]) {
    if (!src || typeof src !== 'object') continue;
    for (const f of TS_FIELDS) {
      if (typeof src[f] !== 'string') continue;
      const t = Date.parse(src[f]);
      if (!Number.isNaN(t)) return { ms: t, iso: src[f] };
    }
  }
  return null;
}

// Compute the delta. `tasks` = buildGraph(ws).tasks (task nodes + note nodes), `overlay` = that
// workspace's overlay, `sinceMs` = validated epoch-ms baseline. Buckets (each sorted oldest→newest):
//   status_changes — tasks whose effective status changed after T (incl. reached done/tested/
//                    canceled), keyed off overlay.timestamps[key].lastChanged. A task BOTH created
//                    and never re-changed after creation lands only in tasks_created (no double-count).
//   tasks_created  — tasks first seen after T (timestamps[key].firstSeen).
//   notes_added    — note nodes recorded after T (created_at = transaction time, never backdated).
//   merges         — verdict knowledge items (value carries `winner`, the judge/merge convention)
//                    whose item/value carries a parseable timestamp after T. Verdicts WITHOUT a
//                    timestamp are omitted (nothing derivable — by design, no new write path).
function computeDelta(tasks, overlay, sinceMs) {
  const timestamps = (overlay && overlay.timestamps) || {};
  const status_changes = [];
  const tasks_created = [];
  for (const t of tasks) {
    if ((t.kind || 'task') === 'note') continue; // notes have their own bucket below
    const ts = timestamps[t.id] || {};
    const first = Date.parse(ts.firstSeen);
    const changed = Date.parse(ts.lastChanged);
    const created = !Number.isNaN(first) && first > sinceMs;
    if (created) tasks_created.push({ key: t.id, label: t.label, status: t.status, firstSeen: ts.firstSeen });
    // A pure creation (lastChanged still == firstSeen) isn't a status CHANGE — skip the double-count.
    if (!Number.isNaN(changed) && changed > sinceMs && !(created && ts.lastChanged === ts.firstSeen))
      status_changes.push({ key: t.id, label: t.label, status: t.status, lastChanged: ts.lastChanged });
  }
  const notes_added = [];
  for (const n of Object.values((overlay && overlay.note_nodes) || {})) {
    const c = Date.parse(n.created_at);
    if (!Number.isNaN(c) && c > sinceMs)
      notes_added.push({ key: 'note:' + n.id, title: n.title, summary: n.summary, created_at: n.created_at });
  }
  const merges = [];
  for (const [key, items] of Object.entries((overlay && overlay.knowledge) || {})) {
    for (const it of (items || [])) {
      let v = it && it.value;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
      if (!v || typeof v !== 'object' || !('winner' in v)) continue; // not a verdict
      const ts = itemTimestamp(it, v);
      if (ts && ts.ms > sinceMs) merges.push({ key, winner: v.winner, at: ts.iso });
    }
  }
  const byTs = (f) => (a, b) => String(a[f]).localeCompare(String(b[f]));
  status_changes.sort(byTs('lastChanged'));
  tasks_created.sort(byTs('firstSeen'));
  notes_added.sort(byTs('created_at'));
  merges.sort(byTs('at'));
  return {
    since: new Date(sinceMs).toISOString(),
    now: new Date().toISOString(),
    counts: { status_changes: status_changes.length, tasks_created: tasks_created.length, notes_added: notes_added.length, merges: merges.length },
    status_changes, tasks_created, notes_added, merges,
  };
}

module.exports = { parseSince, computeDelta, itemTimestamp };
