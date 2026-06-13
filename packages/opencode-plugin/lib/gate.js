'use strict';

const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'patch']);

function orchPort() {
  return process.env.ORCH_PORT || '8787';
}

function orchBase() {
  return `http://127.0.0.1:${orchPort()}`;
}

async function orchGet(path) {
  const res = await fetch(`${orchBase()}${path}`, { signal: AbortSignal.timeout(600) });
  if (!res.ok) return null;
  return res.json();
}

async function orchPost(path, body) {
  const res = await fetch(`${orchBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1500),
  });
  if (!res.ok) return null;
  return res.json();
}

function isGateExemptPath(filePath) {
  if (!filePath) return true;
  const fp = String(filePath);
  if (/\/\.claude\/projects\/[^/]+\/memory\//.test(fp)) return true;
  if (/\/\.claude\/settings(\.local)?\.json$/.test(fp)) return true;
  if (/\/\.claude\/(keybindings|launch)\.json$/.test(fp)) return true;
  if (/\/\.mcp\.json$/.test(fp)) return true;
  if (/\/CLAUDE\.md$/.test(fp)) return true;
  if (/\/scratch\//.test(fp)) return true;
  if (/\.log$/.test(fp) || /\/logs\//.test(fp)) return true;
  return false;
}

function filePathFromArgs(args) {
  if (!args || typeof args !== 'object') return '';
  return String(args.filePath ?? args.file_path ?? args.path ?? args.file ?? '');
}

async function gateWriteTool(sessionID, tool, args) {
  if (!WRITE_TOOLS.has(tool)) return;
  if (isGateExemptPath(filePathFromArgs(args))) return;

  let claim;
  try {
    claim = await orchGet(`/active-claim?session=${encodeURIComponent(sessionID)}`);
  } catch {
    return;
  }
  if (!claim || claim.claimed === true) return;

  let isSub = false;
  try {
    const info = await orchGet(`/session-info?session=${encodeURIComponent(sessionID)}`);
    isSub = info?.is_subagent === true;
  } catch { /* ignore */ }

  const msg = isSub
    ? 'orch-gate: no task claimed. Call task_create, then orchestrator MCP start_task before editing.'
    : 'orch-gate: no task claimed. Mint with task_create or claim via start_task before editing.';
  throw new Error(msg);
}

module.exports = { WRITE_TOOLS, orchPost, gateWriteTool };
