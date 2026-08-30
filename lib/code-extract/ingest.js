'use strict';
// code-extract/ingest.js — Phase 2 ingest helper: extract a repo's symbols and POST them into the
// dedicated code-index layer via /overlay/code-nodes/bulk. This is the glue between the PURE extractor
// (index.js, no daemon writes) and the daemon's code_node storage. The full onboarder CLI (extract →
// bulk-ingest → progress/repair) is Phase 4; this helper is the minimal, testable core it will call.
//
//   extractRepo(repo).symbols  →  code_node payloads  →  POST {nodes, workspace} to a running daemon.
//
// PURE-ish: it reads files (via the extractor) and makes bounded HTTP POSTs. It does NOT touch the
// overlay directly — the daemon owns the writes (batched embed + upsert). Returns the daemon responses
// plus a small ingest summary so a caller/CLI can report counts without re-deriving them.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { extractRepo, extractRepoAsync } = require('./index');
const { resolveCodeEdges } = require('./resolve-edges');

// Default cap on the body snippet folded into a code_node's `summary` (chars). Bounded so the embed
// text stays well under MiniLM's ~256-token (~1000-char) window once name/signature/file are prepended,
// and so a single huge function can't blow up a bulk request body. Tuned in the search-economy bench
// (note-mqqmixayq8m): a 600-char body lifted first-party deliver-code recall 0.385 -> 0.647.
const DEFAULT_BODY_CAP = 600;

// daemon.js intentionally caps request bodies at 1 MiB. Keep code-index writes comfortably below
// that global limit so headers/workspace growth and future payload fields cannot turn a valid batch
// into an EPIPE. This is enforced by serialized UTF-8 bytes, not just item count.
const DEFAULT_MAX_REQUEST_BYTES = 900 * 1024;
const DEFAULT_EDGE_BATCH_SIZE = 2000;

// A leading doc-comment immediately above a symbol is high-signal (it usually states the symbol's
// PURPOSE in NL — exactly what an NL query matches), so we scan at most this many lines upward for a
// contiguous `//`/`*` comment block and prepend it to the body.
const MAX_DOC_LINES = 12;

// Read the source body for one extracted symbol from its file:line span, optionally prefixed with the
// contiguous leading doc-comment block, and cap it at `cap` chars. Returns '' when the file/lines are
// missing or unreadable — the body is ADDITIVE signal, never a hard dependency, so any failure just
// yields the prior thin embed text. `readFile(relPath)` returns the file's full text (or null); the
// caller injects a memoized reader so each file is read at most once across all its symbols.
function symbolBodySnippet(sym, readFile, cap = DEFAULT_BODY_CAP) {
  if (!sym || !sym.file || sym.start_line == null) return '';
  let src;
  try { src = readFile(sym.file); } catch { src = null; }
  if (typeof src !== 'string' || !src) return '';

  const lines = src.split('\n');
  const startIdx = Math.max(0, (sym.start_line | 0) - 1);              // 1-based -> 0-based
  const endIdx = sym.end_line != null ? Math.min(lines.length, sym.end_line | 0) : Math.min(lines.length, startIdx + 1);
  if (startIdx >= lines.length) return '';

  // Walk upward from the line above the symbol while lines are part of a comment block (`//`, `/* … */`,
  // or a continuation `*`). Stop at the first blank/code line so we only grab the symbol's OWN doc.
  const docLines = [];
  for (let i = startIdx - 1, scanned = 0; i >= 0 && scanned < MAX_DOC_LINES; i--, scanned++) {
    const t = lines[i].trim();
    if (t === '') break;
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.endsWith('*/')) {
      docLines.unshift(lines[i]);
    } else break;
  }

  const body = lines.slice(startIdx, endIdx).join('\n');
  const combined = (docLines.length ? docLines.join('\n') + '\n' : '') + body;
  const normalized = combined.replace(/\r/g, '').trim();
  return normalized.length > cap ? normalized.slice(0, cap).trim() : normalized;
}

// Build a memoized repo-relative file reader rooted at `repoRoot`. Reads each file at most once (null
// cached for unreadable/missing files). When `repoRoot` is falsy, returns a reader that always yields
// null — i.e. the body-enrich step no-ops and the legacy thin embed text is preserved.
function makeFileReader(repoRoot) {
  const cache = new Map();
  return function readFile(relPath) {
    if (!repoRoot || !relPath) return null;
    if (cache.has(relPath)) return cache.get(relPath);
    let src = null;
    try { src = fs.readFileSync(path.join(repoRoot, relPath), 'utf8'); } catch { src = null; }
    cache.set(relPath, src);
    return src;
  };
}

