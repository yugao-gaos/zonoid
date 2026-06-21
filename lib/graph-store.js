'use strict';
const fs   = require('fs');
const path = require('path');

const TERMINAL = new Set(['done', 'tested', 'failed', 'canceled']);

// ── helpers ──────────────────────────────────────────────────────────────────

function atomicWrite(dest, content) {
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, dest);
}

function EMPTY_NODE(id) {
  return { id, label: null, kind: null, workspace: null, status: null, summary: null, knowledge: [], note: null, knowledge_node: null, snapshot: null, assignee: null, timestamps: null, metrics: null, measurements: null, usage_records: null, last_actor: null, last_agent_id: null };
}

// ── open ─────────────────────────────────────────────────────────────────────

function open(graphDir) {
  const nodesDir      = path.join(graphDir, 'nodes');
  const checkpointFile = path.join(graphDir, 'checkpoint.json');
  try { fs.mkdirSync(nodesDir, { recursive: true }); } catch { /* ignore */ }
  return { dir: graphDir, nodesDir, checkpointFile };
}

// ── canonicalEventNodeId ──────────────────────────────────────────────────────

function canonicalEventNodeId(nodeId) {
  return /^note-[0-9a-z]+$/.test(nodeId) ? 'note:' + nodeId : nodeId;
}

// ── filename codec ─────────────────────────────────────────────────────────────
// Node IDs like 'note:note-XXXX' or 'system:repos' contain ':', which Windows forbids
// in filenames (breaks git checkout). We encode ONLY ':' as '%3A' in the on-disk name;
// the in-memory node ID keeps the ':' unchanged so all edges/checkpoint refs still resolve.
// '/' is an intentional subdir separator (e.g. 'followup/...') and is NOT encoded.

function idToFile(id) {
  return id.replace(/:/g, '%3A') + '.jsonl';
}

function fileToId(relPath) {
  const base = relPath.replace(/\.jsonl$/, '');
  // Normalize Windows path separators back to '/', then decode the colon.
  return base.split(/[\\/]/).join('/').replace(/%3A/g, ':');
}

// ── appendEvent ───────────────────────────────────────────────────────────────

function appendEvent(store, nodeId, event) {
  if (!event || !event.evt)  throw new Error('event.evt is required');
  if (!event.actor)          throw new Error('event.actor is required');
  const ev   = { ...event, ts: event.ts || new Date().toISOString() };
  const dest = path.join(store.nodesDir, idToFile(canonicalEventNodeId(nodeId)));
  const line = JSON.stringify(ev) + '\n';
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { /* ignore */ }
  // O(1) append; a crash can at worst truncate the trailing line, which loadGraph skips.
  fs.appendFileSync(dest, line);
}

// ── loadGraph ────────────────────────────────────────────────────────────────

