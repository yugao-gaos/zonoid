// File-drop task source: the daemon's OWN documented task-minting substrate (multi-harness
// plan, Phase 2). Non-Claude harness adapters mint a task by dropping a JSON stub file into
// their designated per-workspace folder; the daemon PULLS (aggregation + fs.watch + POST /sync),
// exactly as it does for Claude's native files. This is CORE code, not adapter code — the
// format below is ours and versioned, unlike Claude's internal one.
//
// Folder layout (v1):
//   <dataDir>/tasks/<workspace-key>/<harness>/<id>.json
//     dataDir       = process.env.CLAUDE_PLUGIN_DATA || ~/.claude/orchestrator
//     workspace-key = `<sanitized basename>-<sha1(workspace abs path) hex, first 16>`
//                     — the SAME collision-free naming the overlay store uses for its files
//                     (see lib/overlay.js fileFor); exposed here as workspaceKey().
//     harness       = any folder name (conventionally cursor | codex | opencode | local —
//                     the set is NOT hardcoded; any subfolder is accepted as a namespace).
//                     Avoid 'followup' (reserved by the daemon's follow-up machinery) and
//                     uuid-like names (Claude's session namespace).
//     <id>.json     = one stub per task.
//
// Stub format (v1, documented):
//   { id, subject, description, status, blockedBy, created_by: { harness, agent_id } }
//     id, subject  required — a stub missing either is skipped.
//     description  optional, defaults ''.
//     status       optional, defaults 'pending' (same vocabulary as Claude native:
//                  pending | in_progress | completed).
//     blockedBy    optional array of task keys in ANY namespace ('<harness>/<id>' or Claude's
//                  '<session-uuid>/<id>'); a bare id (no '/') is namespaced to the stub's own
//                  harness folder.
//     created_by   optional provenance: { harness, agent_id }.
//
// Atomic-write convention: writers write `<file>.tmp` (any '.tmp'-suffixed name) then rename.
// The reader only considers files ending in exactly '.json', so in-flight tmp files are
// ignored; unreadable/partial files are skipped (mirrors readSessionTasks' tolerance).
//
// Keys are '<harness>/<id>' — they never collide with Claude's '<session-uuid>/<id>' keys.
// Stub files are durable (we control retention; no cleanupPeriodDays sweep applies), so unlike
// Claude native tasks they need no overlay snapshot fallback — see daemon.js snapshotNative.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BASE = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'orchestrator');
const ROOT = path.join(BASE, 'tasks');

// Collision-free per-workspace folder name; MUST stay in lockstep with lib/overlay.js fileFor
// (same readable-prefix + content-hash scheme, applied to a directory name instead of a file).
function workspaceKey(workspace) {
  const h = crypto.createHash('sha1').update(String(workspace || '')).digest('hex').slice(0, 16);
  const base = (path.basename(String(workspace || '')) || 'ws').replace(/[^A-Za-z0-9._-]/g, '_');
  return `${base}-${h}`;
}

// The designated folder tree for one workspace (parent of the per-harness subfolders).
function dirFor(workspace) {
  return path.join(ROOT, workspaceKey(workspace));
}

// Split a '<harness>/<id>' key. Returns null for unkeyed input (no '/' or empty parts).
function splitKey(key) {
  const k = String(key || '');
  const i = k.indexOf('/');
  if (i <= 0 || i === k.length - 1) return null;
  return { harness: k.slice(0, i), id: k.slice(i + 1) };
}

// Absolute stub-file path for a key, or null when the key is unkeyed.
function stubFile(workspace, key) {
  const k = splitKey(key);
  return k ? path.join(dirFor(workspace), k.harness, `${k.id}.json`) : null;
}

// Read ONE stub file by namespaced key. Returns the parsed raw stub or null (missing/unreadable).
function readStub(workspace, key) {
  const file = stubFile(workspace, key);
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Union all harness subfolders of a workspace's designated folder into namespaced tasks in the
// SAME aggregate shape as the harness adapter's aggregateWorkspace:
//   { key: '<harness>/<id>', session: '<harness>', id, label, description, native_status, deps[] }
// deps: blockedBy entries carrying a '/' pass through verbatim (cross-namespace keys are legal);
// bare ids are namespaced to the stub's own harness. Tolerant: a missing folder yields [],
// unreadable/partial stubs and stubs missing id/subject are skipped, '*.tmp' is never read.
function aggregateWorkspace(workspace) {
  const root = dirFor(workspace);
  let harnesses;
  try { harnesses = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }
  const tasks = [];
  for (const harness of harnesses) {
    let files;
    try { files = fs.readdirSync(path.join(root, harness)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue; // skip .tmp / .lock / anything else
      let t;
      try { t = JSON.parse(fs.readFileSync(path.join(root, harness, f), 'utf8')); } catch { continue; }
      if (!t || t.id == null || !t.subject) continue; // id + subject required by the stub format
      tasks.push({
        key: `${harness}/${t.id}`,
        session: harness,
        id: String(t.id),
        label: t.subject,
        description: t.description || '',
        native_status: t.status || 'pending',
        deps: (Array.isArray(t.blockedBy) ? t.blockedBy : []).map((b) => String(b).includes('/') ? String(b) : `${harness}/${b}`),
      });
    }
  }
  return tasks;
}

// Status write-through for a stub: set the `status` field on the stub file, preserving every
// other field. Atomic temp+rename (same convention writers use). Best-effort, never throws.
// Returns true on a successful write, false when the key is unkeyed or no stub file exists —
// which doubles as the ownership test daemon.js writeTaskStatus routes on (a Claude
// '<session>/<id>' key has no stub file here, so it falls through to the harness adapter).
function writeStatus(workspace, key, status) {
  const file = stubFile(workspace, key);
  if (!file) return false;
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    t.status = status;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(t, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

// Watch the whole designated-folder tree (every workspace), firing onChange on any write, so
// dropped stubs invalidate the daemon's aggregate cache within the TTL without needing /sync.
// The root is OURS, so it is created if missing (fs.watch throws on a missing dir). Returns a
// disposer; no-op disposer when watching is unavailable (callers fall back to their TTL caches).
function watch(onChange) {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    const w = fs.watch(ROOT, { recursive: true }, onChange);
    return () => { try { w.close(); } catch { /* already closed */ } };
  } catch { return () => {}; }
}


// Read ONE stub as a native-task-shaped object (for adoption/snapshot alongside Claude tasks).
function readTask(workspace, key) {
  const stub = readStub(workspace, key);
  if (!stub) return null;
  return {
    id: stub.id,
    subject: stub.subject,
    description: stub.description || '',
    status: stub.status || 'pending',
    blockedBy: Array.isArray(stub.blockedBy) ? stub.blockedBy : [],
    owner: stub.owner ?? null,
    metadata: stub.metadata ?? null,
  };
}

module.exports = { workspaceKey, dirFor, splitKey, stubFile, readStub, readTask, aggregateWorkspace, writeStatus, watch };
