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

async function nudgeReady({ sessionID, workspace, get = orchGet } = {}) {
  const session = sessionID ? String(sessionID) : '';
  const ws = workspace ? String(workspace) : '';
  if (!session && !ws) return null;

  const params = new URLSearchParams();
  if (session) params.set('session', session);
  if (ws) params.set('workspace', ws);

  try {
    return await get(`/ready?${params.toString()}`);
  } catch {
    return null;
  }
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

async function taskDetail(key, workspace) {
  try {
    const params = new URLSearchParams({ key });
    if (workspace) params.set('workspace', workspace);
    return await orchGet(`/task/detail?${params.toString()}`);
  } catch {
    return null;
  }
}

function claimWorktree(detail) {
  const git = detail && detail.task && detail.task.git;
  if (!git || !git.branch) return null;
  return { branch: git.branch, worktree: git.worktree || '' };
}

async function permitForClaim({ sessionID, taskKey, workspace, agentId, foregroundAgentId }) {
  const params = new URLSearchParams({ session_id: sessionID, task_key: taskKey });
  if (workspace) params.set('workspace', workspace);
  if (agentId) params.set('agent_id', agentId);
  if (foregroundAgentId) params.set('foreground_agent_id', foregroundAgentId);
  const permitResp = await orchGet(`/subconscious/permit?${params.toString()}`);
  return permitResp && (permitResp.execution_permit || permitResp.permit);
}

async function claimedScopeMatch(claim, targets, ctx) {
  const claims = Array.isArray(claim && claim.claims) ? claim.claims : [];
  let anyWorktree = false;
  let mismatchBranch = '';
  let offending = '';
  let permitDenyReason = 'no Subconscious execution permit found for this session/task';

  for (const c of claims) {
    if (!c || !c.key) continue;
    const wtInfo = claimWorktree(await taskDetail(c.key, c.workspace));
    if (!wtInfo) {
      permitDenyReason = 'claimed assignment is missing a registered worktree; ask Subconscious to re-prepare it with subconscious_assignment action:"prepare" before requesting a permit';
      continue;
    }
    anyWorktree = true;
    mismatchBranch = wtInfo.branch;
    const outside = policy.firstOutsideWorktree(targets, wtInfo.worktree);
    if (outside) {
      offending = outside;
      continue;
    }
    const permit = await permitForClaim({
      sessionID: ctx.sessionID,
      taskKey: c.key,
      workspace: c.workspace,
      agentId: ctx.agentId,
      foregroundAgentId: ctx.foregroundAgentId,
    });
    const permitValidation = policy.validateExecutionPermit(permit, {
      sessionId: ctx.sessionID,
      taskKey: c.key,
      branch: wtInfo.branch,
      worktree: wtInfo.worktree,
      agentId: ctx.agentId,
      foregroundAgentId: ctx.foregroundAgentId,
    });
    if (!permitValidation.ok) {
      permitDenyReason = permitValidation.reason;
      continue;
    }
    const outsidePermit = policy.firstOutsidePermitScope(targets, wtInfo.worktree, permit);
    if (outsidePermit) {
      offending = outsidePermit;
      permitDenyReason = 'target is outside the Subconscious execution permit scope';
      continue;
    }
    return { matched: true, anyWorktree };
  }

  return { matched: false, anyWorktree, mismatchBranch, offending, permitDenyReason };
}

async function gateWriteTool(sessionID, tool, args, options = {}) {
  const normalizedTool = String(tool || '').toLowerCase();
  if (!WRITE_TOOLS.has(normalizedTool)) return;
  if (!policy) {
    throw new Error('orch-gate: shared gate policy not found. Set ZONOID_ROOT to the Zonoid install root or install the OpenCode plugin via npx @zonoid/cli init --harness opencode.');
  }

  const hookInput = hookInputFromToolArgs(normalizedTool, args);
  const targets = policy.writeEditTargets(hookInput);
  if (policy.allTargetsExempt(targets)) return;
  if (!sessionID) return;
  const agentId = String(
    options.agentId ||
    options.agentID ||
    (args && (args.agent_id || args.agentID)) ||
    `opencode-${String(sessionID).slice(0, 8)}`,
  );
  const foregroundAgentId = String(
    options.foregroundAgentId ||
    options.foregroundAgentID ||
    (args && (args.foreground_agent_id || args.foregroundAgentID)) ||
    '',
  );

  let claim;
  try {
    claim = await orchGet(`/active-claim?session=${encodeURIComponent(sessionID)}`);
  } catch {
    return;
  }
  if (!claim) return;
  if (claim.claimed === true) {
    const match = await claimedScopeMatch(claim, targets, { sessionID, agentId, foregroundAgentId });
    if (match.matched) return;
    if (match.anyWorktree && match.offending && match.permitDenyReason !== 'target is outside the Subconscious execution permit scope') {
      throw new Error(`orch-gate: task has a registered worktree (${match.mismatchBranch}) - writes must happen inside the worktree path, not at ${match.offending || targets[0] || '(tool)'}. Use the worktree returned by subconscious_assignment action:"prepare".`);
    }
    throw new Error(`orch-gate: ${match.permitDenyReason}${match.offending ? ` (${match.offending})` : ''}. Ask Subconscious for an execution permit before writing.`);
  }

  let isSub = false;
  try {
    const info = await orchGet(`/session-info?session=${encodeURIComponent(sessionID)}`);
    isSub = info?.is_subagent === true;
  } catch { /* ignore */ }

  const msg = isSub
    ? 'orch-gate: no task claimed. Worker subagents must accept a prepared Subconscious assignment before editing with subconscious_assignment action:"accept". Dispatchers should create or repair the assignment with subconscious_assignment action:"prepare".'
    : 'orch-gate: no task claimed. Ask Subconscious for an assignment with subconscious_assignment action:"prepare", then accept it before editing.';
  throw new Error(msg);
}

module.exports = { WRITE_TOOLS, orchPost, checkShouldStop, nudgeReady, gateWriteTool };