function loadGraph(store) {
  const nodes      = {};
  const edges      = [];
  const backEdges  = {};
  const edgeSeen   = new Set();
  const edgeBySig  = new Map(); // from\0to\0kind\0fromWorkspace -> { edge, back } live refs

  let checkpointed = {};
  let checkpointEdges = [];
  try {
    const cp = JSON.parse(fs.readFileSync(store.checkpointFile, 'utf8'));
    if (cp && cp.nodes) checkpointed = cp.nodes;
    if (cp && Array.isArray(cp.edges)) checkpointEdges = cp.edges;
  } catch { /* no checkpoint yet */ }

  const edgeKey = (ev) => `${ev.from}\0${ev.to}\0${ev.kind || 'blocking'}\0${ev.fromWorkspace || ''}`;
  const addEdge = (ev) => {
    const eKey = edgeKey(ev);
    if (edgeSeen.has(eKey)) return;
    edgeSeen.add(eKey);
    const e = { from: ev.from, to: ev.to, kind: ev.kind || 'blocking' };
    if (ev.fromWorkspace) e.fromWorkspace = ev.fromWorkspace;
    if (typeof ev.weight === 'number') e.weight = ev.weight;
    // Edge judging metadata (by/judged/score/origin) — added in-memory by autowire/judge and persisted
    // on the edge_added event + checkpoint. Without restoring them, the judging→ready gate keys off a
    // dropped judged:false and silently no-ops after a restart.
    if (ev.by !== undefined) e.by = ev.by;
    if (ev.judged !== undefined) e.judged = ev.judged;
    else if (typeof ev.weight === 'number' && ev.weight > 0) e.judged = true; // back-compat: legacy
    // events lack `judged`; a promoted edge (weight>0) was judged-kept, so default judged:true rather
    // than letting tagBlindEdges re-stamp it judged:false and flip every old promoted edge to unjudged.
    if (typeof ev.score === 'number') e.score = ev.score;
    if (ev.origin !== undefined) e.origin = ev.origin;
    edges.push(e);
    if (!backEdges[ev.to]) backEdges[ev.to] = [];
    const back = {
      from: ev.from,
      kind: e.kind,
      ...(e.fromWorkspace ? { fromWorkspace: e.fromWorkspace } : {}),
      ...(typeof ev.weight === 'number' ? { weight: ev.weight } : {}),
      ...(e.by !== undefined ? { by: e.by } : {}),
      ...(e.judged !== undefined ? { judged: e.judged } : {}),
      ...(typeof e.score === 'number' ? { score: e.score } : {}),
      ...(e.origin !== undefined ? { origin: e.origin } : {}),
    };
    backEdges[ev.to].push(back);
    edgeBySig.set(eKey, { edge: e, back });
  };
  const removeEdge = (ev) => {
    const eKey = edgeKey(ev);
    edgeSeen.delete(eKey);
    edgeBySig.delete(eKey);
    const fw = ev.fromWorkspace || null;
    const kind = ev.kind || 'blocking';
    for (let i = edges.length - 1; i >= 0; i--) {
      const e = edges[i];
      if (e.from === ev.from && e.to === ev.to && (e.kind || 'blocking') === kind && (e.fromWorkspace || null) === fw) {
        edges.splice(i, 1);
      }
    }
    const backs = backEdges[ev.to];
    if (Array.isArray(backs)) {
      backEdges[ev.to] = backs.filter((b) => !(b.from === ev.from && (b.kind || 'blocking') === kind && (b.fromWorkspace || null) === fw));
      if (backEdges[ev.to].length === 0) delete backEdges[ev.to];
    }
  };

  // edge_promoted: keepEdge mutated an existing edge IN PLACE (weight 0→score, judged false→true, by).
  // edge_added's first-sight dedupe would otherwise keep the stale weight-0/unjudged values, so apply
  // the promotion onto the already-built edge (both the edge and its backEdge mirror). If the promote
  // event is replayed BEFORE its edge_added (different-file read order), fall through to addEdge so the
  // edge is created carrying the promoted state — never dropped.
  const promoteEdge = (ev) => {
    const eKey = edgeKey(ev);
    const ref = edgeBySig.get(eKey);
    if (!ref) { addEdge(ev); return; }
    const apply = (obj) => {
      if (typeof ev.weight === 'number') obj.weight = ev.weight;
      if (ev.by !== undefined) obj.by = ev.by;
      if (ev.judged !== undefined) obj.judged = ev.judged;
      if (typeof ev.score === 'number') obj.score = ev.score;
      if (ev.origin !== undefined) obj.origin = ev.origin;
    };
    apply(ref.edge);
    apply(ref.back);
  };

  // Replay checkpointed edges first — compaction deletes the JSONL files whose edge_added
  // events produced them, so the checkpoint is their only surviving record. edgeSeen dedupes
  // against edges still present in live files.
  for (const e of checkpointEdges) { if (e && e.from && e.to) addEdge(e); }

  let files = [];
  try { files = fs.readdirSync(store.nodesDir, { recursive: true }).filter((f) => f.endsWith('.jsonl')); } catch { /* empty */ }

  for (const file of files) {
    const rawId = fileToId(file);
    // note_created events historically stored in the short note-ID.jsonl file
    // while edge_added events go to note:note-ID.jsonl. Canonicalize on read.
    const nodeId = /^note-[0-9a-z]+$/.test(rawId) ? 'note:' + rawId : rawId;
    let raw = '';
    try { raw = fs.readFileSync(path.join(store.nodesDir, file), 'utf8'); } catch { continue; }

    if (!nodes[nodeId]) {
      // A live file for a checkpointed node means events were appended AFTER compaction —
      // fold them on top of the checkpointed state, not an empty node.
      const base = checkpointed[nodeId];
      nodes[nodeId] = base
        ? { ...EMPTY_NODE(nodeId), ...base, id: nodeId, knowledge: [...(base.knowledge || [])] }
        : EMPTY_NODE(nodeId);
    }
    const node = nodes[nodeId];

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev;
      try { ev = JSON.parse(trimmed); } catch { continue; }

      switch (ev.evt) {
        case 'node_created':
          node.label     = ev.label     ?? node.label;
          node.kind      = ev.kind      ?? node.kind;
          node.workspace = ev.workspace ?? node.workspace;
          break;
        case 'note_created':
          node.label     = ev.title     ?? node.label;
          node.kind      = 'note';
          node.workspace = ev.workspace ?? node.workspace;
          node.summary   = ev.summary   ?? node.summary;
          if (Array.isArray(ev.knowledge)) node.knowledge = [...node.knowledge, ...ev.knowledge];
          node.note = {
            title:      ev.title      || null,
            summary:    ev.summary    || null,
            created_by: ev.created_by || null,
            valid_from: ev.valid_from || null,
          };
          if (Array.isArray(ev.vec)) node.vec = ev.vec;
          if (Array.isArray(ev.vecs)) node.vecs = ev.vecs;
          if (ev.vecMeta) node.vecMeta = ev.vecMeta;
          if (Array.isArray(ev.vecsMeta)) node.vecsMeta = ev.vecsMeta;
          break;
        case 'note_vec_set':
          if (Array.isArray(ev.vec)) node.vec = ev.vec;
          if (ev.vecMeta) node.vecMeta = ev.vecMeta;
          break;
        case 'note_vecs_set':
          if (Array.isArray(ev.vecs)) node.vecs = ev.vecs;
          if (Array.isArray(ev.vecsMeta)) node.vecsMeta = ev.vecsMeta;
          break;
        case 'knowledge_node_upserted':
          node.label     = ev.label     ?? ev.title ?? node.label;
          node.kind      = ev.type      ?? ev.kind  ?? node.kind;
          node.workspace = ev.workspace ?? node.workspace;
          node.summary   = ev.summary   ?? node.summary;
          node.knowledge_node = {
            id:          ev.id          || nodeId,
            key:         ev.key         || ev.id || nodeId,
            type:        ev.type        || ev.kind || node.kind,
            label:       ev.label       || ev.title || node.label,
            title:       ev.title       || ev.label || node.label,
            summary:     ev.summary     || node.summary,
            metadata:    ev.metadata && typeof ev.metadata === 'object' ? ev.metadata : {},
            source_path: ev.source_path || null,
            section_ref: ev.section_ref || null,
            chunk_ref:   ev.chunk_ref   || null,
            cluster_ref: ev.cluster_ref || null,
            created_at:  ev.created_at  || null,
            updated_at:  ev.updated_at  || ev.ts || null,
          };
          if (Array.isArray(ev.vec)) node.vec = ev.vec;
          if (Array.isArray(ev.vecs)) node.vecs = ev.vecs;
          if (ev.vecMeta) node.vecMeta = ev.vecMeta;
          if (Array.isArray(ev.vecsMeta)) node.vecsMeta = ev.vecsMeta;
          break;
        case 'status_changed':
          node.status    = ev.status    ?? node.status;
          node.workspace = ev.workspace ?? node.workspace;
          if (ev.note != null) node.statusNote = String(ev.note).slice(0, 280);
          break;
        case 'summary_set':
          node.summary   = ev.summary   ?? node.summary;
          node.workspace = ev.workspace ?? node.workspace;
          break;
        case 'knowledge_added':
          if (ev.item) node.knowledge.push(ev.item);
          break;
        case 'edge_added':
          addEdge(ev);
          break;
        case 'edge_promoted':
          promoteEdge(ev);
          break;
        case 'edge_removed':
          removeEdge(ev);
          break;
        case 'snapshot_stored':
          node.snapshot = {
            subject:        ev.subject,
            description:    ev.description,
            status:         ev.status,
            blockedBy:      ev.blockedBy,
            owner:          ev.owner,
            metadata:       ev.metadata,
            snapshotted_at: ev.snapshotted_at || ev.ts,
          };
          break;
        case 'assignee_set':
          node.assignee = ev.assignee ?? node.assignee;
          break;
        case 'timestamps_set':
          node.timestamps = ev.timestamps ?? node.timestamps;
          break;
        case 'metrics_set':
          node.metrics = ev.metrics ?? node.metrics;
          break;
        case 'measurements_set':
          node.measurements = ev.measurements ?? node.measurements;
          break;
        case 'usage_recorded':
          if (ev.agent_id && ev.slice) {
            if (!node.usage_records) node.usage_records = {};
            node.usage_records[ev.agent_id] = ev.slice;
          }
          break;
        case 'benchmarks_set':
          node.benchmarks = ev.benchmarks ?? node.benchmarks;
          break;
        case 'repo_config_set':
          node.repos = ev.repos ?? node.repos;
          break;
        case 'note_superseded':
          if (ev.supersededBy) node.supersededBy = ev.supersededBy;
          if (ev.validTo) node.validTo = ev.validTo;
          break;
        case 'note_supersedes':
          if (ev.supersedes) node.supersedes = ev.supersedes;
          break;
        case 'note_reinforced':
          if (typeof ev.boost === 'number') node.reinforceBoost = (node.reinforceBoost || 0) + ev.boost;
          if (ev.winRate !== undefined) node.reinforceWinRate = ev.winRate;
          break;
        default:
          break;
      }
      if (ev.actor)    node.last_actor    = ev.actor;
      if (ev.agent_id) node.last_agent_id = ev.agent_id;
    }
  }

  return { nodes, edges, backEdges, checkpointed };
}

