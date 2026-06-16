'use strict';
const overlayStore = require('../lib/overlay');
const judge = require('../lib/judge');
const graphStore = require('../lib/graph-store');
const { computeNoteStats, WIN_RATE_THRESHOLD } = require('../lib/recall-outcome-journal');

const { JUDGE_DEPTH, computePressureNudge } = require('../lib/pressure-nudge');

// Stable key for the standing "harness: judge drain" task. Fixed slug so it is findable by label
// prefix across daemon restarts; the snapshot substrate keeps it in the graph indefinitely.
// Workers call start_task with this key before judging, complete_task after. Standing harness
// tasks auto-requeue to ready on complete_task so the next pass is immediately claimable; claim
// conflict is preserved because complete clears in_progress before requeue. The 10-min stale-claim
// sweep is a secondary safety net for crashed workers.
const HARNESS_JUDGE_DRAIN_KEY = 'followup/harness-judge-drain';

// Ensure the standing harness task exists idempotently in the overlay (pure mutation; caller saves).
// Uses the snapshot substrate (same as daemon-originated follow-up tasks) so buildGraph, status
// derivation, and cost attribution all work with zero special-casing. The node is marked_root
// (no unwired quarantine) via the overlay.unwired delete — it is a genuine root with no prereqs.
function ensureHarnessJudgeDrainTask(ov, save) {
  if (ov.snapshots && ov.snapshots[HARNESS_JUDGE_DRAIN_KEY]) return; // already present
  overlayStore.setSnapshot(ov, HARNESS_JUDGE_DRAIN_KEY, {
    subject: 'harness: judge drain',
    description: 'Standing recurrent task claimed by each judge-drain background subagent. ' +
      'Token attribution for judge self-maintenance work flows to this node (HARNESS bucket).',
    status: 'pending',
    blockedBy: [],
    owner: null,
    metadata: { harness: true, created_by: 'daemon:judge-route' },
  });
  // Remove from unwired quarantine — this is a genuine root (no prerequisites).
  if (ov.unwired) delete ov.unwired[HARNESS_JUDGE_DRAIN_KEY];
  save();
}