// Map one extractor symbol -> a code_node payload the /overlay/code-nodes/bulk route accepts.
// The route forms the key (code:<file>#<name>) and embeds `<name> — <signature> in <file>` plus the
// `summary` (lib/node-tags.js codeNodeEmbedText), so we forward the salient fields AND — when a body
// snippet is supplied — fold the bounded source body into `summary` to thicken the embed surface for
// NL recall. `class` (the enclosing class for a method, when present) is folded into the signature so
// it stays retrievable without adding a bespoke field.
function symbolToCodeNode(sym, summary) {
  if (!sym || !sym.name) return null;
  const signature = sym.class ? `${sym.class}.${sym.signature || sym.name}` : (sym.signature || sym.name);
  const node = {
    name: sym.name,
    kind: sym.kind || 'symbol',
    file: sym.file || null,
    start_line: sym.start_line != null ? sym.start_line : null,
    end_line: sym.end_line != null ? sym.end_line : null,
    signature,
    exported: !!sym.exported,
  };
  const body = typeof summary === 'string' ? summary.trim() : (sym.summary ? String(sym.summary).trim() : '');
  if (body) node.summary = body;
  return node;
}

// Turn an extractor result (or a raw symbols[]) into the code_node payload array. Exposed so a caller
// can extract once and reuse the symbols for both ingest and (later) edge sync without re-walking.
// Options:
//   repoRoot — absolute repo path. When present, each symbol's bounded source body (file:line span +
//              leading doc-comment, capped at bodyCap) is read and folded into the code_node `summary`
//              so the embed text becomes `name — signature in file <body>`. Omitted => legacy thin text.
//   bodyCap  — max body-snippet length in chars (default DEFAULT_BODY_CAP=600).
function symbolsToCodeNodes(symbols, { repoRoot = null, bodyCap = DEFAULT_BODY_CAP } = {}) {
  const arr = Array.isArray(symbols) ? symbols : [];
  const readFile = makeFileReader(repoRoot);
  const out = [];
  for (const s of arr) {
    const body = repoRoot ? symbolBodySnippet(s, readFile, bodyCap) : '';
    const node = symbolToCodeNode(s, body);
    if (node) out.push(node);
  }
  return out;
}