// ── compact ───────────────────────────────────────────────────────────────────

function compact(store) {
  const graph = loadGraph(store);

  let liveFiles = new Set();
  try {
    fs.readdirSync(store.nodesDir, { recursive: true })
      .filter((f) => f.endsWith('.jsonl'))
      .forEach((f) => liveFiles.add(fileToId(f)));
  } catch { /* empty */ }

  const toCompact = Object.values(graph.nodes).filter(
    (n) => TERMINAL.has(n.status) && liveFiles.has(n.id)
  );
  if (toCompact.length === 0) return { compacted: 0 };

  let existing = {};
  try {
    const cp = JSON.parse(fs.readFileSync(store.checkpointFile, 'utf8'));
    if (cp && cp.nodes) existing = cp.nodes;
  } catch { /* no checkpoint */ }

  for (const n of toCompact) existing[n.id] = n;

  // Persist the FULL deduped edge set, not just edges from compacted nodes: edge_added events
  // live inside arbitrary node JSONL files (usually the from-node's, but not guaranteed — e.g.
  // record-decision writes note→task edges into the note's file), so deleting any file can drop
  // edges. graph.edges already includes previously checkpointed edges, so this is lossless and
  // stable across repeated compactions.
  atomicWrite(
    store.checkpointFile,
    JSON.stringify({ nodes: existing, edges: graph.edges, compacted_at: new Date().toISOString() }, null, 2)
  );

  let count = 0;
  for (const n of toCompact) {
    try { fs.rmSync(path.join(store.nodesDir, idToFile(n.id))); count++; } catch { /* best effort */ }
  }
  return { compacted: count };
}

