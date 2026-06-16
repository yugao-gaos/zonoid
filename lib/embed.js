// Embedding client — delegates to the MiniLM sidecar (lib/embed-server.js).
//
// The sidecar runs as a detached process so it survives daemon restarts; cold start
// (10–90s model load) happens at most once per machine session, not per daemon restart.
//
// CONTRACT (unchanged from the old monolithic version):
//   embed(text)  → Promise<number[]|null>   384 floats, or null while sidecar is loading / on error.
//   cosine(a, b) → number                   dot product of pre-normalized vectors.
//   embedStatus()→ string                   'idle' | 'loading' | 'ready' | 'disabled'
//   ping()       → Promise<bool>            heartbeat to sidecar (daemon calls every 60s)
'use strict';
const http    = require('http');
const { spawn } = require('child_process');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');

const BASE         = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'orchestrator');
const { ipcPath }  = require('./ipc-path');
const SOCKET_PATH  = ipcPath('embed');  // Unix socket (mac/linux) | named pipe (Windows)
const PID_FILE     = path.join(BASE, 'embed.pid');
const SERVER_SCRIPT = path.join(__dirname, 'embed-server.js');
const DIMS         = 384;

let _ready    = false;
let _disabled = false;
let _spawning = false;

// --- sidecar management -----------------------------------------------------------------------

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function spawnSidecar() {
  if (_spawning || _disabled) return;
  // Already running?
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (pid && isRunning(pid)) return;  // still alive — socket should be available shortly
  }
  _spawning = true;
  try {
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      detached: true,
      stdio: ['ignore', 'ignore', 'inherit'],  // inherit stderr so logs appear in daemon output
      env: { ...process.env },
      windowsHide: true,
    });
    child.unref();  // don't keep the daemon alive for the sidecar
    process.stderr.write(`[embed] spawned sidecar pid=${child.pid}\n`);
  } catch (e) {
    process.stderr.write(`[embed] failed to spawn sidecar: ${e.message} — falling back to lexical\n`);
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

async function embed(text) {
  if (_disabled) return null;
  const s = String(text ?? '').trim();
  if (!s) return null;
  try {
    const r = await socketRequest('POST', '/embed', { text: s });
    if (!_ready) { _ready = true; process.stderr.write('[embed] sidecar connected\n'); }
    return Array.isArray(r.vec) && r.vec.length === DIMS ? r.vec : null;
  } catch {
    spawnSidecar();   // socket not ready — sidecar loading or not yet spawned
    return null;      // caller falls back to lexical; retry on next call
  }
}

async function ping() {
  if (_disabled) return false;
  try {
    const r = await socketRequest('GET', '/ping', null, 2000);
    return r?.ok === true;
  } catch { return false; }
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// PID-file liveness, not socket existence: fs.existsSync is false for a Windows named pipe even
// when the sidecar is listening, so it would wrongly report 'idle'.
function sidecarAlive() {
  try { const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10); return pid > 0 && isRunning(pid); }
  catch { return false; }
}
function embedStatus() {
  if (_disabled) return 'disabled';
  if (!sidecarAlive()) return 'idle';
  return _ready ? 'ready' : 'loading';
}

// MULTI-VECTOR schema accessor. A node may carry EITHER a single `.vec` (legacy notes) OR a `.vecs`
// array (tasks, and any future multi-vector node — e.g. Step 3 doc expansion appends extra vectors).
// Returns the node's vectors as a (possibly empty) array WITHOUT mutating the node. Back-compat:
// `.vecs` wins when present; otherwise a single `.vec` is wrapped; otherwise [].
function nodeVecs(node) {
  if (node && Array.isArray(node.vecs) && node.vecs.length) return node.vecs;
  if (node && Array.isArray(node.vec)) return [node.vec];
  return [];
}

// MAX cosine of a query vector against a node's vector set (the multi-vec scoring rule). Returns 0
// when the query vec or the node's vector set is empty — identical to single-.vec cosine for a node
// that carries exactly one vector, so note scores are UNCHANGED.
function maxCosine(qvec, node) {
  if (!Array.isArray(qvec) || qvec.length === 0) return 0;
  let best = 0;
  for (const v of nodeVecs(node)) {
    const s = cosine(qvec, v);
    if (s > best) best = s;
  }
  return best;
}

// Eagerly spawn sidecar on module load so MiniLM is warm before the first write arrives
spawnSidecar();

module.exports = { embed, cosine, nodeVecs, maxCosine, embedStatus, ping, MODEL: 'Xenova/all-MiniLM-L6-v2', DIMS };
