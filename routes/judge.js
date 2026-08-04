'use strict';
const overlayStore = require('../lib/overlay');
const judge = require('../lib/judge');
const headlessDrain = require('../lib/headless-drain');
const { applyStructuredContextCompression } = require('../lib/search/context-compression');
const graphStore = require('../lib/graph-store');
const { computeNoteUsageEvidence, scoreNoteNecessity, WIN_RATE_THRESHOLD } = require('../lib/recall-outcome-journal');
const { nodeVecs, embeddingMeta } = require('../lib/embed');

const { JUDGE_DEPTH, computePressureNudge } = require('../lib/pressure-nudge');
const { appendShadow } = require('../lib/shadow-journal');
const { checkAndPromote } = require('../lib/promotion-gate');

// Lazy-load the learned edge classifier. Returns null when the model file is absent
// or the module fails to load — best-effort only, never breaks the verdict path.
let _predictEdge = null;
function getPredictEdge() {
  if (_predictEdge !== null) return _predictEdge;
  try {
    _predictEdge = require('../scripts/predict-edge-classifier').predictEdge;
  } catch { _predictEdge = undefined; }
  return _predictEdge || null;
}

// Task-decision action -> lifecycle EVENT. The single place an advertised action becomes a real
// transition; anything absent here is refused (and NOT retired) instead of silently falling through.
// Actions are normalized to snake_case lowercase before lookup.
const TASK_DECISION_EVENTS = Object.freeze({
  approve: 'review_approve',
  kick_back: 'review_kick_back',
  reject: 'review_kick_back',
  merge: 'review_merge_request',
  discard: 'review_discard',
  cancel: 'review_cancel',
  escalate: 'review_escalate',
});

// Promotion state cache: null = unchecked; refresh at most every 60s.
let _promotionState = null;
let _promotionAt = 0;
function getPromotion(ws) {
  const now = Date.now();
  if (_promotionState !== null && now - _promotionAt < 60000) return _promotionState;
  try {
    _promotionState = checkAndPromote(ws);
  } catch { _promotionState = { promoted: false }; }
  _promotionAt = now;
  return _promotionState;
}

// Compute the learned-model prediction for an edge. Returns { label, score, shadowVerdict } or null.
// Best-effort: returns null when model is absent or on any error.
function computePrediction(ws, { cosine, fromKind, toKind }) {
  try {
    const predictEdge = getPredictEdge();
    if (!predictEdge) return null;
    const features = {
      cosine_score: typeof cosine === 'number' ? cosine : 0,
      from_kind: fromKind || 'task',
      to_kind: toKind || 'task',
      neighborhood_size: 0,
      neighborhood_avg_relevance: 0,
      supersede_chain_len: 0,
      task_task: false,
    };
    const { score, label } = predictEdge(features, ws);
    return { label, score, shadowVerdict: label === 1 ? 'keep' : 'prune', cosineUsed: features.cosine_score };
  } catch { return null; }
}

// Append a shadow journal row. Best-effort: wrapped in try/catch.
// When promoted, the model verdict IS primary, so roles are swapped in the journal:
// verdict = what model decided, shadow_verdict = what Sonnet decided.
function appendShadowRow(ws, { from, to, verdict, shadowVerdict, score, cosineUsed, promoted }) {
  try {
    appendShadow(ws, {
      ts: Date.now(),
      from,
      to,
      verdict: promoted ? shadowVerdict : verdict,
      shadow_verdict: promoted ? verdict : shadowVerdict,
      shadow_conf: score,
      cosine: cosineUsed,
      model_version: 'v1',
    });
  } catch { /* best-effort */ }
}

// Score an edge with the learned classifier and append a shadow row.
// Best-effort: wrapped in try/catch — a missing model file must never break a verdict.
// Only called for keepEdge / pruneEdge verdicts (the binary-verdict cases).
// Returns the model's verdict string ('keep' | 'prune') when promoted, null otherwise.
function scoreShadow(ws, { from, to, verdict, cosine, fromKind, toKind }) {
  try {
    const pred = computePrediction(ws, { cosine, fromKind, toKind });
    if (!pred) return null;
    const promotion = getPromotion(ws);
    appendShadowRow(ws, {
      from, to, verdict,
      shadowVerdict: pred.shadowVerdict,
      score: pred.score,
      cosineUsed: pred.cosineUsed,
      promoted: promotion.promoted,
    });
    return promotion.promoted ? pred.shadowVerdict : null;
  } catch { return null; }
}

// Compute the max pairwise cosine similarity among a set of note keys, using their stored vectors.
// Returns null if fewer than 2 vectors are available or on any error.
function clusterMaxCosine(overlay, keys) {
  try {
    const judgeLib = require('../lib/judge');
    const expectedMeta = embeddingMeta(overlay);
    const vecs = keys.map(k => {
      const n = overlay.note_nodes && overlay.note_nodes[String(k).replace(/^note:/, '')];
      return nodeVecs(n, { expectedMeta })[0] || null;
    }).filter(Boolean);
    if (vecs.length < 2) return null;
    let max = -1;
    for (let i = 0; i < vecs.length; i++)
      for (let j = i + 1; j < vecs.length; j++) {
        const s = judgeLib.cosine(vecs[i], vecs[j]);
        if (s > max) max = s;
      }
    return max >= 0 ? max : null;
  } catch { return null; }
}