// ── initGitAttributes ────────────────────────────────────────────────────────

function initGitAttributes(repoRoot) {
  const file  = path.join(repoRoot, '.gitattributes');
  // `.graph` is daemon-owned state: on ANY merge the current branch's (main's) copy wins wholesale,
  // so an attempt branch's stale .graph snapshot can't clobber the daemon's live writes (FU-2 desync).
  // Needs the `ours` driver registered per-clone — git.ensureMergeDriver does that on workspace setup;
  // without the driver this attribute silently no-ops.
  const entry = '.graph/** merge=ours';
  let content = '';
  try { content = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  if (content.split('\n').some((l) => l.trim() === entry)) return;
  const updated = content.endsWith('\n') || content === ''
    ? content + entry + '\n'
    : content + '\n' + entry + '\n';
  atomicWrite(file, updated);
}

// ── workspace-keyed registry ──────────────────────────────────────────────────

const _stores    = new Map(); // wsPath → store handle
const _prevState = new Map(); // wsPath → prev-state snapshot

function forWorkspace(wsPath) {
  if (!_stores.has(wsPath)) {
    _stores.set(wsPath, open(path.join(wsPath, '.graph')));
  }
  return _stores.get(wsPath);
}

// Every store opened via forWorkspace (i.e. every workspace this process has loaded) —
// lets the daemon's periodic compaction cover all known workspaces, not just the primary.
function allStores() {
  return [..._stores.values()];
}

function getPrevState(wsPath) {
  return _prevState.get(wsPath) || { edges: [], status: {}, summaries: {}, knowledge: {}, note_nodes: {}, knowledge_nodes: {}, snapshots: {}, assignee: {}, timestamps: {}, metrics: {}, measurements: {}, benchmarks: {}, repos: {}, usage_records: {} };
}

function setPrevState(wsPath, overlay) {
  _prevState.set(wsPath, {
    // Shallow-CLONE each edge, not just the array: keepEdge promotes an edge IN PLACE (weight 0→score,
    // judged false→true). A spread-only [...edges] keeps the SAME object references, so the next save's
    // diff would compare an edge to itself and miss the promotion. Cloning freezes the field values at
    // snapshot time so emitDiff can detect the change and emit edge_promoted.
    edges:        overlay.edges      ? overlay.edges.map((e) => ({ ...e })) : [],
    status:       { ...(overlay.status     || {}) },
    summaries:    { ...(overlay.summaries  || {}) },
    knowledge:    Object.fromEntries(Object.entries(overlay.knowledge || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])),
    note_nodes:   { ...(overlay.note_nodes || {}) },
    knowledge_nodes: JSON.parse(JSON.stringify(overlay.knowledge_nodes || {})),
    snapshots:    { ...(overlay.snapshots  || {}) },
    assignee:     { ...(overlay.assignee   || {}) },
    timestamps:   { ...(overlay.timestamps || {}) },
    metrics:      { ...(overlay.metrics    || {}) },
    measurements: { ...(overlay.measurements || {}) },
    benchmarks:   { ...(overlay.benchmarks || {}) },
    repos:        { ...(overlay.repos      || {}) },
    usage_records: Object.fromEntries(Object.keys(overlay.usage_records || {}).map(k => [k, true])),
  });
}

// ── exports ───────────────────────────────────────────────────────────────────

module.exports = { open, appendEvent, loadGraph, compact, initGitAttributes, forWorkspace, allStores, getPrevState, setPrevState, canonicalEventNodeId, idToFile, fileToId };
