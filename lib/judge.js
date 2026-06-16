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
const {
  computeNoteStats,
  MIN_AGE_DAYS,
  MIN_OPPORTUNITIES,
  WIN_RATE_THRESHOLD,
} = require('./recall-outcome-journal');

// Lazy loader for the learned edge classifier (scripts/edge-clf-predict.js).
// Returns null if the module is absent or fails to load — best-effort only.
let _clf = null;
function getClf() {
  if (_clf !== null) return _clf;
  try { _clf = require('../scripts/edge-clf-predict'); } catch { _clf = undefined; }
  return _clf || null;
}

// Derive shadow verdict from the learned classifier for a journal row.
// Maps journal row fields (cosine, note_a_kind, note_b_kind, etc.) to the classifier's
// feature names. Returns {} if the classifier is unavailable or throws.
function shadowFields(row) {
  const clf = getClf();
  if (!clf) return {};
  try {
    // Infer node kinds from the `from`/`to` keys: keys starting with 'note:' are note nodes,
    // others are tasks. The journal doesn't store kind directly, so we derive it.
    const kindOf = (key) => (typeof key === 'string' && key.startsWith('note:') ? 'note' : 'task');
    const result = clf.predict({
      cosine_sim: typeof row.cosine === 'number' ? row.cosine : 0,
      note_a_kind: row.note_a_kind ?? kindOf(row.from),
      note_b_kind: row.note_b_kind ?? kindOf(row.to),
      task_complexity: row.complexity ?? 0.5,
      dag_depth_a: row.dag_depth_a ?? 0,
      dag_depth_b: row.dag_depth_b ?? 0,
    });
    return {
      shadow_verdict: result.verdict,
      shadow_conf: result.conf,
      model_version: 'v1-provisional',
    };
  } catch { return {}; }
}

// Append ONE verdict row to the durable judge journal (.graph/judge-journal.jsonl), mirroring the
// append-only style of .graph/gate-journal.jsonl. This is ADDITIVE logging only — it never changes
// what is kept/pruned; it just records the verdict so keep-rate-by-cosine is recoverable. A PRUNE
// deletes the edge, so callers MUST read the edge's cosine and pass it here BEFORE the edge is removed
// (once gone it's unrecoverable). `cosine` is the edge's creation score (autowire: the seeded
// score/weight); null for note/cluster verdicts that carry no single edge cosine. Journal failure must
// never break a verdict apply — the write is best-effort and swallows errors.
//
// Schema v2 optional fields (all absent on legacy rows — readers must treat missing as null/undefined):
//   shadow_verdict  (string)  — learned-model verdict ("keep"|"prune") BEFORE enforcement; training signal.
//   shadow_conf     (number)  — learned-model confidence 0.0–1.0 paired with shadow_verdict.
//   model_version   (string)  — identifier of the model that produced shadow_verdict, e.g. "sonnet-4-6".
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
      ...shadowFields(row),                 // shadow_verdict, shadow_conf, model_version (best-effort)
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

