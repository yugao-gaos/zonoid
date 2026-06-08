// Shared MCP core: tool/resource definitions + JSON-RPC dispatch, used by BOTH transports —
// the stdio server (mcp-graph.js) and the daemon's HTTP /mcp endpoint (for custom connectors).
// Tools operate by calling the daemon's existing HTTP API via an injected `call(method,path,body)`.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOKEN_BASE = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'orchestrator');
// Auth token: env ORCH_TOKEN, else BASE/token file, else null (auth off — back-compat).
function readToken() {
  if (process.env.ORCH_TOKEN) return process.env.ORCH_TOKEN.trim() || null;
  try { return fs.readFileSync(path.join(TOKEN_BASE, 'token'), 'utf8').trim() || null; } catch { return null; }
}

const UI_URI = 'ui://orchestrator/graph';
const UI_MIME = 'text/html;profile=mcp-app';
const PORT = process.env.ORCH_PORT ? Number(process.env.ORCH_PORT) : 8787;
const DEFAULT_PROTOCOL = '2025-06-18';

const q = (o) => Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

function uiHtml() {
  try { return fs.readFileSync(path.join(__dirname, '..', 'public', 'inline.html'), 'utf8'); }
  catch { return '<!doctype html><body>inline.html missing</body>'; }
}

// An HTTP client bound to the daemon port — same for stdio (mcp-graph) and the daemon's self-calls.
function makeCall(port) {
  return (method, p, body) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const tok = readToken(); if (tok) headers['authorization'] = `Bearer ${tok}`;
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
    req.on('error', (e) => resolve({ error: `daemon unreachable on :${port} (${e.code}). Is the orchestrator daemon running?` }));
    if (data) req.write(data); req.end();
  });
}

