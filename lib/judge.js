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
'use strict';

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
// Two buckets, edges first then orphan notes, each in a stable order so the cursor advances
// predictably and a restart resumes at the same position.
//   - edges  : every UNVERIFIED context edge, ordered by `${from}>>${to}`.
//   - orphans: every CURRENT (validTo==null) note that is under-connected AND not yet judged at the
//              current epoch (judgedAtEpoch < epoch), ordered by note id.
// `epoch` and `judgedAtEpoch` come from the overlay (judgedAtEpoch is a per-note-key map). Pure.
function buildQueue(overlay) {
  const epoch = overlay.epoch || 0;
  const judgedAt = overlay.judgedAtEpoch || {};
  const items = [];
  // (1) unverified edges
  const edgeItems = [];
  for (const e of overlay.edges) {
    if (!isUnverifiedEdge(e)) continue;
    edgeItems.push({ kind: 'edge', id: `${e.from}>>${e.to}`, from: e.from, to: e.to });
  }
  edgeItems.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // (2) orphan / under-connected notes not yet judged this epoch
  const noteItems = [];
  for (const n of Object.values(overlay.note_nodes || {})) {
    if (n.validTo != null) continue;                       // current notes only
    const key = 'note:' + n.id;
    if ((judgedAt[key] || 0) >= epoch) continue;           // already judged at/after current epoch
    if (!noteIsUnderConnected(overlay, key)) continue;     // already provides context to something
    noteItems.push({ kind: 'orphan', id: key, note: n.id });
  }
  noteItems.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...edgeItems, ...noteItems];
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
  return depth;
}

// Take up to `budget` items starting at the persisted cursor, advancing + WRAPPING it. Returns
// { items, cursorBefore, cursorAfter, total, idle }. `idle` ⇒ the queue is empty (nothing to judge
// until epoch grows / new unverified edges appear); cursor is reset to 0 and no items are returned.
// Wrapping: if the cursor sits past the end (queue shrank as items were judged), it wraps to 0 so we
// never strand the tail. We never return the SAME item twice in one call (budget is capped at total).
// PURE on (queue, cursor, budget) — the daemon persists cursorAfter.
function nextSlice(queue, cursor, budget) {
  const total = queue.length;
  if (total === 0) return { items: [], cursorBefore: cursor, cursorAfter: 0, total: 0, idle: true };
  const b = Math.max(0, Math.floor(budget) || 0);
  let start = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  if (start >= total) start = 0;                            // wrap a stale cursor past a shrunken queue
  const take = Math.min(b, total);                         // never re-emit within one call
  const items = [];
  for (let i = 0; i < take; i++) items.push(queue[(start + i) % total]);
  const cursorAfter = total === 0 ? 0 : (start + take) % total;
  return { items, cursorBefore: cursor || 0, cursorAfter, total, idle: false };
}

// Apply a single verdict's effect on a NOTE's judged watermark: stamp judgedAtEpoch[noteKey] = epoch
// so a 'no edge' (or any) decision keeps the note out of the queue until epoch grows. Pure mutation
// on the map; noteKey may be null (an edge-only verdict that touches no note watermark). Returns map.
function stampJudged(judgedAtEpoch, noteKey, epoch) {
  if (noteKey) judgedAtEpoch[noteKey] = epoch;
  return judgedAtEpoch;
}

// Mark a specific unverified edge as KEPT (judged:true) — the agent affirmed it meets the context bar.
// Idempotent. Returns true if an edge matched and flipped.
function keepEdge(overlay, from, to) {
  let changed = false;
  for (const e of overlay.edges) {
    if (e.from === from && e.to === to && e.kind === 'context' && e.judged === false) {
      e.judged = true; e.by = 'judge'; changed = true;
    }
  }
  return changed;
}

module.exports = {
  isUnverifiedEdge, isBlindNoteProviderEdge, tagBlindEdges, noteIsUnderConnected,
  buildQueue, judgeQueueDepth, nextSlice, stampJudged, keepEdge,
};