// Stable key for the standing "harness: judge drain" task. Fixed slug so it is findable by label
// prefix across daemon restarts; the snapshot substrate keeps it in the graph indefinitely.
// Workers accept a Subconscious assignment with this key before judging, then complete it after.
// Standing harness tasks auto-requeue to ready on completion so the next pass is immediately claimable; claim
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
    noteRagCandidates, filedrop } = ctx;

  // PROMOTION QUEUE: autowire context edges are seeded at weight 0 (retrieval-invisible). An `edge`
  // item here is an unjudged autowire edge awaiting confirmation; a keepEdge verdict PROMOTES it
  // (judged:true + a real weight off the preserved recall `score`) so it re-enters ranked retrieval,
  // while pruneEdge deletes it. Until judged, the edge contributes ZERO relevance.
  if (p === '/judge/next') {
    const T = targetOverlay(null, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    const ws = T.ws;
    const cfg = T.ov.config.judge || {};
    const defBudget = Number(cfg.budgetPerRun) || 20;
    const budget = Math.max(1, Math.min(parseInt(u.searchParams.get('budget') || String(defBudget), 10) || defBudget, 50));
    const g = buildGraph(ws);
    const byId = new Map(g.tasks.map((t) => [t.id, t]));
    const detail = (key) => { const t = byId.get(key); return t ? { key, title: t.label, summary: String(t.summary || '').slice(0, 200), kind: t.kind || 'task', status: t.status } : { key, title: key, summary: '', missing: true }; };
    // EAGER MODE (task C): ?node=<key> serves THIS node's whole unjudged candidate edge-set in ONE
    // slice (no cursor, no priority/orphan mixing) so an eager dispatch judges the freshly-wired node
    // immediately. The mark is cleared here — the node has been handed to a judge; if some edges go
    // unjudged this pass they remain on the global queue (periodic fallback) and re-mark only on a
    // fresh node-add. Falls through to the normal cursor-walked queue when ?node is absent.
    const eagerNode = u.searchParams.get('node');
    if (eagerNode) {
      const nodeItems = judge.buildQueueForNode(T.ov, eagerNode);
      if (overlayStore.clearEagerJudge(T.ov, eagerNode)) {
        overlayStore.clearEagerJudgeLease(T.ov, eagerNode); // release dispatch lease (task 27)
        T.save();
      }
      const nbAdj = judge.buildContextAdjacency(T.ov);
      const isNK = (k) => typeof k === 'string' && k.startsWith('note:');
      const nodeOfE = (key) => {
        if (isNK(key)) { const n = T.ov.note_nodes[key.replace(/^note:/, '')]; return n ? { title: n.title, summary: String(n.summary || '').slice(0, 200) } : { title: key, summary: '' }; }
        const t = byId.get(key); return t ? { title: t.label, summary: String(t.summary || '').slice(0, 200) } : { title: key, summary: '' };
      };
      const eagerItems = nodeItems.slice(0, budget).map((it) => {
        const neighborhood = judge.expandNeighborhood(T.ov, it.to, nodeOfE, { adjacency: nbAdj });
        const supersedeChain = judge.supersedeChain(T.ov, it.to);
        const taskTask = !isNK(it.from) && !isNK(it.to);
        return { kind: 'edge', id: it.id, from: detail(it.from), to: detail(it.to), neighborhood: neighborhood.nodes, neighborhoodTruncated: neighborhood.truncated, supersedeChain, taskTask, allowed_actions: judge.judgeItemAllowedActions('edge') };
      });
      const contextCompression = applyStructuredContextCompression(eagerItems);
      send(res, 200, { epoch: T.ov.epoch || 0, workspace: ws, budget, node: eagerNode, eager: true, idle: eagerItems.length === 0, total: nodeItems.length, items: eagerItems, context_compression: contextCompression }); return true;
    }
    const queue = judge.buildQueue(T.ov);
    const slice = judge.nextSlice(queue, T.ov.judgeCursor || 0, budget);
    // Unified node resolver for the structural neighborhood walk: a key may be a note ('note:<id>')
    // or a task (graph id). The DAEMON only assembles + serves this context; the agent reasons.
    const nodeOf = (key) => {
      if (typeof key === 'string' && key.startsWith('note:')) {
        const n = T.ov.note_nodes[key.replace(/^note:/, '')];
        return n ? { title: n.title, summary: String(n.summary || '').slice(0, 200) } : { title: key, summary: '' };
      }
      const t = byId.get(key);
      return t ? { title: t.label, summary: String(t.summary || '').slice(0, 200) } : { title: key, summary: '' };
    };
    const isNoteKey = (k) => typeof k === 'string' && k.startsWith('note:');
    // Reuse ONE adjacency build across all edge items in this slice (positive-weight context edges).
    const nbAdjacency = judge.buildContextAdjacency(T.ov);
	    const items = slice.items.map((it) => {
	      if (it.kind === 'readiness-repair') {
	        const task = detail(it.task_key);
	        const dep = it.dependency ? detail(it.dependency) : null;
	        return {
	          kind: 'readiness-repair',
	          id: it.id,
	          task,
	          readiness_kind: it.readiness_kind || null,
	          dependency: dep,
	          dependency_key: it.dependency || null,
	          dependency_status: it.dependency_status || null,
	          reason: it.reason || null,
	          allowed_actions: judge.judgeItemAllowedActions('readiness-repair'),
	        };
	      }
	      if (it.kind === 'followup-triage') {
	        const task = detail(it.task_key);
	        return {
	          kind: 'followup-triage',
	          id: it.id,
	          guidance_id: it.guidance_id || null,
	          task,
	          reason: it.reason || null,
	          when: it.when || null,
	          bucket: it.bucket || null,
	          allowed_actions: judge.judgeItemAllowedActions('followup-triage'),
	        };
	      }
	      if (it.kind === 'task-decision') {
	        const task = detail(it.task_key);
	        return {
	          kind: 'task-decision',
	          id: it.id,
	          task,
	          task_key: it.task_key,
	          action: it.action || null,
	          reason: it.reason || null,
	          review_state: it.review_state || null,
	          review_verdict: it.review_verdict || null,
	          merge_state: it.merge_state || null,
	          attempt_branch: it.attempt_branch || null,
	          attempt_worktree: it.attempt_worktree || null,
	          allowed_actions: judge.judgeItemAllowedActions('task-decision'),
	        };
	      }
	      if (it.kind === 'edge') {
        // The candidate edge is anchor(from) → N(to). Adjudicate N WITH structure: expand N's
        // weighted neighborhood + its supersede chain so the agent reasons over context, not the
        // endpoint alone. task→task candidates additionally carry kind/dup classification flags.
        const neighborhood = judge.expandNeighborhood(T.ov, it.to, nodeOf, { adjacency: nbAdjacency });
        const supersedeChain = judge.supersedeChain(T.ov, it.to);
        const taskTask = !isNoteKey(it.from) && !isNoteKey(it.to);
        return {
          kind: 'edge', id: it.id, from: detail(it.from), to: detail(it.to),
          neighborhood: neighborhood.nodes, neighborhoodTruncated: neighborhood.truncated,
          supersedeChain, taskTask,
          allowed_actions: judge.judgeItemAllowedActions('edge'),
        };
      }
      if (it.kind === 'dup-cluster') {
        const notes = it.keys.map((k) => {
          const n = T.ov.note_nodes[String(k).replace(/^note:/, '')];
          return n ? { key: k, title: n.title, summary: String(n.summary || '').slice(0, 300), created_at: n.created_at || null } : { key: k, title: k, summary: '', created_at: null, missing: true };
        });
        return { kind: 'dup-cluster', id: it.id, keys: it.keys, notes, pending_dup: !!it.pending_dup, allowed_actions: judge.judgeItemAllowedActions('dup-cluster') };
      }
      if (it.kind === 'decay') {
        const noteId = String(it.noteId || it.id).replace(/^note:/, '');
        const n = T.ov.note_nodes[noteId];
        return {
          kind: 'decay',
          id: it.id,
          noteId: it.noteId,
          note: n ? { key: it.noteId, title: n.title, summary: String(n.summary || '').slice(0, 300), validFrom: n.validFrom || null } : { key: it.noteId, title: it.id, summary: '' },
          winRate: it.winRate,
          wins: it.wins,
          losses: it.losses,
          total: it.total,
          ageDays: it.ageDays,
          confidence: it.confidence,
          reasons: it.reasons || [],
          action: it.action,
          allowed_actions: judge.judgeItemAllowedActions('decay'),
        };
      }
      if (it.kind === 'reinforce') {
        const noteId = String(it.noteId || it.id).replace(/^note:/, '');
        const n = T.ov.note_nodes[noteId];
        return {
          kind: 'reinforce',
          id: it.id,
          noteId: it.noteId,
          note: n ? { key: it.noteId, title: n.title, summary: String(n.summary || '').slice(0, 300), validFrom: n.validFrom || null } : { key: it.noteId, title: it.id, summary: '' },
          boost: it.boost,
          winRate: it.winRate,
          total: it.total,
          action: it.action,
          allowed_actions: judge.judgeItemAllowedActions('reinforce'),
        };
      }
      const note = byId.get(it.id) || { id: it.id, label: it.id, summary: '', vec: null };
      const expectedMeta = ctx.embeddingMeta ? ctx.embeddingMeta(T.ov) : embeddingMeta(T.ov);
      const candidates = noteRagCandidates(T.ov, g, it.id, note.label, note.summary, note.vec, 8, { expectedMeta, targetVecMeta: note.vecMeta || null })
        .map((c) => ({ key: c.key, title: c.title, summary: c.summary, score: c.score, status: c.status, via: c.via }));
      return { kind: 'orphan', id: it.id, note: detail(it.id), candidates, allowed_actions: judge.judgeItemAllowedActions('orphan') };
    });
    if (!slice.idle && slice.cursorAfter !== (T.ov.judgeCursor || 0)) {
      T.ov.judgeCursor = slice.cursorAfter;
      T.save();
    }
    const contextCompression = applyStructuredContextCompression(items);
    send(res, 200, {
      epoch: T.ov.epoch || 0,
      workspace: ws,
      budget, idle: slice.idle, total: slice.total,
      cursorBefore: slice.cursorBefore, cursorAfter: slice.cursorAfter,
      items,
      context_compression: contextCompression,
    }); return true;
  }

  if (p === '/judge/verdict' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
	    const verdicts = Array.isArray(b.verdicts) ? b.verdicts : (b.createEdge || b.keepEdge || b.pruneEdge || b.consolidate || b.surfaceCluster || b.markJudged || b.repairTask || b.taskDecision || b.item ? [b] : []);
    const epoch = T.ov.epoch || 0;
    if (!T.ov.judgedAtEpoch) T.ov.judgedAtEpoch = {};
    if (!T.ov.judgedClusters) T.ov.judgedClusters = {};
    const applied = { created: 0, kept: 0, pruned: 0, surfaced: 0, judged: 0, consolidated: 0, superseded: 0, repointed: 0, clustersJudged: 0 };
    // Machine-readable "why nothing happened" rows for refused task decisions. A zero counter is
    // otherwise indistinguishable from an under-reporting apply (see the applied-counters OVERRIDE
    // note), so refusals are reported explicitly rather than inferred.
    const refusals = [];
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
	    const removeBlockingDependency = (taskKey, depKey) => {
	      let changed = 0;
	      const beforeEdges = T.ov.edges.length;
	      T.ov.edges = T.ov.edges.filter((e) => !(e.from === depKey && e.to === taskKey && (e.kind == null || e.kind === 'blocking')));
	      changed += beforeEdges - T.ov.edges.length;
	      const snap = T.ov.snapshots && T.ov.snapshots[taskKey];
	      if (snap && Array.isArray(snap.blockedBy)) changed += overlayStore.removeSnapshotBlockedBy(T.ov, taskKey, depKey);
	      if (filedrop && typeof filedrop.removeBlockedBy === 'function') changed += filedrop.removeBlockedBy(T.ws, taskKey, depKey);
	      return changed;
	    };
	    const clearRepair = (taskKey) => {
	      if (T.ov.readinessRepairs && T.ov.readinessRepairs[taskKey]) delete T.ov.readinessRepairs[taskKey];
	    };
	    const resolveFollowupGuidance = (guidanceId, answer) => {
	      if (!guidanceId || !Array.isArray(T.ov.guidance)) return;
	      const g = T.ov.guidance.find((item) => item.id === guidanceId);
	      if (!g || g.resolved) return;
	      overlayStore.resolveGuidance(T.ov, guidanceId, answer);
	    };
	    for (const v of verdicts) {
	      if (v && v.taskDecision && v.taskDecision.task_key && v.taskDecision.action) {
	        const taskKey = String(v.taskDecision.task_key);
	        const action = String(v.taskDecision.action).toLowerCase().replace(/[\s-]+/g, '_');
	        const sourceAction = v.taskDecision.source_action
	          ? String(v.taskDecision.source_action).toLowerCase().replace(/[\s-]+/g, '_')
	          : action;
	        const reason = String(v.taskDecision.reason || 'task decision verdict');
	        const now = new Date().toISOString();
	        if (!T.ov.judgedTaskDecisions) T.ov.judgedTaskDecisions = {};
	        // EVERY task decision goes through the ONE guarded transition authority
	        // (lib/overlay/lifecycle-machine.js) BEFORE any state is touched. It owns the in-flight
	        // guard (a verdict on a live worker's attempt is judging an empty diff), the
	        // merged-is-absorbing guard, and the settled-verdict guard. An action with no event
	        // mapping is REFUSED here instead of falling off the end of an else-if chain — the old
	        // chain silently retired such items with zero state change (observed live with the
	        // advertised-but-unimplemented "review" action).
	        const liveStatus = (byId.get(taskKey) || {}).status || null;
	        const event = TASK_DECISION_EVENTS[action] || null;
	        const decision = event
	          ? overlayStore.applyLifecycleEvent(T.ov, taskKey, event, {
	            task_status: liveStatus, agent_id: 'judge', reason, now,
	          })
	          : {
	            ok: false,
	            refusal: {
	              code: 'unknown_action',
	              reason: `no handler for task decision action '${action}'; expected one of ${Object.keys(TASK_DECISION_EVENTS).join(', ')}`,
	              retryable: false,
	            },
	          };
	        // Retire the item ONLY when the decision landed, or when it was refused because the state
	        // is genuinely settled (re-offering those would loop). A timing refusal ('in_flight') and
	        // an unrecognized action both leave the item UNSTAMPED so it can be re-judged — the stamp
	        // is permanent (judgedTaskDecisions is never cleared by an epoch bump).
	        const refusal = decision.ok ? null : decision.refusal;
	        const retireOnRefusal = !!refusal && (refusal.code === 'already_merged' || refusal.code === 'already_reviewed');
	        if (refusal) {
	          applied.refused = (applied.refused || 0) + 1;
	          if (refusal.retryable) applied.skippedInFlight = (applied.skippedInFlight || 0) + 1;
	          refusals.push({ task_key: taskKey, action, code: refusal.code, reason: refusal.reason, retryable: refusal.retryable, retired: retireOnRefusal });
	          // 'in_flight' keeps its established audit token; newer refusal codes get their own.
	          const auditVerdict = refusal.code === 'in_flight'
	            ? `task:${action}_skipped_in_flight`
	            : `task:${action}_refused_${refusal.code}`;
	          judge.appendVerdict(T.ws, { epoch, verdict: auditVerdict, from: taskKey, to: null, edgeKind: 'task', cosine: null, by: 'judge' });
	        } else if (action === 'approve') {
	          applied.taskDecisions = (applied.taskDecisions || 0) + 1;
	          judge.appendVerdict(T.ws, { epoch, verdict: 'task:approve', from: taskKey, to: null, edgeKind: 'task', cosine: null, by: 'judge' });
	        } else if (action === 'kick_back' || action === 'reject') {
	          overlayStore.setStatus(T.ov, taskKey, 'failed', `judge kick-back: ${reason}`);
	          applied.taskDecisions = (applied.taskDecisions || 0) + 1;
	          judge.appendVerdict(T.ws, { epoch, verdict: 'task:kick_back', from: taskKey, to: null, edgeKind: 'task', cosine: null, by: 'judge' });
	        } else if (action === 'merge') {
	          applied.taskDecisions = (applied.taskDecisions || 0) + 1;
	          applied.mergeRequested = (applied.mergeRequested || 0) + 1;
	          judge.appendVerdict(T.ws, { epoch, verdict: 'task:merge_request', from: taskKey, to: null, edgeKind: 'task', cosine: null, by: 'judge' });
	        } else if (action === 'discard') {
	          T.ov.notes[taskKey] = `discard decision applied by judge: ${reason}`.slice(0, 280);
	          applied.taskDecisions = (applied.taskDecisions || 0) + 1;
	          applied.discarded = (applied.discarded || 0) + 1;
	          judge.appendVerdict(T.ws, { epoch, verdict: 'task:discard', from: taskKey, to: null, edgeKind: 'task', cosine: null, by: 'judge' });
	        } else if (action === 'cancel') {
	          overlayStore.setStatus(T.ov, taskKey, 'canceled', `cancel decision applied by judge: ${reason}`);
	          T.ov.cancel_requested[taskKey] = now;
	          applied.taskDecisions = (applied.taskDecisions || 0) + 1;
	          applied.canceled = (applied.canceled || 0) + 1;
	          judge.appendVerdict(T.ws, { epoch, verdict: 'task:cancel', from: taskKey, to: null, edgeKind: 'task', cosine: null, by: 'judge' });
	        } else if (action === 'escalate') {
	          overlayStore.addGuidance(T.ov, {
	            question: `Resolve task decision for ${taskKey}`,
	            context: reason,
	            trigger: 'task_decision',
	            severity: 'blocking',
	            action: { kind: 'task-decision', task_key: taskKey, source_action: v.taskDecision.source_action || null },
	          });
	          applied.escalated = (applied.escalated || 0) + 1;
	          judge.appendVerdict(T.ws, { epoch, verdict: 'task:escalate', from: taskKey, to: null, edgeKind: 'task', cosine: null, by: 'judge' });
	        }
	        if (!refusal || retireOnRefusal) judge.stampTaskDecision(T.ov.judgedTaskDecisions, taskKey, sourceAction);
	      }
	      if (v && v.followupTriage && v.followupTriage.task_key && v.followupTriage.action) {
	        const taskKey = String(v.followupTriage.task_key);
	        const action = String(v.followupTriage.action);
	        const guidanceId = v.followupTriage.guidance_id ? String(v.followupTriage.guidance_id) : null;
	        const reason = String(v.followupTriage.reason || 'follow-up triage verdict');
	        const followups = require('../lib/followups');
	        const guidance = guidanceId && Array.isArray(T.ov.guidance) ? T.ov.guidance.find((g) => g.id === guidanceId) : null;
	        const guidanceAction = guidance && guidance.action && guidance.action.kind === 'follow-up'
	          ? guidance.action
	          : { kind: 'follow-up', task_key: taskKey };
	        if (action === 'approve') {
	          const fr = followups.resolveGate(T.ov, guidanceAction, 'approve');
	          resolveFollowupGuidance(guidanceId, reason);
	          applied.repaired = (applied.repaired || 0) + 1;
	          applied.followupsApproved = (applied.followupsApproved || 0) + 1;
	          if (fr && fr.released) applied.released = (applied.released || 0) + 1;
	          judge.appendVerdict(T.ws, { epoch, verdict: 'followup:approve', from: taskKey, to: null, edgeKind: 'task', cosine: null, by: 'judge' });
	        } else if (action === 'reject') {
	          const fr = followups.resolveGate(T.ov, guidanceAction, 'reject');
	          resolveFollowupGuidance(guidanceId, reason);
	          applied.repaired = (applied.repaired || 0) + 1;
	          applied.followupsRejected = (applied.followupsRejected || 0) + 1;
	          if (fr && fr.canceled) applied.canceled = (applied.canceled || 0) + 1;
	          judge.appendVerdict(T.ws, { epoch, verdict: 'followup:reject', from: taskKey, to: null, edgeKind: 'task', cosine: null, by: 'judge' });
	        } else if (action === 'escalate') {
	          if (!Array.isArray(T.ov.guidance)) T.ov.guidance = [];
	          const existing = T.ov.guidance.some((g) => !g.resolved && g.action && g.action.kind === 'follow-up' && g.action.task_key === taskKey && g.action.judge_eligible === false);
	          if (!existing) {
	            T.ov.guidance.push({ id: `gate/followup-human-${Date.now().toString(36)}`, question: `Approve follow-up ${taskKey}?`, context: reason, trigger: 'follow_up', severity: 'blocking', ts: new Date().toISOString(), resolved: false, action: { kind: 'follow-up', task_key: taskKey, guidance_id: guidanceId, judge_eligible: false } });
	            applied.escalated = (applied.escalated || 0) + 1;
	          }
	          resolveFollowupGuidance(guidanceId, 'escalated to user guidance');
	          judge.appendVerdict(T.ws, { epoch, verdict: 'followup:escalate', from: taskKey, to: null, edgeKind: 'task', cosine: null, by: 'judge' });
	        }
	      }
	      if (v && v.repairTask && v.repairTask.task_key && v.repairTask.action) {
	        const taskKey = String(v.repairTask.task_key);
	        const action = String(v.repairTask.action);
	        const depKey = v.repairTask.dependency ? String(v.repairTask.dependency) : (T.ov.readinessRepairs && T.ov.readinessRepairs[taskKey] && T.ov.readinessRepairs[taskKey].dependency);
	        const reason = String(v.repairTask.reason || 'readiness repair verdict');
	        if (action === 'remove_dependency' && depKey) {
	          const removed = removeBlockingDependency(taskKey, depKey);
	          if (removed > 0) {
	            clearRepair(taskKey);
	            applied.repaired = (applied.repaired || 0) + 1;
	            applied.removedDeps = (applied.removedDeps || 0) + removed;
	            judge.appendVerdict(T.ws, { epoch, verdict: 'repair:remove_dependency', from: depKey, to: taskKey, edgeKind: 'blocking', cosine: null, by: 'judge' });
	          }
	        } else if (action === 'release_hold') {
	          if (T.ov.status && T.ov.status[taskKey] === 'not_ready') delete T.ov.status[taskKey];
	          clearRepair(taskKey);
	          applied.repaired = (applied.repaired || 0) + 1;
	          judge.appendVerdict(T.ws, { epoch, verdict: 'repair:release_hold', from: taskKey, to: null, edgeKind: 'task', cosine: null, by: 'judge' });
	        } else if (action === 'cancel_task') {
	          overlayStore.setStatus(T.ov, taskKey, 'canceled', reason);
	          T.ov.cancel_requested[taskKey] = new Date().toISOString();
	          clearRepair(taskKey);
	          applied.repaired = (applied.repaired || 0) + 1;
	          judge.appendVerdict(T.ws, { epoch, verdict: 'repair:cancel_task', from: taskKey, to: null, edgeKind: 'task', cosine: null, by: 'judge' });
	        } else if (action === 'escalate') {
	          if (!Array.isArray(T.ov.guidance)) T.ov.guidance = [];
	          const existing = T.ov.guidance.some((g) => !g.resolved && g.action && g.action.kind === 'readiness-repair' && g.action.task_key === taskKey);
	          if (!existing) {
	            T.ov.guidance.push({ id: `gate/readiness-repair-${Date.now().toString(36)}`, question: `Resolve readiness repair for ${taskKey}`, context: reason, trigger: 'readiness_repair', ts: new Date().toISOString(), resolved: false, action: { kind: 'readiness-repair', task_key: taskKey, dependency: depKey || null } });
	            applied.escalated = (applied.escalated || 0) + 1;
	          }
	          clearRepair(taskKey);
	          judge.appendVerdict(T.ws, { epoch, verdict: 'repair:escalate', from: taskKey, to: depKey || null, edgeKind: 'task', cosine: null, by: 'judge' });
	        }
	      }
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
        const fromNode = T.ov.note_nodes && T.ov.note_nodes[String(v.keepEdge.from).replace(/^note:/, '')];
        const toNode = T.ov.note_nodes && T.ov.note_nodes[String(v.keepEdge.to).replace(/^note:/, '')];
        const fromKind = fromNode ? (fromNode.kind || 'note') : (isNote(v.keepEdge.from) ? 'note' : 'task');
        const toKind = toNode ? (toNode.kind || 'note') : (isNote(v.keepEdge.to) ? 'note' : 'task');
        // Compute model prediction before applying. When promoted, model verdict overrides Sonnet.
        const modelVerdict = scoreShadow(T.ws, { from: v.keepEdge.from, to: v.keepEdge.to, verdict: 'keep', cosine: cos, fromKind, toKind });
        if (modelVerdict === 'prune') {
          // Promoted + model says prune: override — remove the edge instead of keeping it.
          const beforePr = T.ov.edges.length;
          overlayStore.removeEdge(T.ov, v.keepEdge.from, v.keepEdge.to, null, 'context');
          if (T.ov.edges.length < beforePr) {
            overlayStore.clearEdgeRejudge(T.ov, v.keepEdge.from, v.keepEdge.to);
            applied.pruned++;
            judge.appendVerdict(T.ws, { epoch, verdict: 'prune', from: v.keepEdge.from, to: v.keepEdge.to, edgeKind: 'context', cosine: cos, origin, by: 'model' });
          }
        } else {
          // keepEdge() only promotes (and returns truthy for) a weight-0 / judged===false autowire edge.
          // A LEGACY already-judged edge (judged===true, weight>0) flagged for rejudge returns falsy —
          // so we must ALSO enter this block when the edge is currently rejudge-flagged, to clear the
          // flag + journal the keep. Compute that flag first (sig = from>>to; see overlay.markForRejudge).
          const rejudgeSig = v.keepEdge.from + '>>' + v.keepEdge.to;
          const wasRejudgeFlagged = !!(T.ov.edgeRejudge && T.ov.edgeRejudge[rejudgeSig]);
          const edgePromoted = judge.keepEdge(T.ov, v.keepEdge.from, v.keepEdge.to);
          if (edgePromoted || (wasRejudgeFlagged && kept)) {
            overlayStore.clearEdgeRejudge(T.ov, v.keepEdge.from, v.keepEdge.to);
            applied.kept++;
            // task→task KIND classification: the agent decided "anchor REQUIRES N" → reclassify the
            // kept context edge as a true blocking prerequisite (the dual of context = non-blocking).
            const reversePairedJudge = v.keepEdge.kind === 'blocking' && overlayStore.isReversePairedJudgeBlockingEdge(T.ov, v.keepEdge.from, v.keepEdge.to);
            if (v.keepEdge.kind === 'blocking' && kept && !reversePairedJudge) {
              kept.kind = 'blocking';
              delete kept.weight;            // blocking edges carry no relevance weight
              applied.reclassified = (applied.reclassified || 0) + 1;
            }
            const by = modelVerdict === 'keep' ? 'model' : 'judge';
            judge.appendVerdict(T.ws, { epoch, verdict: 'keep', from: v.keepEdge.from, to: v.keepEdge.to, edgeKind: v.keepEdge.kind === 'blocking' && !reversePairedJudge ? 'blocking' : 'context', cosine: cos, origin, by });
          }
        }
      }
      if (v && v.pruneEdge && v.pruneEdge.from && v.pruneEdge.to) {
        // Read the cosine BEFORE removeEdge — once the edge is deleted its creation score is gone.
        const doomed = findEdge(v.pruneEdge.from, v.pruneEdge.to, v.pruneEdge.kind || 'context');
        const cos = edgeCosine(doomed);
        const origin = edgeOrigin(doomed);
        const fromPruneNode = T.ov.note_nodes && T.ov.note_nodes[String(v.pruneEdge.from).replace(/^note:/, '')];
        const toPruneNode = T.ov.note_nodes && T.ov.note_nodes[String(v.pruneEdge.to).replace(/^note:/, '')];
        const fromPruneKind = fromPruneNode ? (fromPruneNode.kind || 'note') : (isNote(v.pruneEdge.from) ? 'note' : 'task');
        const toPruneKind = toPruneNode ? (toPruneNode.kind || 'note') : (isNote(v.pruneEdge.to) ? 'note' : 'task');
        // Compute model prediction before applying. When promoted, model verdict overrides Sonnet.
        const modelVerdict = scoreShadow(T.ws, { from: v.pruneEdge.from, to: v.pruneEdge.to, verdict: 'prune', cosine: cos, fromKind: fromPruneKind, toKind: toPruneKind });
        if (modelVerdict === 'keep') {
          // Promoted + model says keep: override — promote the edge instead of removing it.
          const edgePromoted2 = judge.keepEdge(T.ov, v.pruneEdge.from, v.pruneEdge.to);
          if (edgePromoted2) {
            overlayStore.clearEdgeRejudge(T.ov, v.pruneEdge.from, v.pruneEdge.to);
            applied.kept++;
            judge.appendVerdict(T.ws, { epoch, verdict: 'keep', from: v.pruneEdge.from, to: v.pruneEdge.to, edgeKind: v.pruneEdge.kind || 'context', cosine: cos, origin, by: 'model' });
          }
        } else {
          const before = T.ov.edges.length;
          overlayStore.removeEdge(T.ov, v.pruneEdge.from, v.pruneEdge.to, null, v.pruneEdge.kind);
          if (T.ov.edges.length < before) {
            overlayStore.clearEdgeRejudge(T.ov, v.pruneEdge.from, v.pruneEdge.to);
            applied.pruned++;
            const by = modelVerdict === 'prune' ? 'model' : 'judge';
            judge.appendVerdict(T.ws, { epoch, verdict: 'prune', from: v.pruneEdge.from, to: v.pruneEdge.to, edgeKind: v.pruneEdge.kind || 'context', cosine: cos, origin, by });
          }
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
        judge.appendVerdict(T.ws, { epoch, verdict: 'consolidate', from: keepKey, to: supersededNow.join(',') || null, edgeKind: 'note', cosine: clusterMaxCosine(T.ov, [keepKey, ...v.consolidate.supersede.map((k) => String(k).startsWith('note:') ? String(k) : 'note:' + k)]), by: 'judge' });
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
        // The judge prompt is CONSERVATIVE by default: two notes must be the SAME fact to consolidate.
        // Failure to consolidate (surfaceCluster) IS the distinct verdict — auto-resolve as DISTINCT
        // rather than escalating to the user via an AMBIGUOUS_INTENT guidance item.
        overlayStore.markClusterDistinct(T.ov, keys);
        for (const k of keys) overlayStore.clearPendingDup(T.ov, k);
        judge.stampCluster(T.ov.judgedClusters, keys, epoch);
        applied.stamped = (applied.stamped || 0) + 1; applied.clustersJudged++;
        judge.appendVerdict(T.ws, { epoch, verdict: 'distinct', from: keys[0] || null, to: keys.slice(1).join(',') || null, edgeKind: 'note', cosine: clusterMaxCosine(T.ov, keys), by: 'judge' });
      }
      if (v && v.markDistinct && Array.isArray(v.markDistinct.keys) && v.markDistinct.keys.length) {
        const keys = v.markDistinct.keys.map((k) => String(k).startsWith('note:') ? String(k) : 'note:' + k);
        overlayStore.markClusterDistinct(T.ov, keys);
        // PENDING-DUP: DISTINCT verdict — the notes are NOT the same fact. Clear provisional so a
        // pending-dup new note becomes recall-eligible (visible) again.
        for (const k of keys) overlayStore.clearPendingDup(T.ov, k);
        judge.stampCluster(T.ov.judgedClusters, keys, epoch);
        applied.stamped = (applied.stamped || 0) + 1; applied.clustersJudged++;
        judge.appendVerdict(T.ws, { epoch, verdict: 'distinct', from: keys[0] || null, to: keys.slice(1).join(',') || null, edgeKind: 'note', cosine: clusterMaxCosine(T.ov, keys), by: 'judge' });
      }
      // boostNote: record a reinforce boost on a note that has a high win rate.
      // Appends note_reinforced event carrying the boost amount, winRate, and observation count.
      // Best-effort: skips notes not found or already retired.
      if (v && v.boostNote && v.boostNote.noteKey) {
        const bId = String(v.boostNote.noteKey).replace(/^note:/, '');
        const bNode = T.ov.note_nodes && T.ov.note_nodes[bId];
        if (bNode && bNode.validTo == null) {
          const store = graphStore.forWorkspace(T.ws);
          graphStore.appendEvent(store, 'note:' + bId, {
            evt: 'note_reinforced',
            actor: 'judge:reinforce',
            boost: typeof v.boostNote.boost === 'number' ? v.boostNote.boost : 0,
            winRate: v.boostNote.winRate,
            total: v.boostNote.total,
          });
          applied.reinforced = (applied.reinforced || 0) + 1;
          bNode.reinforceStampedEpoch = T.ov.epoch || 0;
        }
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
    T.save(); notifyChange(T.graph_repo || T.ws);
    send(res, 200, { ok: true, epoch, applied, refusals, edges: T.ov.edges.length }); return true;
  }

  // POST /judge/drain?node=<key>&budget=<N>&sync=1[&workspace=<ws>]
  // SYNCHRONOUS, node-scoped, budget-bounded judge drain. Drives the node's unjudged autowire
  // candidate edge-set to idle (or the budget/round ceiling) in ONE request, REUSING the in-process
  // judge (lib/headless-drain.runJudgeDrainSync → resolveJudgeBackend → provider.runJudgeLoop, the
  // kind:'api' Node-http judge) — same prompt (buildJudgePrompt), same /judge/next?node= + verdict
  // path the eager drain uses, NO second judge implementation. The drain is bounded by the SAME
  // per-call timeout the background drain applies, so the async drain's hang class cannot return; it
  // does NOT touch the background-drain governor. Returns { judged, kept, pruned, idle }.
  if (p === '/judge/drain' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    const node = u.searchParams.get('node') || b.node;
    if (!node) { send(res, 400, { ok: false, error: 'node required' }); return true; }
    // budget clamps 1..50 in runJudgeDrainSync (same as buildJudgePrompt); read it loosely here.
    const rawBudget = u.searchParams.get('budget') != null ? u.searchParams.get('budget') : b.budget;
    const budget = rawBudget != null ? (parseInt(rawBudget, 10) || undefined) : undefined;
    const out = await headlessDrain.runJudgeDrainSync({ workspaceRoot: T.ws, node: String(node), budget });
    send(res, 200, {
      ok: true, workspace: T.ws, node: String(node),
      judged: out.judged, kept: out.kept, pruned: out.pruned, idle: out.idle,
      rounds: out.rounds, ...(out.skipped ? { skipped: out.skipped } : {}),
    }); return true;
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
    if (marked > 0) { T.save(); notifyChange(T.graph_repo || T.ws); }
    send(res, 200, { ok: true, marked, skipped, total: sigs.length }); return true;
  }

  if (p === '/judge/pressure' && m === 'GET') {
    // Ensure the standing harness task exists before we might nudge (idempotent, cheap).
    const T = targetOverlay(null, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    const ws = T.ws;
    ensureHarnessJudgeDrainTask(T.ov, () => { T.save(); notifyChange(T.graph_repo || T.ws); });
    const queue = judge.buildQueue(T.ov);
    const depth = queue.length;
    const dupClusters = queue.filter((i) => i.kind === 'dup-cluster').length;
    const gate = computePressureNudge({
      depth,
      depthThreshold: JUDGE_DEPTH,
      buildGraph,
      ws,
      overlay: T.ov,
      harnessKey: HARNESS_JUDGE_DRAIN_KEY,
      // Demote periodic catch-up to fallback: suppress while eager dispatch (task C) is keeping up.
      eagerActive: judge.eagerJudgePending(T.ov),
    });
    send(res, 200, {
      workspace: ws,
      depth, dupClusters, nudge: gate.nudge, harness_task_key: HARNESS_JUDGE_DRAIN_KEY,
      running: gate.running, capacity_ok: gate.capacity_ok, drain_in_progress: gate.drain_in_progress,
      eager_active: gate.eager_active,
    }); return true;
  }

  // GET /judge/decay-preview
  // Read-only diagnostic endpoint. Runs the same decay gate logic as buildQueue pass (4) and returns
  // which notes WOULD be soft-retired WITHOUT writing any note_superseded event.
  // Response: { candidates: [{noteId, label, winRate, wins, losses, total, ageDays, validFrom}],
  //             review: [{noteId, label, reason, ...}], scanned, belowThreshold }
  if (p === '/judge/decay-preview' && m === 'GET') {
    const T = targetOverlay(null, u);
    const ws = T.ws;
    const noteNodes = T.ov.note_nodes || {};
    const evidenceMap = computeNoteUsageEvidence(ws, noteNodes);
    const nowMs = Date.now();
    let scanned = 0;
    let belowThreshold = 0;
    const candidates = [];
    const review = [];
    for (const n of Object.values(noteNodes)) {
      scanned++;
      const noteKey = 'note:' + n.id;
      const evidence = evidenceMap.get(noteKey);
      const check = scoreNoteNecessity(evidence, nowMs);
      // Count notes that have stats but fail win-rate gate (regardless of age/opportunities).
      if (evidence && evidence.opportunities > 0 && evidence.winRate < WIN_RATE_THRESHOLD) belowThreshold++;
      const wins = evidence ? evidence.wins : 0;
      const losses = evidence ? evidence.losses : 0;
      if (!check.retireCandidate) {
        if (check.review && evidence && evidence.opportunities > 0 && (evidence.winRate < WIN_RATE_THRESHOLD || check.borderline)) {
          review.push({
            noteId: noteKey,
            label: n.title || n.id,
            classification: check.classification,
            reasons: check.reasons,
            winRate: check.winRate,
            wins,
            losses,
            total: check.total,
            ageDays: check.ageDays,
            validFrom: n.validFrom || null,
          });
        }
        continue;
      }
      candidates.push({
        noteId: noteKey,
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
    review.sort((a, b) => (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0));
    send(res, 200, { candidates, review, scanned, belowThreshold }); return true;
  }

  return false;
};

// Deprecated test seam (hourly debounce removed — capacity gate is stateless).
makeRoute._setLastNudgeAt = () => {};
makeRoute.HARNESS_JUDGE_DRAIN_KEY = HARNESS_JUDGE_DRAIN_KEY;
makeRoute.ensureHarnessJudgeDrainTask = ensureHarnessJudgeDrainTask;

module.exports = makeRoute;
