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
  return { id, label: null, kind: null, workspace: null, status: null, summary: null, knowledge: [], note: null, snapshot: null, last_actor: null, last_agent_id: null };
}

// ── open ─────────────────────────────────────────────────────────────────────

function open(graphDir) {
  const nodesDir      = path.join(graphDir, 'nodes');
  const checkpointFile = path.join(graphDir, 'checkpoint.json');
  try { fs.mkdirSync(nodesDir, { recursive: true }); } catch { /* ignore */ }
  return { dir: graphDir, nodesDir, checkpointFile };
}

// ── appendEvent ───────────────────────────────────────────────────────────────

function appendEvent(store, nodeId, event) {
  if (!event || !event.evt)  throw new Error('event.evt is required');
  if (!event.actor)          throw new Error('event.actor is required');
  const ev   = { ...event, ts: event.ts || new Date().toISOString() };
  const dest = path.join(store.nodesDir, `${nodeId}.jsonl`);
  const line = JSON.stringify(ev) + '\n';
  const tmp  = `${dest}.${process.pid}.tmp`;
  try { fs.mkdirSync(require('path').dirname(dest), { recursive: true }); } catch { /* ignore */ }
  let existing = '';
  try { existing = fs.readFileSync(dest, 'utf8'); } catch { /* new file */ }
  fs.writeFileSync(tmp, existing + line);
  fs.renameSync(tmp, dest);
}

// ── loadGraph ────────────────────────────────────────────────────────────────

function loadGraph(store) {
  const nodes      = {};
  const edges      = [];
  const backEdges  = {};
  const edgeSeen   = new Set();

  let checkpointed = {};
  try {
    const cp = JSON.parse(fs.readFileSync(store.checkpointFile, 'utf8'));
    if (cp && cp.nodes) checkpointed = cp.nodes;
  } catch { /* no checkpoint yet */ }

  let files = [];
  try { files = fs.readdirSync(store.nodesDir, { recursive: true }).filter((f) => f.endsWith('.jsonl')); } catch { /* empty */ }

  for (const file of files) {
    const nodeId = file.slice(0, -6);
    let raw = '';
    try { raw = fs.readFileSync(path.join(store.nodesDir, file), 'utf8'); } catch { continue; }

    if (!nodes[nodeId]) nodes[nodeId] = EMPTY_NODE(nodeId);
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
        case 'edge_added': {
          const eKey = `${ev.from}\0${ev.to}\0${ev.kind || 'blocking'}`;
          if (!edgeSeen.has(eKey)) {
            edgeSeen.add(eKey);
            const e = { from: ev.from, to: ev.to, kind: ev.kind || 'blocking' };
            if (ev.fromWorkspace) e.fromWorkspace = ev.fromWorkspace;
            if (typeof ev.weight === 'number') e.weight = ev.weight;
            edges.push(e);
            if (!backEdges[ev.to]) backEdges[ev.to] = [];
            backEdges[ev.to].push({
              from: ev.from,
              kind: e.kind,
              ...(e.fromWorkspace ? { fromWorkspace: e.fromWorkspace } : {}),
              ...(typeof ev.weight === 'number' ? { weight: ev.weight } : {}),
            });
          }
          break;
        }
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
      .forEach((f) => liveFiles.add(f.slice(0, -6)));
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

  atomicWrite(
    store.checkpointFile,
    JSON.stringify({ nodes: existing, compacted_at: new Date().toISOString() }, null, 2)
  );

  let count = 0;
  for (const n of toCompact) {
    try { fs.rmSync(path.join(store.nodesDir, `${n.id}.jsonl`)); count++; } catch { /* best effort */ }
  }
  return { compacted: count };
}

// ── initGitAttributes ────────────────────────────────────────────────────────

function initGitAttributes(repoRoot) {
  const file  = path.join(repoRoot, '.gitattributes');
  const entry = '.graph/nodes/*.jsonl merge=union';
  let content = '';
  try { content = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  if (content.split('\n').some((l) => l.trim() === entry)) return;
  const updated = content.endsWith('\n') || content === ''
    ? content + entry + '\n'
    : content + '\n' + entry + '\n';
  atomicWrite(file, updated);
}

// ── exports ───────────────────────────────────────────────────────────────────

module.exports = { open, appendEvent, loadGraph, compact, initGitAttributes };
