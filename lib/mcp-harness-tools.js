// Client-scoped MCP tools — NOT part of the default lib/mcp-core.js TOOLS surface.
// The stdio server (mcp-graph.js) merges these via handleRpc ctx.extraTools when
// ORCH_CLIENT on the MCP spawn selects a client that needs adapter-specific helpers.
'use strict';
const fs = require('fs');
const path = require('path');
const sw = require('./schedule-wakeup');

const NOTIFY_PATTERN = '^ORCH_SCHEDULED_TASK';

function resolveSession(ctx) {
  const client = String((ctx && ctx.client) || '').trim();
  return String(
    (ctx && ctx.session)
    || process.env.ORCH_SESSION
    || process.env.ZONOID_SESSION
    || (client === 'codex' ? process.env.CODEX_THREAD_ID : '')
    || (client === 'claude' ? process.env.CLAUDE_CODE_SESSION_ID : '')
    || '',
  ).trim();
}

function wakeMonitorCommand(session) {
  return `tail -n0 -F ${JSON.stringify(sw.fireFile(session))}`;
}

function validTaskId(id) {
  return /^[A-Za-z0-9._-]+$/.test(id);
}

// Codex minting: write a stub JSON into the designated file-drop folder, then pull via /sync.
function createTaskTool(workspace, harness) {
  return {
    name: 'create_task',
    description: 'Mint a new task in the orchestrator graph by writing a file-drop stub and calling POST /sync (Codex harness). Returns { ok, task_key, adopted, suggestions }.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id within the harness namespace (becomes codex/<id>). Use letters, numbers, dot, underscore, or dash only.' },
        subject: { type: 'string', description: 'Short imperative label for the task.' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        blockedBy: { type: 'array', items: { type: 'string' }, description: 'Prerequisite task keys (<harness>/<id> or bare id namespaced to this harness).' },
        agent_id: { type: 'string', description: 'Provenance: which agent minted the task.' },
      },
      required: ['id', 'subject'],
      additionalProperties: false,
    },
    run: async (a, call) => {
      const filedrop = require('./filedrop-tasks');
      const id = String(a.id || '').trim();
      const subject = String(a.subject || '').trim();
      if (!id || !subject) return { error: 'id and subject are required' };
      if (!validTaskId(id)) return { error: 'id may contain only letters, numbers, dot, underscore, and dash' };
      const stub = {
        id,
        subject,
        description: a.description || '',
        status: a.status || 'pending',
        created_by: { harness, agent_id: a.agent_id || null },
      };
      if (Array.isArray(a.blockedBy) && a.blockedBy.length) stub.blockedBy = a.blockedBy;
      const dir = path.join(filedrop.dirFor(workspace), harness);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${id}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(stub, null, 2));
      fs.renameSync(tmp, file);
      const sync = await call('POST', '/sync', {});
      if (sync && sync.error) return sync;
      const task_key = `${harness}/${id}`;
      return { ok: true, task_key, adopted: sync.adopted, suggestions: sync.suggestions };
    },
  };
}

async function scheduleWakeupRun(ctx, a) {
  const session = String((a && a.session_id) || resolveSession(ctx)).trim();
  if (!session) return { ok: false, error: 'session required (pass session_id or set ORCH_SESSION from hook context)' };
  const delaySeconds = Math.max(0, Math.floor(Number(a.delaySeconds) || 0));
  const reason = String(a.reason ?? '');
  const prompt = String(a.prompt ?? '');
  const cancel = sw.cancelWakeup(session);
  if (!cancel.ok) return cancel;
  const armed = sw.armWakeup({ session, delaySeconds, reason, prompt });
  if (!armed.ok) return armed;
  return { ok: true, armed: true, command: wakeMonitorCommand(session), notify_pattern: NOTIFY_PATTERN };
}

function scheduleWakeupTool(ctx) {
  return {
    name: 'ScheduleWakeup',
    description: 'Schedule a delayed re-prompt for this session (cancels any prior wake).',
    inputSchema: {
      type: 'object',
      properties: {
        delaySeconds: { type: 'number' },
        reason: { type: 'string' },
        prompt: { type: 'string' },
        session_id: { type: 'string', description: 'Optional session/conversation id when the MCP server cannot infer one from the harness environment.' },
      },
      required: ['delaySeconds', 'reason', 'prompt'],
      additionalProperties: false,
    },
    run: async (a) => scheduleWakeupRun(ctx, a),
  };
}

function extraToolsForClient(client, workspace, ctx) {
  const tools = [];
  if (client === 'codex') tools.push(createTaskTool(workspace, 'codex'));
  if (client === 'cursor' || client === 'codex') tools.push(scheduleWakeupTool({ ...(ctx || {}), client }));
  return tools;
}

module.exports = { createTaskTool, scheduleWakeupTool, extraToolsForClient, resolveSession, wakeMonitorCommand, validTaskId, NOTIFY_PATTERN };
