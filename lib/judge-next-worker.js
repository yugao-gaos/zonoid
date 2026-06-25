'use strict';

const { parentPort, workerData } = require('worker_threads');
const overlayStore = require('./overlay');
const judge = require('./judge');
const { buildGraph, noteRagCandidates } = require('../daemon');

function parseBudget(overlay, rawBudget) {
  const cfg = (overlay && overlay.config && overlay.config.judge) || {};
  const defBudget = Number(cfg.budgetPerRun) || 20;
  return Math.max(1, Math.min(parseInt(rawBudget || String(defBudget), 10) || defBudget, 50));
}

function noteDetail(overlay, key) {
  const n = overlay.note_nodes && overlay.note_nodes[String(key).replace(/^note:/, '')];
  return n
    ? { key, title: n.title || key, summary: String(n.summary || '').slice(0, 200), kind: 'note', status: n.validTo == null ? 'current' : 'retired' }
    : { key, title: key, summary: '', missing: true };
}

function taskDetail(overlay, byId, key) {
  const snap = overlay.snapshots && overlay.snapshots[key];
  if (snap) {
    return {
      key,
      title: snap.subject || snap.title || key,
      summary: String(snap.description || snap.summary || '').slice(0, 200),
      kind: snap.kind || 'task',
      status: (overlay.status && overlay.status[key]) || snap.status || 'pending',
    };
  }
  if (byId && byId.has(key)) {
    const t = byId.get(key);
    return { key, title: t.label, summary: String(t.summary || '').slice(0, 200), kind: t.kind || 'task', status: t.status };
  }
  return { key, title: key, summary: '', missing: true };
}

function makeContext(overlay, workspace) {
  let graph = null;
  let byId = null;
  const ensureGraph = () => {
    if (!graph) {
      graph = buildGraph(workspace);
      byId = new Map(graph.tasks.map((t) => [t.id, t]));
    }
    return graph;
  };
  const detail = (key) => (
    typeof key === 'string' && key.startsWith('note:')
      ? noteDetail(overlay, key)
      : taskDetail(overlay, byId, key)
  );
  const nodeOf = (key) => {
    const d = detail(key);
    return { title: d.title, summary: d.summary };
  };
  return { ensureGraph, detail, nodeOf, byId: () => byId };
}

function edgeItemResponse(overlay, it, detail, nodeOf, adjacency) {
  const isNoteKey = (k) => typeof k === 'string' && k.startsWith('note:');
  const neighborhood = judge.expandNeighborhood(overlay, it.to, nodeOf, { adjacency });
  const supersedeChain = judge.supersedeChain(overlay, it.to);
  return {
    kind: 'edge',
    id: it.id,
    from: detail(it.from),
    to: detail(it.to),
    neighborhood: neighborhood.nodes,
    neighborhoodTruncated: neighborhood.truncated,
    supersedeChain,
    taskTask: !isNoteKey(it.from) && !isNoteKey(it.to),
  };
}

function itemResponse(overlay, workspace, it, ctx, adjacency) {
  if (it.kind === 'edge') return edgeItemResponse(overlay, it, ctx.detail, ctx.nodeOf, adjacency);
  if (it.kind === 'dup-cluster') {
    const notes = it.keys.map((k) => {
      const n = overlay.note_nodes[String(k).replace(/^note:/, '')];
      return n
        ? { key: k, title: n.title, summary: String(n.summary || '').slice(0, 300), created_at: n.created_at || null }
        : { key: k, title: k, summary: '', created_at: null, missing: true };
    });
    return { kind: 'dup-cluster', id: it.id, keys: it.keys, notes, pending_dup: !!it.pending_dup };
  }
  if (it.kind === 'decay') {
    const noteId = String(it.noteId || it.id).replace(/^note:/, '');
    const n = overlay.note_nodes[noteId];
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
    };
  }
  if (it.kind === 'reinforce') {
    const noteId = String(it.noteId || it.id).replace(/^note:/, '');
    const n = overlay.note_nodes[noteId];
    return {
      kind: 'reinforce',
      id: it.id,
      noteId: it.noteId,
      note: n ? { key: it.noteId, title: n.title, summary: String(n.summary || '').slice(0, 300), validFrom: n.validFrom || null } : { key: it.noteId, title: it.id, summary: '' },
      boost: it.boost,
      winRate: it.winRate,
      total: it.total,
      action: it.action,
    };
  }

  const graph = ctx.ensureGraph();
  const byId = ctx.byId();
  const note = byId.get(it.id) || { id: it.id, label: it.id, summary: '', vec: null };
  const candidates = noteRagCandidates(overlay, graph, it.id, note.label, note.summary, note.vec, 8)
    .map((c) => ({ key: c.key, title: c.title, summary: c.summary, score: c.score, status: c.status, via: c.via }));
  return { kind: 'orphan', id: it.id, note: ctx.detail(it.id), candidates };
}

function assemble() {
  const workspace = workerData && workerData.workspace;
  if (!workspace) return { ok: false, error: 'workspace required' };
  const overlay = overlayStore.load(workspace);
  overlay.workspace = workspace;
  const budget = parseBudget(overlay, workerData.budgetParam);
  const node = workerData.node ? String(workerData.node) : null;
  const ctx = makeContext(overlay, workspace);
  const adjacency = judge.buildContextAdjacency(overlay);

  if (node) {
    const nodeItems = judge.buildQueueForNode(overlay, node);
    const items = nodeItems.slice(0, budget).map((it) => edgeItemResponse(overlay, it, ctx.detail, ctx.nodeOf, adjacency));
    return {
      ok: true,
      result: {
        epoch: overlay.epoch || 0,
        workspace,
        budget,
        node,
        eager: true,
        idle: items.length === 0,
        total: nodeItems.length,
        items,
        _mutation: { clearEagerNode: node },
      },
    };
  }

  const queue = judge.buildQueue(overlay);
  const slice = judge.nextSlice(queue, overlay.judgeCursor || 0, budget);
  const items = slice.items.map((it) => itemResponse(overlay, workspace, it, ctx, adjacency));
  return {
    ok: true,
    result: {
      epoch: overlay.epoch || 0,
      workspace,
      budget,
      idle: slice.idle,
      total: slice.total,
      cursorBefore: slice.cursorBefore,
      cursorAfter: slice.cursorAfter,
      items,
      _mutation: { cursorAfter: slice.cursorAfter, idle: slice.idle },
    },
  };
}

try {
  parentPort.postMessage(assemble());
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.stack) || e) });
}
