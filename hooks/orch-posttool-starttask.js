#!/usr/bin/env node
'use strict';
// PostToolUse hook: after start_task, register session->task_key with the daemon so /active-claim
// can find cross-session claims (gate Fix B). Node port of orch-posttool-starttask.sh.
const k = require('./lib/hookkit');

const START_TASK_TOOLS = new Set([
  'mcp__orchestrator-graph__start_task',
  'mcp__orchestrator_graph__start_task',
  'start_task',
]);

(async () => {
  const input = await k.readInput();
  if (!START_TASK_TOOLS.has(input.tool_name || '')) k.allow();
  const sid = input.session_id || '';
  const taskKey = (input.tool_input && input.tool_input.task_key) || '';
  if (!sid || !taskKey) k.allow();
  await k.post('/overlay/claim-session', { task_key: taskKey, session_id: sid }, 1000);
  process.exit(0);
})().catch(() => process.exit(0));
