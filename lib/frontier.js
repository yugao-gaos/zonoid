// Frontier projection + archival sweep for GET /state. Pure functions (unit-tested) — the daemon
// route stays a thin wrapper. Two jobs:
//   1. frontierKeep: server-side twin of the dashboard's frontierSelect (public/graph.html) — live
//      seeds (ready/in_progress/failed/tested/not_ready) + all 1-hop neighbors, then walk UP the
//      ancestry: blocking deps always (to root), context deps only when important (weight>=0.5 OR
//      top-3 for that node), capped ~4 hops from the seeds. Returns the keep-set of node ids.
//      Scope name "frontier" is deliberate: a follow-up folds get_adjacent/get_dependency_tree into
//      get_full_graph behind scope: "all" | "frontier" | "adjacent" | "tree".
//   2. archivedIds: stale terminal tasks (done/canceled) + superseded notes whose last activity is
//      older than the window — excluded from the default /state payload (lean-payload principle).
//      Nodes the frontier retains are NEVER archived (a done dep that is still an important context
//      provider stays). Archived nodes remain on disk and stay queryable via /search +
//      suggest_links (those read the substrate directly, not /state).
'use strict';

const LIVE_STATUSES = new Set(['not_ready', 'ready', 'in_progress', 'failed', 'tested']);
const ARCHIVE_STATUSES = new Set(['done', 'canceled']);
const DEFAULT_ARCHIVE_DAYS = 14;     // override per-workspace: POST /config { archive_after_days }
const RECENT_FALLBACK = 15;          // nothing live ⇒ show the N most recently changed
const CONTEXT_HOP_CAP = 4;           // context-ancestry walk cap (blocking ancestry is uncapped)
const IMPORTANT_WEIGHT = 0.5;        // context edge weight floor to count as "important"
const SUMMARY_CLIP = 280;            // frontier nodes carry summaries (they ARE the context) — clipped

const ms = (v) => (typeof v === 'number' ? v : Date.parse(v || '') || 0);

// Keep-set of node ids forming the active frontier. Works purely off task nodes (deps/context_deps
// already merge native blockedBy + overlay edges in buildGraph); ghost refs are skipped.
function frontierKeep(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seeds = tasks.filter((t) => t.kind !== 'note' && LIVE_STATUSES.has(t.status)).map((t) => t.id);
  if (!seeds.length) {  // nothing live: the N most recently changed, so the digest is never empty
    const ts = (t) => ms(t.lastChanged || t.firstSeen || t.created_at);
    return new Set(tasks.slice().sort((a, b) => ts(b) - ts(a)).slice(0, RECENT_FALLBACK).map((t) => t.id));
  }
  const keep = new Set(seeds);
  // 1-hop neighbors in either direction (blocking + context).
  const adj = new Map();
  const link = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
  for (const t of tasks) {
    for (const dep of [...(t.deps || []), ...(t.context_deps || [])]) {
      if (String(dep).startsWith('ghost:') || !byId.has(dep)) continue;
      link(t.id, dep); link(dep, t.id);
    }
  }
  for (const s of seeds) for (const n of adj.get(s) || []) keep.add(n);
  // Ancestry walk: blocking always, context only when important, capped.
  const importantCtx = (t) => {
    const cds = (t.context_deps || []).filter((x) => !String(x).startsWith('ghost:') && byId.has(x));
    const cw = t.context_weights || {};
    const wt = (x) => (cw[x] != null ? cw[x] : 0.5);
    const top = cds.slice().sort((a, b) => wt(b) - wt(a)).slice(0, 3);
    return cds.filter((x) => wt(x) >= IMPORTANT_WEIGHT || top.includes(x));
  };
  const queue = [...keep].map((id) => [id, 0]);
  while (queue.length) {
    const [id, depth] = queue.shift();
    const t = byId.get(id);
    if (!t) continue;
    for (const dep of t.deps || [])  // blocking ancestry: always, all the way to root
      if (!String(dep).startsWith('ghost:') && byId.has(dep) && !keep.has(dep)) { keep.add(dep); queue.push([dep, depth + 1]); }
    if (depth >= CONTEXT_HOP_CAP) continue;
    for (const dep of importantCtx(t))
      if (!keep.has(dep)) { keep.add(dep); queue.push([dep, depth + 1]); }
  }
  return keep;
}

// Ids to archive: stale terminal tasks + stale superseded notes, minus anything `keep` retains.
// windowMs Infinity ⇒ archive nothing (the ?include_archived=1 escape hatch).
function archivedIds(tasks, { now = Date.now(), windowMs = DEFAULT_ARCHIVE_DAYS * 864e5, keep = null } = {}) {
  const out = new Set();
  if (!isFinite(windowMs)) return out;
  const stale = (ref) => { const t = ms(ref); return t > 0 && now - t > windowMs; };
  for (const t of tasks) {
    if (keep && keep.has(t.id)) continue;
    if (t.kind === 'note') {
      if (t.supersededBy && stale(t.validTo || t.created_at)) out.add(t.id);
    } else if (ARCHIVE_STATUSES.has(t.status) && stale(t.lastChanged || t.firstSeen)) out.add(t.id);
  }
  return out;
}

// Slim node for the frontier digest: structural fields + clipped summary (the summary is the whole
// point of including a done/note provider — it IS the Tier-1 context other agents pull).
function slimNode(t) {
  const o = { id: t.id, label: t.label, status: t.status, deps: t.deps || [], context_deps: t.context_deps || [] };
  if (t.context_weights && Object.keys(t.context_weights).length) o.context_weights = t.context_weights;
  if (t.kind) o.kind = t.kind;
  if (t.agent_id) o.assignee = t.agent_id;
  if (t.summary) o.summary = t.summary.length > SUMMARY_CLIP ? t.summary.slice(0, SUMMARY_CLIP) + '…' : t.summary;
  return o;
}

// The frontier digest payload pieces: slim kept nodes, edges/ghosts filtered to them, and the
// archived count (reported so callers know the substrate is bigger than the digest).
function projectFrontier(tasks, ghosts, edges, opts = {}) {
  const keep = frontierKeep(tasks);
  const archived = archivedIds(tasks, { ...opts, keep });
  const out = tasks.filter((t) => keep.has(t.id)).map(slimNode);
  const ids = new Set(out.map((t) => t.id));
  const keptEdges = (edges || []).filter((e) => ids.has(e.from) && ids.has(e.to));
  const ghostRefs = new Set();
  for (const t of out)
    for (const d of [...(t.deps || []), ...(t.context_deps || [])])
      if (String(d).startsWith('ghost:')) ghostRefs.add(String(d).slice('ghost:'.length));
  const keptGhosts = (ghosts || []).filter((g) => ghostRefs.has(`${g.workspace}|${g.key}`));
  return { tasks: out, ghosts: keptGhosts, edges: keptEdges, archived: archived.size };
}

module.exports = { frontierKeep, archivedIds, projectFrontier, slimNode, DEFAULT_ARCHIVE_DAYS, LIVE_STATUSES, ARCHIVE_STATUSES };
