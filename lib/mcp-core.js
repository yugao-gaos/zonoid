// Shared MCP core: tool/resource definitions + JSON-RPC dispatch, used by BOTH transports —
// the stdio server (mcp-graph.js) and the daemon's HTTP /mcp endpoint (for custom connectors).
// Tools operate by calling the daemon's existing HTTP API via an injected `call(method,path,body)`.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const runtimePaths = require('./runtime-paths');
const requestIdentity = require('./request-identity');
const clientProfile = require('./mcp/client-profile');

// Auth token: env ORCH_TOKEN, else BASE/token file, else null (auth off — back-compat).
function readToken() {
  if (process.env.ORCH_TOKEN) return process.env.ORCH_TOKEN.trim() || null;
  try { return fs.readFileSync(runtimePaths.runtimePath('token'), 'utf8').trim() || null; } catch { return null; }
}

const UI_URI = 'ui://orchestrator/graph';
const UI_MIME = 'text/html;profile=mcp-app';
const PORT = process.env.ORCH_PORT ? Number(process.env.ORCH_PORT) : 8787;
const DASHBOARD_ORIGIN = process.env.ZONOID_DASHBOARD_ORIGIN || null;
const DEFAULT_PROTOCOL = '2025-06-18';

const q = (o) => Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

function uiHtml() {
  try { return fs.readFileSync(path.join(__dirname, '..', 'public', 'inline.html'), 'utf8'); }
  catch { return '<!doctype html><body>inline.html missing</body>'; }
}

async function runSubconsciousAssignment(a, call) {
  const args = a || {};
  const action = args.action;
  if (action === 'prepare') return call('POST', '/subconscious/assignment', args);
  if (action === 'read') return call('GET', `/subconscious/assignment?${q({ workspace: args.workspace, task_key: args.task_key, judge_task_key: args.judge_task_key, repo_path: args.repo_path, base: args.base, agent_id: args.agent_id, intent: args.intent, situation: args.situation, query: args.query, context_query: args.context_query, agentic_context: args.agentic_context ? 1 : undefined, search_context: args.search_context ? 1 : undefined, k: args.k, max_rounds: args.max_rounds })}`);
  if (!args.task_key) return { error: 'task_key required' };
  if (action === 'accept') {
    return call('POST', '/overlay/status', {
      workspace: args.workspace,
      key: args.task_key,
      status: 'in_progress',
      agent_id: args.agent_id,
      session_id: args.session_id,
      force: args.force,
    });
  }
  if (action === 'complete') {
    const taskResultStatus = args.task_result && typeof args.task_result === 'object' && !Array.isArray(args.task_result)
      ? args.task_result.status
      : null;
    const status = args.status || (['tested', 'failed'].includes(taskResultStatus) ? taskResultStatus : null) || (args.failed ? 'failed' : 'done');
    if (!['done', 'tested', 'failed', 'canceled'].includes(status)) return { error: 'complete status must be done, tested, failed, or canceled' };
    return call('POST', '/overlay/status', {
      workspace: args.workspace,
      key: args.task_key,
      status,
      summary: args.summary,
      note: args.note,
      agent_id: args.agent_id,
      session_id: args.session_id,
      task_result: args.task_result,
      follow_ups: args.follow_ups,
      verdicts: args.verdicts,
    });
  }
  if (action === 'submit_verdict') {
    const verdict = String(args.verdict || '').toUpperCase();
    if (verdict === 'APPROVE') {
      const approvedSummary = args.summary || args.reason || 'Attempt approved.';
      const reviewed = await call('POST', '/overlay/status', {
        workspace: args.workspace,
        key: args.task_key,
        status: 'tested',
        summary: approvedSummary,
        note: args.reason,
        agent_id: args.agent_id,
        session_id: args.session_id,
        task_result: args.task_result,
        // NAMED lifecycle event, not a hand-built review patch: the daemon runs it through the
        // guarded transition machine, so an approval that arrives after a merge (or on top of a
        // settled kick-back) is REFUSED and reported instead of silently overwriting the record.
        lifecycle_event: 'review_approve',
        review_reason: args.reason,
      });
      if (reviewed && reviewed.error) {
        return { ok: false, action, verdict, task_key: args.task_key, task_status: reviewed, error: reviewed.error };
      }
      const approveRefused = Array.isArray(reviewed && reviewed.lifecycle_refused)
        ? reviewed.lifecycle_refused.find((r) => r && r.event === 'review_approve')
        : null;
      if (approveRefused) {
        return {
          ok: false,
          action,
          verdict,
          task_key: args.task_key,
          review_task_key: args.task_key,
          judge_task_key: null,
          legacy_judge_task_key: args.judge_task_key || null,
          task_status: reviewed,
          lifecycle_refused: approveRefused,
          error: `review_approve refused: ${approveRefused.reason || approveRefused.code}`,
        };
      }
      return {
        ok: true,
        action,
        verdict,
        task_key: args.task_key,
        review_task_key: args.task_key,
        judge_task_key: null,
        legacy_judge_task_key: args.judge_task_key || null,
        task_status: reviewed,
        next_action: 'merge_attempt',
      };
    }
    if (verdict === 'KICK_BACK') {
      const taskStatus = await call('POST', '/overlay/status', {
        workspace: args.workspace,
        key: args.task_key,
        status: 'failed',
        summary: args.summary || args.reason || 'Judge kicked back the attempt.',
        note: args.reason,
        agent_id: args.agent_id,
        session_id: args.session_id,
        task_result: args.task_result,
        lifecycle_event: 'review_kick_back',
        review_reason: args.reason,
      });
      const kickBackRefused = Array.isArray(taskStatus && taskStatus.lifecycle_refused)
        ? taskStatus.lifecycle_refused.find((r) => r && r.event === 'review_kick_back')
        : null;
      const out = {
        ok: !(taskStatus && taskStatus.error) && !kickBackRefused,
        ...(kickBackRefused ? { lifecycle_refused: kickBackRefused, error: `review_kick_back refused: ${kickBackRefused.reason || kickBackRefused.code}` } : {}),
        action,
        verdict,
        task_key: args.task_key,
        review_task_key: args.task_key,
        judge_task_key: null,
        legacy_judge_task_key: args.judge_task_key || null,
        task_status: taskStatus,
      };
      return out;
    }
    return { error: 'submit_verdict requires verdict APPROVE or KICK_BACK' };
  }
  return { error: 'action must be prepare, accept, complete, submit_verdict, or read' };
}