const TOOLS = [
  { name: 'get_full_graph', description: 'Get the current workspace task graph: all tasks (with derived status not_ready/ready/in_progress/tested/done/failed/canceled and dependencies), cross-workspace ghost stubs, overlay edges, and a summary.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: (a, call) => call('GET', '/state') },
  { name: 'get_adjacent', description: 'Get one task plus its immediate neighbourhood: dependencies, cross-workspace ghost dependencies, and dependents.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('GET', `/task/adjacent?${q({ key: a.task_key })}`) },
  { name: 'get_dependency_tree', description: 'Walk VERTICALLY up a task\'s dependency chain (transitive deps) returning each ancestor with summary + depth. Ghost deps come back as a frontier (use peek_workspace).', inputSchema: { type: 'object', properties: { task_key: { type: 'string' }, depth: { type: 'number' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('GET', `/task/tree?${q({ key: a.task_key, depth: a.depth })}`) },
  { name: 'start_task', description: 'Claim a task and mark it in_progress, recording which agent is working it (drives the live graph). Call FIRST when you begin a task.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' }, agent_id: { type: 'string' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('POST', '/overlay/status', { key: a.task_key, status: 'in_progress', agent_id: a.agent_id }) },
  { name: 'complete_task', description: 'Mark a task done and record a CONCISE summary (the interface other tasks pull as cheap base context). Keep it short.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' }, summary: { type: 'string' }, agent_id: { type: 'string' } }, required: ['task_key', 'summary'], additionalProperties: false }, run: (a, call) => call('POST', '/overlay/status', { key: a.task_key, status: 'done', summary: a.summary, agent_id: a.agent_id }) },
  { name: 'set_status', description: 'Set the overlay status for a task. Allowed: in_progress, tested, done, failed, canceled (also not_ready/ready, normally derived). Prefer start_task/complete_task.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' }, status: { type: 'string', enum: ['not_ready', 'ready', 'in_progress', 'tested', 'done', 'failed', 'canceled'] }, note: { type: 'string' } }, required: ['task_key', 'status'], additionalProperties: false }, run: (a, call) => call('POST', '/overlay/status', { key: a.task_key, status: a.status, note: a.note }) },
  { name: 'get_dependency_summaries', description: 'TIER 1 (cheap, do first): concise summaries of a task\'s dependencies — enough to start without loading full context.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('GET', `/task/context?${q({ key: a.task_key })}`) },
  { name: 'get_task_detail', description: 'TIER 2 (on demand): full detail for one task — knowledge items, summary, assigned agent, token usage, transcript pointer.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('GET', `/task/detail?${q({ key: a.task_key })}`) },
  { name: 'attach_knowledge', description: 'Attach a Tier-2 knowledge item to a task. item = { type: "file"|"snippet"|"link"|"note", value, ... }.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' }, item: { type: 'object' } }, required: ['task_key', 'item'], additionalProperties: false }, run: (a, call) => call('POST', '/overlay/knowledge', { key: a.task_key, item: a.item }) },
  { name: 'record_decision', description: "Capture a durable decision, rationale, or finding from the conversation as a NOTE node in the graph (NOT a todo). It becomes Tier-1 context for related future tasks via context edges + suggest_links. Use when a turn produces lasting knowledge, or when the user says 'remember this'.", inputSchema: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' }, knowledge: { type: 'array' } }, required: ['title', 'summary'], additionalProperties: false }, run: (a, call) => call('POST', '/overlay/note', { title: a.title, summary: a.summary, knowledge: a.knowledge, created_by: 'main' }) },
  { name: 'add_dependency', description: 'Add a dependency edge. kind:"blocking" (default) = `to` is blocked by `from` (true prerequisite). kind:"context" = non-blocking link so `from`\'s summary flows into `to` as Tier-1 context EVEN IF `from` is already done (use to wire a new task to relevant existing/completed work). For a CROSS-WORKSPACE ghost edge set from_workspace to the provider\'s absolute path.', inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, from_workspace: { type: 'string' }, kind: { type: 'string', enum: ['blocking', 'context'] } }, required: ['from', 'to'], additionalProperties: false }, run: (a, call) => call('POST', '/overlay/edge', { from: a.from, to: a.to, fromWorkspace: a.from_workspace, kind: a.kind }) },
  { name: 'suggest_links', description: 'Suggest existing tasks (INCLUDING completed ones) that a task should link to, ranked by label+summary overlap. Call right after creating a task: link DONE matches as kind:"context" so their summaries become context, and true prerequisites as kind:"blocking" — this stops new tasks from piling up as disconnected root nodes.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('GET', `/task/suggest?${q({ key: a.task_key })}`) },
  { name: 'next_action', description: 'HEARTBEAT: ask the daemon what to do next — { action: spawn|idle|stop, tasks?, next_poll_seconds?, budget_remaining }.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: (a, call) => call('GET', '/next-action') },
  { name: 'loop_start', description: 'Start the heartbeat loop with explicit token controls (tokenBudget, maxIterations, minPoll, maxPoll, estPerTick, batch). Hard caps.', inputSchema: { type: 'object', properties: { tokenBudget: { type: 'number' }, maxIterations: { type: 'number' }, minPoll: { type: 'number' }, maxPoll: { type: 'number' }, estPerTick: { type: 'number' }, batch: { type: 'number' } }, additionalProperties: false }, run: (a, call) => call('POST', '/loop/start', a) },
  { name: 'loop_stop', description: 'Stop the heartbeat loop.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: (a, call) => call('POST', '/loop/stop', {}) },
  { name: 'loop_status', description: 'Get heartbeat loop state: active, iterations, spent, budget, config.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: (a, call) => call('GET', '/loop/status') },
  { name: 'peek_workspace', description: 'Load another workspace\'s full task graph on demand (does not change current). Inspect a ghost dependency\'s source.', inputSchema: { type: 'object', properties: { workspace: { type: 'string' } }, required: ['workspace'], additionalProperties: false }, run: (a, call) => call('GET', `/peek?${q({ workspace: a.workspace })}`) },
  { name: 'git_init', description: 'Initialize git in the current workspace so attempts can branch (idempotent). Run once before branch_task.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: (a, call) => call('POST', '/git/init') },
  { name: 'branch_task', description: 'Create an isolated git worktree + branch (orch/attempt/<key>) for a task attempt, recorded on the task node. The foundation of side-by-side experiment isolation.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('POST', '/git/worktree', { key: a.task_key }) },
  { name: 'remove_worktree', description: 'Remove a task attempt\'s git worktree and delete its branch (idempotent cleanup).', inputSchema: { type: 'object', properties: { task_key: { type: 'string' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('POST', '/git/worktree/remove', { key: a.task_key }) },
  { name: 'git_status', description: 'Report whether the workspace is a git repo and list active attempt worktrees.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: (a, call) => call('GET', '/git/status') },
  { name: 'merge_attempt', description: 'Merge a winning attempt\'s branch (orch/attempt/<key>) back into the base. Returns {merged} or {conflict, files}. The merge half of the judge/merge-back loop.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('POST', '/git/merge', { key: a.task_key }) },
  { name: 'show_dashboard', description: 'Render the orchestrator task-graph dashboard INLINE in the conversation (interactive, live-updating). Use when the user wants to SEE the graph without a browser.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, meta: { ui: { resourceUri: UI_URI, visibility: ['model', 'app'], csp: { connectDomains: [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, 'https://localhost:8788', 'https://127.0.0.1:8788'] } } }, run: () => Promise.resolve({ rendered: true, note: 'Dashboard shown inline; it polls the daemon live.' }) },
];
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// Handle one JSON-RPC message. Returns the response object, or undefined for notifications.
async function handleRpc(msg, ctx) {
  const { id, method, params } = msg;
  const call = ctx.call, html = ctx.uiHtml || uiHtml;
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL, capabilities: { tools: {}, resources: {}, extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [UI_MIME] } } }, serverInfo: { name: 'orchestrator-graph', version: '0.1.0' } } };
  if (method === 'notifications/initialized' || method === 'initialized') return undefined;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.meta ? { _meta: t.meta } : {}) })) } };
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [{ uri: UI_URI, name: 'Orchestrator dashboard', mimeType: UI_MIME, description: 'Live task dependency graph (inline)' }] } };
  if (method === 'resources/read') {
    if (params && params.uri === UI_URI) return { jsonrpc: '2.0', id, result: { contents: [{ uri: UI_URI, mimeType: UI_MIME, text: html() }] } };
    return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown resource: ${params && params.uri}` } };
  }
  if (method === 'tools/call') {
    const tool = TOOL_BY_NAME[params && params.name];
    if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${params && params.name}` } };
    try { const out = await tool.run(params.arguments || {}, call); return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: !!(out && out.error) } }; }
    catch (e) { return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true } }; }
  }
  if (id != null) return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  return undefined;
}

module.exports = { UI_URI, UI_MIME, DEFAULT_PROTOCOL, TOOLS, handleRpc, makeCall, uiHtml, readToken };
