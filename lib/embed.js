// Embedding client — defaults to the MiniLM sidecar (lib/embed-server.js), with a provider registry
// for instruction-aware/tunable alternatives.
//
// The sidecar runs as a detached process so it survives daemon restarts; cold start
// (10–90s model load) happens at most once per machine session, not per daemon restart.
//
// CONTRACT (unchanged from the old monolithic version):
//   embed(text)  → Promise<number[]|null>   vector floats, or null while provider is unavailable.
//   cosine(a, b) → number                   dot product of pre-normalized vectors.
//   embedStatus()→ string                   'idle' | 'loading' | 'ready' | 'disabled'
//   ping()       → Promise<bool>            heartbeat to sidecar (daemon calls every 60s)
'use strict';
const http    = require('http');
const { spawn } = require('child_process');
const fs      = require('fs');
const path    = require('path');
const runtimePaths = require('./runtime-paths');
const embedProviders = require('./embed-providers');

const BASE         = runtimePaths.resolveDataDir();
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
    // Sidecar stderr must not inherit a short-lived test/CLI process pipe; otherwise
    // spawnSync callers can wait for EOF until timeout even after the parent exits.
    let errStdio = 'ignore';
    try { fs.mkdirSync(BASE, { recursive: true }); errStdio = fs.openSync(path.join(BASE, 'embed-server.log'), 'a'); } catch { /* fall back to ignore */ }
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      detached: true,
      stdio: ['ignore', 'ignore', errStdio],
      env: { ...process.env },
      windowsHide: true,
    });
    if (typeof errStdio === 'number') { try { fs.closeSync(errStdio); } catch { /* child keeps its dup */ } }
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

async function embedWithMeta(text, opts = {}) {
  const s = String(text ?? '').trim();
  const cfg = embedProviders.normalizeEmbeddingConfig(opts.overlay || opts.config || opts);
  const provider = embedProviders.getProvider(cfg.provider) || embedProviders.getProvider(embedProviders.DEFAULT_PROVIDER_ID);
  const meta = embedProviders.embeddingMeta(cfg);
  if (!s) return { vec: null, meta };
  if (provider.id !== embedProviders.DEFAULT_PROVIDER_ID) {
    try {
      const vec = provider.embed ? await provider.embed(s, cfg, { mode: embedProviders.normalizeMode(opts.mode) }) : null;
      if (Array.isArray(vec) && (!meta.dimensions || vec.length === meta.dimensions)) return { vec, meta: { ...meta, dimensions: vec.length, identity: `${meta.provider}:${meta.model}:${vec.length}` } };
    } catch (e) {
      if (process.env.ZONOID_EMBED_DEBUG === '1') process.stderr.write(`[embed] provider ${provider.id} failed: ${e.message}\n`);
    }
    return { vec: null, meta };
  }
  if (_disabled) return { vec: null, meta };
  try {
    const r = await socketRequest('POST', '/embed', { text: s });
    if (!_ready) { _ready = true; process.stderr.write('[embed] sidecar connected\n'); }
    const vec = Array.isArray(r.vec) && r.vec.length === DIMS ? r.vec : null;
    return { vec, meta };
  } catch {
    spawnSidecar();   // socket not ready — sidecar loading or not yet spawned
    return { vec: null, meta };      // caller falls back to lexical; retry on next call
  }
}

async function embed(text, opts = {}) {
  const r = await embedWithMeta(text, opts);
  return r && Array.isArray(r.vec) ? r.vec : null;
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
function expectedMeta(opts = {}) {
  return opts.expectedMeta || (opts.overlay ? embedProviders.embeddingMeta(opts.overlay) : null);
}

function nodeVecs(node, opts = {}) {
  const expected = expectedMeta(opts);
  const keep = (vec, meta) => {
    if (!Array.isArray(vec)) return false;
    if (!expected) return vec.length > 0;
    return embedProviders.vectorMatchesMeta(vec, meta || null, expected);
  };
  if (node && Array.isArray(node.vecs) && node.vecs.length) {
    const metas = Array.isArray(node.vecsMeta) ? node.vecsMeta : [];
    return node.vecs.filter((v, i) => keep(v, metas[i] || node.vecMeta || null));
  }
  if (node && Array.isArray(node.vec) && keep(node.vec, node.vecMeta || null)) return [node.vec];
  return [];
}

// MAX cosine of a query vector against a node's vector set (the multi-vec scoring rule). Returns 0
// when the query vec or the node's vector set is empty — identical to single-.vec cosine for a node
// that carries exactly one vector, so note scores are UNCHANGED.
function maxCosine(qvec, node, opts = {}) {
  if (!Array.isArray(qvec) || qvec.length === 0) return 0;
  const vecs = nodeVecs(node, opts);
  if (vecs.length === 0) return 0;
  let best = -Infinity;
  for (const v of vecs) {
    const s = cosine(qvec, v);
    if (s > best) best = s;
  }
  return best;
}

// Eagerly spawn sidecar on module load so MiniLM is warm before the first write arrives
spawnSidecar();

module.exports = {
  embed,
  embedWithMeta,
  cosine,
  nodeVecs,
  maxCosine,
  embedStatus,
  ping,
  embeddingMeta: embedProviders.embeddingMeta,
  normalizeEmbeddingConfig: embedProviders.normalizeEmbeddingConfig,
  validateEmbeddingConfig: embedProviders.validateEmbeddingConfig,
  listEmbeddingProviders: embedProviders.listProviders,
  getEmbeddingProvider: embedProviders.getProvider,
  annotateEmbeddingProvider: embedProviders.annotateProvider,
  vectorMatchesMeta: embedProviders.vectorMatchesMeta,
  MODEL: 'Xenova/all-MiniLM-L6-v2',
  DIMS,
};
