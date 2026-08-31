#!/usr/bin/env node
'use strict';
// PostToolUse hook: after a successful claim, register the real hook session with the daemon so
// /active-claim can find a claim created through a different MCP process session.
const k = require('./lib/hookkit');

const START_TASK_TOOLS = new Set([
  'mcp__orchestrator-graph__start_task',
  'mcp__orchestrator_graph__start_task',
  'start_task',
]);
const ASSIGNMENT_TOOLS = new Set([
  'mcp__orchestrator-graph__subconscious_assignment',
  'mcp__orchestrator_graph__subconscious_assignment',
  'subconscious_assignment',
]);

function collectResultObjects(value, out = [], depth = 0) {
  if (depth > 4 || value == null) return out;
  if (typeof value === 'string') {
    try { return collectResultObjects(JSON.parse(value), out, depth + 1); }
    catch { return out; }
  }
  if (Array.isArray(value)) {
    for (const item of value) collectResultObjects(item, out, depth + 1);
    return out;
  }
  if (typeof value !== 'object') return out;
  out.push(value);
  for (const key of ['structuredContent', 'result', 'content', 'text', 'git_claim', 'git_claim_finalize']) {
    if (value[key] != null) collectResultObjects(value[key], out, depth + 1);
  }
  return out;
}

function successfulAssignmentAccept(input) {
  if (!ASSIGNMENT_TOOLS.has(input.tool_name || '')) return false;
  if (!input.tool_input || input.tool_input.action !== 'accept') return false;
  const results = collectResultObjects(input.tool_response);
  const failed = results.some((item) => {
    const hasFailure = item.isError === true || item.ok === false || item.error != null;
    const advisoryGitClaim = item.advisory === true && item.ok === false && (
      Object.prototype.hasOwnProperty.call(item, 'already_claimed') ||
      Object.prototype.hasOwnProperty.call(item, 'pushed') ||
      Object.prototype.hasOwnProperty.call(item, 'conflict') ||
      Object.prototype.hasOwnProperty.call(item, 'skipped')
    );
    return hasFailure && !advisoryGitClaim;
  });
  return !failed && results.some((item) => item.ok === true);
}

function responseExecutionPermit(input, taskKey, agentId) {
  const results = collectResultObjects(input.tool_response);
  for (const item of results) {
    const permit = item.execution_permit;
    if (!permit || typeof permit !== 'object') continue;
    const workspace = typeof permit.workspace === 'string' ? permit.workspace.trim() : '';
    const sessionId = typeof permit.session_id === 'string' ? permit.session_id.trim() : '';
    if (
      workspace &&
      sessionId &&
      permit.task_key === taskKey &&
      permit.agent_id === agentId
    ) {
      return { ...permit, workspace, session_id: sessionId };
    }
  }
  return null;
}

function wouldRebindExplicitPermit(input, sid, permit) {
  const requestedSession = input.tool_input && typeof input.tool_input.session_id === 'string'
    ? input.tool_input.session_id.trim()
    : '';
  return sid !== permit.session_id && requestedSession === permit.session_id;
}

(async () => {
  const input = await k.readInput();
  const isLegacyStart = START_TASK_TOOLS.has(input.tool_name || '');
  const taskKey = (input.tool_input && input.tool_input.task_key) || '';
  const agentId = (input.tool_input && input.tool_input.agent_id) || '';
  const permit = responseExecutionPermit(input, taskKey, agentId);
  if (!isLegacyStart && (!successfulAssignmentAccept(input) || !permit)) k.allow();
  const sid = k.hookSessionId(input);
  if (!sid || !taskKey || !agentId || !permit) k.allow();
  if (!isLegacyStart) k.bindTurnSession(input, permit, taskKey, agentId);
  if (wouldRebindExplicitPermit(input, sid, permit)) k.allow();
  const body = {
    task_key: taskKey,
    session_id: sid,
    agent_id: agentId,
    workspace: permit.workspace,
    expected_session_id: permit.session_id,
  };
  await k.post('/overlay/claim-session', body, 1000);
  process.exit(0);
})().catch(() => process.exit(0));
