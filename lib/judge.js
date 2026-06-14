// Judge queue substrate — the DUMB half of the RAG-candidate → agent-adjudicator pipeline.
//
// The principle: the daemon must NOT decide whether a similarity edge is a real DAG edge. It only
//   (a) keeps a deterministic, persistent QUEUE of work items the judge agent should reason about,
//   (b) advances a persistent CURSOR through that queue under a per-run BUDGET (incremental — never
//       re-walks the whole graph in one tick; accumulates across ticks), and
//   (c) idles when nothing is left to judge until the EPOCH grows (a new note/task arrived).
// All REASONING (keep/prune/create/surface) lives in the agent loop (PHASE 2); this file is pure
// bookkeeping so it unit-tests without daemon state or HTTP.
//
// EPOCH: a monotonic counter bumped whenever a note/task node is added. Per-note `judgedAtEpoch`
//   (absent/0 = never judged) records the epoch at which a note was last adjudicated. A note is
//   re-pullable only when judgedAtEpoch < epoch — so a 'no edge' verdict (which stamps judgedAtEpoch
//   = epoch) keeps the note OUT of the queue until the graph actually changes.
//
// WORK ITEM kinds:
//   - 'orphan'  : an under-connected/never-recently-judged NOTE → the judge attaches RAG candidates.
//                 Identity = the note key ('note:<id>').
//   - 'edge'    : an UNVERIFIED blind similarity edge ({judged:false}) → keep-or-prune.
//                 Identity = `${from}>>${to}`.
//   - 'dup-cluster' : a set of CURRENT notes whose pairwise embeddings cluster above a cosine RECALL
//                 threshold → the judge confirms "same fact" and consolidates (supersede non-canonical
//                 into a keeper) or surfaces the ambiguous remainder. Identity = a stable signature of
//                 the cluster's sorted note keys; watermarked in overlay.judgedClusters by that
//                 signature + epoch so a confirmed cluster isn't re-judged until its notes change.
'use strict';
const fs = require('fs');
const path = require('path');
const { cosine } = require('./embed');

// Append ONE verdict row to the durable judge journal (.graph/judge-journal.jsonl), mirroring the
// append-only style of .graph/gate-journal.jsonl. This is ADDITIVE logging only — it never changes
// what is kept/pruned; it just records the verdict so keep-rate-by-cosine is recoverable. A PRUNE
// deletes the edge, so callers MUST read the edge's cosine and pass it here BEFORE the edge is removed
// (once gone it's unrecoverable). `cosine` is the edge's creation score (autowire: the seeded
// score/weight); null for note/cluster verdicts that carry no single edge cosine. Journal failure must
// never break a verdict apply — the write is best-effort and swallows errors.
function appendVerdict(ws, row) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      epoch: row.epoch ?? null,
      verdict: row.verdict,                 // keep | prune | markJudged | consolidate | surface
      from: row.from ?? null,
      to: row.to ?? null,
      edgeKind: row.edgeKind ?? null,
      cosine: typeof row.cosine === 'number' ? row.cosine : null,
      origin: row.origin ?? null,           // how the edge was created: autowire-lexical | autowire-semantic | asserted (null for note/cluster verdicts)
      by: row.by ?? null,
    });
    fs.appendFileSync(path.join(ws, '.graph', 'judge-journal.jsonl'), line + '\n');
  } catch { /* journal failure must not break the verdict apply */ }
}

// A context edge is "blind/unverified" iff it was tagged judged:false by the autowire migration and
// not since re-judged. We never touch blocking/supersede/structural edges or hand-asserted ones.
function isUnverifiedEdge(e) {
  return !!e && e.kind === 'context' && e.judged === false;
}

// Was this context edge written by the blind note-provider autowire pass? Signature: a CONTEXT edge
// whose `from` is a note node (autowireNoteProvider always makes the note the provider/`from`).
// That covers the ~178 note->note plus the note->task blind edges. task->task autowire edges and any
// hand-asserted context edges are intentionally OUT of scope (the prompt's demotion target is the
// note-provider similarity pass). Used ONCE at boot to stamp judged:false on legacy edges.
function isBlindNoteProviderEdge(e) {
  return !!e && e.kind === 'context' && typeof e.from === 'string' && e.from.startsWith('note:');
}

