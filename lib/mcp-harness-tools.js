// Client-scoped MCP tools — NOT part of the default lib/mcp-core.js TOOLS surface.
// The stdio server (mcp-graph.js) merges these via handleRpc ctx.extraTools when
// ORCH_CLIENT on the MCP spawn selects a client that needs adapter-specific helpers.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sw = require('./schedule-wakeup');
const codexSessionBridge = require('./codex-session-bridge');

const NOTIFY_PATTERN = '^ORCH_SCHEDULED_TASK';
let codexProcessSession = null;

function resolveCodexProcessSession() {
  if (!codexProcessSession) {
    codexProcessSession = `codex-mcp-${process.pid}-${crypto.randomBytes(16).toString('hex')}`;
  }
  return codexProcessSession;
}

function resolveSessionDetails(ctx, opts = {}) {
  const client = String((ctx && ctx.client) || '').trim();
  const candidates = [
    [(ctx && ctx.session), 'context'],
    [process.env.ORCH_SESSION, 'env:ORCH_SESSION'],
    [process.env.ZONOID_SESSION, 'env:ZONOID_SESSION'],
    [client === 'codex' ? process.env.CODEX_THREAD_ID : '', 'env:CODEX_THREAD_ID'],
    [client === 'claude' ? process.env.CLAUDE_CODE_SESSION_ID : '', 'env:CLAUDE_CODE_SESSION_ID'],
  ];
  let skippedFallback = null;
  for (const [value, source] of candidates) {
    const session = String(value || '').trim();
    if (!session) continue;
    if (
      client === 'codex'
      && opts.preferBridgeOverFallback
      && codexSessionBridge.isCodexProcessFallback(session)
    ) {
      skippedFallback = { session, source: 'codex-process-fallback' };
      continue;
    }
    return { session, source };
  }
  if (client === 'codex' && opts.useBridge && ctx && ctx.workspace) {
    const bridged = codexSessionBridge.latestSession({ workspace: ctx && ctx.workspace });
    if (bridged && bridged.session_id) return { session: String(bridged.session_id), source: 'codex-bridge', bridge: bridged };
  }
  if (skippedFallback) return skippedFallback;
  if (client !== 'codex') return { session: '', source: 'none' };
  // Codex Desktop does not expose a request-scoped thread id to this MCP process.
  return { session: resolveCodexProcessSession(), source: 'codex-process-fallback' };
}

function resolveSession(ctx, opts) {
  return resolveSessionDetails(ctx, opts).session;
}

function wakeMonitorCommand(session) {
  return `tail -n0 -F ${JSON.stringify(sw.fireFile(session))}`;
}

function codexDeliveryCommand(session) {
  const monitor = path.join(__dirname, '..', 'adapters', 'codex', 'wakeup-monitor.js');
  return `${wakeMonitorCommand(session)} | node ${JSON.stringify(monitor)} --session ${JSON.stringify(session)}`;
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
  const explicit = String((a && a.session_id) || '').trim();
  const resolved = explicit
    ? { session: explicit, source: 'argument' }
    : resolveSessionDetails(ctx, { useBridge: true, preferBridgeOverFallback: true });
  const session = String(resolved.session || '').trim();
  if (!session) return { ok: false, error: 'session required (pass session_id or set ORCH_SESSION from hook context)' };
  const delaySeconds = Math.max(0, Math.floor(Number(a.delaySeconds) || 0));
  const reason = String(a.reason ?? '');
  const prompt = String(a.prompt ?? '');
  const cancel = sw.cancelWakeup(session);
  if (!cancel.ok) return cancel;
  const armed = sw.armWakeup({ session, delaySeconds, reason, prompt });
  if (!armed.ok) return armed;
  const out = { ok: true, armed: true, command: wakeMonitorCommand(session), notify_pattern: NOTIFY_PATTERN };
  if (String((ctx && ctx.client) || '') === 'codex') {
    const canResume = !codexSessionBridge.isCodexProcessFallback(session);
    out.session_source = resolved.source;
    out.delivery = canResume
      ? {
          supported: true,
          method: 'codex-resume',
          session_id: session,
          command: codexDeliveryCommand(session),
        }
      : {
          supported: false,
          method: 'timer-only',
          reason: 'No real Codex session id is available; the process-local fallback can arm the timer but cannot resume Codex Desktop.',
        };
  }
  return out;
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
  if (client === 'cursor' || client === 'codex') tools.push(scheduleWakeupTool({ ...(ctx || {}), client, workspace }));
  return tools;
}

module.exports = {
  createTaskTool,
  scheduleWakeupTool,
  extraToolsForClient,
  resolveSession,
  resolveSessionDetails,
  wakeMonitorCommand,
  codexDeliveryCommand,
  validTaskId,
  NOTIFY_PATTERN,
};
