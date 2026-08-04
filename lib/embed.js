// Embedding client — defaults to the MiniLM sidecar (lib/embed-server.js), with a provider registry
// for instruction-aware/tunable alternatives.
//
// The sidecar runs as a detached process so it survives daemon restarts; cold start
// (10–90s model load) happens at most once per machine session, not per daemon restart.
//
// CONTRACT:
//   embed(text)  → Promise<number[]|null>   legacy document-text embedding.
//   embed({ input, mode, modality, ...providerOptions }) → Promise<number[]|null>
//                 instruction-aware request; mode accepts retrieval.query / retrieval.document
//                 plus query / document aliases.
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
// See lib/rerank.js for the full rationale. The child writes PID_FILE only after Node boots and
// server.listen fires, and the socket doesn't accept until the model loads — a window in which
// every embed() failure would otherwise spawn another sidecar. This in-process latch caps spawns to
// one per SPAWN_COOLDOWN_MS regardless of PID-file timing, so a cold start can't storm. (embed is
// spawned eagerly on module load so this rarely fires in practice, but the storm-safety is shared
// with rerank — keep the two guards identical.)
let _lastSpawnAt = 0;
const SPAWN_COOLDOWN_MS = 30_000;  // ≥ worst-case child boot + model load before it binds/accepts

// --- sidecar management -----------------------------------------------------------------------

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function spawnSidecar() {
  if (_spawning || _disabled) return;
  // In-process cooldown: suppress re-spawns while a sidecar we already launched is still booting /
  // loading its model (before it has had a chance to write PID_FILE and bind the socket).
  if (_lastSpawnAt && (Date.now() - _lastSpawnAt) < SPAWN_COOLDOWN_MS) return;
  // Already running?
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (pid && isRunning(pid)) return;  // still alive — socket should be available shortly
  }
  _spawning = true;
  _lastSpawnAt = Date.now();
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

function normalizeEmbedRequest(input, opts = {}) {
  if (input && typeof input === 'object' && !Array.isArray(input) && Object.prototype.hasOwnProperty.call(input, 'input')) {
    const { input: requestInput, text, mode, modality, overlay, config, provider, model, dimensions, baseUrl, apiStyle, adapter, tuned_model_id, tunedModelId, customModel } = input;
    const providerOptions = { provider, model, dimensions, baseUrl, apiStyle, adapter, tuned_model_id, tunedModelId, customModel };
    for (const key of Object.keys(providerOptions)) {
      if (providerOptions[key] === undefined) delete providerOptions[key];
    }
    return {
      input: requestInput !== undefined ? requestInput : text,
      opts: {
        ...providerOptions,
        ...opts,
        overlay: opts.overlay || overlay,
        config: opts.config || config,
        mode: opts.mode || mode,
        modality: opts.modality || modality,
      },
    };
  }
  return { input, opts: opts || {} };
}

async function embedWithMeta(text, opts = {}) {
  const req = normalizeEmbedRequest(text, opts);
  text = req.input;
  opts = req.opts;
  const cfgSource = opts.overlay || opts.config || (opts.provider ? opts : null) || opts;
  const cfg = embedProviders.normalizeEmbeddingConfig(cfgSource);
  const provider = embedProviders.getProvider(cfg.provider) || embedProviders.getProvider(embedProviders.DEFAULT_PROVIDER_ID);
  const mode = embedProviders.normalizeMode(opts.mode);
  const meta = embedProviders.embeddingMeta(cfg, { mode, modality: opts.modality });
  const modality = embedProviders.normalizeModality(opts.modality || cfg.modality);
  const input = modality === 'text' ? String(text ?? '').trim() : text;
  if (modality === 'text' && !input) return { vec: null, meta };
  if (modality !== 'text' && (input === null || input === undefined || input === '')) return { vec: null, meta };
  if (provider.id !== embedProviders.DEFAULT_PROVIDER_ID) {
    try {
      const vec = provider.embed ? await provider.embed(input, cfg, { mode, modality }) : null;
      if (Array.isArray(vec) && (!meta.dimensions || vec.length === meta.dimensions)) {
        const actualMeta = { ...meta, dimensions: vec.length };
        actualMeta.identity = embedProviders.vectorIdentityString(actualMeta);
        return { vec, meta: actualMeta };
      }
    } catch (e) {
      if (process.env.ZONOID_EMBED_DEBUG === '1') process.stderr.write(`[embed] provider ${provider.id} failed: ${e.message}\n`);
    }
    return { vec: null, meta };
  }
  if (_disabled) return { vec: null, meta };
  try {
    const r = await socketRequest('POST', '/embed', { text: input });
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
  const normalized = Array.isArray(texts) ? texts.map((t) => normalizeEmbedRequest(t, opts)) : [];
  const arr = normalized.map((r) => String(r.input ?? '').trim());
  if (!arr.length) return [];

  // A non-default provider has no /embed-batch — preserve correctness by mapping through embed().
  const cfg = embedProviders.normalizeEmbeddingConfig(opts.overlay || opts.config || opts);
  if (cfg.provider && cfg.provider !== embedProviders.DEFAULT_PROVIDER_ID) {
    return Promise.all(normalized.map(async (r) => ({ vec: await embed({ input: r.input, mode: r.opts.mode, modality: r.opts.modality }, r.opts) })));
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
    return Promise.all(normalized.map(async (r) => ({ vec: await embed({ input: r.input, mode: r.opts.mode, modality: r.opts.modality }, r.opts) })));
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
  VECTOR_SCHEMA_VERSION: embedProviders.VECTOR_SCHEMA_VERSION,
  VECTOR_IDENTITY_FIELDS: embedProviders.VECTOR_IDENTITY_FIELDS,
  vectorMatchesMeta: embedProviders.vectorMatchesMeta,
  MODEL: 'Xenova/all-MiniLM-L6-v2',
  DIMS,
};