// One-time migration: tag every blind note-provider context edge as UNVERIFIED so the judge can
// re-adjudicate it. Idempotent — an edge already carrying a `judged` flag is left alone (so a verdict
// that pruned/kept it earlier is never re-stamped). Returns the count newly tagged.
function tagBlindEdges(overlay) {
  let tagged = 0;
  for (const e of overlay.edges) {
    if (!isBlindNoteProviderEdge(e)) continue;
    if ('judged' in e) continue;              // already adjudicated or tagged
    e.judged = false;
    e.by = 'autowire';
    tagged++;
  }
  return tagged;
}

// Is a note UNDER-CONNECTED? It has ZERO outgoing context edges (it provides context to nothing) —
// the orphan/under-wired case the judge should look at for RAG candidates. We look at OUTGOING only
// because autowireNoteProvider made notes PROVIDERS (note -> neighbor); a note with no outgoing
// context edge is sitting idle. Pure over the edge list.
function noteIsUnderConnected(overlay, noteKey) {
  for (const e of overlay.edges) {
    if (e.kind === 'context' && e.from === noteKey) return false;
  }
  return true;
}

// Build the FULL ordered work queue (deterministic — stable sort by identity) the cursor walks.
// Three buckets in priority order, each stably sorted so the cursor advances predictably and a
// restart resumes at the same position:
//   - dup-clusters FIRST: a duplicate cluster degrades EVERY future retrieval (measured: clones
//                 depressed a winner note from 0.787 → 0.480 cosine recall). Fixing it is high
//                 leverage; each item carries the member keys for the agent.
//   - edges  : UNVERIFIED context edges next, ordered by `${from}>>${to}`. An unverified autowire
//                 edge was created at a deliberately loose 0.25 threshold; mis-wiring is cheap.
//   - orphans: every CURRENT (validTo==null) note that is under-connected AND not yet judged at the
//              current epoch (judgedAtEpoch < epoch), ordered by note id.
// `epoch` and `judgedAtEpoch` come from the overlay (judgedAtEpoch is a per-note-key map). Pure.
// NOTE: judgeQueueDepth() mirrors membership exactly — ordering changes here must not affect which
// items are members, only their position.
function buildQueue(overlay) {
  const epoch = overlay.epoch || 0;
  const judgedAt = overlay.judgedAtEpoch || {};
  // (1) duplicate-note clusters not yet judged this epoch — HIGHEST PRIORITY.
  // dupClusters already returns clusters in a stable (signature) order.
  const clusterItems = [];
  for (const keys of dupClusters(overlay)) {
    if (!clusterPending(overlay, keys)) continue;
    clusterItems.push({ kind: 'dup-cluster', id: clusterSignature(keys), keys });
  }
  // (2) unverified edges
  const edgeItems = [];
  for (const e of overlay.edges) {
    if (!isUnverifiedEdge(e)) continue;
    edgeItems.push({ kind: 'edge', id: `${e.from}>>${e.to}`, from: e.from, to: e.to });
  }
  edgeItems.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // (3) orphan / under-connected notes not yet judged this epoch
  const noteItems = [];
  for (const n of Object.values(overlay.note_nodes || {})) {
    if (n.validTo != null) continue;                       // current notes only
    const key = 'note:' + n.id;
    if ((judgedAt[key] || 0) >= epoch) continue;           // already judged at/after current epoch
    if (!noteIsUnderConnected(overlay, key)) continue;     // already provides context to something
    noteItems.push({ kind: 'orphan', id: key, note: n.id });
  }
  noteItems.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...clusterItems, ...edgeItems, ...noteItems];
}

