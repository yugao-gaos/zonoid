'use strict';
const fs = require('fs');
const path = require('path');
const runtimePaths = require('./runtime-paths');

const FALLBACK_RE = /^codex-mcp-\d+-[a-f0-9]{32}$/;

function bridgeFile() {
  return runtimePaths.adapterPath('codex', 'session-bridge.json');
}

function legacyBridgeFile() {
  if (process.env.ORCH_DATA) return path.join(path.resolve(process.env.ORCH_DATA), 'codex', 'session-bridge.json');
  if (process.env.ZONOID_DATA) return path.join(path.resolve(process.env.ZONOID_DATA), 'codex', 'session-bridge.json');
  const legacy = process.env.CLAUDE_PLUGIN_DATA
    ? path.resolve(process.env.CLAUDE_PLUGIN_DATA)
    : runtimePaths.legacyBaseDir();
  return path.join(legacy, 'codex', 'session-bridge.json');
}

function workspaceKey(workspace) {
  const s = String(workspace || '').trim();
  return s ? path.resolve(s) : '';
}

function readBridge(file = bridgeFile()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    if (file === bridgeFile()) {
      try {
        const data = JSON.parse(fs.readFileSync(legacyBridgeFile(), 'utf8'));
        return data && typeof data === 'object' ? data : {};
      } catch {
        return {};
      }
    }
    return {};
  }
}

function writeBridge(data, file = bridgeFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function writeLatestSession({ workspace, session_id, transcript = '', now = new Date().toISOString() }, file = bridgeFile()) {
  const sessionId = String(session_id || '').trim();
  const ws = workspaceKey(workspace);
  if (!sessionId || !ws) return { ok: false, error: 'workspace and session_id required' };

  const data = readBridge(file);
  const record = {
    session_id: sessionId,
    workspace: ws,
    transcript: transcript ? String(transcript) : '',
    updatedAt: now,
  };
  const next = {
    version: 1,
    workspaces: { ...((data && data.workspaces) || {}), [ws]: record },
    latest: record,
  };
  writeBridge(next, file);
  return { ok: true, record };
}

function latestSession({ workspace } = {}, file = bridgeFile()) {
  const data = readBridge(file);
  const ws = workspaceKey(workspace);
  if (ws && data.workspaces && data.workspaces[ws] && data.workspaces[ws].session_id) {
    return data.workspaces[ws];
  }
  if (!ws && data.latest && data.latest.session_id) return data.latest;
  return null;
}

function isCodexProcessFallback(session) {
  return FALLBACK_RE.test(String(session || '').trim());
}

module.exports = {
  bridgeFile,
  legacyBridgeFile,
  readBridge,
  writeLatestSession,
  latestSession,
  isCodexProcessFallback,
};