// ---- Decay candidate gate (named helper for buildQueue + preview endpoint) ----------------------
// Tests whether a single note node meets ALL decay gates. Returns
//   { candidate: true,  winRate, total, ageDays }  — note passes all gates
//   { candidate: false }                            — at least one gate failed
//
// Gates (all must be true):
//   a) node.note and node.validFrom present    — fully-formed note (not a phantom)
//   b) !node.validTo                           — note is still current (not already soft-retired)
//   c) age >= MIN_AGE_DAYS                     — note has had time to accumulate signal
//   d) stat.total >= MIN_OPPORTUNITIES         — enough task resolutions have occurred
//   e) stat.winRate < WIN_RATE_THRESHOLD       — note correlates with failures more than successes
//
// `node` is a note_nodes entry (plain object from the overlay); `noteStats` is the Map entry from
// computeNoteStats (may be null/undefined); `now` is Date.now() in ms (injected for testability).
// PURE — no I/O, no side effects.
function isDecayCandidate(node, noteStats, now) {
  if (!node) return { candidate: false };
  // Gate (a): fully-formed note — created_by and validFrom must be present
  if (!node.created_by || !node.validFrom) return { candidate: false };
  // Gate (b): not already soft-retired
  if (node.validTo != null) return { candidate: false };
  // Gate (c): age check
  const validFromMs = Date.parse(node.validFrom);
  const MIN_AGE_MS = MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
  if (Number.isNaN(validFromMs) || (now - validFromMs) < MIN_AGE_MS) return { candidate: false };
  // Gate (d): opportunity count
  if (!noteStats || noteStats.total < MIN_OPPORTUNITIES) return { candidate: false };
  // Gate (e): win-rate threshold (strict <)
  if (noteStats.winRate >= WIN_RATE_THRESHOLD) return { candidate: false };
  const ageDays = (now - validFromMs) / (24 * 60 * 60 * 1000);
  return { candidate: true, winRate: noteStats.winRate, total: noteStats.total, ageDays };
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
  // dupClusters already returns clusters in a stable (signature) order. Merge in pending-dup pairs
  // (write-time guard fires, 0.70–0.80 band that never forms a natural 0.80 cluster) by signature so a
  // pair surfaced by BOTH sources is one item. Marking pending_dup:true lets the verdict handler know
  // to clear the provisional state on adjudication.
  const clusterItems = [];
  const clusterSeen = new Set();
  for (const keys of dupClusters(overlay)) {
    if (!clusterPending(overlay, keys)) continue;
    const sig = clusterSignature(keys);
    clusterSeen.add(sig);
    clusterItems.push({ kind: 'dup-cluster', id: sig, keys });
  }
  for (const keys of pendingDupClusters(overlay)) {
    if (!clusterPending(overlay, keys)) continue;
    const sig = clusterSignature(keys);
    if (clusterSeen.has(sig)) continue;
    clusterSeen.add(sig);
    clusterItems.push({ kind: 'dup-cluster', id: sig, keys, pending_dup: true });
  }
  // (2) unverified edges (weight=0, judged:false) + edges flagged for re-judgment
  const edgeRejudge = overlay.edgeRejudge || {};
  const edgeItems = [];
  const edgeSeen = new Set();
  for (const e of overlay.edges) {
    const sig = e.from + '>>' + e.to;
    const needsRejudge = !!edgeRejudge[sig];
    if (!isUnverifiedEdge(e) && !needsRejudge) continue;
    if (edgeSeen.has(sig)) continue;
    edgeSeen.add(sig);
    edgeItems.push({ kind: 'edge', id: sig, from: e.from, to: e.to, needs_rejudge: needsRejudge });
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

  // (4) decay slow lane — age-gated, opportunity-gated, low-win-rate notes → soft-retire candidates.
  // This is a SLOW LANE: only notes that have been around long enough and have enough resolution data
  // are considered. Gates (all must be true):
  //   a) note.created_by && note.valid_from   — a fully-formed note node (not a phantom)
  //   b) !node.validTo                         — note is still current (not already soft-retired)
  //   c) age >= MIN_AGE_DAYS                   — note has had time to accumulate signal
  //   d) total >= MIN_OPPORTUNITIES            — enough task resolutions have occurred
  //   e) winRate < WIN_RATE_THRESHOLD          — note correlates with failures more than successes
  // Workspace is inferred from overlay.workspace (populated by the daemon when it builds the overlay).
  const decayItems = [];
  const ws = overlay.workspace || null;
  if (ws) {
    const noteStats = computeNoteStats(ws);
    const nowMs = Date.now();
    for (const n of Object.values(overlay.note_nodes || {})) {
      const noteKey = 'note:' + n.id;
      const stat = noteStats.get(noteKey);
      const check = isDecayCandidate(n, stat, nowMs);
      if (!check.candidate) continue;
      decayItems.push({
        kind: 'decay',
        id: noteKey,
        noteId: noteKey,
        reason: 'decay',
        action: 'retire',
        winRate: check.winRate,
        total: check.total,
      });
    }
    decayItems.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  return [...clusterItems, ...edgeItems, ...noteItems, ...decayItems];
}

// Count PENDING judge work WITHOUT advancing the cursor — a pure read for the heartbeat idle-fill
// decision (daemon decideAll). Mirrors buildQueue's membership exactly so the count never disagrees
// with what the cursor would actually walk: every UNVERIFIED context edge PLUS every current,
// under-connected note not yet judged at the current epoch (judgedAtEpoch < epoch). `g` is accepted
// for callsite symmetry with buildQueue's neighbors but unused here — membership is overlay-only.
function judgeQueueDepth(overlay, g) {
  const epoch = overlay.epoch || 0;
  const judgedAt = overlay.judgedAtEpoch || {};
  const edgeRejudge = overlay.edgeRejudge || {};
  const seenEdges = new Set();
  let depth = 0;
  for (const e of overlay.edges) {
    const sig = e.from + '>>' + e.to;
    const needsRejudge = !!edgeRejudge[sig];
    if (!isUnverifiedEdge(e) && !needsRejudge) continue;
    if (seenEdges.has(sig)) continue;
    seenEdges.add(sig);
    depth++;
  }
  // also count edgeRejudge sigs not present in overlay.edges (edge may have been promoted but marked)
  for (const sig of Object.keys(edgeRejudge)) {
    if (edgeRejudge[sig] && !seenEdges.has(sig)) depth++;
  }
  for (const n of Object.values(overlay.note_nodes || {})) {
    if (n.validTo != null) continue;                       // current notes only
    const key = 'note:' + n.id;
    if ((judgedAt[key] || 0) >= epoch) continue;           // already judged at/after current epoch
    if (!noteIsUnderConnected(overlay, key)) continue;     // already provides context to something
    depth++;
  }
  // unjudged dup-clusters (each is ONE work item) — natural recall clusters + pending-dup pairs,
  // deduped by signature so a pair surfaced by both is counted once (mirrors buildQueue).
  const clusterSigs = new Set();
  for (const keys of dupClusters(overlay)) {
    if (clusterPending(overlay, keys)) clusterSigs.add(clusterSignature(keys));
  }
  for (const keys of pendingDupClusters(overlay)) {
    if (clusterPending(overlay, keys)) clusterSigs.add(clusterSignature(keys));
  }
  depth += clusterSigs.size;
  return depth;
}

// ---- EAGER judge dispatch (task C) --------------------------------------------------------------
// On node-add, the autowire seed callsites mark the new node in overlay.eagerJudge (via
// overlay.markEagerJudge). EAGER judgment dispatches a judge for THAT node's unjudged candidate
// edge-set IMMEDIATELY rather than waiting for the periodic depth-driven drain. The daemon stays
// DUMB: these are PURE reads; the orchestration layer reads eagerJudgeNodes() and dispatches one
// judge per node (each node-scoped via /judge/next?node=<key>).

// Every UNVERIFIED context edge incident to `nodeKey` (either endpoint). This is the node's whole
// eager edge-set — ONE dispatch covers all of it, never one dispatch per edge. Pure read.
function unverifiedEdgesForNode(overlay, nodeKey) {
  const out = [];
  for (const e of (overlay.edges || [])) {
    if (!isUnverifiedEdge(e)) continue;
    if (e.from === nodeKey || e.to === nodeKey) out.push(e);
  }
  return out;
}

// The nodes pending EAGER judgment, in FIFO-ish order (oldest mark first). SELF-CLEANING: a marked
// node whose candidate edges are ALL now judged (drained by an earlier dispatch) is dropped from the
// signal in-place — so a node never re-dispatches once its edge-set is resolved. Pure on the edge
// set; MUTATES overlay.eagerJudge only to prune resolved marks (caller persists). Returns string[].
function eagerJudgeNodes(overlay) {
  const marks = overlay.eagerJudge || {};
  const keys = Object.keys(marks);
  if (!keys.length) return [];
  // Oldest epoch-stamp first; stable by key for equal stamps so ordering is deterministic.
  keys.sort((a, b) => (marks[a] - marks[b]) || (a < b ? -1 : a > b ? 1 : 0));
  const now = Date.now();
  const leases = overlay.eagerJudgeLease || {};
  const pending = [];
  for (const k of keys) {
    if (unverifiedEdgesForNode(overlay, k).length === 0) { delete marks[k]; continue; } // drained
    const lease = leases[k];
    if (lease && lease.leaseExpiry > now) continue; // leased
    pending.push(k);
  }
  return pending;
}

// PURE read (no prune): does the eager dispatch (task C) have any node still actively pending — a
// marked node whose candidate edge-set is not yet fully judged? When true, eager is keeping up and
// the periodic prompt-driven catch-up nudge stays demoted to fallback (see computePressureNudge's
// eagerActive gate). Distinct from eagerJudgeNodes(), which MUTATES to prune; this never writes.
function eagerJudgePending(overlay) {
  const marks = (overlay && overlay.eagerJudge) || {};
  for (const k of Object.keys(marks)) {
    if (unverifiedEdgesForNode(overlay, k).length > 0) return true;
  }
  return false;
}

// Node-scoped judge queue: the eager dispatch judges ONE node's whole unjudged edge-set in a single
// effort. Returns edge items (same shape as buildQueue's edge items) for every unverified context
// edge incident to `nodeKey`, stably ordered. dup-clusters/orphans are global concerns and excluded
// here — eager dispatch is about the freshly-wired node's candidate edges. Pure.
function buildQueueForNode(overlay, nodeKey) {
  const items = unverifiedEdgesForNode(overlay, nodeKey)
    .map((e) => ({ kind: 'edge', id: `${e.from}>>${e.to}`, from: e.from, to: e.to }));
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return items;
}

// ---- JUDGING→READY gate (task D) ----------------------------------------------------------------
// A task is in the 'judging' lifecycle phase while it still carries unjudged autowire candidate edges
// (the weight-0 judged:false edges seeded by whole-graph recall on node-add, by:'autowire'). Such a
// task must NOT be claimable yet — its inherited context is provisional until the judge keeps/prunes
// those edges (eager path C is the happy case). To prevent a permanent DEADLOCK if the judge stalls
// (no judge running, crash, perpetual error), the gate FALLS BACK to ready once the edges have sat
// unjudged past a timeout, with the surviving unjudged edges FLAGGED (provisional) rather than
// silently trusted. Wall-clock anchor: overlay.judgingSince[nodeKey] (ms), stamped when the node's
// candidate set is seeded (overlay.markEagerJudge) and cleared when the set drains.
const JUDGING_TIMEOUT_MS = 10 * 60 * 1000;   // conservative default: 10 minutes

// Effective judging-timeout (ms): overlay.config.judge.timeoutMs, else env JUDGE_TIMEOUT_MS, else default.
function judgingTimeoutMs(overlay) {
  const c = (overlay && overlay.config && overlay.config.judge) || {};
  if (typeof c.timeoutMs === 'number' && isFinite(c.timeoutMs) && c.timeoutMs > 0) return c.timeoutMs;
  const env = Number(process.env.JUDGE_TIMEOUT_MS);
  if (isFinite(env) && env > 0) return env;
  return JUDGING_TIMEOUT_MS;
}

// HARD CEILING (deadlock backstop, FU-2): an absolute upper bound on the judging phase, measured from
// the task's STABLE firstSeen (overlay.timestamps[key].firstSeen — set once, never overwritten) rather
// than the re-stampable judgingSince anchor. The soft judgingSince clock is reset to "now" whenever a
// node's edge-set briefly drains then re-seeds (autowire churn) OR a concurrent stale overlay save
// loses the anchor — either keeps the soft timeout perpetually fresh and deadlocks the task. The hard
// ceiling is immune to both: firstSeen never moves, so a task ALWAYS falls back to provisional-ready
// within the ceiling no matter how its edges churn. Precedence: config.judge.hardCeilingMs > env
// JUDGE_HARD_CEILING_MS > default.
const JUDGING_HARD_CEILING_MS = 30 * 60 * 1000;   // 30 min: a backstop, not the primary timeout (10 min soft)

function judgingHardCeilingMs(overlay) {
  const c = (overlay && overlay.config && overlay.config.judge) || {};
  if (typeof c.hardCeilingMs === 'number' && isFinite(c.hardCeilingMs) && c.hardCeilingMs > 0) return c.hardCeilingMs;
  const env = Number(process.env.JUDGE_HARD_CEILING_MS);
  if (isFinite(env) && env > 0) return env;
  return JUDGING_HARD_CEILING_MS;
}

// Classify a node's judging state. PURE. Returns:
//   { judging:false } — no outstanding unjudged autowire edges (or none ever); fully ready-eligible.
//   { judging:true,  timedOut:false } — still being judged within the timeout; NOT ready, NOT claimable.
//   { judging:true,  timedOut:true  } — unjudged past the timeout; FALLS BACK to ready, but PROVISIONAL
//                                       (surviving unjudged edges flagged so consumers know context is
//                                       not yet adjudicated). Never a permanent block.
// nowMs/timeoutMs are injected for testability; callers pass Date.now() / judgingTimeoutMs(overlay).
function judgingState(overlay, nodeKey, nowMs, timeoutMs, hardCeilingMs) {
  if (unverifiedEdgesForNode(overlay, nodeKey).length === 0) return { judging: false, timedOut: false };
  const since = (overlay.judgingSince && overlay.judgingSince[nodeKey]) || 0;
  // SOFT window: measured from the (re-stampable) judgingSince anchor.
  // No anchor (pre-feature edges) → treat as already timed-out so we never deadlock on un-anchored work.
  const softTimedOut = !since || (nowMs - since) >= timeoutMs;
  // HARD CEILING (FU-2 deadlock backstop): measured from the task's STABLE firstSeen, immune to the
  // judgingSince drain→reseed reset cycle (and to overlay-save races). Skipped when hardCeilingMs is
  // absent (back-compat: old 4-arg callers/tests stay soft-only) or no firstSeen is recorded.
  let hardTimedOut = false;
  const tsRec = overlay.timestamps && overlay.timestamps[nodeKey];
  if (hardCeilingMs && tsRec && tsRec.firstSeen) {
    const firstSeenMs = Date.parse(tsRec.firstSeen);
    if (!Number.isNaN(firstSeenMs)) hardTimedOut = (nowMs - firstSeenMs) >= hardCeilingMs;
  }
  return { judging: true, timedOut: softTimedOut || hardTimedOut };
}

// ---- PENDING-DUP defer-to-judge (write-time dup guard) ------------------------------------------
// A note admitted PROVISIONAL on a write-time dup-guard fire (cosine >= DUP_THRESHOLD vs a current
// note) lives in overlay.pendingDup: { noteKey -> { match, score, at } }. Two PURE derivations:
//
//   pendingDupState — visibility classification, mirrors judgingState EXACTLY: while unjudged within
//     the timeout the note is RETRIEVAL-INVISIBLE; once (now - at) >= timeoutMs it FALLS BACK to
//     visible (provisional) as a PURE derived flip. The pendingDup ENTRY is NEVER mutated on timeout —
//     it stays so the dup-judge still adjudicates it later (still enqueued via pendingDupClusters).
//     Only an actual verdict (overlay.clearPendingDup) removes the entry.
//   pendingDupClusters — the {new, match} pairs to surface to the dup-judge as dup-cluster work items,
//     INDEPENDENT of the 0.80 dupClusters() recall threshold (a 0.70–0.80 pair never forms a natural
//     cluster, so it must be surfaced explicitly here or it would never be judged).
//
// nowMs/timeoutMs are injected for testability; callers pass Date.now() / judgingTimeoutMs(overlay).
function pendingDupState(overlay, noteKey, nowMs, timeoutMs) {
  const entry = overlay.pendingDup && overlay.pendingDup[noteKey];
  if (!entry) return { pending: false, timedOut: false, visible: true };
  const at = (typeof entry.at === 'number' && entry.at > 0) ? entry.at : 0;
  // No anchor (pre-feature entry) → treat as timed-out so we never keep a note invisible forever.
  const timedOut = !at || (nowMs - at) >= timeoutMs;
  return { pending: true, timedOut, visible: timedOut };
}

// The pending-dup pairs to adjudicate, as dup-cluster keysets [matchKey, newKey] (sorted for a stable
// signature), one per pending entry whose member notes both still exist + are current. PURE read. A
// TIMED-OUT entry is STILL returned here (timeout never drops it from the queue), satisfying the
// lifecycle invariant: pending_dup(invisible,queued) -> [timeout] provisional(visible, STILL queued).
function pendingDupClusters(overlay) {
  const pd = overlay.pendingDup || {};
  const nn = overlay.note_nodes || {};
  const out = [];
  for (const [noteKey, entry] of Object.entries(pd)) {
    if (!entry || !entry.match) continue;
    const newId = String(noteKey).replace(/^note:/, '');
    const matchId = String(entry.match).replace(/^note:/, '');
    const newN = nn[newId], matchN = nn[matchId];
    // Both members must still exist + be current (a superseded member means the pair is moot).
    if (!newN || !matchN || newN.validTo != null || matchN.validTo != null) continue;
    out.push([noteKey, entry.match].sort());
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
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

// ---- neighborhood expansion (STRUCTURAL context for edge adjudication) --------------------------
// The daemon stays DUMB: it ASSEMBLES and SERVES N's surrounding context so the judge AGENT can
// reason over the candidate edge WITH structure, not the endpoint node alone. The assembly is a
// relevance-decayed best-first walk OVER JUDGED CONTEXT-EDGE WEIGHTS — strong chains reach deeper,
// diffuse neighborhoods stop ~1 hop. This is NOT fixed-hop.
//
//   relevance(node @ depth d) = product(edge weights along the path) × decay^d
//
// We visit highest-relevance first and STOP when relevance < threshold OR a node/char budget is hit.
// Only CONTEXT edges with a POSITIVE weight are traversed: unpromoted autowire edges sit at weight 0
// (retrieval-invisible) and must not pull in unjudged neighbors — the judge promotes them first. Both
// edge directions are followed (a structural neighbor connected either way is context for N).
//
// PURE on (overlay, startKey, opts). `nodeOf(key)` resolves a key to { title, summary } for both
// note nodes (overlay.note_nodes) and tasks (caller supplies a task lookup); a key with no resolver
// hit is still traversable (it just contributes the key as its own label). Returns
//   { nodes: [{ key, depth, relevance, title, summary, via }], truncated, visited }
// ordered by descending relevance (the start node is NOT included — it's the candidate endpoint).
const DEFAULT_CONTEXT_WEIGHT = 0.5; // fallback edge weight (mirrors overlay.js)
const NB_DECAY = 0.6;        // per-hop relevance multiplier (conservative — diffuse stops ~1 hop)
const NB_THRESHOLD = 0.15;   // stop expanding below this relevance
const NB_MAX_NODES = 12;     // hard node-count cap (latency + payload bound)
const NB_MAX_CHARS = 4000;   // hard char budget across included title+summary text

function neighborhoodConfig(overlay) {
  const c = (overlay && overlay.config && overlay.config.judge && overlay.config.judge.neighborhood) || {};
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const env = (k, d) => { const v = Number(process.env[k]); return isFinite(v) && v > 0 ? v : d; };
  return {
    decay:     num(c.decay,     env('JUDGE_NB_DECAY',     NB_DECAY)),
    threshold: num(c.threshold, env('JUDGE_NB_THRESHOLD', NB_THRESHOLD)),
    maxNodes:  num(c.maxNodes,  env('JUDGE_NB_MAX_NODES',  NB_MAX_NODES)),
    maxChars:  num(c.maxChars,  env('JUDGE_NB_MAX_CHARS',  NB_MAX_CHARS)),
  };
}

// Build a from->[{to,weight}] + to->[{from,weight}] adjacency over POSITIVE-weight context edges only.
function buildContextAdjacency(overlay) {
  const out = new Map();   // key -> [{ key, weight, dir }]
  const push = (a, b, w, dir) => {
    if (!out.has(a)) out.set(a, []);
    out.get(a).push({ key: b, weight: w, dir });
  };
  for (const e of overlay.edges || []) {
    if (e.kind !== 'context') continue;
    const w = typeof e.weight === 'number' ? e.weight : DEFAULT_CONTEXT_WEIGHT;
    if (!(w > 0)) continue;                 // weight-0 (unpromoted) edges are not traversed
    const cw = Math.max(0, Math.min(1, w));
    push(e.from, e.to, cw, 'out');
    push(e.to, e.from, cw, 'in');
  }
  return out;
}

function expandNeighborhood(overlay, startKey, nodeOf, opts = {}) {
  const cfg = { ...neighborhoodConfig(overlay), ...opts };
  const adj = opts.adjacency || buildContextAdjacency(overlay);
  // Best-relevance-first frontier. Small N (budget-capped) ⇒ linear scan beats a heap.
  const start = { key: startKey, depth: 0, relevance: 1 };
  const frontier = [start];
  const bestRel = new Map([[startKey, 1]]);   // best relevance at which we've reached a node
  const out = [];
  let chars = 0;
  let truncated = false;
  let visited = 0;
  while (frontier.length) {
    // pop the highest-relevance frontier node
    let bi = 0;
    for (let i = 1; i < frontier.length; i++) if (frontier[i].relevance > frontier[bi].relevance) bi = i;
    const cur = frontier.splice(bi, 1)[0];
    if (cur.relevance < bestRel.get(cur.key)) continue;   // a better path already processed this node
    if (cur.key !== startKey) {
      visited++;
      const meta = (nodeOf && nodeOf(cur.key)) || { title: cur.key, summary: '' };
      const title = String(meta.title || cur.key);
      const summary = String(meta.summary || '');
      // char budget: stop INCLUDING once exceeded (but the walk already capped by node count below)
      if (chars + title.length + summary.length > cfg.maxChars && out.length) { truncated = true; break; }
      chars += title.length + summary.length;
      out.push({ key: cur.key, depth: cur.depth, relevance: cur.relevance, title, summary, via: cur.via });
      if (out.length >= cfg.maxNodes) { truncated = (frontier.length > 0); break; }
    }
    // expand neighbors
    for (const nb of adj.get(cur.key) || []) {
      const rel = cur.relevance * nb.weight * cfg.decay;
      if (rel < cfg.threshold) continue;                  // decayed below the relevance floor — prune
      const prev = bestRel.get(nb.key);
      if (prev != null && prev >= rel) continue;          // already reachable at >= relevance
      bestRel.set(nb.key, rel);
      frontier.push({ key: nb.key, depth: cur.depth + 1, relevance: rel, via: nb.dir });
    }
  }
  out.sort((a, b) => b.relevance - a.relevance);
  return { nodes: out, truncated, visited };
}

// TEMPORAL: the full supersede chain N belongs to (oldest→newest), each entry the note's
// {key, title, summary, validFrom, validTo, current}. Linear + bounded by the substrate, so include
// it fully. Excludes N itself. Returns [] for tasks or notes with no chain. Pure over note_nodes.
function supersedeChain(overlay, startKey) {
  const nn = overlay.note_nodes || {};
  const id = String(startKey).replace(/^note:/, '');
  if (!nn[id]) return [];
  // walk back to the root, then forward (mirrors overlay.noteChain but self-contained + pure here).
  let root = id; const seen = new Set();
  while (nn[root] && nn[root].supersedes && !seen.has(root)) { seen.add(root); root = nn[root].supersedes; }
  const chain = []; const fwd = new Set(); let cur = root;
  while (nn[cur] && !fwd.has(cur)) { fwd.add(cur); chain.push(cur); cur = nn[cur].supersededBy; }
  return chain
    .filter((cid) => cid !== id)
    .map((cid) => {
      const n = nn[cid];
      return {
        key: 'note:' + cid,
        title: n.title || cid,
        summary: String(n.summary || '').slice(0, 300),
        validFrom: n.validFrom || null,
        validTo: n.validTo || null,
        current: n.validTo == null,
      };
    });
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
  unverifiedEdgesForNode, eagerJudgeNodes, eagerJudgePending, buildQueueForNode,
  judgingState, judgingTimeoutMs, JUDGING_TIMEOUT_MS, judgingHardCeilingMs, JUDGING_HARD_CEILING_MS,
  pendingDupState, pendingDupClusters,
  dupClusters, clusterSignature, clusterPending, stampCluster, clusterConsolidationState,
  resolveSettledClusterGuidance, DUP_RECALL_THRESHOLD,
  expandNeighborhood, buildContextAdjacency, supersedeChain, neighborhoodConfig,
  isDecayCandidate,
  // decay slow lane — constants re-exported from recall-outcome-journal for consumer symmetry
  MIN_AGE_DAYS, MIN_OPPORTUNITIES, WIN_RATE_THRESHOLD,
};
