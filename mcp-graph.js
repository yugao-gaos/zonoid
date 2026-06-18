#!/usr/bin/env node
// MCP server (stdio) for the orchestrator graph. Thin transport over the shared mcp-core;
// self-boots the daemon so it works in environments that launch MCP servers but not hooks.
'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./lib/mcp-core');
const { extraToolsForClient, resolveSession } = require('./lib/mcp-harness-tools');
const { repoRoot } = require('./lib/workspace-registry');

const CLIENT = String(process.env.ORCH_CLIENT || 'claude').trim() || 'claude';

const PORT = process.env.ORCH_PORT ? Number(process.env.ORCH_PORT) : 8787;
const DAEMON = path.join(__dirname, 'daemon.js');
// This session's pinned workspace (ORCH_WORKSPACE lets a process target a workspace independent
// of its cwd). Passed into makeCall so every MUTATING (POST) tool call carries it — graph writes
// land in THIS session's workspace even when another session flipped the daemon's global
// state.workspace (the workspace-gremlin fix). The old ~/.claude/orchestrator/workspace pointer
// file AND the process.cwd()-as-workspace fallback are gone (note:note-mqj0wcabtxh): when
// ORCH_WORKSPACE is unset we resolve cwd -> its containing repo via repoRoot, and WS stays null if
// cwd is not inside a repo (callers tolerate null — see makeCall in lib/mcp-core.js).
const WS = process.env.ORCH_WORKSPACE || repoRoot(process.cwd());
const CALL = core.makeCall(PORT, WS);
// Harness session fallback: Claude Desktop exposes CLAUDE_CODE_SESSION_ID and Codex exposes
// CODEX_THREAD_ID. Without this, ctx.session is null and session-bound tools such as start_task
// cannot inject the worker's real harness session into the claim.
const SESSION = resolveSession({ client: CLIENT }) || null;
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
(async () => { try { await ensureDaemon(); if (WS) await CALL('POST', '/workspace', { path: WS }); } catch { /* ignore */ } })();
