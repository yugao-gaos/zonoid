#!/usr/bin/env node
// MCP server (stdio) for the orchestrator graph. Thin transport over the shared mcp-core;
// self-boots the daemon so it works in environments that launch MCP servers but not hooks.
'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./lib/mcp-core');
const { extraToolsForClient } = require('./lib/mcp-harness-tools');

const CLIENT = String(process.env.ORCH_CLIENT || 'claude').trim() || 'claude';

const PORT = process.env.ORCH_PORT ? Number(process.env.ORCH_PORT) : 8787;
const DAEMON = path.join(__dirname, 'daemon.js');
// This session's pinned workspace (ORCH_WORKSPACE lets a process target a workspace independent
// of its cwd; unset => cwd). Passed into makeCall so every MUTATING (POST) tool call carries it —
// graph writes land in THIS session's workspace even when another session flipped the daemon's
// global state.workspace (the workspace-gremlin fix).
const WS = process.env.ORCH_WORKSPACE || (() => { try { return require('fs').readFileSync(require('path').join(process.env.CLAUDE_PLUGIN_DATA || require('path').join(require('os').homedir(),'.claude','orchestrator'), 'workspace'), 'utf8').trim() || null; } catch {} return null; })() || process.cwd();
const CALL = core.makeCall(PORT, WS);
// CLAUDE_CODE_SESSION_ID fallback: under the claude-desktop entrypoint the harness exports the
// session as CLAUDE_CODE_SESSION_ID (ORCH_SESSION/ZONOID_SESSION are unset). Without this the MCP
// server's session is null, so start_task records a claim under no/ fabricated session and the
// PreToolUse gate (which queries /active-claim with the worker's real harness .session_id) never
// matches → background-worker writes are wrongly denied (verified by probe, note-mqftffo7f2b).
const SESSION = process.env.ORCH_SESSION || process.env.ZONOID_SESSION || process.env.CLAUDE_CODE_SESSION_ID || null;
const CLIENT_EXTRA = extraToolsForClient(CLIENT, WS, { session: SESSION });

function daemonEnv() {
  const env = { ...process.env };
  delete env.ZONOID_HARNESS;
  delete env.ORCH_CLIENT;
  return env;
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
  if (await ping()) return;
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
  const resp = await core.handleRpc(msg, { call: CALL, uiHtml: core.uiHtml, extraTools: CLIENT_EXTRA, session: SESSION, workspace: WS });
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

// Startup: boot the daemon + register this workspace, so the graph reflects this project.
// (WS is resolved above, next to CALL, so mutating tool calls carry it per-request too.)
(async () => { try { await ensureDaemon(); await CALL('POST', '/workspace', { path: WS }); } catch { /* ignore */ } })();