// POST a JSON body to a URL, resolving the parsed JSON response (or rejecting on non-2xx / bad JSON).
function postJSON(endpoint, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(endpoint); } catch (e) { reject(e); return; }
    const data = Buffer.from(JSON.stringify(body));
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': data.length };
    try {
      const token = require('../mcp-core').readToken();
      if (token) headers['x-orch-token'] = token;
    } catch { /* auth is optional for legacy/local daemons */ }
    const req = mod.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = s ? JSON.parse(s) : null; } catch { /* leave null */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(new Error(`bulk ingest HTTP ${res.statusCode}: ${parsed ? JSON.stringify(parsed) : s}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('bulk ingest timeout')));
    req.write(data);
    req.end();
  });
}

// Split an array across JSON request payloads bounded by BOTH item count and serialized UTF-8 bytes.
// `base` contains the fields repeated on every request (currently workspace). A single item larger
// than the cap is rejected before any oversized request is emitted.
function boundedPayloads(items, { field, base = {}, maxItems = Infinity, maxBytes = DEFAULT_MAX_REQUEST_BYTES } = {}) {
  if (!field) throw new Error('payload field required');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive number');
  if (!(maxItems === Infinity || (Number.isFinite(maxItems) && maxItems > 0))) {
    throw new Error('maxItems must be a positive number');
  }

  const arr = Array.isArray(items) ? items : [];
  const emptyBytes = Buffer.byteLength(JSON.stringify({ [field]: [], ...base }));
  const payloads = [];
  let chunk = [];
  let chunkBytes = emptyBytes;

  for (const item of arr) {
    const json = JSON.stringify(item);
    const itemBytes = Buffer.byteLength(json === undefined ? 'null' : json);
    const separatorBytes = chunk.length ? 1 : 0;
    const candidateBytes = chunkBytes + separatorBytes + itemBytes;
    if (chunk.length && (chunk.length >= maxItems || candidateBytes > maxBytes)) {
      payloads.push({ [field]: chunk, ...base });
      chunk = [];
      chunkBytes = emptyBytes;
    }

    const nextBytes = chunkBytes + (chunk.length ? 1 : 0) + itemBytes;
    if (nextBytes > maxBytes) {
      throw new Error(`${field} item exceeds the ${maxBytes}-byte request cap`);
    }
    chunk.push(item);
    chunkBytes = nextBytes;
  }

  if (chunk.length) payloads.push({ [field]: chunk, ...base });
  return payloads;
}

// Ingest an already-extracted repo result. Kept separate from extraction so the HTTP batching contract
// can be regression-tested with a synthetic graph large enough to exceed the daemon body limit.
async function ingestExtracted(extracted, {
  daemonUrl,
  workspace,
  batchSize = 500,
  edgeBatchSize = DEFAULT_EDGE_BATCH_SIZE,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  bodyCap = DEFAULT_BODY_CAP,
  enrichBody = true,
  post = postJSON,
} = {}) {
  if (!daemonUrl) throw new Error('daemonUrl required');
  if (!workspace) throw new Error('workspace required');
  if (!extracted || !Array.isArray(extracted.symbols)) throw new Error('extracted symbols required');

  const nodes = symbolsToCodeNodes(extracted.symbols, { repoRoot: enrichBody ? extracted.repo : null, bodyCap });
  const { codeEdges, stats: edgeStats } = resolveCodeEdges({ symbols: extracted.symbols, edges: extracted.edges });
  const baseUrl = String(daemonUrl).replace(/\/$/, '');
  const nodeEndpoint = `${baseUrl}/overlay/code-nodes/bulk`;
  const edgeEndpoint = `${baseUrl}/overlay/code-edges/bulk`;
  const nodePayloads = boundedPayloads(nodes, {
    field: 'nodes', base: { workspace }, maxItems: batchSize, maxBytes: maxRequestBytes,
  });
  const edgePayloads = boundedPayloads(codeEdges, {
    field: 'edges', base: { workspace }, maxItems: edgeBatchSize, maxBytes: maxRequestBytes,
  });

  const responses = [];
  let created = 0;
  let edgesAdded = 0;
  for (const payload of nodePayloads) {
    const resp = await post(nodeEndpoint, payload);
    responses.push(resp);
    if (resp && typeof resp.created === 'number') created += resp.created;
  }
  for (const payload of edgePayloads) {
    const resp = await post(edgeEndpoint, payload);
    responses.push(resp);
    if (resp && typeof resp.edges_added === 'number') edgesAdded += resp.edges_added;
    else if (resp && typeof resp.created === 'number') edgesAdded += resp.created;
  }

  return {
    repo: extracted.repo,
    workspace,
    symbols: nodes.length,
    created,
    edges: codeEdges.length,
    edges_added: edgesAdded,
    edge_stats: edgeStats,
    batches: nodePayloads.length,
    edge_batches: edgePayloads.length,
    stats: extracted.stats,
    responses,
  };
}

// Extract `repo` and ingest its symbols into the code-index layer of the daemon at `daemonUrl`, for
// `workspace`. Options:
//   daemonUrl  — base URL of a running daemon (e.g. http://localhost:8799). Required.
//   workspace  — workspace path the code_nodes belong to. Required (the route needs it to resolve overlay).
//   async      — when true, use extractRepoAsync (boots tree-sitter for non-JS/TS). Default false (JS/TS).
//   extractOpts— passed through to the extractor (skipDirs/exts overrides).
//   batchSize  — maximum nodes per request (default 500); serialized bytes are bounded separately.
//   edgeBatchSize — maximum edges per request (default 2000); edges use their own idempotent bulk route.
//   maxRequestBytes — serialized request cap (default 900 KiB, below daemon.js' 1 MiB limit).
//   bodyCap    — max source-body snippet folded into each code_node `summary` (chars, default 600).
//   enrichBody — fold the bounded source body into `summary` (default true). The body is read from the
//                extractor's own repo (extracted.repo), so the enriched embed text needs no extra I/O
//                config. Set false to restore the legacy thin `name — signature in file` embed text.
// Returns { repo, workspace, symbols, created, edges, edges_added, batches, edge_batches, stats, responses }.
async function ingestRepo(repo, opts = {}) {
  const { async = false, extractOpts = {} } = opts;
  const extracted = async ? await extractRepoAsync(repo, extractOpts) : extractRepo(repo, extractOpts);
  return ingestExtracted(extracted, opts);
}

module.exports = {
  ingestRepo,
  ingestExtracted,
  boundedPayloads,
  symbolsToCodeNodes,
  symbolToCodeNode,
  symbolBodySnippet,
  makeFileReader,
  postJSON,
  DEFAULT_BODY_CAP,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_EDGE_BATCH_SIZE,
  resolveCodeEdges,
};
