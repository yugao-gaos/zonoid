// Cross-encoder rerank client — delegates to the rerank sidecar (lib/rerank-server.js).
//
// Mirrors lib/embed.js, with ONE deliberate difference: the sidecar is spawned LAZILY on the first
// rerank() call, NOT eagerly on module load. Reranking sits behind the ORCH_RERANK flag, so the
// ~80MB cross-encoder must not load when the flag is off / rerank() is never called.
//
// CONTRACT:
//   rerank(query, docs) → Promise<number[]|null>  one relevance score per doc (input order),
//                                                  or null while the sidecar loads / on any error
//                                                  → callers KEEP their upstream cosine order.
//   rerankStatus()      → string                  'idle' | 'loading' | 'ready' | 'disabled'
//   ping()              → Promise<bool>            heartbeat to sidecar
'use strict';
const http      = require('http');
const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

const BASE          = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'orchestrator');
const { ipcPath }   = require('./ipc-path');
const SOCKET_PATH   = ipcPath('rerank');  // Unix socket (mac/linux) | named pipe (Windows)
const PID_FILE      = path.join(BASE, 'rerank.pid');
const SERVER_SCRIPT = path.join(__dirname, 'rerank-server.js');

let _ready    = false;
let _disabled = false;
let _spawning = false;

// --- sidecar management -----------------------------------------------------------------------

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function spawnSidecar() {
  if (_spawning || _disabled) return;
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (pid && isRunning(pid)) return;  // still alive — socket should be available shortly
  }
  _spawning = true;
  try {
    // Sidecar stderr → a log file under BASE, NOT the parent's inherited stderr. A detached child
    // that inherits stderr keeps that fd's write-end open after the parent exits; when the parent is
    // a short-lived process whose stderr is a pipe (e.g. the test runner's spawnSync, or any CLI that
    // triggers a rerank then exits), the reader never sees EOF and hangs. A log file decouples the
    // sidecar's lifetime from the parent's stdio while keeping its logs inspectable.
    let errStdio = 'ignore';
    try { fs.mkdirSync(BASE, { recursive: true }); errStdio = fs.openSync(path.join(BASE, 'rerank-server.log'), 'a'); } catch { /* fall back to ignore */ }
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      detached: true,
      stdio: ['ignore', 'ignore', errStdio],
      env: { ...process.env },
      windowsHide: true,
    });
    if (typeof errStdio === 'number') { try { fs.closeSync(errStdio); } catch { /* child keeps its dup */ } }
    child.unref();
    process.stderr.write(`[rerank] spawned sidecar pid=${child.pid}\n`);
  } catch (e) {
    process.stderr.write(`[rerank] failed to spawn sidecar: ${e.message} — reranking disabled\n`);
    _disabled = true;
  }
  _spawning = false;
}

// --- socket RPC -------------------------------------------------------------------------------

function socketRequest(method, urlPath, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      socketPath: SOCKET_PATH,
      path: urlPath,
      method,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
    };
    const req = http.request(opts, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { reject(new Error('bad json')); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

// --- public API -------------------------------------------------------------------------------

// Rerank `docs` against `query`. Returns number[] (one score per doc, input order; higher = more
// relevant) or null on bad input / sidecar-loading / error. NULL-SAFE: a null return means the
// caller keeps its existing order — reranking is a best-effort precision boost, never a hard dep.
async function rerank(query, docs) {
  if (_disabled) return null;
  const q = String(query ?? '').trim();
  if (!q || !Array.isArray(docs) || docs.length === 0) return null;
  try {
    const r = await socketRequest('POST', '/rerank', { query: q, docs });
    if (!_ready) { _ready = true; process.stderr.write('[rerank] sidecar connected\n'); }
    return Array.isArray(r.scores) && r.scores.length === docs.length ? r.scores : null;
  } catch {
    spawnSidecar();   // socket not ready — sidecar loading or not yet spawned; retry next call
    return null;      // caller keeps cosine order
  }
}

async function ping() {
  if (_disabled) return false;
  try {
    const r = await socketRequest('GET', '/ping', null, 2000);
    return r?.ok === true;
  } catch { return false; }
}

// PID-file liveness, not socket existence (fs.existsSync is false for a Windows named pipe).
function sidecarAlive() {
  try { const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10); return pid > 0 && isRunning(pid); }
  catch { return false; }
}
function rerankStatus() {
  if (_disabled) return 'disabled';
  if (!sidecarAlive()) return 'idle';
  return _ready ? 'ready' : 'loading';
}

// NOTE: no eager spawnSidecar() here (unlike embed.js) — the sidecar loads lazily on first rerank().

module.exports = { rerank, ping, rerankStatus, MODEL: 'Xenova/ms-marco-MiniLM-L-6-v2' };