// Count PENDING judge work WITHOUT advancing the cursor — a pure read for the heartbeat idle-fill
// decision (daemon decideAll). Mirrors buildQueue's membership exactly so the count never disagrees
// with what the cursor would actually walk: every UNVERIFIED context edge PLUS every current,
// under-connected note not yet judged at the current epoch (judgedAtEpoch < epoch). `g` is accepted
// for callsite symmetry with buildQueue's neighbors but unused here — membership is overlay-only.
function judgeQueueDepth(overlay, g) {
  const epoch = overlay.epoch || 0;
  const judgedAt = overlay.judgedAtEpoch || {};
  let depth = 0;
  for (const e of overlay.edges) {
    if (isUnverifiedEdge(e)) depth++;
  }
  for (const n of Object.values(overlay.note_nodes || {})) {
    if (n.validTo != null) continue;                       // current notes only
    const key = 'note:' + n.id;
    if ((judgedAt[key] || 0) >= epoch) continue;           // already judged at/after current epoch
    if (!noteIsUnderConnected(overlay, key)) continue;     // already provides context to something
    depth++;
  }
  // unjudged dup-clusters (each is ONE work item)
  for (const keys of dupClusters(overlay)) {
    if (clusterPending(overlay, keys)) depth++;
  }
  return depth;
}

// Take up to `budget` items from the queue with PRIORITY-FIRST semantics.
//
// The queue is split into two logical halves:
//   - PRIORITY items: dup-cluster items (kind === 'dup-cluster'). They are few (cap 8 per cluster
//     build) but degrade every retrieval; every slice serves ALL pending priority items first.
//   - TAIL items: edges + orphans, walked in order with a persistent cursor so we make steady
//     incremental progress across many runs.
//
// Slice contract:
//   - Serve every priority item (up to budget cap).
//   - Fill remaining budget slots (budget - priority.length, clamped >= 0) from the tail starting
//     at the persisted cursor, wrapping if the cursor is stale (>= tail length).
//   - cursorBefore / cursorAfter refer ONLY to positions in the TAIL.  Priority items never
//     consume cursor positions.
//   - total = queue.length (all items, both kinds) — unchanged for external consumers.
//   - idle ⇒ BOTH the priority list AND the tail are empty; cursor resets to 0.
//
// Returns { items, cursorBefore, cursorAfter, total, idle }.
// PURE on (queue, cursor, budget) — the daemon persists cursorAfter.
function nextSlice(queue, cursor, budget) {
  const total = queue.length;
  if (total === 0) return { items: [], cursorBefore: cursor || 0, cursorAfter: 0, total: 0, idle: true };

  const b = Math.max(0, Math.floor(budget) || 0);

  // Split into priority (dup-clusters) and tail (everything else).
  const priority = queue.filter((it) => it.kind === 'dup-cluster');
  const tail     = queue.filter((it) => it.kind !== 'dup-cluster');

  if (priority.length === 0 && tail.length === 0) {
    return { items: [], cursorBefore: cursor || 0, cursorAfter: 0, total: 0, idle: true };
  }

  // Normalise the cursor against the current tail length.
  let tailStart = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  if (tail.length > 0 && tailStart >= tail.length) tailStart = 0; // wrap stale cursor
  if (tail.length === 0) tailStart = 0;

  // Priority items — served unconditionally up to budget.
  const priorityTake = Math.min(priority.length, b);
  const priorityItems = priority.slice(0, priorityTake);

  // Remaining budget fills from the tail.
  const remainingBudget = Math.max(0, b - priorityTake);
  const tailTake = tail.length > 0 ? Math.min(remainingBudget, tail.length) : 0;
  const tailItems = [];
  for (let i = 0; i < tailTake; i++) tailItems.push(tail[(tailStart + i) % tail.length]);

  // Advance the tail cursor (wraps around the tail, not the full queue).
  const cursorAfter = tail.length === 0 ? 0 : (tailStart + tailTake) % tail.length;

  const items = [...priorityItems, ...tailItems];
  const idle = items.length === 0; // only possible if b===0 AND queue was non-empty (edge case)

  return { items, cursorBefore: cursor || 0, cursorAfter, total, idle: false };
}

