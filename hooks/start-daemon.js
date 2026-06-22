#!/usr/bin/env node
'use strict';
// SessionStart: boot the daemon (idempotent, detached) and register this workspace so the graph
// reflects this project. Cross-platform Node port of start-daemon.sh — daemon.js is located
// relative to this hook (<install-root>/daemon.js) rather than via $HOME guessing.
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { runtimePath } = require('../lib/runtime-paths');
const k = require('./lib/hookkit');
const { repoRoot } = require('../lib/workspace-registry');
const codexSessionBridge = require('../lib/codex-session-bridge');
const { hasHeadlessDrainAncestor } = require('../lib/headless-ancestor');

/**
 * Returns a promise that resolves true when TCP port is already bound (i.e., something is
 * listening on it), false otherwise. Cross-platform — uses Node's built-in `net` module.
 *
 * This is used to detect a daemon that is still loading (has bound the port but hasn't yet
 * answered the /ping health-check), preventing a duplicate spawn storm during that window.
 */
function isPortBound(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.listen(port, '127.0.0.1', () => {
      // We were able to bind → port is FREE → no daemon listening
      server.close(() => resolve(false));
    });
    server.on('error', (err) => {
      // EADDRINUSE → port is already in use → daemon (or something) holds it
      resolve(err.code === 'EADDRINUSE');
    });
  });
}

/**
 * hasDaemonProcess(): returns true when a running daemon is detected on port 8787.
 *
 * Two complementary checks (either one returns true):
 *   1. PID-file check: reads daemon.pid and tests liveness via process.kill(pid, 0).
 *      Cross-platform in Node — works on Windows and POSIX.
 *   2. TCP port check: attempts to bind 8787; if EADDRINUSE, the port is held.
 *      Catches the load window where the daemon has bound but not yet answered /ping,
 *      which is exactly the window that was triggering the respawn storm.
 */
async function hasDaemonProcess() {
  const port = process.env.ORCH_PORT ? Number(process.env.ORCH_PORT) : 8787;
  if (port !== 8787) return false;

  // Check 1: PID file
  try {
    const pid = Number(fs.readFileSync(runtimePath('daemon.pid'), 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      process.kill(pid, 0); // throws ESRCH when the pid is not alive
      return true; // pid alive → daemon is running
    }
  } catch { /* no pidfile, malformed pid, or ESRCH → fall through to port check */ }

  // Check 2: TCP port — catch the startup window where daemon holds port but /ping not ready
  try {
    if (await isPortBound(port)) return true;
  } catch { /* ignore — conservative fallback */ }

  return false;
}

(async () => {
  if (hasHeadlessDrainAncestor()) process.exit(0);
  if (fs.existsSync(path.join(__dirname, '..', '.orch-off'))) process.exit(0);
  const input = await k.readInput();
  const tx = input.transcript_path || '';
  const sid = input.session_id || '';
  const harness = input.harness || process.env.ZONOID_HARNESS || '';
  // Resolve the workspace as the repo CONTAINING cwd (note:note-mqj0wcabtxh): the old
  // ~/.claude/orchestrator/workspace pointer and the raw-cwd-as-workspace fallback are gone.
  // repoRoot returns null when cwd is not inside a repo — we then skip POST /workspace.
  const cwd = repoRoot(input.cwd || process.cwd());

  let reachable = await k.ping(300);
  if (!reachable && await hasDaemonProcess()) {
    for (let i = 0; i < 20; i++) {
      if (await k.ping(500)) { reachable = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!reachable) process.exit(0);
  }

  if (!reachable) {
    try {
      const daemon = path.join(__dirname, '..', 'daemon.js');
      const env = { ...process.env };
      delete env.ZONOID_HARNESS; delete env.ORCH_CLIENT;
      // Headless drains are default-on for the long-lived user daemon. Do not let a
      // bench/test parent env silently disable them for normal hook-launched boots.
      delete env.ORCH_HEADLESS_DRAINS;
      spawn(process.execPath, [daemon], { detached: true, stdio: 'ignore', env, windowsHide: true }).unref();
    } catch { /* ignore */ }
    for (let i = 0; i < 40; i++) { if (await k.ping(200)) break; await new Promise((r) => setTimeout(r, 100)); }
  }

  if (cwd) {
    const body = { path: cwd, transcript: tx, session_id: sid };
    if (harness) body.harness = harness;
    if (harness === 'codex' && sid) {
      try { codexSessionBridge.writeLatestSession({ workspace: cwd, session_id: sid, transcript: tx }); } catch { /* best effort */ }
    }
    await k.post('/workspace', body, 500);
    await k.post('/usage/reconcile', { harness: harness || 'claude', workspace: cwd, session: sid }, 2000);
  }
  process.exit(0);
})().catch(() => process.exit(0));