// An HTTP client bound to the daemon port — same for stdio (mcp-graph) and the daemon's self-calls.
// `workspace` (optional): the calling session's pinned workspace. When set it is injected into
// every POST (mutating) body so the daemon's graph-WRITE routes target THAT workspace instead of
// the daemon-global one (the workspace-gremlin fix), AND into every GET path as ?workspace= so the
// daemon's READ routes resolve THIS session's graph too (the read-side counterpart — without it,
// reads land on whatever workspace the daemon-global state last pinned, e.g. after a restart).
// The stdio server passes its ORCH_WORKSPACE/cwd; the daemon's self-call passes nothing =>
// unchanged fallback behavior. An explicit body.workspace / ?workspace= from a caller wins.
//
// RESTART RESILIENCE (two halves, both client-side here):
//   RETRY — a brief daemon restart must be invisible to in-flight tool calls. Retry ONLY on
//   connection-level failures where NO response was received (req 'error': ECONNREFUSED = the
//   request never arrived, always safe; ECONNRESET/EPIPE/"socket hang up" = it may or may not
//   have arrived). Bounded: RETRY_ATTEMPTS total, RETRY_BACKOFF_MS×attempt backoff. HTTP-level
//   errors (4xx/5xx — a response WAS received) are never retried; an error after the response
//   started surfaces on the response stream, not req 'error', so it is never retried either.
//   IDEMPOTENCY — a retried POST could duplicate a write that actually landed (reset after
//   delivery, before the response). Every mutating POST is stamped with ONE op_id (uuid) per
//   LOGICAL request, REUSED across its retries; the daemon's replay cache returns the recorded
//   response for a duplicate op_id instead of re-applying (see daemon.js opReplay/sendOp). An
//   explicit body.op_id from a caller wins (spread order).
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.ORCH_MCP_REQUEST_TIMEOUT_MS) || 30000);
const SLOW_REQUEST_TIMEOUT_MS = Math.max(
  REQUEST_TIMEOUT_MS,
  Number(process.env.ORCH_MCP_SLOW_REQUEST_TIMEOUT_MS) || 180000
);
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 500;
const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE']);
function requestTimeoutMs(method, p, body) {
  if (method === 'POST' && p === '/subconscious/assignment') return SLOW_REQUEST_TIMEOUT_MS;
  if (method === 'POST' && /^\/git\/(branch|merge|feature|merge-feature|remove-worktree)\b/.test(String(p || ''))) return SLOW_REQUEST_TIMEOUT_MS;
  if (method === 'POST' && p === '/overlay/status' && body && body.review) return SLOW_REQUEST_TIMEOUT_MS;
  return REQUEST_TIMEOUT_MS;
}
function makeCall(port, identity) {
  const legacyOnly = typeof identity === 'string';
  // Deprecated single-path clients explicitly describe a single-repo session. Preserve that
  // convenience in client composition by sending the same path as both graph and Git target.
  const defaults = legacyOnly ? { graph_repo: identity, target_repo: identity } : (identity || {});
  return (method, p, body) => new Promise((resolve) => {
    if (method === 'GET') p = requestIdentity.augmentUrl(p, defaults, { legacyOnly });
    let payload = method === 'POST'
      ? requestIdentity.augmentBody(body || {}, defaults, { legacyOnly })
      : body;
    if (method === 'POST') payload = { op_id: crypto.randomUUID(), ...(payload || {}) };
    const data = payload ? JSON.stringify(payload) : null;
    const headers = {};
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const tok = readToken(); if (tok) headers['authorization'] = `Bearer ${tok}`;
    const attempt = (n) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const b = Buffer.concat(chunks).toString('utf8');
            let parsed; try { parsed = b ? JSON.parse(b) : {}; } catch { parsed = { raw: b }; }
            if (res.statusCode >= 400 && !(parsed && parsed.error)) parsed = { error: `daemon HTTP ${res.statusCode}`, status: res.statusCode, body: parsed };
            resolve(parsed);
          });
        });
      req.on('error', (e) => {
        if (RETRYABLE.has(e.code) && n < RETRY_ATTEMPTS) return setTimeout(() => attempt(n + 1), RETRY_BACKOFF_MS * n);
        resolve({ error: `daemon unreachable on :${port} (${e.code}). Is the orchestrator daemon running?` });
      });
      req.setTimeout(requestTimeoutMs(method, p, payload), () => {
        req.destroy();
        resolve({ error: 'request timed out' });
      });
      if (data) req.write(data); req.end();
    };
    attempt(1);
  });
}

