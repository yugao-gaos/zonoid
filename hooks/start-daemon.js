#!/usr/bin/env node
'use strict';
// SessionStart: boot the daemon (idempotent, detached) and register this workspace so the graph
// reflects this project. Cross-platform Node port of start-daemon.sh — daemon.js is located
// relative to this hook (<install-root>/daemon.js) rather than via $HOME guessing.
const path = require('path');
const fs = require('fs');
const k = require('./lib/hookkit');
const { repoRoot } = require('../lib/workspace-registry');
const codexSessionBridge = require('../lib/codex-session-bridge');
const { hasHeadlessDrainAncestor } = require('../lib/headless-ancestor');
const daemonHandoff = require('../lib/daemon-handoff');

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

  const port = process.env.ORCH_PORT ? Number(process.env.ORCH_PORT) : 8787;
  const daemon = path.join(__dirname, '..', 'daemon.js');
  const expectedIdentity = daemonHandoff.expectedDaemonIdentity(daemon);
  let reachable = await k.ping(300);
  let observed = null;
  if (reachable) {
    observed = await daemonHandoff.probeDaemon({ port, timeoutMs: 700 });
  }

  // Unsigned listeners retain the historical ping-only compatibility path, but are never signaled.
  // A signed daemon serving an older checkout goes through the guarded, PID-file-backed handoff.
  if (!reachable || (observed && observed.identified && !daemonHandoff.identityMatches(observed, expectedIdentity))) {
    const env = { ...process.env };
    delete env.ZONOID_HARNESS; delete env.ORCH_CLIENT;
    // Headless drains are default-on for the long-lived user daemon. Do not let a
    // bench/test parent env silently disable them for normal hook-launched boots.
    delete env.ORCH_HEADLESS_DRAINS;
    const handoff = await daemonHandoff.ensureCurrentDaemon({
      port,
      daemonPath: daemon,
      expectedIdentity,
      env,
      healthTimeoutMs: 700,
      handoffTimeoutMs: 4500,
      startupTimeoutMs: 7000,
      pollMs: 100,
    });
    reachable = handoff.ok;
  }
  if (!reachable) process.exit(0);

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
