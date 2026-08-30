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
  for (const key of ['structuredContent', 'result', 'content', 'text']) {
    if (value[key] != null) collectResultObjects(value[key], out, depth + 1);
  }
  return out;
}

function successfulAssignmentAccept(input) {
  if (!ASSIGNMENT_TOOLS.has(input.tool_name || '')) return false;
  if (!input.tool_input || input.tool_input.action !== 'accept') return false;
  const results = collectResultObjects(input.tool_response);
  const failed = results.some((item) => item.isError === true || item.ok === false || item.error != null);
  return !failed && results.some((item) => item.ok === true);
}

(async () => {
  const input = await k.readInput();
  const isLegacyStart = START_TASK_TOOLS.has(input.tool_name || '');
  if (!isLegacyStart && !successfulAssignmentAccept(input)) k.allow();
  const sid = input.session_id || '';
  const taskKey = (input.tool_input && input.tool_input.task_key) || '';
  const agentId = (input.tool_input && input.tool_input.agent_id) || '';
  if (!sid || !taskKey || !agentId) k.allow();
  await k.post('/overlay/claim-session', { task_key: taskKey, session_id: sid, agent_id: agentId }, 1000);
  process.exit(0);
})().catch(() => process.exit(0));
