// Frontier projection + archival sweep for GET /state. Pure functions (unit-tested) — the daemon
// route stays a thin wrapper. Two jobs:
//   1. frontierKeep: server-side twin of the dashboard's frontierSelect (public/graph.html) — live
//      seeds (ready/in_progress/failed/tested/not_ready) + BFS neighbors, gated by a hop-weight
//      formula: weight >= depth * 0.30. Blocking edges treat weight=1.0; context edges use stored
//      weight defaulting to 0.5. Natural 4-hop max (live depth 4 needs weight>=1.0 — only blocking
//      hits that; done/note depth 4 needs 1.20, so blocking tops out at 3 hops there). Returns the
//      keep-set of node ids.
//      Scope name "frontier" is deliberate: a follow-up folds get_adjacent/get_dependency_tree into
//      get_graph behind scope: "all" | "frontier" | "adjacent" | "tree".
//   2. archivedIds: stale terminal tasks (done/canceled) + superseded notes whose last activity is
//      older than the window — excluded from the default /state payload (lean-payload principle).
//      Nodes the frontier retains are NEVER archived (a done dep that is still an important context
//      provider stays). Archived nodes remain on disk and stay queryable via /search +
//      suggest_links (those read the substrate directly, not /state).
'use strict';

const { isStandingHarnessTaskKey } = require('./harness-task');

const LIVE_STATUSES = new Set(['not_ready', 'ready', 'in_progress', 'failed', 'tested']);
const ARCHIVE_STATUSES = new Set(['done', 'canceled']);
const DEFAULT_ARCHIVE_DAYS = 14;     // override per-workspace: POST /config { archive_after_days }
const RECENT_FALLBACK = 15;          // nothing live ⇒ show the N most recently changed
// Hop-weight formula: threshold = depth * 0.30 (done/note) or max(0, depth*0.30 - 0.2) (live nodes)
//   Live nodes get a 0.2 leniency bonus — they're still active work, less aggressive pruning.
//   done depth 1→0.30, 2→0.60, 3→0.90, 4→1.20 (natural max 3 hops for blocking done, 1 hop at the 0.5 context default)
//   live depth 1→0.10, 2→0.40, 3→0.70, 4→1.00 (natural max 4 hops for blocking live, 2 hops at the 0.5 context default)
// Blocking edges use weight=1.0; context edges default to 0.5 when weight absent.
const IMPORTANT_WEIGHT = 0.5;        // midpoint of the formula scale; kept for reference
const SUMMARY_CLIP = 280;            // frontier nodes carry summaries (they ARE the context) — clipped

const ms = (v) => (typeof v === 'number' ? v : Date.parse(v || '') || 0);

// Keep-set of node ids forming the active frontier. Works purely off task nodes (deps/context_deps
// already merge native blockedBy + overlay edges in buildGraph); ghost refs are skipped.
// Formula: a node at hop depth D is kept if its edge weight >= D * 0.30.
// Blocking edges: weight=1.0. Context edges: stored weight, default 0.5.
// Seeds (depth 0) always kept. Natural cap: live depth 4 requires weight>=1.0 (only blocking
// reaches it); done/note depth 4 requires 1.20, unreachable — blocking stops at depth 3 there.
function frontierKeep(tasks) {
  const visibleTasks = tasks.filter((t) => !isStandingHarnessTaskKey(t.id));
  const byId = new Map(visibleTasks.map((t) => [t.id, t]));
  const seeds = visibleTasks.filter((t) => t.kind !== 'note' && LIVE_STATUSES.has(t.status)).map((t) => t.id);
  if (!seeds.length) {
    const ts = (t) => ms(t.lastChanged || t.firstSeen || t.created_at);
    return new Set(visibleTasks.slice().sort((a, b) => ts(b) - ts(a)).slice(0, RECENT_FALLBACK).map((t) => t.id));
  }

  const keep = new Set(seeds);
  // BFS: [nodeId, depth]
  // Seeds start at depth 0. Each hop increments depth and checks weight >= depth * 0.30.
  const queue = seeds.map((id) => [id, 0]);
  const visited = new Set(seeds);

  while (queue.length) {
    const [id, depth] = queue.shift();
    const t = byId.get(id);
    if (!t) continue;

    const nextDepth = depth + 1;
    const baseThreshold = nextDepth * 0.30;
    const cw = t.context_weights || {};
    // Live nodes (not_ready/ready/in_progress) get a 0.2 leniency bonus: threshold = max(0, depth*0.30 - 0.2)
    const thresholdFor = (dep) => {
      const n = byId.get(dep);
      return n && LIVE_STATUSES.has(n.status) ? Math.max(0, baseThreshold - 0.2) : baseThreshold;
    };

    // Blocking deps: weight = 1.0 (satisfies threshold as long as nextDepth <= 3 for done, <= 4 for live)
    for (const dep of t.deps || []) {
      if (String(dep).startsWith('ghost:') || !byId.has(dep) || visited.has(dep)) continue;
      if (1.0 >= thresholdFor(dep)) { keep.add(dep); visited.add(dep); queue.push([dep, nextDepth]); }
    }

    // Context deps: use stored weight, default 0.5
    for (const dep of t.context_deps || []) {
      if (String(dep).startsWith('ghost:') || !byId.has(dep) || visited.has(dep)) continue;
      const wt = cw[dep] != null ? cw[dep] : 0.5;
      if (wt >= thresholdFor(dep)) { keep.add(dep); visited.add(dep); queue.push([dep, nextDepth]); }
    }

    // Reverse direction at depth 0: live nodes that depend on a seed are also kept.
    // O(n) per seed — acceptable for typical graph sizes.
    if (depth === 0) {
      for (const other of visibleTasks) {
        if (visited.has(other.id)) continue;
        if ([...(other.deps || []), ...(other.context_deps || [])].includes(id)) {
          if (LIVE_STATUSES.has(other.status)) { keep.add(other.id); visited.add(other.id); queue.push([other.id, 1]); }
        }
      }
    }
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

// Minimal projection for server-archived tasks (GET /state archived_tasks): id/label/status only,
// plus kind and last activity timestamp when present — no deps/summary/heavy fields.
function archivedSlimNode(t) {
  if (!t) return null;
  const o = { id: t.id, label: t.label, status: t.status };
  if (t.kind) o.kind = t.kind;
  const lc = t.lastChanged || t.validTo || t.firstSeen;
  if (lc) o.lastChanged = lc;
  return o;
}

function archivedTaskList(tasks, archIds) {
  if (!archIds || !archIds.size) return [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return [...archIds].map((id) => archivedSlimNode(byId.get(id))).filter(Boolean);
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

module.exports = { frontierKeep, archivedIds, archivedSlimNode, archivedTaskList, projectFrontier, slimNode, DEFAULT_ARCHIVE_DAYS, LIVE_STATUSES, ARCHIVE_STATUSES };
