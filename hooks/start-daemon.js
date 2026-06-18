#!/usr/bin/env node
'use strict';
// SessionStart: boot the daemon (idempotent, detached) and register this workspace so the graph
// reflects this project. Cross-platform Node port of start-daemon.sh — daemon.js is located
// relative to this hook (<install-root>/daemon.js) rather than via $HOME guessing.
const path = require('path');
const { spawn } = require('child_process');
const k = require('./lib/hookkit');
const { repoRoot } = require('../lib/workspace-registry');

(async () => {
  const input = await k.readInput();
  const tx = input.transcript_path || '';
  const sid = input.session_id || '';
  const harness = input.harness || '';
  // Resolve the workspace as the repo CONTAINING cwd (note:note-mqj0wcabtxh): the old
  // ~/.claude/orchestrator/workspace pointer and the raw-cwd-as-workspace fallback are gone.
  // repoRoot returns null when cwd is not inside a repo — we then skip POST /workspace.
  const cwd = repoRoot(input.cwd || process.cwd());

  if (!(await k.ping(300))) {
    try {
      const daemon = path.join(__dirname, '..', 'daemon.js');
      const env = { ...process.env };
      delete env.ZONOID_HARNESS; delete env.ORCH_CLIENT;
      spawn(process.execPath, [daemon], { detached: true, stdio: 'ignore', env, windowsHide: true }).unref();
    } catch { /* ignore */ }
    for (let i = 0; i < 40; i++) { if (await k.ping(200)) break; await new Promise((r) => setTimeout(r, 100)); }
  }

  if (cwd) {
    const body = { path: cwd, transcript: tx, session_id: sid };
    if (harness) body.harness = harness;
    await k.post('/workspace', body, 500);
    await k.post('/usage/reconcile', { harness: harness || 'claude', workspace: cwd, session: sid }, 2000);
  }
  process.exit(0);
})().catch(() => process.exit(0));
