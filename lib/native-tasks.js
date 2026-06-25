// Native task aggregator. Reads Claude Code's per-session task files and unions them
// into one workspace-wide list with globally-unique, namespaced keys.
//
// WARNING: the on-disk layout (~/.claude/tasks/{session}/{id}.json and the projects dir
// encoding) is UNDOCUMENTED / internal. This module is the single adapter for it — if a
// Claude Code version changes the format, only this file should need updating.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeDeps } = require('./filedrop-tasks');

const CLAUDE = path.join(os.homedir(), '.claude');
const PROJECTS = path.join(CLAUDE, 'projects');
const TASKS = path.join(CLAUDE, 'tasks');
const TERMINAL_STATUSES = new Set(['done', 'completed', 'tested', 'failed', 'canceled']);

// Claude Code encodes an absolute workspace path into a projects-dir name by replacing
// path separators ('/' and Windows '\'), '.', and the Windows drive colon ':' with '-'
// (e.g. /Users/x/Desktop/app/.claude → -Users-x-Desktop-app--claude; D:\zonoid → D--zonoid).
function encodeWorkspace(absPath) {
  return String(absPath || '').replace(/[/.\\:]/g, '-');
}

// Session UUIDs for a workspace = the basenames under its projects dir (both `<uuid>.jsonl`
// files and `<uuid>` directories appear; dedupe).
function listSessions(workspaceAbsPath) {
  const dir = path.join(PROJECTS, encodeWorkspace(workspaceAbsPath));
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const ids = new Set();
  for (const e of entries) {
    const base = e.endsWith('.jsonl') ? e.slice(0, -'.jsonl'.length) : e;
    if (/^[0-9a-f-]{8,}$/i.test(base)) ids.add(base);
  }
  return [...ids];
}

// Read one session's native tasks. Returns [] if the session has none.
function readSessionTasks(sessionId) {
  const dir = path.join(TASKS, sessionId);
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue; // skip .lock
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (t && t.id != null && t.status !== 'deleted') out.push(t);
    } catch { /* skip unreadable/partial */ }
  }
  return out;
}

// Read ONE native task file. Returns the parsed task or null (missing/unreadable).
function readTask(session, id) {
  try { return JSON.parse(fs.readFileSync(path.join(TASKS, session, `${id}.json`), 'utf8')); }
  catch { return null; }
}

function mergedNativeStatus(liveStatus, snapStatus) {
  if (snapStatus && TERMINAL_STATUSES.has(String(snapStatus))) return snapStatus;
  return liveStatus || snapStatus || 'pending';
}

// Union all sessions in a workspace into namespaced tasks.
// task: { key, session, id, label, description, native_status, deps[] }
//   key  = "{session}/{id}"
//   deps = intra-session blockedBy, namespaced to the same session
// `snapshots` (optional): the overlay's per-key adopted/frozen copies of native fields. Claude
// native tasks are adopted at first sight (id, title, blockedBy); once adopted the snapshot is
// authoritative for structure while the native file is a live echo (status/title changes fold
// in). When the native file is gone (cleanupPeriodDays retention sweep) we serve the snapshot.
function aggregateWorkspace(workspaceAbsPath, snapshots) {
  const tasks = [];
  const seen = new Set();
  for (const session of listSessions(workspaceAbsPath)) {
    for (const t of readSessionTasks(session)) {
      const key = `${session}/${t.id}`;
      seen.add(key);
      const snap = (snapshots || {})[key];
      if (snap) {
        tasks.push({
          key, session, id: String(t.id),
          label: t.subject || t.activeForm || snap.subject || String(t.id),
          description: snap.description || '',
          native_status: mergedNativeStatus(t.status, snap.status),
          deps: normalizeDeps(session, snap.blockedBy),
        });
      } else {
        tasks.push({
          key, session, id: String(t.id),
          label: t.subject || t.activeForm || String(t.id),
          description: t.description || '',
          native_status: t.status || 'pending',
          deps: (t.blockedBy || []).map((bid) => `${session}/${bid}`),
        });
      }
    }
  }
  for (const [key, s] of Object.entries(snapshots || {})) {
    if (seen.has(key)) continue;            // native file still present — merged above
    const i = key.indexOf('/');
    if (i <= 0) continue;
    const session = key.slice(0, i), id = key.slice(i + 1);
    tasks.push({
      key,
      session,
      id,
      label: s.subject || id,
      description: s.description || '',
      native_status: s.status || 'completed',
      deps: normalizeDeps(session, s.blockedBy),
    });
  }
  return tasks;
}

// Write-through: set the `status` field on a native task file (~/.claude/tasks/{session}/{id}.json),
// preserving every other field. Atomic temp+rename. Best-effort: never throws (the daemon calls this
// as a side-effect of /overlay/status and must not fail the request if the native file is missing).
// Returns true on a successful write, false otherwise.
function writeStatus(session, id, status) {
  try {
    const file = path.join(TASKS, session, `${id}.json`);
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    t.status = status;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(t, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

// Format-health check: detects if the (undocumented) native task format has drifted, so we
// fail loud instead of silently dropping tasks. Returns counts + sample anomalies.
function formatHealth(workspaceAbsPath) {
  const sessions = listSessions(workspaceAbsPath);
  let files = 0, parsed = 0, wellFormed = 0;
  const anomalies = [];
  for (const session of sessions) {
    const dir = path.join(TASKS, session);
    let entries; try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      files++;
      let t; try { t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { if (anomalies.length < 5) anomalies.push(`${session}/${f}: unparseable`); continue; }
      parsed++;
      const ok = t && t.id != null && typeof t.status === 'string' && Array.isArray(t.blockedBy ?? []);
      if (ok) wellFormed++; else if (anomalies.length < 5) anomalies.push(`${session}/${f}: missing id/status/blockedBy`);
    }
  }
  return { sessions: sessions.length, files, parsed, wellFormed, anomalies, healthy: files === 0 || wellFormed / Math.max(1, files) >= 0.8 };
}

module.exports = { encodeWorkspace, listSessions, readSessionTasks, readTask, aggregateWorkspace, writeStatus, formatHealth };