// Apply a single verdict's effect on a NOTE's judged watermark: stamp judgedAtEpoch[noteKey] = epoch
// so a 'no edge' (or any) decision keeps the note out of the queue until epoch grows. Pure mutation
// on the map; noteKey may be null (an edge-only verdict that touches no note watermark). Returns map.
function stampJudged(judgedAtEpoch, noteKey, epoch) {
  if (noteKey) judgedAtEpoch[noteKey] = epoch;
  return judgedAtEpoch;
}

// Promoted weight for a kept edge when no recall score was preserved on it. Autowire edges seed
// weight 0 (retrieval-invisible) and carry the recall cosine in `score`; a keep-verdict PROMOTES the
// edge to a real weight so it re-enters ranked retrieval. /judge/next is therefore a PROMOTION queue.
const PROMOTED_EDGE_WEIGHT = 0.5;

// Mark a specific unverified edge as KEPT — the agent affirmed it meets the context bar. PROMOTION:
// set judged:true AND lift the weight off 0 (seed from the preserved recall `score`, else a fixed
// default) so the edge becomes retrieval-VISIBLE. Idempotent. Returns true if an edge matched.
function keepEdge(overlay, from, to) {
  let changed = false;
  for (const e of overlay.edges) {
    if (e.from === from && e.to === to && e.kind === 'context' && e.judged === false) {
      e.judged = true; e.by = 'judge';
      e.weight = (typeof e.score === 'number' && e.score > 0) ? e.score : PROMOTED_EDGE_WEIGHT;
      changed = true;
    }
  }
  return changed;
}

// ---- duplicate-note clustering (NODE adjudication) ---------------------------------------------
// PURE: over CURRENT notes (validTo==null) that carry a vec, union-find every pair whose cosine
// similarity is >= `threshold` into clusters, return clusters of size >= 2 as arrays of note KEYS
// ('note:<id>'). This is the RECALL half — deliberately loose (a high-recall, lower-precision bar);
// the AGENT supplies precision (confirm same-fact / split false-positive merges). `threshold` defaults
// to DUP_RECALL_THRESHOLD. A `cap` (default 8) bounds any single cluster so a pathological low-threshold
// run can't surface one unactionable blob — when a connected component exceeds `cap` it is emitted as
// the `cap` mutually-highest-similarity members (each note kept by its single strongest in-component
// edge), so the agent always gets tractable clusters. Notes/order are stable (sorted by key) so the
// derived signature is deterministic across runs and restarts. Returns array<array<noteKey>>.
const DUP_RECALL_THRESHOLD = 0.80;
function dupClusters(overlay, threshold = DUP_RECALL_THRESHOLD, cap = 8) {
  const notes = Object.values(overlay.note_nodes || {})
    .filter((n) => n.validTo == null && Array.isArray(n.vec) && n.vec.length)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const N = notes.length;
  // union-find over the index space
  const parent = notes.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const uni = (a, b) => { parent[find(a)] = find(b); };
  // best in-component similarity per node (for the cap trim) — node -> {peer, sim}
  const best = notes.map(() => ({ peer: -1, sim: -1 }));
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const s = cosine(notes[i].vec, notes[j].vec);
      if (s >= threshold) {
        uni(i, j);
        if (s > best[i].sim) best[i] = { peer: j, sim: s };
        if (s > best[j].sim) best[j] = { peer: i, sim: s };
      }
    }
  }
  const comps = new Map();
  for (let i = 0; i < N; i++) { const r = find(i); (comps.get(r) || comps.set(r, []).get(r)).push(i); }
  const out = [];
  for (const members of comps.values()) {
    if (members.length < 2) continue;
    let idxs = members;
    if (members.length > cap) {
      // Trim to the `cap` members with the strongest single in-component tie (keeps the densest core,
      // never an arbitrary slice). Ties broken by id order (members are already id-sorted).
      idxs = members.slice().sort((a, b) => best[b].sim - best[a].sim).slice(0, cap);
    }
    out.push(idxs.map((i) => 'note:' + notes[i].id).sort());
  }
  // Drop any cluster the user definitively marked DISTINCT ("don't ask again"): a permanent skip keyed
  // by the exact member-set signature (overlay.distinctClusters). Membership change → new signature →
  // re-surfaceable, which is correct (a genuinely different set is a different question).
  const distinct = overlay.distinctClusters || {};
  const filtered = Object.keys(distinct).length ? out.filter((keys) => !distinct[clusterSignature(keys)]) : out;
  // Stable order: by first key so the queue position is deterministic.
  filtered.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return filtered;
}

