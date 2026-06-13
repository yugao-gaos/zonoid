'use strict';
// Atomic stub writer for the daemon file-drop task substrate (lib/filedrop-tasks.js layout).
// Harness adapters call this from plugin tools; unit-tested without OpenCode runtime.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HARNESS = 'opencode';

function baseDir() {
  const base = process.env.CLAUDE_PLUGIN_DATA || path.join(require('os').homedir(), '.claude', 'orchestrator');
  return path.join(base, 'tasks');
}

function workspaceKey(workspace) {
  const h = crypto.createHash('sha1').update(String(workspace || '')).digest('hex').slice(0, 16);
  const base = (path.basename(String(workspace || '')) || 'ws').replace(/[^A-Za-z0-9._-]/g, '_');
  return `${base}-${h}`;
}

function dirFor(workspace) {
  return path.join(baseDir(), workspaceKey(workspace));
}

function stubPath(workspace, id) {
  return path.join(dirFor(workspace), HARNESS, `${id}.json`);
}

/** Write a v1 stub file atomically (.tmp then rename). Returns { key, file, stub }. */
function writeTaskStub(workspace, { id, subject, description, status, blockedBy, agent_id }) {
  if (!id || !subject) throw new Error('task_create: id and subject are required');
  const dir = path.join(dirFor(workspace), HARNESS);
  fs.mkdirSync(dir, { recursive: true });
  const file = stubPath(workspace, String(id));
  const stub = {
    id: String(id),
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

module.exports = { HARNESS, workspaceKey, dirFor, stubPath, writeTaskStub };
