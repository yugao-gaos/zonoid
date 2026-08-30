#!/usr/bin/env node
// MCP server (stdio) for the orchestrator graph. Thin transport over the shared mcp-core;
// self-boots the daemon so it works in environments that launch MCP servers but not hooks.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runtimePath } = require('./lib/runtime-paths');
const core = require('./lib/mcp-core');
const { extraToolsForClient, resolveSession } = require('./lib/mcp-harness-tools');
const workspaceRegistry = require('./lib/workspace-registry');
const requestIdentity = require('./lib/request-identity');
const { hasHeadlessDrainAncestor } = require('./lib/headless-ancestor');

const CLIENT = String(process.env.ORCH_CLIENT || 'claude').trim() || 'claude';

const PORT = process.env.ORCH_PORT ? Number(process.env.ORCH_PORT) : 8787;
const DAEMON = path.join(__dirname, 'daemon.js');
// This CLIENT composes request identity. Explicit canonical env vars win; deprecated
// ORCH_WORKSPACE still aliases graph_repo. Cwd discovery belongs here—not in the daemon—and only
// finds the graph-bearing repo. target_repo defaults client-side only when the named workspace is
// unambiguous.
const GRAPH_REPO = process.env.ORCH_GRAPH_REPO || process.env.ORCH_WORKSPACE
  || workspaceRegistry.repoRoot(process.cwd());
const CLIENT_IDENTITY = {
  workspace_id: process.env.ORCH_WORKSPACE_ID || null,
  graph_repo: GRAPH_REPO,
  target_repo: process.env.ORCH_TARGET_REPO || null,
};
function refreshClientIdentity() {
  const reg = workspaceRegistry.loadRegistry(runtimePath('workspaces.json'));
  Object.assign(CLIENT_IDENTITY, requestIdentity.composeClientIdentity(CLIENT_IDENTITY, reg));
}
refreshClientIdentity();
const CALL = core.makeCall(PORT, CLIENT_IDENTITY);
// Harness session fallback: Claude Desktop exposes CLAUDE_CODE_SESSION_ID and Codex may expose
// CODEX_THREAD_ID. When Codex Desktop exposes neither, resolveSession creates a random key scoped
// to this MCP process so session-bound tools can still use the shared timer substrate.
const SESSION = resolveSession({ client: CLIENT }) || null;
const CLIENT_EXTRA = extraToolsForClient(CLIENT, GRAPH_REPO, { session: SESSION, workspace: GRAPH_REPO });
const RPC_CONTEXT = {
  call: CALL,
  uiHtml: core.uiHtml,
  extraTools: CLIENT_EXTRA,
  session: SESSION,
  identity: CLIENT_IDENTITY,
  workspace: GRAPH_REPO,
  client: CLIENT,
};

function daemonEnv() {
  const env = { ...process.env };
  delete env.ZONOID_HARNESS;
  delete env.ORCH_CLIENT;
  return env;
}

// Cross-platform liveness check for an already-running daemon. The daemon writes its pid to a global
// pidfile on bind (see daemon.js writeDaemonPidfile); we read it and probe the pid with signal 0.
// This replaces a `ps`-based scan that THREW on Windows (no `ps`) and so ALWAYS returned false —
// which let every slow-ping moment spawn a redundant daemon, piling up zombies behind a window storm.
function hasDaemonProcess() {
  if (PORT !== 8787) return false;
  try {
    const pid = Number(fs.readFileSync(runtimePath('daemon.pid'), 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    process.kill(pid, 0); // throws ESRCH when the pid is not alive
    return true;
  } catch {
    return false; // no pidfile, malformed pid, or not alive ⇒ treat as no daemon
  }
}

// ---- boot the daemon if it isn't up (hookless environments) ----
function ping() {
  return new Promise((r) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/ping', method: 'GET', timeout: 300 }, (res) => { res.resume(); res.on('end', () => r(true)); });
    req.on('error', () => r(false)); req.on('timeout', () => { req.destroy(); r(false); });
    req.end();
  });
}
let ensuring = null;
async function ensureDaemon() {
  if (hasHeadlessDrainAncestor()) return;
  if (await ping()) return;
  if (hasDaemonProcess()) {
    for (let i = 0; i < 20; i++) {
      if (await ping()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    return;
  }
  if (!ensuring) ensuring = (async () => {
    try { spawn(process.execPath, [DAEMON], { detached: true, stdio: 'ignore', env: daemonEnv(), windowsHide: true }).unref(); } catch { /* ignore */ }
    for (let i = 0; i < 40; i++) { if (await ping()) break; await new Promise((r) => setTimeout(r, 100)); }
  })().finally(() => { ensuring = null; });
  return ensuring;
}

// ---- JSON-RPC over stdio ----
function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
async function handle(msg) {
  if (msg.method === 'tools/call') await ensureDaemon();   // self-heal before any tool runs
  const resp = await core.handleRpc(msg, RPC_CONTEXT);
  if (resp !== undefined) write(resp);
}

let buf = '', inFlight = 0, ending = false;
const maybeExit = () => { if (ending && inFlight === 0) process.exit(0); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    inFlight++;
    Promise.resolve(handle(msg)).catch(() => {}).finally(() => { inFlight--; maybeExit(); });
  }
});
process.stdin.on('end', () => { ending = true; maybeExit(); });

// Startup: boot the daemon + register this graph repo, then refresh named-workspace ambiguity.
(async () => {
  try {
    await ensureDaemon();
    if (GRAPH_REPO) {
      await CALL('POST', '/workspace', { path: GRAPH_REPO, workspace_id: CLIENT_IDENTITY.workspace_id });
      refreshClientIdentity();
    }
  } catch { /* ignore */ }
})();
