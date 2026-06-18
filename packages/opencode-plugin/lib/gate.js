'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function loadGatePolicy() {
  const candidates = [
    process.env.ZONOID_ROOT && path.join(process.env.ZONOID_ROOT, 'hooks', 'lib', 'gate-policy.js'),
    path.resolve(__dirname, '../../../hooks/lib/gate-policy.js'),
    path.resolve(process.cwd(), 'hooks/lib/gate-policy.js'),
    path.join(os.homedir(), '.claude', 'orchestrator', 'hooks', 'lib', 'gate-policy.js'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return require(candidate);
    } catch {
      // Try the next install location.
    }
  }
  return null;
}

const policy = loadGatePolicy();

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

async function checkShouldStop({ sessionID, agentId, workspace, get = orchGet } = {}) {
  const session = sessionID ? String(sessionID) : '';
  if (!session) return null;

  const params = new URLSearchParams();
  params.set('session', session);
  params.set('agent', agentId ? String(agentId) : `opencode-${session.slice(0, 8)}`);
  if (workspace) params.set('workspace', String(workspace));

  let verdict;
  try {
    verdict = await get(`/should-stop?${params.toString()}`);
  } catch {
    return null;
  }

  if (verdict && verdict.stop === true) {
    const reason = verdict.reason ? String(verdict.reason) : 'orchestrator requested stop';
    throw new Error(`orch-stop: ${reason}`);
  }
  return verdict || null;
}

function hookInputFromToolArgs(tool, args) {
  const input = (args && typeof args === 'object') ? { ...args } : {};
  if (input.file_path == null) {
    input.file_path = input.filePath ?? input.path ?? input.file ?? '';
  }
  return {
    tool_name: String(tool || '').toLowerCase(),
    tool_input: input,
  };
}

async function taskDetail(key) {
  try {
    return await orchGet(`/task/detail?key=${encodeURIComponent(key)}`);
  } catch {
    return null;
  }
}

function claimWorktree(detail) {
  const git = detail && detail.task && detail.task.git;
  if (!git || !git.branch) return null;
  return { branch: git.branch, worktree: git.worktree || '' };
}

async function claimedWorktreeMatch(claim, targets) {
  const claims = Array.isArray(claim && claim.claims) ? claim.claims : [];
  let anyWorktree = false;
  let mismatchBranch = '';
  let offending = '';

  for (const c of claims) {
    if (!c || !c.key) continue;
    const wtInfo = claimWorktree(await taskDetail(c.key));
    if (!wtInfo) continue;
    anyWorktree = true;
    mismatchBranch = wtInfo.branch;
    if (!targets.length) return { matched: true, anyWorktree };
    const outside = policy.firstOutsideWorktree(targets, wtInfo.worktree);
    if (!outside) return { matched: true, anyWorktree };
    offending = outside;
  }

  return { matched: !anyWorktree, anyWorktree, mismatchBranch, offending };
}

async function gateWriteTool(sessionID, tool, args) {
  const normalizedTool = String(tool || '').toLowerCase();
  if (!WRITE_TOOLS.has(normalizedTool)) return;
  if (!policy) {
    throw new Error('orch-gate: shared gate policy not found. Set ZONOID_ROOT to the Zonoid install root or install the OpenCode plugin via npx @zonoid/cli init --harness opencode.');
  }

  const hookInput = hookInputFromToolArgs(normalizedTool, args);
  const targets = policy.writeEditTargets(hookInput);
  if (policy.allTargetsExempt(targets)) return;
  if (!sessionID) return;

  let claim;
  try {
    claim = await orchGet(`/active-claim?session=${encodeURIComponent(sessionID)}`);
  } catch {
    return;
  }
  if (!claim) return;
  if (claim.claimed === true) {
    const match = await claimedWorktreeMatch(claim, targets);
    if (match.matched) return;
    throw new Error(`orch-gate: task has a registered worktree (${match.mismatchBranch}) - writes must happen inside the worktree path, not at ${match.offending || targets[0] || '(tool)'}. Use the path returned by branch_task.`);
  }

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

module.exports = { WRITE_TOOLS, orchPost, checkShouldStop, gateWriteTool };
