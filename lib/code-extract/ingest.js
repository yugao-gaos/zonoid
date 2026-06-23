'use strict';
// code-extract/ingest.js — Phase 2 ingest helper: extract a repo's symbols and POST them into the
// dedicated code-index layer via /overlay/code-nodes/bulk. This is the glue between the PURE extractor
// (index.js, no daemon writes) and the daemon's code_node storage. The full onboarder CLI (extract →
// bulk-ingest → progress/repair) is Phase 4; this helper is the minimal, testable core it will call.
//
//   extractRepo(repo).symbols  →  code_node payloads  →  POST {nodes, workspace} to a running daemon.
//
// PURE-ish: it reads files (via the extractor) and makes ONE HTTP POST. It does NOT touch the overlay
// directly — the daemon owns the write (batched embed + upsert). Returns the daemon's bulk response
// plus a small ingest summary so a caller/CLI can report counts without re-deriving them.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { extractRepo, extractRepoAsync } = require('./index');
const { resolveCodeEdges } = require('./resolve-edges');

// Map one extractor symbol -> a code_node payload the /overlay/code-nodes/bulk route accepts.
// The route forms the key (code:<file>#<name>) and embeds `<name> — <signature> in <file>`, so we only
// forward the salient fields. `class` (the enclosing class for a method, when present) is folded into
// the signature so it stays retrievable without adding a bespoke field.
function symbolToCodeNode(sym) {
  if (!sym || !sym.name) return null;
  const signature = sym.class ? `${sym.class}.${sym.signature || sym.name}` : (sym.signature || sym.name);
  return {
    name: sym.name,
    kind: sym.kind || 'symbol',
    file: sym.file || null,
    start_line: sym.start_line != null ? sym.start_line : null,
    end_line: sym.end_line != null ? sym.end_line : null,
    signature,
    exported: !!sym.exported,
  };
}

// Turn an extractor result (or a raw symbols[]) into the code_node payload array. Exposed so a caller
// can extract once and reuse the symbols for both ingest and (later) edge sync without re-walking.
function symbolsToCodeNodes(symbols) {
  const arr = Array.isArray(symbols) ? symbols : [];
  const out = [];
  for (const s of arr) {
    const node = symbolToCodeNode(s);
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
    const req = mod.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
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

// Extract `repo` and ingest its symbols into the code-index layer of the daemon at `daemonUrl`, for
// `workspace`. Options:
//   daemonUrl  — base URL of a running daemon (e.g. http://localhost:8799). Required.
//   workspace  — workspace path the code_nodes belong to. Required (the route needs it to resolve overlay).
//   async      — when true, use extractRepoAsync (boots tree-sitter for non-JS/TS). Default false (JS/TS).
//   extractOpts— passed through to the extractor (skipDirs/exts overrides).
//   batchSize  — split the POST into batches of this many nodes (default 500). The route already
//                chunks embeds internally; this bounds a single request body for very large repos.
// Returns { repo, workspace, symbols, created, batches, stats, responses }.
async function ingestRepo(repo, { daemonUrl, workspace, async = false, extractOpts = {}, batchSize = 500 } = {}) {
  if (!daemonUrl) throw new Error('daemonUrl required');
  if (!workspace) throw new Error('workspace required');

  const extracted = async ? await extractRepoAsync(repo, extractOpts) : extractRepo(repo, extractOpts);
  const nodes = symbolsToCodeNodes(extracted.symbols);
  // Resolve the RAW extractor edges into deterministic code_node↔code_node edges (calls → defining
  // symbol(s); local imports → the imported file's exported symbols, else a file-level edge). This is
  // what previously got DROPPED here; now they ride the bulk POST so the daemon persists them into the
  // code_edges layer alongside the symbols (symbols + edges onboarded together).
  const { codeEdges, stats: edgeStats } = resolveCodeEdges({ symbols: extracted.symbols, edges: extracted.edges });
  const endpoint = `${String(daemonUrl).replace(/\/$/, '')}/overlay/code-nodes/bulk`;

  const responses = [];
  let created = 0;
  let edgesAdded = 0;
  let batches = 0;
  for (let off = 0; off < nodes.length; off += batchSize) {
    const slice = nodes.slice(off, off + batchSize);
    if (!slice.length) continue;
    // Send the whole resolved edge set ONCE, on the first node batch (edges reference symbols across
    // the entire repo, so they cannot be meaningfully sharded per node-batch — the daemon de-dups on
    // upsert anyway). Subsequent batches send nodes only.
    const payload = off === 0 ? { nodes: slice, edges: codeEdges, workspace } : { nodes: slice, workspace };
    const resp = await postJSON(endpoint, payload);
    responses.push(resp);
    if (resp && typeof resp.created === 'number') created += resp.created;
    if (resp && typeof resp.edges_added === 'number') edgesAdded += resp.edges_added;
    batches++;
  }
  // (No standalone edge-only POST: the bulk route requires a non-empty nodes[], and code edges always
  // reference symbols — an edge set with zero symbols cannot occur. Edges ride the first node batch.)

  return {
    repo: extracted.repo,
    workspace,
    symbols: nodes.length,
    created,
    edges: codeEdges.length,
    edges_added: edgesAdded,
    edge_stats: edgeStats,
    batches,
    stats: extracted.stats,
    responses,
  };
}

module.exports = { ingestRepo, symbolsToCodeNodes, symbolToCodeNode, postJSON, resolveCodeEdges };