const makeRoute = (ctx) => async (p, m, req, res, u, body) => {
  const { send, readBody, notifyChange, buildGraph, state, targetOverlay,
    noteRagCandidates } = ctx;

  // PROMOTION QUEUE: autowire context edges are seeded at weight 0 (retrieval-invisible). An `edge`
  // item here is an unjudged autowire edge awaiting confirmation; a keepEdge verdict PROMOTES it
  // (judged:true + a real weight off the preserved recall `score`) so it re-enters ranked retrieval,
  // while pruneEdge deletes it. Until judged, the edge contributes ZERO relevance.
  if (p === '/judge/next') {
    const cfg = state.overlay.config.judge || {};
    const defBudget = Number(cfg.budgetPerRun) || 20;
    const budget = Math.max(1, Math.min(parseInt(u.searchParams.get('budget') || String(defBudget), 10) || defBudget, 50));
    const g = buildGraph(state.workspace);
    const byId = new Map(g.tasks.map((t) => [t.id, t]));
    const detail = (key) => { const t = byId.get(key); return t ? { key, title: t.label, summary: String(t.summary || '').slice(0, 200), kind: t.kind || 'task', status: t.status } : { key, title: key, summary: '', missing: true }; };
    // EAGER MODE (task C): ?node=<key> serves THIS node's whole unjudged candidate edge-set in ONE
    // slice (no cursor, no priority/orphan mixing) so an eager dispatch judges the freshly-wired node
    // immediately. The mark is cleared here — the node has been handed to a judge; if some edges go
    // unjudged this pass they remain on the global queue (periodic fallback) and re-mark only on a
    // fresh node-add. Falls through to the normal cursor-walked queue when ?node is absent.
    const eagerNode = u.searchParams.get('node');
    if (eagerNode) {
      const nodeItems = judge.buildQueueForNode(state.overlay, eagerNode);
      if (overlayStore.clearEagerJudge(state.overlay, eagerNode)) {
        overlayStore.clearEagerJudgeLease(state.overlay, eagerNode); // release dispatch lease (task 27)
        overlayStore.save(state.workspace, state.overlay);
      }
      const nbAdj = judge.buildContextAdjacency(state.overlay);
      const isNK = (k) => typeof k === 'string' && k.startsWith('note:');
      const nodeOfE = (key) => {
        if (isNK(key)) { const n = state.overlay.note_nodes[key.replace(/^note:/, '')]; return n ? { title: n.title, summary: String(n.summary || '').slice(0, 200) } : { title: key, summary: '' }; }
        const t = byId.get(key); return t ? { title: t.label, summary: String(t.summary || '').slice(0, 200) } : { title: key, summary: '' };
      };
      const eagerItems = nodeItems.slice(0, budget).map((it) => {
        const neighborhood = judge.expandNeighborhood(state.overlay, it.to, nodeOfE, { adjacency: nbAdj });
        const supersedeChain = judge.supersedeChain(state.overlay, it.to);
        const taskTask = !isNK(it.from) && !isNK(it.to);
        return { kind: 'edge', id: it.id, from: detail(it.from), to: detail(it.to), neighborhood: neighborhood.nodes, neighborhoodTruncated: neighborhood.truncated, supersedeChain, taskTask };
      });
      send(res, 200, { epoch: state.overlay.epoch || 0, budget, node: eagerNode, eager: true, idle: eagerItems.length === 0, total: nodeItems.length, items: eagerItems }); return true;
    }
    const queue = judge.buildQueue(state.overlay);
    const slice = judge.nextSlice(queue, state.overlay.judgeCursor || 0, budget);
    // Unified node resolver for the structural neighborhood walk: a key may be a note ('note:<id>')
    // or a task (graph id). The DAEMON only assembles + serves this context; the agent reasons.
    const nodeOf = (key) => {
      if (typeof key === 'string' && key.startsWith('note:')) {
        const n = state.overlay.note_nodes[key.replace(/^note:/, '')];
        return n ? { title: n.title, summary: String(n.summary || '').slice(0, 200) } : { title: key, summary: '' };
      }
      const t = byId.get(key);
      return t ? { title: t.label, summary: String(t.summary || '').slice(0, 200) } : { title: key, summary: '' };
    };
    const isNoteKey = (k) => typeof k === 'string' && k.startsWith('note:');
    // Reuse ONE adjacency build across all edge items in this slice (positive-weight context edges).
    const nbAdjacency = judge.buildContextAdjacency(state.overlay);
    const items = slice.items.map((it) => {
      if (it.kind === 'edge') {
        // The candidate edge is anchor(from) → N(to). Adjudicate N WITH structure: expand N's
        // weighted neighborhood + its supersede chain so the agent reasons over context, not the
        // endpoint alone. task→task candidates additionally carry kind/dup classification flags.
        const neighborhood = judge.expandNeighborhood(state.overlay, it.to, nodeOf, { adjacency: nbAdjacency });
        const supersedeChain = judge.supersedeChain(state.overlay, it.to);
        const taskTask = !isNoteKey(it.from) && !isNoteKey(it.to);
        return {
          kind: 'edge', id: it.id, from: detail(it.from), to: detail(it.to),
          neighborhood: neighborhood.nodes, neighborhoodTruncated: neighborhood.truncated,
          supersedeChain, taskTask,
        };
      }
      if (it.kind === 'dup-cluster') {
        const notes = it.keys.map((k) => {
          const n = state.overlay.note_nodes[String(k).replace(/^note:/, '')];
          return n ? { key: k, title: n.title, summary: String(n.summary || '').slice(0, 300), created_at: n.created_at || null } : { key: k, title: k, summary: '', created_at: null, missing: true };
        });
        return { kind: 'dup-cluster', id: it.id, keys: it.keys, notes, pending_dup: !!it.pending_dup };
      }
      if (it.kind === 'decay') {
        const noteId = String(it.noteId || it.id).replace(/^note:/, '');
        const n = state.overlay.note_nodes[noteId];
        return {
          kind: 'decay',
          id: it.id,
          noteId: it.noteId,
          note: n ? { key: it.noteId, title: n.title, summary: String(n.summary || '').slice(0, 300), validFrom: n.validFrom || null } : { key: it.noteId, title: it.id, summary: '' },
          winRate: it.winRate,
          total: it.total,
          action: it.action,
        };
      }
      const note = byId.get(it.id) || { id: it.id, label: it.id, summary: '', vec: null };
      const candidates = noteRagCandidates(state.overlay, g, it.id, note.label, note.summary, note.vec, 8)
        .map((c) => ({ key: c.key, title: c.title, summary: c.summary, score: c.score, status: c.status, via: c.via }));
      return { kind: 'orphan', id: it.id, note: detail(it.id), candidates };
    });
    if (!slice.idle && slice.cursorAfter !== (state.overlay.judgeCursor || 0)) {
      state.overlay.judgeCursor = slice.cursorAfter;
      overlayStore.save(state.workspace, state.overlay);
    }
    send(res, 200, {
      epoch: state.overlay.epoch || 0,
      budget, idle: slice.idle, total: slice.total,
      cursorBefore: slice.cursorBefore, cursorAfter: slice.cursorAfter,
      items,
    }); return true;
  }

  if (p === '/judge/verdict' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    const verdicts = Array.isArray(b.verdicts) ? b.verdicts : (b.createEdge || b.keepEdge || b.pruneEdge || b.consolidate || b.surfaceCluster || b.markJudged || b.item ? [b] : []);
    const epoch = T.ov.epoch || 0;
    if (!T.ov.judgedAtEpoch) T.ov.judgedAtEpoch = {};
    if (!T.ov.judgedClusters) T.ov.judgedClusters = {};
    const applied = { created: 0, kept: 0, pruned: 0, surfaced: 0, judged: 0, consolidated: 0, superseded: 0, repointed: 0, clustersJudged: 0 };
    const byId = new Map(buildGraph(T.ws).tasks.map(function(t){return [t.id,t];}));
    // The edge's creation cosine lives in `score` (autowire seeds it there with weight 0); fall back to
    // `weight` for hand-asserted edges. Read it BEFORE a prune deletes the edge, else it's gone.
    const edgeCosine = (e) => (e && typeof e.score === 'number') ? e.score : (e && typeof e.weight === 'number' ? e.weight : null);
    // Origin of the edge being judged — what lets keepRateByBand isolate the threshold-gated
    // (autowire-lexical) population from hand-asserted note->task edges. Prefer the stamped tag; for
    // tag-less PRE-EXISTING edges (created before origin stamping) INFER from by + endpoints as a
    // LEGACY FALLBACK: by:'autowire' + note source ⇒ semantic; by:'autowire' + both endpoints tasks ⇒
    // lexical; otherwise asserted. A node id starting 'note:' marks a note endpoint.
    const isNote = (id) => typeof id === 'string' && id.startsWith('note:');
    const edgeOrigin = (e) => {
      if (e && typeof e.origin === 'string') return e.origin;
      if (e && e.by === 'autowire') return isNote(e.from) ? 'autowire-semantic' : 'autowire-lexical';
      return 'asserted';
    };
    const findEdge = (from, to, kind) => T.ov.edges.find((x) => x.from === from && x.to === to && (kind == null || x.kind === kind));
    for (const v of verdicts) {
      if (v && v.createEdge && v.createEdge.from && v.createEdge.to) {
        const before = T.ov.edges.length;
        overlayStore.addEdge(T.ov, v.createEdge.from, v.createEdge.to, null, 'context', v.createEdge.weight);
        const e = T.ov.edges.find((x) => x.from === v.createEdge.from && x.to === v.createEdge.to && x.kind === 'context');
        if (e) { e.judged = true; e.by = 'judge'; }
        if (T.ov.edges.length > before || e) applied.created++;
      }
      if (v && v.keepEdge && v.keepEdge.from && v.keepEdge.to) {
        const kept = findEdge(v.keepEdge.from, v.keepEdge.to, 'context');
        const cos = edgeCosine(kept);
        const origin = edgeOrigin(kept);
        // keepEdge() only promotes (and returns truthy for) a weight-0 / judged===false autowire edge.
        // A LEGACY already-judged edge (judged===true, weight>0) flagged for rejudge returns falsy —
        // so we must ALSO enter this block when the edge is currently rejudge-flagged, to clear the
        // flag + journal the keep. Compute that flag first (sig = from>>to; see overlay.markForRejudge).
        const rejudgeSig = v.keepEdge.from + '>>' + v.keepEdge.to;
        const wasRejudgeFlagged = !!(T.ov.edgeRejudge && T.ov.edgeRejudge[rejudgeSig]);
        const promoted = judge.keepEdge(T.ov, v.keepEdge.from, v.keepEdge.to);
        if (promoted || (wasRejudgeFlagged && kept)) {
          overlayStore.clearEdgeRejudge(T.ov, v.keepEdge.from, v.keepEdge.to);
          applied.kept++;
          // task→task KIND classification: the agent decided "anchor REQUIRES N" → reclassify the
          // kept context edge as a true blocking prerequisite (the dual of context = non-blocking).
          if (v.keepEdge.kind === 'blocking' && kept) {
            kept.kind = 'blocking';
            delete kept.weight;            // blocking edges carry no relevance weight
            applied.reclassified = (applied.reclassified || 0) + 1;
          }
          judge.appendVerdict(T.ws, { epoch, verdict: 'keep', from: v.keepEdge.from, to: v.keepEdge.to, edgeKind: v.keepEdge.kind === 'blocking' ? 'blocking' : 'context', cosine: cos, origin, by: 'judge' });
        }
      }
      if (v && v.pruneEdge && v.pruneEdge.from && v.pruneEdge.to) {
        // Read the cosine BEFORE removeEdge — once the edge is deleted its creation score is gone.
        const doomed = findEdge(v.pruneEdge.from, v.pruneEdge.to, v.pruneEdge.kind || 'context');
        const cos = edgeCosine(doomed);
        const origin = edgeOrigin(doomed);
        const before = T.ov.edges.length;
        overlayStore.removeEdge(T.ov, v.pruneEdge.from, v.pruneEdge.to, null, v.pruneEdge.kind);
        if (T.ov.edges.length < before) {
          overlayStore.clearEdgeRejudge(T.ov, v.pruneEdge.from, v.pruneEdge.to);
          applied.pruned++;
          judge.appendVerdict(T.ws, { epoch, verdict: 'prune', from: v.pruneEdge.from, to: v.pruneEdge.to, edgeKind: v.pruneEdge.kind || 'context', cosine: cos, origin, by: 'judge' });
        }
      }
      // task→task DUPLICATE: the agent decided the anchor RE-PLANS N (anchor supersedes the older N).
      // Retire N (cancel + supersede edge) so a replan reconciles instead of leaving an orphan dup —
      // same semantics as supersede_task / the /supersede route, applied atomically with the verdict.
      if (v && v.supersedeTask && v.supersedeTask.old && v.supersedeTask.new) {
        const oldKey = v.supersedeTask.old, newKey = v.supersedeTask.new;
        if (byId.has(oldKey) && byId.has(newKey) && oldKey !== newKey) {
          const note = `superseded by ${newKey}${v.supersedeTask.reason ? ' — ' + v.supersedeTask.reason : ''}`;
          overlayStore.setStatus(T.ov, oldKey, 'canceled', note);
          const before = T.ov.edges.length;
          overlayStore.addEdge(T.ov, oldKey, newKey, null, 'supersede');
          if (T.ov.edges.length > before) applied.repointed++;   // count the supersede link
          applied.superseded++;
          judge.appendVerdict(T.ws, { epoch, verdict: 'supersede', from: oldKey, to: newKey, edgeKind: 'task', cosine: null, by: 'judge' });
        }
      }
      if (v && v.consolidate && v.consolidate.keep && Array.isArray(v.consolidate.supersede)) {
        const keep = String(v.consolidate.keep).replace(/^note:/, '');
        const supersededNow = [];
        for (const oldKey of v.consolidate.supersede) {
          const oldId = String(oldKey).replace(/^note:/, '');
          const r = overlayStore.supersedeNote(T.ov, oldId, keep, undefined, T.ws);
          if (r && r.ok) { applied.superseded++; supersededNow.push('note:' + oldId); }
        }
        const keepKey = 'note:' + keep;
        for (const e of T.ov.edges) {
          if (e.kind !== 'context') continue;
          if (supersededNow.includes(e.from)) { e.from = keepKey; applied.repointed++; }
          if (supersededNow.includes(e.to)) { e.to = keepKey; applied.repointed++; }
        }
        const seen = new Set();
        T.ov.edges = T.ov.edges.filter((e) => {
          if (e.from === e.to) return false;
          const sig = `${e.from}>>${e.to}>>${e.fromWorkspace || ''}>>${e.kind || 'blocking'}`;
          if (seen.has(sig)) return false;
          seen.add(sig); return true;
        });
        // PENDING-DUP: this verdict adjudicates the pair (CONSOLIDATE = new superseded into match;
        // SUPERSEDE = new is the keeper, match superseded). Clear provisional on keeper + every
        // superseded note so the survivor becomes recall-eligible and the pair leaves the dup-queue.
        overlayStore.clearPendingDup(T.ov, keepKey);
        for (const sk of supersededNow) overlayStore.clearPendingDup(T.ov, sk);
        judge.stampCluster(T.ov.judgedClusters, [keepKey, ...v.consolidate.supersede.map((k) => String(k).startsWith('note:') ? String(k) : 'note:' + k)], epoch);
        applied.consolidated++; applied.clustersJudged++;
        judge.appendVerdict(T.ws, { epoch, verdict: 'consolidate', from: keepKey, to: supersededNow.join(',') || null, edgeKind: 'note', cosine: null, by: 'judge' });
      }
      if (v && v.surfaceCluster && Array.isArray(v.surfaceCluster.keys) && v.surfaceCluster.keys.length) {
        const keys = v.surfaceCluster.keys.map((k) => String(k).startsWith('note:') ? String(k) : 'note:' + k);
        const settled = judge.clusterConsolidationState(T.ov, keys);
        if (settled) {
          judge.stampCluster(T.ov.judgedClusters, keys, epoch);
          applied.skippedSettled = (applied.skippedSettled || 0) + 1;
          applied.clustersJudged++;
          continue;
        }
        const notesMeta = keys.map((k) => {
          const n = T.ov.note_nodes[String(k).replace(/^note:/, '')];
          return { key: k, title: (n && n.title) || k, created_at: (n && n.created_at) || null };
        });
        overlayStore.addGuidance(T.ov, {
          question: `Ambiguous duplicate cluster (${keys.length} notes): are these the SAME fact to consolidate, or distinct? Notes: ${keys.join(', ')}`,
          context: `judge surfaced a node-dedup cluster it could not confidently consolidate. ${v.surfaceCluster.why || ''}`.slice(0, 2000),
          trigger: 'ambiguous_intent', severity: 'review',
          action: { kind: 'dup-cluster', keys, signature: judge.clusterSignature(keys), notes: notesMeta },
        });
        judge.stampCluster(T.ov.judgedClusters, keys, epoch);
        applied.surfaced++; applied.clustersJudged++;
        judge.appendVerdict(T.ws, { epoch, verdict: 'surface', from: keys[0] || null, to: keys.slice(1).join(',') || null, edgeKind: 'note', cosine: null, by: 'judge' });
      }
      if (v && v.markDistinct && Array.isArray(v.markDistinct.keys) && v.markDistinct.keys.length) {
        const keys = v.markDistinct.keys.map((k) => String(k).startsWith('note:') ? String(k) : 'note:' + k);
        overlayStore.markClusterDistinct(T.ov, keys);
        // PENDING-DUP: DISTINCT verdict — the notes are NOT the same fact. Clear provisional so a
        // pending-dup new note becomes recall-eligible (visible) again.
        for (const k of keys) overlayStore.clearPendingDup(T.ov, k);
        judge.stampCluster(T.ov.judgedClusters, keys, epoch);
        applied.stamped = (applied.stamped || 0) + 1; applied.clustersJudged++;
      }
      // retireNote: soft-retire a note that failed the decay gate (low win rate, age+opp gated).
      // Appends note_superseded with validTo set, NO supersededBy — retire-without-replacement.
      // Mirrors the retire-continuity-notes.js pattern exactly. Best-effort: skips notes that are
      // already retired (validTo != null) or not found.
      if (v && v.retireNote && v.retireNote.noteKey) {
        const rId = String(v.retireNote.noteKey).replace(/^note:/, '');
        const rNode = T.ov.note_nodes && T.ov.note_nodes[rId];
        if (rNode && rNode.validTo == null) {
          const retiredAt = new Date().toISOString();
          rNode.validTo = retiredAt;
          const store = graphStore.forWorkspace(T.ws);
          graphStore.appendEvent(store, 'note:' + rId, {
            evt: 'note_superseded',
            id: rId,
            validTo: retiredAt,
            ts: retiredAt,
            actor: 'judge:decay',
          });
          applied.retired = (applied.retired || 0) + 1;
          judge.appendVerdict(T.ws, { epoch, verdict: 'retire', from: 'note:' + rId, to: null, edgeKind: 'note', cosine: null, by: 'judge:decay' });
        }
      }
      const noteKey = v && (v.markJudged || (v.item && v.item.kind === 'orphan' ? v.item.id : null));
      if (noteKey) {
        judge.stampJudged(T.ov.judgedAtEpoch, noteKey, epoch); applied.judged++;
        judge.appendVerdict(T.ws, { epoch, verdict: 'markJudged', from: noteKey, to: null, edgeKind: 'note', cosine: null, by: 'judge' });
      }
    }
    // JUDGING→READY gate (task D): prune the wall-clock judging anchor for any node whose candidate
    // edge-set fully drained as a result of these verdicts — it has left the 'judging' phase and is
    // now ready-eligible. Stale anchors are harmless (judgingState ignores them once no unjudged edges
    // remain) but we clear them so the overlay stays tidy and the timeout never re-fires spuriously.
    for (const k of Object.keys(T.ov.judgingSince || {})) {
      if (judge.unverifiedEdgesForNode(T.ov, k).length === 0) overlayStore.clearJudgingSince(T.ov, k);
    }
    T.save(); notifyChange();
    send(res, 200, { ok: true, epoch, applied, edges: T.ov.edges.length }); return true;
  }

  // POST /judge/rejudge-edges
  // Body: { sigs: string[] }  — array of "from>>to" edge signatures.
  // Marks each listed edge for re-judgment so /judge/next resurfaces it with needs_rejudge:true.
  // Additive: only touches edges that are LEGACY KEPT (judged===true, weight>0, not asserted) and
  // exist in the overlay. Unrecognized or non-context sigs are silently skipped.
  // This endpoint is the apply mechanism for a future greenlit full re-adjudication run — do NOT
  // call it with all 1680 legacy edges until the calibration pilot (task #30) gives a GO verdict.
  if (p === '/judge/rejudge-edges' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    const sigs = Array.isArray(b.sigs) ? b.sigs : [];
    if (!sigs.length) { send(res, 400, { ok: false, error: 'sigs must be a non-empty array' }); return true; }
    // Build a lookup of context edges by "from>>to" signature for O(1) access.
    const edgeMap = new Map();
    for (const e of T.ov.edges) {
      if (e.kind !== 'context') continue;
      edgeMap.set(e.from + '>>' + e.to, e);
    }
    let marked = 0, skipped = 0;
    for (const sig of sigs) {
      if (typeof sig !== 'string') { skipped++; continue; }
      const e = edgeMap.get(sig);
      // Only mark LEGACY KEPT edges: judged===true, weight>0, not asserted.
      if (!e || e.judged !== true || typeof e.weight !== 'number' || e.weight <= 0 || e.origin === 'asserted') {
        skipped++;
        continue;
      }
      if (!T.ov.edgeRejudge) T.ov.edgeRejudge = {};
      if (!T.ov.edgeRejudge[sig]) { T.ov.edgeRejudge[sig] = true; marked++; }
      // Already-marked edges count as success (idempotent).
      else marked++;
    }
    if (marked > 0) { T.save(); notifyChange(); }
    send(res, 200, { ok: true, marked, skipped, total: sigs.length }); return true;
  }

  if (p === '/judge/pressure' && m === 'GET') {
    // Ensure the standing harness task exists before we might nudge (idempotent, cheap).
    const T = targetOverlay(null, u);
    ensureHarnessJudgeDrainTask(T.ov, () => { T.save(); notifyChange(); });
    const queue = judge.buildQueue(state.overlay);
    const depth = queue.length;
    const dupClusters = queue.filter((i) => i.kind === 'dup-cluster').length;
    const gate = computePressureNudge({
      depth,
      depthThreshold: JUDGE_DEPTH,
      buildGraph,
      ws: state.workspace,
      overlay: state.overlay,
      harnessKey: HARNESS_JUDGE_DRAIN_KEY,
      // Demote periodic catch-up to fallback: suppress while eager dispatch (task C) is keeping up.
      eagerActive: judge.eagerJudgePending(state.overlay),
    });
    send(res, 200, {
      depth, dupClusters, nudge: gate.nudge, harness_task_key: HARNESS_JUDGE_DRAIN_KEY,
      running: gate.running, capacity_ok: gate.capacity_ok, drain_in_progress: gate.drain_in_progress,
      eager_active: gate.eager_active,
    }); return true;
  }

  // GET /judge/decay-preview
  // Read-only diagnostic endpoint. Runs the same decay gate logic as buildQueue pass (4) and returns
  // which notes WOULD be soft-retired WITHOUT writing any note_superseded event.
  // Response: { candidates: [{noteId, label, winRate, wins, losses, total, ageDays, validFrom}],
  //             scanned, belowThreshold }
  if (p === '/judge/decay-preview' && m === 'GET') {
    const T = targetOverlay(null, u);
    const ws = T.ws;
    const noteNodes = T.ov.note_nodes || {};
    const noteStats = computeNoteStats(ws);
    const nowMs = Date.now();
    let scanned = 0;
    let belowThreshold = 0;
    const candidates = [];
    for (const n of Object.values(noteNodes)) {
      scanned++;
      const stat = noteStats.get('note:' + n.id);
      const check = judge.isDecayCandidate(n, stat, nowMs);
      // Count notes that have stats but fail win-rate gate (regardless of age/opportunities).
      if (stat && stat.winRate < WIN_RATE_THRESHOLD) belowThreshold++;
      if (!check.candidate) continue;
      const wins = stat ? stat.wins : 0;
      const losses = stat ? stat.losses : 0;
      candidates.push({
        noteId: 'note:' + n.id,
        label: n.title || n.id,
        winRate: check.winRate,
        wins,
        losses,
        total: check.total,
        ageDays: check.ageDays,
        validFrom: n.validFrom || null,
      });
    }
    // Stable ordering: ascending by noteId so output is deterministic
    candidates.sort((a, b) => (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0));
    send(res, 200, { candidates, scanned, belowThreshold }); return true;
  }

  return false;
};

// Deprecated test seam (hourly debounce removed — capacity gate is stateless).
makeRoute._setLastNudgeAt = () => {};
makeRoute.HARNESS_JUDGE_DRAIN_KEY = HARNESS_JUDGE_DRAIN_KEY;
makeRoute.ensureHarnessJudgeDrainTask = ensureHarnessJudgeDrainTask;

module.exports = makeRoute;
