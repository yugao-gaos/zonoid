'use strict';
// Atomic stub writer for the daemon file-drop task substrate (lib/filedrop-tasks.js layout).
// Harness adapters call this from plugin tools; unit-tested without OpenCode runtime.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HARNESS = 'opencode';

function resolveDataDir() {
  try {
    return require('../../../lib/runtime-paths').resolveDataDir();
  } catch {
    if (process.env.ORCH_DATA) return path.resolve(process.env.ORCH_DATA);
    if (process.env.ZONOID_DATA) return path.resolve(process.env.ZONOID_DATA);
    if (process.env.CLAUDE_PLUGIN_DATA) {
      const legacy = path.resolve(process.env.CLAUDE_PLUGIN_DATA);
      const isInstall = fs.existsSync(path.join(legacy, 'daemon.js'))
        && fs.existsSync(path.join(legacy, 'mcp-graph.js'))
        && fs.existsSync(path.join(legacy, 'package.json'));
      return isInstall ? path.join(legacy, '.zonoid') : legacy;
    }
    return path.join(require('os').homedir(), '.claude', 'orchestrator', '.zonoid');
  }
}

function baseDir() {
  return path.join(resolveDataDir(), 'tasks');
}

function workspaceKey(workspace) {
  const h = crypto.createHash('sha1').update(String(workspace || '')).digest('hex').slice(0, 16);
  const base = (path.basename(String(workspace || '')) || 'ws').replace(/[^A-Za-z0-9._-]/g, '_');
  return `${base}-${h}`;
}

function dirFor(workspace) {
  return path.join(baseDir(), workspaceKey(workspace));
}

function normalizeTaskId(id) {
  const normalized = String(id ?? '').trim();
  if (!normalized) throw new Error('task_create: id and subject are required');
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error('task_create: id may contain only letters, numbers, dot, underscore, and dash');
  }
  return normalized;
}

function stubPath(workspace, id) {
  return path.join(dirFor(workspace), HARNESS, `${normalizeTaskId(id)}.json`);
}

/** Write a v1 stub file atomically (.tmp then rename). Returns { key, file, stub }. */
function writeTaskStub(workspace, { id, subject, description, status, blockedBy, agent_id }) {
  if (!subject) throw new Error('task_create: id and subject are required');
  const taskId = normalizeTaskId(id);
  const dir = path.join(dirFor(workspace), HARNESS);
  fs.mkdirSync(dir, { recursive: true });
  const file = stubPath(workspace, taskId);
  const stub = {
    id: taskId,
    subject: String(subject),
    description: description != null ? String(description) : '',
    status: status || 'pending',
    blockedBy: Array.isArray(blockedBy) ? blockedBy.map(String) : [],
    created_by: { harness: HARNESS, agent_id: agent_id || null },
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stub, null, 2));
  fs.renameSync(tmp, file);
  return { key: `${HARNESS}/${stub.id}`, file, stub };
}

module.exports = { HARNESS, workspaceKey, dirFor, stubPath, normalizeTaskId, writeTaskStub };
