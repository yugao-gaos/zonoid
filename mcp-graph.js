#!/usr/bin/env node
// MCP server (stdio) for the orchestrator graph. Thin transport over the shared mcp-core;
// self-boots the daemon so it works in environments that launch MCP servers but not hooks.
'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./lib/mcp-core');

const PORT = process.env.ORCH_PORT ? Number(process.env.ORCH_PORT) : 8787;
const DAEMON = path.join(__dirname, 'daemon.js');
const CALL = core.makeCall(PORT);

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
    try { spawn(process.execPath, [DAEMON], { detached: true, stdio: 'ignore', env: process.env }).unref(); } catch { /* ignore */ }
    for (let i = 0; i < 40; i++) { if (await ping()) break; await new Promise((r) => setTimeout(r, 100)); }
  })().finally(() => { ensuring = null; });
  return ensuring;
}

// ---- JSON-RPC over stdio ----
function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
async function handle(msg) {
  if (msg.method === 'tools/call') await ensureDaemon();   // self-heal before any tool runs
  const resp = await core.handleRpc(msg, { call: CALL, uiHtml: core.uiHtml });
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

// Startup: boot the daemon + register this workspace (cwd), so the graph reflects this project.
(async () => { try { await ensureDaemon(); await CALL('POST', '/workspace', { path: process.cwd() }); } catch { /* ignore */ } })();
