// Local semantic embeddings for the knowledge graph — NO hosted API, NO vector DB.
//
// Wraps transformers.js (@xenova/transformers) + all-MiniLM-L6-v2 (ONNX, 384-dim) to turn a piece
// of text into a unit-normalized 384-float vector, computed entirely in-process. The pipeline is
// lazy-loaded ONCE on first use (the weights download the first time, then cache to disk) and the
// loaded extractor is cached for the daemon's lifetime.
//
// CONTRACT (the rest of the daemon relies on this):
//   embed(text)  -> Promise<number[]|null>   384 floats, or null on ANY failure. NEVER throws.
//   cosine(a, b) -> number                    dot product (vectors are pre-normalized) in [-1, 1].
//
// embed() returning null is a first-class, expected outcome (module not installed, weights can't
// download, runtime error) — callers fall back to lexical scoring. Retrieval must never hard-fail.
//
// transformers.js v2 is ESM-only; this module is CommonJS, so the pipeline is reached via dynamic
// import(). The model cache is pinned under the daemon data dir so it survives node_modules reinstalls.
'use strict';
const os = require('os');
const path = require('path');

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIMS = 384;
// Pin the model cache next to the daemon's other persistent state (not inside node_modules, which
// is per-machine/disposable). Mirrors lib/overlay.js's BASE resolution.
const BASE = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'orchestrator');
const CACHE_DIR = path.join(BASE, 'models');

let _extractorPromise = null;  // memoized load (shared across concurrent callers)
let _ready = false;            // flipped to true once the extractor resolves successfully
let _disabled = false;         // set once if loading is known to be impossible — short-circuits future calls

// Lazy-load + cache the MiniLM feature-extraction pipeline. Resolves to the extractor, or null if
// the module/model can't be loaded (recorded so we don't retry a hopeless load on every query).
function getExtractor() {
  if (_disabled) return Promise.resolve(null);
  if (_extractorPromise) return _extractorPromise;
  const _loadStart = Date.now();
  _extractorPromise = (async () => {
    try {
      const { pipeline, env } = await import('@xenova/transformers');
      env.allowLocalModels = false;   // pull canonical weights from the hub (then cached locally)
      env.cacheDir = CACHE_DIR;       // persist weights under the daemon data dir
      const fs = require('fs');
      const cached = fs.existsSync(CACHE_DIR);
      process.stderr.write(
        cached
          ? '[zonoid] MiniLM loading from cache...\n'
          : '[zonoid] MiniLM downloading (~90MB) and loading — first run only, ~90s...\n'
      );
      const extractor = await pipeline('feature-extraction', MODEL);
      const elapsed = ((Date.now() - _loadStart) / 1000).toFixed(1);
      process.stderr.write(`[zonoid] MiniLM ready (${elapsed}s)\n`);
      _ready = true;
      return extractor;
    } catch (e) {
      _disabled = true;               // module missing or load failed — stop trying, fall back to lexical
      process.stderr.write(`[zonoid] MiniLM unavailable (${e.message}) — falling back to lexical search\n`);
      return null;
    }
  })();
  return _extractorPromise;
}

// Embed `text` to a 384-float unit vector. Returns null (never throws) on empty input or any
// failure, so callers can transparently fall back to lexical scoring.
async function embed(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  const extractor = await getExtractor();
  if (!extractor) return null;
  try {
    const out = await extractor(s, { pooling: 'mean', normalize: true });
    const vec = Array.from(out.data);
    if (vec.length !== DIMS) return null;
    return vec;
  } catch (e) {
    return null;
  }
}

// Cosine similarity. Inputs from embed() are already unit-normalized, so this is just the dot
// product; we divide by the norms anyway so it's correct for un-normalized inputs too. Returns 0
// for missing / mismatched-length / zero vectors (never throws).
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Returns current MiniLM load state for health/status endpoints.
function embedStatus() {
  if (_disabled) return 'disabled';
  if (!_extractorPromise) return 'idle';
  return _ready ? 'ready' : 'loading';
}

module.exports = { embed, cosine, embedStatus, MODEL, DIMS };
