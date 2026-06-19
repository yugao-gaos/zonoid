#!/usr/bin/env node
// Cross-encoder rerank sidecar — runs detached from the daemon, survives daemon restarts.
// Mirrors lib/embed-server.js (MiniLM sidecar); coexists with it on a SEPARATE socket/pid.
//
// Lifecycle:
//   - Spawned by lib/rerank.js on first rerank() call (detached + unref'd, outlives the daemon).
//   - Exits after IDLE_MS of no /rerank calls (frees the model's RSS when retrieval is idle).
//   - Exits if no /ping heartbeat for HEARTBEAT_TIMEOUT_MS (daemon died without clean shutdown).
//   - On daemon restart, rerank.js reconnects to the already-running sidecar — no re-load.
//
// Why a cross-encoder: the bi-encoder (MiniLM embed sidecar) scores query and doc SEPARATELY, so
// it confuses "about X" with "the answer to X" — the precision@k failure. A cross-encoder attends
// query+doc JOINTLY in one forward pass and is far more precise at ranking a recall shortlist.
//
// Protocol: HTTP over Unix socket (SOCKET_PATH). Two endpoints:
//   POST /rerank { query: string, docs: string[] } → { scores: number[]|null }  (one per doc, in order)
//   GET  /ping                                      → { ok: true, ready: bool }
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const runtimePaths = require('./runtime-paths');

const BASE              = runtimePaths.resolveDataDir();
const { ipcPath }       = require('./ipc-path');
const SOCKET_PATH       = ipcPath('rerank');   // SEPARATE from embed — Unix socket (mac/linux) | named pipe (Windows)
const PID_FILE          = path.join(BASE, 'rerank.pid');    // SEPARATE from embed.pid
const CACHE_DIR         = path.join(BASE, 'models');        // shared model cache dir is fine
const MODEL             = 'Xenova/ms-marco-MiniLM-L-6-v2';  // cross-encoder (sequence classification, 1 logit)
const IDLE_MS           = 30 * 60 * 1000;  // exit after 30 min of no rerank requests
const HEARTBEAT_TIMEOUT = 2 * 60 * 1000;   // exit if no /ping for 2 min (daemon gone)

let _tokenizer      = null;
let _model          = null;
let _idleTimer      = null;
let _heartbeatTimer = null;

function resetIdle() {
  clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    process.stderr.write('[rerank-server] idle 30min — exiting\n');
    cleanup(); process.exit(0);
  }, IDLE_MS);
}

function resetHeartbeat() {
  clearTimeout(_heartbeatTimer);
  _heartbeatTimer = setTimeout(() => {
    process.stderr.write('[rerank-server] no heartbeat 2min — daemon gone, exiting\n');
    cleanup(); process.exit(0);
  }, HEARTBEAT_TIMEOUT);
}

function cleanup() {
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
}

const ready = () => !!(_tokenizer && _model);
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

async function loadModel() {
  const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import('@xenova/transformers');
  env.allowLocalModels = false;
  env.cacheDir = CACHE_DIR;
  const cached = fs.existsSync(path.join(CACHE_DIR, MODEL.replace('/', path.sep)));
  process.stderr.write(
    cached
      ? '[rerank-server] loading cross-encoder from cache...\n'
      : '[rerank-server] downloading cross-encoder (~80MB) — first run only...\n'
  );
  const t = Date.now();
  _tokenizer = await AutoTokenizer.from_pretrained(MODEL);
  _model     = await AutoModelForSequenceClassification.from_pretrained(MODEL);
  process.stderr.write(`[rerank-server] ready (${((Date.now() - t) / 1000).toFixed(1)}s)\n`);
}

// Score each (query, doc) pair jointly. Returns number[] (one relevance score per doc, in input
// order; higher = more relevant) or null on bad input / not-ready / error — the caller then keeps
// the upstream cosine order (null-safe degrade, mirroring embed()).
async function rerank(query, docs) {
  const q = String(query ?? '').trim();
  if (!q || !ready() || !Array.isArray(docs) || docs.length === 0) return null;
  const texts = docs.map((d) => String(d ?? ''));
  try {
    // Batched cross-encoder: the query is paired with every doc; the tokenizer builds
    // [CLS] query [SEP] doc [SEP] for each pair. text_pair accepts a parallel array.
    const inputs = await _tokenizer(texts.map(() => q), { text_pair: texts, padding: true, truncation: true });
    const { logits } = await _model(inputs);
    const dims = logits.dims;                       // [batch, num_labels]
    const numLabels = dims[dims.length - 1];
    const data = logits.data;                       // flat Float32Array, length batch*num_labels
    const scores = [];
    for (let i = 0; i < texts.length; i++) {
      // ms-marco cross-encoders are single-logit relevance regressors; squash to (0,1) so the
      // score is on a comparable scale to cosine for downstream blending. If a 2-label variant is
      // ever used, take the positive-class logit.
      const logit = numLabels === 1 ? data[i] : data[i * numLabels + 1];
      scores.push(sigmoid(logit));
    }
    return scores.length === texts.length ? scores : null;
  } catch (e) {
    process.stderr.write(`[rerank-server] rerank error: ${e.message}\n`);
    return null;
  }
}

// Remove stale socket from a previous crash before binding
try { fs.unlinkSync(SOCKET_PATH); } catch {}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/ping') {
    resetHeartbeat();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ready: ready() }));
    return;
  }

  if (req.method === 'POST' && req.url === '/rerank') {
    resetIdle();
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      try {
        const { query, docs } = JSON.parse(body);
        const scores = await rerank(query, docs);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ scores }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ scores: null, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(SOCKET_PATH, () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  process.stderr.write(`[rerank-server] listening pid=${process.pid}\n`);
  resetIdle();
  resetHeartbeat();
  loadModel().catch((e) => {
    process.stderr.write(`[rerank-server] model load failed: ${e.message}\n`);
    cleanup(); process.exit(1);
  });
});

process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT',  () => { cleanup(); process.exit(0); });