function bindCallIdentity(call, identity) {
  return (method, p, body) => {
    if (method === 'GET') return call(method, requestIdentity.augmentUrl(p, identity), body);
    if (method === 'POST') return call(method, p, requestIdentity.augmentBody(body || {}, identity));
    return call(method, p, body);
  };
}

const { createTools, withRequestIdentity } = require('./mcp/tools');
const TOOLS = createTools({ q, UI_URI, PORT, DASHBOARD_ORIGIN, runSubconsciousAssignment });
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

function toolsForCtx(ctx) {
  const extra = ctx && ctx.extraTools;
  const tools = !extra || extra.length === 0
    ? TOOLS
    : TOOLS.concat(extra.map(withRequestIdentity));
  return clientProfile.toolsForClient(tools, clientProfile.clientName(ctx));
}
function toolByNameForCtx(ctx) {
  const selected = toolsForCtx(ctx);
  if (selected === TOOLS) return TOOL_BY_NAME;
  return Object.fromEntries(selected.map((t) => [t.name, t]));
}
function formatToolsList(tools) {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.meta ? { _meta: t.meta } : {}) }));
}

// Advisory cooperative-stop (in-band counterpart to hooks/orch-stop.sh enforcement).
// When a tool call carries agent_id and that agent has stop_requested set (or, with session,
// /should-stop would halt the hook path), attach should_stop + reason to the MCP result WITHOUT
// blocking the call. Fail-open on daemon errors — same spirit as the hook's unreachable fallback.
async function stopAdvisory(agentId, call, session) {
  if (!agentId || typeof agentId !== 'string') return null;
  try {
    if (session) {
      const r = await call('GET', `/should-stop?${q({ session, agent: agentId })}`);
      if (r && r.stop) return { should_stop: true, reason: r.reason || 'stop_requested' };
      return null;
    }
    const r = await call('GET', `/agent/stop-requested?${q({ agent_id: agentId })}`);
    if (r && r.stop_requested) return { should_stop: true, reason: 'stop_requested' };
  } catch { /* fail open */ }
  return null;
}

