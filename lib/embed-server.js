#!/usr/bin/env node
// MiniLM embedding sidecar — runs detached from the daemon, survives daemon restarts.
//
// Lifecycle:
//   - Spawned by lib/embed.js on first embed() call (detached + unref'd, so it outlives the daemon).
//   - Exits after IDLE_MS of no /embed calls (frees ~150MB RSS when orchestrator is idle).
//   - Exits if no /ping heartbeat for HEARTBEAT_TIMEOUT_MS (daemon died without clean shutdown).
//   - On daemon restart, embed.js reconnects to the already-running sidecar — no re-load.
//
// Protocol: HTTP over Unix socket (SOCKET_PATH). Three endpoints:
//   POST /embed        { text: string }    → { vec: number[]|null }
//   POST /embed-batch  { texts: string[] } → { vecs: (number[]|null)[] }   (one MiniLM inference for the whole array)
//   GET  /ping                             → { ok: true, ready: bool }
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const runtimePaths = require('./runtime-paths');

const BASE              = runtimePaths.resolveDataDir();
const { ipcPath }       = require('./ipc-path');
const SOCKET_PATH       = ipcPath('embed');  // Unix socket (mac/linux) | named pipe (Windows)
const PID_FILE          = path.join(BASE, 'embed.pid');
const CACHE_DIR         = path.join(BASE, 'models');
const MODEL             = 'Xenova/all-MiniLM-L6-v2';
const DIMS              = 384;
const IDLE_MS           = 30 * 60 * 1000;  // exit after 30 min of no embed requests
const HEARTBEAT_TIMEOUT = 2 * 60 * 1000;   // exit if no /ping for 2 min (daemon gone)

let _extractor      = null;
let _idleTimer      = null;
let _heartbeatTimer = null;

function resetIdle() {
  clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    process.stderr.write('[embed-server] idle 30min — exiting\n');
    cleanup(); process.exit(0);
  }, IDLE_MS);
}

function resetHeartbeat() {
  clearTimeout(_heartbeatTimer);
  _heartbeatTimer = setTimeout(() => {
    process.stderr.write('[embed-server] no heartbeat 2min — daemon gone, exiting\n');
    cleanup(); process.exit(0);
  }, HEARTBEAT_TIMEOUT);
}

function cleanup() {
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
}

async function loadModel() {
  const { pipeline, env } = await import('@xenova/transformers');
  env.allowLocalModels = false;
  env.cacheDir = CACHE_DIR;
  const cached = fs.existsSync(CACHE_DIR);
  process.stderr.write(
    cached
      ? '[embed-server] loading MiniLM from cache...\n'
      : '[embed-server] downloading MiniLM (~90MB) — first run only...\n'
  );
  const t = Date.now();
  _extractor = await pipeline('feature-extraction', MODEL);
  process.stderr.write(`[embed-server] ready (${((Date.now() - t) / 1000).toFixed(1)}s)\n`);
}

async function embed(text) {
  const s = String(text ?? '').trim();
  if (!s || !_extractor) return null;
  try {
    const out = await _extractor(s, { pooling: 'mean', normalize: true });
    const vec = Array.from(out.data);
    return vec.length === DIMS ? vec : null;
  } catch { return null; }
}

// Batch embed: run the extractor over the WHOLE array in ONE inference (the costly part is the
// forward pass, not the JS glue — batching collapses N round-trips into one). For array input the
// pipeline returns a tensor shaped [N, DIMS]; out.data is a flat Float32Array of N*DIMS, which we
// slice back into N vectors. Returns a (number[]|null)[] aligned 1:1 with `texts` — a slot is null
// when the text is blank or its slice isn't exactly DIMS long. Returns all-nulls if the model isn't
// loaded yet, mirroring embed()'s fail-soft contract (the caller falls back to lexical).
async function embedBatch(texts) {
  const arr = Array.isArray(texts) ? texts.map((t) => String(t ?? '').trim()) : [];
  if (!arr.length) return [];
  if (!_extractor) return arr.map(() => null);
  // Blank entries can't be embedded (and an all-blank array would feed nothing to the model); only
  // run inference on the non-empty texts, then scatter results back to their original positions.
  const idx = [];
  const nonEmpty = [];
  for (let i = 0; i < arr.length; i++) { if (arr[i]) { idx.push(i); nonEmpty.push(arr[i]); } }
  const vecs = arr.map(() => null);
  if (!nonEmpty.length) return vecs;
  try {
    const out = await _extractor(nonEmpty, { pooling: 'mean', normalize: true });
    const flat = out.data; // flat Float32Array of nonEmpty.length * DIMS
    for (let j = 0; j < nonEmpty.length; j++) {
      const slice = Array.from(flat.slice(j * DIMS, (j + 1) * DIMS));
      vecs[idx[j]] = slice.length === DIMS ? slice : null;
    }
    return vecs;
  } catch { return arr.map(() => null); }
}

// Remove stale socket from a previous crash before binding
try { fs.unlinkSync(SOCKET_PATH); } catch {}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/ping') {
    resetHeartbeat();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ready: !!_extractor }));
    return;
  }

  if (req.method === 'POST' && req.url === '/embed') {
    resetIdle();
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        const vec = await embed(text);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ vec }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ vec: null, error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/embed-batch') {
    resetIdle();
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      try {
        const { texts } = JSON.parse(body);
        const vecs = await embedBatch(texts);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ vecs }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ vecs: null, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end();
});

// Only bind the socket + load the model when run as the spawned sidecar process
// (node lib/embed-server.js). lib/embed.js ALWAYS launches it that way (spawn(execPath,
// [SERVER_SCRIPT])), so production behaviour is byte-identical. Guarding the side effects behind
// require.main lets tests `require()` this module to exercise embedBatch / the route splitting with a
// stubbed extractor, without binding a socket, writing a PID file, or loading the real ~90MB model.
if (require.main === module) {
  server.listen(SOCKET_PATH, () => {
    fs.writeFileSync(PID_FILE, String(process.pid));
    process.stderr.write(`[embed-server] listening pid=${process.pid}\n`);
    resetIdle();
    resetHeartbeat();
    // Eager load — minimise the window where writes arrive before MiniLM is ready
    loadModel().catch((e) => {
      process.stderr.write(`[embed-server] model load failed: ${e.message}\n`);
      cleanup(); process.exit(1);
    });
  });

  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT',  () => { cleanup(); process.exit(0); });
}

// Exported for tests only — the spawned sidecar uses none of these (it runs the server above).
// __setExtractor injects a stub so the batch path can be exercised without loading MiniLM.
module.exports = {
  embed,
  embedBatch,
  server,
  DIMS,
  __setExtractor: (fn) => { _extractor = fn; },
};