// Stable signature of a cluster = its sorted note keys joined. Two runs that recall the SAME member set
// produce the SAME signature, so a judged cluster is recognizable across ticks/restarts even though the
// daemon recomputes clusters live. If the cluster's membership changes (a note added/superseded), the
// signature changes and it becomes re-judgeable. Pure.
function clusterSignature(keys) {
  return keys.slice().sort().join('|');
}

// Is this dup-cluster still pending (not yet judged at the CURRENT epoch)? Watermark store is
// overlay.judgedClusters: signature -> epoch at which it was last adjudicated. Pending iff the stored
// epoch is below the current epoch (or absent). Pure read.
function clusterPending(overlay, keys) {
  const sig = clusterSignature(keys);
  const judged = overlay.judgedClusters || {};
  return (judged[sig] || 0) < (overlay.epoch || 0);
}

// Stamp a cluster judged at the current epoch so it isn't re-offered until its membership (signature)
// changes or the epoch grows. Pure mutation on the map; returns it.
function stampCluster(judgedClusters, keys, epoch) {
  judgedClusters[clusterSignature(keys)] = epoch;
  return judgedClusters;
}

function noteNodeId(key) {
  return String(key).replace(/^note:/, '');
}

// Dup-cluster already settled via supersede chain or only one current member — no user question needed.
function clusterConsolidationState(overlay, keys) {
  const nn = overlay.note_nodes || {};
  const ids = (Array.isArray(keys) ? keys : []).map(noteNodeId).filter(Boolean);
  if (ids.length < 2) return null;
  const nodes = ids.map((id) => ({ id, n: nn[id] })).filter((x) => x.n);
  if (nodes.length < 2) return null;
  const current = nodes.filter((x) => x.n.validTo == null);
  if (current.length === 1) {
    return { keeper: 'note:' + current[0].id, reason: 'single current member' };
  }
  for (const { id, n } of nodes) {
    if (n.supersedes && ids.includes(noteNodeId(n.supersedes))) {
      return { keeper: 'note:' + id, reason: 'explicit supersedes link' };
    }
  }
  for (const { id, n } of nodes) {
    if (n.supersededBy && ids.includes(noteNodeId(n.supersededBy))) {
      return { keeper: 'note:' + noteNodeId(n.supersededBy), reason: 'explicit supersededBy link' };
    }
  }
  return null;
}

// Auto-close dup-cluster guidance when consolidation already happened (supersede chain present).
function resolveSettledClusterGuidance(overlay) {
  const resolved = [];
  if (!Array.isArray(overlay.guidance)) return resolved;
  if (!overlay.judgedClusters) overlay.judgedClusters = {};
  const epoch = overlay.epoch || 0;
  for (const g of overlay.guidance) {
    if (g.resolved || !g.action || g.action.kind !== 'dup-cluster') continue;
    const state = clusterConsolidationState(overlay, g.action.keys || []);
    if (!state) continue;
    g.resolved = true;
    g.resolvedAt = new Date().toISOString();
    g.answer = `auto: already consolidated (${state.reason}; keeper ${state.keeper})`;
    stampCluster(overlay.judgedClusters, g.action.keys, epoch);
    resolved.push(g.id);
  }
  return resolved;
}

module.exports = {
  isUnverifiedEdge, isBlindNoteProviderEdge, tagBlindEdges, noteIsUnderConnected,
  buildQueue, judgeQueueDepth, nextSlice, stampJudged, keepEdge, appendVerdict,
  dupClusters, clusterSignature, clusterPending, stampCluster, clusterConsolidationState,
  resolveSettledClusterGuidance, DUP_RECALL_THRESHOLD,
};
