#!/usr/bin/env node
// Isolated snapshot-daemon for bench reproducibility.
//
// Boots a private daemon on a private port, pointed at a FROZEN copy of .graph so
// the gated/search arms RAG against a stable KB — not the live churning :8787 daemon.
//
// Usage (standalone):
//   node scripts/bench-snapshot-daemon.js [--refresh-snapshot] [--port 8810]
//
// Exported API (for bench-heldout.js):
//   const snap = require('./bench-snapshot-daemon');
//   const port = await snap.ensureRunning({ refreshSnapshot: false });
//   await snap.teardown();
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const REPO = process.env.ZONOID_REPO || path.resolve(__dirname, '..');
const DAEMON = path.join(REPO, 'daemon.js');
const SNAPSHOT_WS = path.join(REPO, 'bench', 'snapshot');   // frozen workspace root
const SNAPSHOT_GRAPH = path.join(SNAPSHOT_WS, '.graph');     // frozen .graph copy
const LIVE_GRAPH = path.join(REPO, '.graph');                // source to freeze from

// Singleton state for this process — one isolated daemon per bench run.
let _pid = null;
let _port = null;
let _dataDir = null;

// ---------- helpers ----------

function ping(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/ping', method: 'GET', timeout: 500 },
      (res) => { res.resume(); res.on('end', () => resolve(true)); }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function waitReady(port, attempts = 80, delayMs = 100) {
  for (let i = 0; i < attempts; i++) {
    if (await ping(port)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

function postJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, timeout: 5000 },
      (res) => { let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; }); res.on('end', () => resolve(s)); }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('postJson timeout')); });
    req.write(data);
    req.end();
  });
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// ---------- snapshot ----------

/**
 * Refresh the frozen snapshot from the live .graph.
 * Idempotent when refreshSnapshot=false: reuses existing bench/snapshot/.graph.
 */
function ensureSnapshot(refreshSnapshot = false) {
  if (!fs.existsSync(LIVE_GRAPH)) {
    throw new Error('Live .graph dir not found at ' + LIVE_GRAPH + ' — nothing to snapshot');
  }
  if (!refreshSnapshot && fs.existsSync(SNAPSHOT_GRAPH)) {
    return;  // already frozen, reuse for reproducibility
  }
  fs.rmSync(SNAPSHOT_GRAPH, { recursive: true, force: true });
  copyDirSync(LIVE_GRAPH, SNAPSHOT_GRAPH);
}

// ---------- daemon lifecycle ----------

/**
 * Pick a free-ish private port deterministically in the 8810–8899 range.
 * Avoids the live :8787 and smoke :8799 ports.
 */
function pickPort() {
  return 8810 + (crypto.randomInt(90));
}

/**
 * Boot the isolated daemon and POST /workspace to load the frozen snapshot.
 * Returns the chosen port. Idempotent — if already running, returns the cached port.
 */
async function ensureRunning({ refreshSnapshot = false, port: requestedPort } = {}) {
  // Already running in this process? Return cached port.
  if (_pid !== null) {
    // Verify it's still alive.
    if (await ping(_port)) return _port;
    // Stale — fall through to re-boot.
    _pid = null; _port = null; _dataDir = null;
  }

  ensureSnapshot(refreshSnapshot);

  const chosenPort = requestedPort || pickPort();
  // If something else is already on this port from a previous run, try to reuse it.
  if (await ping(chosenPort)) {
    // Accept an already-running daemon on this port (idempotent second boot).
    _port = chosenPort;
    _pid = null; // not our child, but usable
    return _port;
  }

  // Isolated CLAUDE_PLUGIN_DATA so the snapshot daemon's state never pollutes production.
  _dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bench-snap-'));

  // SHARE the immutable model cache (read-only weights) instead of isolating it: a fresh temp
  // dir has no embed/rerank models, forcing an ~80MB+ re-download per run — which never finishes
  // before the bench queries complete, so the cross-encoder silently never engages (rerank() → null
  // → cosine order). Symlink the canonical models dir so the sidecars load the CACHED weights fast
  // and reliably. State stays isolated; only the read-only weights are shared.
  try {
    const realModels = [path.join(REPO, 'models'), path.join(os.homedir(), '.claude', 'orchestrator', 'models')]
      .find((p) => fs.existsSync(p));
    if (realModels) fs.symlinkSync(realModels, path.join(_dataDir, 'models'), 'dir');
  } catch { /* best effort — falls back to download if the symlink can't be made */ }

  const child = spawn(process.execPath, [DAEMON], {
    env: {
      ...process.env,
      ORCH_PORT: String(chosenPort),
      CLAUDE_PLUGIN_DATA: _dataDir,
    },
    stdio: 'ignore',
    detached: false,
  });
  _pid = child.pid;
  _port = chosenPort;

  child.on('error', (err) => {
    process.stderr.write('[bench-snapshot-daemon] daemon spawn error: ' + err.message + '\n');
  });

  const ready = await waitReady(chosenPort);
  if (!ready) {
    throw new Error('bench-snapshot-daemon: isolated daemon did not come up on port ' + chosenPort);
  }

  // Point the isolated daemon at the frozen snapshot workspace.
  await postJson(chosenPort, '/workspace', { path: SNAPSHOT_WS });

  return _port;
}

/**
 * Kill the isolated daemon (if we spawned it). Safe to call multiple times.
 */
function teardown() {
  if (_pid !== null) {
    try { process.kill(_pid, 'SIGKILL'); } catch { /* already gone */ }
    _pid = null;
  }
  if (_dataDir) {
    try { fs.rmSync(_dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    _dataDir = null;
  }
  _port = null;
}

module.exports = { ensureSnapshot, ensureRunning, teardown, SNAPSHOT_WS, SNAPSHOT_GRAPH };

// ---------- CLI ----------
if (require.main === module) {
  const refreshSnapshot = process.argv.includes('--refresh-snapshot');
  const portArg = process.argv.indexOf('--port');
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : undefined;
  (async () => {
    try {
      const p = await ensureRunning({ refreshSnapshot, port });
      console.log('Isolated snapshot daemon running on port ' + p);
      console.log('Snapshot workspace: ' + SNAPSHOT_WS);
      console.log('Press Ctrl-C to stop.');
      process.on('SIGINT', () => { teardown(); process.exit(0); });
      process.on('SIGTERM', () => { teardown(); process.exit(0); });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  })();
}
