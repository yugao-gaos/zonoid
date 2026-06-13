'use strict';

const ORCH = () => `http://127.0.0.1:${process.env.ORCH_PORT || '8787'}`;

async function orchGet(path) {
  const res = await fetch(`${ORCH()}${path}`, { signal: AbortSignal.timeout(600) });
  return res.ok ? res.json() : null;
}

async function orchPost(path, body) {
  const res = await fetch(`${ORCH()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1500),
  });
  return res.ok ? res.json() : null;
}

function isGateExemptPath(fp) {
  if (!fp) return true;
  const s = String(fp);
  if (/\/\.claude\/projects\/[^/]+\/memory\//.test(s)) return true;
  if (/\/\.claude\/settings(\.local)?\.json$/.test(s)) return true;
  if (/\/\.mcp\.json$/.test(s)) return true;
  if (/\/CLAUDE\.md$/.test(s)) return true;
  if (/\/scratch\//.test(s)) return true;
  return false;
}

function filePathFromArgs(args) {
  if (!args || typeof args !== 'object') return '';
  return String(args.filePath ?? args.file_path ?? args.path ?? args.file ?? '');
}

module.exports = { orchGet, orchPost, isGateExemptPath, filePathFromArgs };