function wrapToolResult(out, advisory) {
  const result = { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: !!(out && out.error) };
  if (advisory) Object.assign(result, advisory);
  return result;
}

// Handle one JSON-RPC message. Returns the response object, or undefined for notifications.
async function handleRpc(msg, ctx) {
  const { id, method, params } = msg;
  const call = ctx.call, html = ctx.uiHtml || uiHtml;
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL, capabilities: { tools: {}, resources: {}, extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [UI_MIME] } } }, serverInfo: { name: 'orchestrator-graph', version: '0.1.0' } } };
  if (method === 'notifications/initialized' || method === 'initialized') return undefined;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: formatToolsList(toolsForCtx(ctx)) } };
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [{ uri: UI_URI, name: 'Orchestrator dashboard', mimeType: UI_MIME, description: 'Live task dependency graph (inline)' }] } };
  if (method === 'resources/read') {
    if (params && params.uri === UI_URI) return { jsonrpc: '2.0', id, result: { contents: [{ uri: UI_URI, mimeType: UI_MIME, text: html() }] } };
    return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown resource: ${params && params.uri}` } };
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const tool = toolByNameForCtx(ctx)[name];
    if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } };
    // Usage beacon: tally every dispatch on the daemon. Covers BOTH transports at this single
    // choke point: `call` is always a daemon-bound HTTP client (makeCall), so counts from the
    // separate stdio process reach the daemon too; makeCall injects the session's workspace into
    // the POST body (the daemon falls back to its own). AWAITED (one loopback POST, never rejects)
    // so the short-lived stdio process can't exit before the beacon lands; never fails the call.
    const tally = (isError) => { try { return call('POST', '/analytics/tool-call', { tool: name, error: !!isError }); } catch { /* best effort */ } };
    const defaultIdentity = ctx.identity || {
      workspace_id: ctx.workspace_id,
      graph_repo: ctx.graph_repo || ctx.workspace,
      target_repo: ctx.target_repo,
    };
    let args = requestIdentity.augmentBody(params.arguments || {}, defaultIdentity);
    if (name === 'start_task' && !args.session_id && ctx.session) args = { ...args, session_id: ctx.session };
    if (name === 'complete_task' && !args.session_id && ctx.session) args = { ...args, session_id: ctx.session };
    if (name === 'subconscious_assignment' && ['accept', 'complete', 'submit_verdict'].includes(args.action) && !args.session_id && ctx.session) args = { ...args, session_id: ctx.session };
    if (name === 'request_guidance' && !args.session_id && ctx.session) args = { ...args, session_id: ctx.session };
    // Inject the session's graph repo and viewer host into show_dashboard. The viewer is presentation
    // context only; accounting stays workspace-scoped and server-owned.
    if (name === 'show_dashboard') {
      if (!args.workspace && args.graph_repo) args = { ...args, workspace: args.graph_repo };
      const viewer = clientProfile.clientName(ctx);
      if (!args.viewer && viewer) args = { ...args, viewer };
    }
    const agentId = args.agent_id || null;
    const toolCall = bindCallIdentity(call, requestIdentity.fromRequest(args));
    try {
      const out = await tool.run(args, toolCall);
      await tally(out && out.error);
      const advisory = await stopAdvisory(agentId, toolCall, ctx.session);
      return { jsonrpc: '2.0', id, result: wrapToolResult(out, advisory) };
    }
    catch (e) { await tally(true); return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true } }; }
  }
  if (id != null) return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  return undefined;
}

module.exports = {
  UI_URI,
  UI_MIME,
  DEFAULT_PROTOCOL,
  TOOLS,
  toolsForCtx,
  formatToolsList,
  handleRpc,
  makeCall,
  bindCallIdentity,
  uiHtml,
  readToken,
  stopAdvisory,
  wrapToolResult,
  _test: { REQUEST_TIMEOUT_MS, SLOW_REQUEST_TIMEOUT_MS, requestTimeoutMs },
};
