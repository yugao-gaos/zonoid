// Per-workspace overlay store: the things native tasks can't hold —
// cross-session dependency edges, richer statuses, and notes. Persisted to disk so it
// survives daemon restarts and is shared by every session in the workspace.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { encodeWorkspace } = require('./native-tasks');

const BASE = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'orchestrator');
const DIR = path.join(BASE, 'overlay');
// edges: cross-session/workspace deps · status: richer-status overrides · notes: freeform
// summaries: on-complete "interface" summary per task (Tier-1 context) · knowledge: Tier-2
// context items per task · assignee: which agent is working a task (for live animation)
// timestamps: per-task { firstSeen, lastChanged, lastStatus } — daemon-observed task lifecycle
// git: per-task { branch, worktree, head, createdAt } — the isolated attempt worktree for a task
const EMPTY = () => ({ edges: [], status: {}, notes: {}, summaries: {}, knowledge: {}, assignee: {}, timestamps: {}, config: {}, git: {}, note_nodes: {} });

// Collision-free overlay filename: encodeWorkspace is lossy (both `/` and `.` → `-`), so distinct
// workspaces could map to ONE file and clobber each other (review H2). Use a content hash, keeping a
// readable basename prefix for debuggability.
function fileFor(workspace) {
  const h = crypto.createHash('sha1').update(String(workspace || '')).digest('hex').slice(0, 16);
  const base = (path.basename(String(workspace || '')) || 'ws').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(DIR, `${base}-${h}.json`);
}
// Pre-hash filename — read for one-time migration of overlays written before the H2 fix.
function legacyFileFor(workspace) {
  return path.join(DIR, `${encodeWorkspace(workspace)}.json`);
}

function load(workspace) {
  let o = null;
  try { o = JSON.parse(fs.readFileSync(fileFor(workspace), 'utf8')); }
  catch { try { o = JSON.parse(fs.readFileSync(legacyFileFor(workspace), 'utf8')); } catch { o = null; } }
  return o ? { ...EMPTY(), ...o } : EMPTY();
}

function save(workspace, overlay) {
  fs.mkdirSync(DIR, { recursive: true });
  const dest = fileFor(workspace);
  const tmp = `${dest}.${process.pid}.tmp`;            // atomic write: temp + rename (review H1)
  fs.writeFileSync(tmp, JSON.stringify(overlay, null, 2));
  fs.renameSync(tmp, dest);
}

// Add a dependency edge from -> to. Idempotent.
//   kind 'blocking' (default): `to` is blocked by `from` (scheduling — gates readiness).
//   kind 'context': non-blocking provenance — `from`'s summary flows into `to` as Tier-1
//     context even when `from` is already done. Lets new tasks pull existing nodes' summaries
//     without making the graph a flat list of roots.
// fromWorkspace set ⇒ ghost edge: the provider `from` lives in another workspace.
// Stored in the CONSUMER's overlay (the workspace owning `to`).
function addEdge(overlay, from, to, fromWorkspace, kind) {
  const fw = fromWorkspace || null;
  const existing = overlay.edges.find((e) => e.from === from && e.to === to && (e.fromWorkspace || null) === fw);
  if (existing) {
    if (kind === 'context') existing.kind = 'context';   // upgrade blocking → context on re-add (never silently downgrade)
    return overlay;
  }
  const edge = { from, to };
  if (fromWorkspace) edge.fromWorkspace = fromWorkspace;
  if (kind === 'context') edge.kind = 'context';         // omit for blocking (absent = blocking, back-compat)
  overlay.edges.push(edge);
  return overlay;
}

function setStatus(overlay, key, status, note) {
  overlay.status[key] = status;
  if (note != null) overlay.notes[key] = String(note).slice(0, 280);
  return overlay;
}

// Record/merge the git attempt worktree info for a task. Stamps createdAt on first write.
function setGit(overlay, key, info) {
  overlay.git[key] = { ...(overlay.git[key] || { createdAt: new Date().toISOString() }), ...info };
  return overlay;
}

// Add a "note node": an overlay-only graph node capturing durable conversation knowledge
// (a decision/finding) as a Tier-1 context provider. It is NOT a native todo — it lives only
// in the overlay and surfaces in the graph via buildGraph + context edges. Returns the id.
function addNoteNode(overlay, { title, summary, knowledge, created_by }) {
  const id = `note-${Date.now().toString(36)}`;
  overlay.note_nodes[id] = {
    id,
    title: String(title || '').slice(0, 200),
    summary: String(summary || '').slice(0, 2000),
    knowledge: Array.isArray(knowledge) ? knowledge : [],
    created_by: created_by || null,
    created_at: new Date().toISOString(),
  };
  return id;
}

module.exports = { load, save, addEdge, setStatus, setGit, addNoteNode, EMPTY };
