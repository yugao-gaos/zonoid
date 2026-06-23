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
const embeddingStore = require('./embedding-store');

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

// Batch embed: ONE sidecar round-trip for an array of texts (vs N round-trips through embed()). The
// sidecar runs the whole array through MiniLM in a single forward pass — the win that lets bulk
// ingest scale. Returns a [{ vec }]: an array aligned 1:1 with `texts`, each entry { vec: number[]|null }
// (null where the text is blank, the slice isn't DIMS long, or the sidecar is unavailable). Mirrors
// embed()'s fail-soft contract: a missing/cold sidecar yields nulls (caller falls back to lexical),
// it never throws. Non-default embedding providers don't expose a batch endpoint, so when one is
// configured we fan out through embed() per text (still correct, just not batched) rather than
// silently dropping to MiniLM.
async function embedBatch(texts, opts = {}) {
  const arr = Array.isArray(texts) ? texts.map((t) => String(t ?? '').trim()) : [];
  if (!arr.length) return [];

  // A non-default provider has no /embed-batch — preserve correctness by mapping through embed().
  const cfg = embedProviders.normalizeEmbeddingConfig(opts.overlay || opts.config || opts);
  if (cfg.provider && cfg.provider !== embedProviders.DEFAULT_PROVIDER_ID) {
    return Promise.all(arr.map(async (t) => ({ vec: await embed(t, opts) })));
  }

  if (_disabled) return arr.map(() => ({ vec: null }));
  try {
    const r = await socketRequest('POST', '/embed-batch', { texts: arr });
    if (!_ready) { _ready = true; process.stderr.write('[embed] sidecar connected\n'); }
    const vecs = Array.isArray(r && r.vecs) ? r.vecs : null;
    return arr.map((_t, i) => {
      const v = vecs && Array.isArray(vecs[i]) && vecs[i].length === DIMS ? vecs[i] : null;
      return { vec: v };
    });
  } catch {
    // Socket not ready — sidecar loading or not yet spawned. Kick a spawn (same as embed()) and fall
    // back to per-text embed() so the caller still gets vectors instead of an all-null batch.
    spawnSidecar();
    return Promise.all(arr.map(async (t) => ({ vec: await embed(t, opts) })));
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

const nodeVecs = embeddingStore.nodeVecs;
const maxCosine = embeddingStore.maxCosine;

// Eagerly spawn sidecar on module load so MiniLM is warm before the first write arrives
spawnSidecar();

module.exports = {
  embed,
  embedBatch,
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
