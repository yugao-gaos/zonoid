'use strict';
const overlayStore = require('../lib/overlay');
const judge = require('../lib/judge');

// Pressure nudge rate-limit: one nudge per NUDGE_INTERVAL_MS, in-memory (a missed hour after
// restart is harmless). First caller within the window that sees depth>=NUDGE_DEPTH wins the
// nudge token; concurrent callers in that same tick get nudge:false.
const NUDGE_DEPTH = 30;
const NUDGE_INTERVAL_MS = 3600000; // 1 hour
let _lastNudgeAt = 0;

// Stable key for the standing "harness: judge drain" task. Fixed slug so it is findable by label
// prefix across daemon restarts; the snapshot substrate keeps it in the graph indefinitely.
// Workers call start_task with this key before judging, complete_task after — per-pass
// complete_task (status → done) is the claim-conflict guarantee: the next pass's start_task sees
// 'done' (not 'in_progress'), so no CAS conflict. The 10-min stale-claim sweep is a secondary
// safety net for crashed workers, but is never needed when passes complete normally.
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

  if (p === '/judge/next') {
    const cfg = state.overlay.config.judge || {};
    const defBudget = Number(cfg.budgetPerRun) || 20;
    const budget = Math.max(1, Math.min(parseInt(u.searchParams.get('budget') || String(defBudget), 10) || defBudget, 50));
    const g = buildGraph(state.workspace);
    const byId = new Map(g.tasks.map((t) => [t.id, t]));
    const detail = (key) => { const t = byId.get(key); return t ? { key, title: t.label, summary: String(t.summary || '').slice(0, 200), kind: t.kind || 'task', status: t.status } : { key, title: key, summary: '', missing: true }; };
    const queue = judge.buildQueue(state.overlay);
    const slice = judge.nextSlice(queue, state.overlay.judgeCursor || 0, budget);
    const items = slice.items.map((it) => {
      if (it.kind === 'edge') {
        return { kind: 'edge', id: it.id, from: detail(it.from), to: detail(it.to) };
      }
      if (it.kind === 'dup-cluster') {
        const notes = it.keys.map((k) => {
          const n = state.overlay.note_nodes[String(k).replace(/^note:/, '')];
          return n ? { key: k, title: n.title, summary: String(n.summary || '').slice(0, 300), created_at: n.created_at || null } : { key: k, title: k, summary: '', created_at: null, missing: true };
        });
        return { kind: 'dup-cluster', id: it.id, keys: it.keys, notes };
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
    for (const v of verdicts) {
      if (v && v.createEdge && v.createEdge.from && v.createEdge.to) {
        const before = T.ov.edges.length;
        overlayStore.addEdge(T.ov, v.createEdge.from, v.createEdge.to, null, 'context', v.createEdge.weight);
        const e = T.ov.edges.find((x) => x.from === v.createEdge.from && x.to === v.createEdge.to && x.kind === 'context');
        if (e) { e.judged = true; e.by = 'judge'; }
        if (T.ov.edges.length > before || e) applied.created++;
      }
      if (v && v.keepEdge && v.keepEdge.from && v.keepEdge.to) {
        if (judge.keepEdge(T.ov, v.keepEdge.from, v.keepEdge.to)) applied.kept++;
      }
      if (v && v.pruneEdge && v.pruneEdge.from && v.pruneEdge.to) {
        const before = T.ov.edges.length;
        overlayStore.removeEdge(T.ov, v.pruneEdge.from, v.pruneEdge.to, null, v.pruneEdge.kind);
        if (T.ov.edges.length < before) applied.pruned++;
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
        judge.stampCluster(T.ov.judgedClusters, [keepKey, ...v.consolidate.supersede.map((k) => String(k).startsWith('note:') ? String(k) : 'note:' + k)], epoch);
        applied.consolidated++; applied.clustersJudged++;
      }
      if (v && v.surfaceCluster && Array.isArray(v.surfaceCluster.keys) && v.surfaceCluster.keys.length) {
        const keys = v.surfaceCluster.keys.map((k) => String(k).startsWith('note:') ? String(k) : 'note:' + k);
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
      }
      if (v && v.markDistinct && Array.isArray(v.markDistinct.keys) && v.markDistinct.keys.length) {
        const keys = v.markDistinct.keys.map((k) => String(k).startsWith('note:') ? String(k) : 'note:' + k);
        overlayStore.markClusterDistinct(T.ov, keys);
        judge.stampCluster(T.ov.judgedClusters, keys, epoch);
        applied.stamped = (applied.stamped || 0) + 1; applied.clustersJudged++;
      }
      const noteKey = v && (v.markJudged || (v.item && v.item.kind === 'orphan' ? v.item.id : null));
      if (noteKey) { judge.stampJudged(T.ov.judgedAtEpoch, noteKey, epoch); applied.judged++; }
    }
    T.save(); notifyChange();
    send(res, 200, { ok: true, epoch, applied, edges: T.ov.edges.length }); return true;
  }

  if (p === '/judge/pressure' && m === 'GET') {
    // Ensure the standing harness task exists before we might nudge (idempotent, cheap).
    const T = targetOverlay(null, u);
    ensureHarnessJudgeDrainTask(T.ov, () => { T.save(); notifyChange(); });
    const queue = judge.buildQueue(state.overlay);
    const depth = queue.length;
    const dupClusters = queue.filter((i) => i.kind === 'dup-cluster').length;
    let nudge = false;
    if (depth >= NUDGE_DEPTH) {
      const now = Date.now();
      if (now - _lastNudgeAt >= NUDGE_INTERVAL_MS) {
        _lastNudgeAt = now;  // stamp atomically — first caller wins the hour
        nudge = true;
      }
    }
    send(res, 200, { depth, dupClusters, nudge, harness_task_key: HARNESS_JUDGE_DRAIN_KEY }); return true;
  }

  return false;
};

// Test seams: allows unit tests to control the nudge stamp without sleeping, and to inspect the
// standing harness task key and ensure function.
makeRoute._setLastNudgeAt = (ts) => { _lastNudgeAt = ts; };
makeRoute.HARNESS_JUDGE_DRAIN_KEY = HARNESS_JUDGE_DRAIN_KEY;
makeRoute.ensureHarnessJudgeDrainTask = ensureHarnessJudgeDrainTask;

module.exports = makeRoute;
