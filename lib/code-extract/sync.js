'use strict';
// code-extract/sync.js — incremental git-diff sync for the code-index layer (Phase 3 of the native
// onboarder). The FULL onboard (extract whole repo -> /overlay/code-nodes/bulk) is a one-time cost; on
// every subsequent code change this keeps the code_nodes in step with HEAD by re-onboarding ONLY the
// files git says changed, instead of re-walking the repo.
//
// DESIGN (note-mqpzfgjlux8, "graph maintenance on code change"): track lastIndexedCommit per repo; on
// sync run `git diff <lastIndexedCommit>..HEAD --name-status`:
//   ADDED / MODIFIED code file -> re-extract its symbols (AST) and REPLACE its code_nodes
//                                 (delete-by-file + bulk-upsert, via POST /overlay/code-nodes/replace)
//   DELETED code file          -> remove its code_nodes (DELETE /overlay/code-nodes)
//   RENAMED (Rxxx)             -> delete the OLD path's code_nodes + replace at the NEW path
// then advance lastIndexedCommit -> HEAD. No lastIndexedCommit recorded yet ⇒ there is nothing to diff
// against, so the caller must do a FULL onboard (syncRepo signals this rather than silently doing
// nothing). Per-file invalidation is cheap because code_nodes are keyed by file (code:<file>#<name>).
//
// SEAMS (for testing without a live daemon / real git): `opts.git` overrides the git runner
// (default: spawn `git -C <repo> ...`), and `opts.daemon` is an object with { replaceFile, deleteFile,
// setLastIndexedCommit } the sync calls instead of HTTP — the default daemon client (httpDaemonClient)
// talks to a running daemon over HTTP. The stubbed unit test injects both; the e2e test uses neither
// (real git + real isolated daemon over HTTP).

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { extractFile, extractRepo, extractRepoAsync, initTreeSitter } = require('./index');
const { symbolsToCodeNodes } = require('./ingest');
const { resolveCodeEdges } = require('./resolve-edges');
const registry = require('./backends/registry');

// Extensions the extractor can parse — only these files are synced (a changed README or .json is not a
// code symbol source). Union of every backend's extensions, same set extractRepo walks.
const CODE_EXTS = new Set(registry.allExtensions());
function isCodeFile(rel) {
  return CODE_EXTS.has(path.extname(String(rel || '')).toLowerCase());
}

// ── git ────────────────────────────────────────────────────────────────────────────────────────
// Default git runner: `git -C <repo> <args...>`, resolving stdout (trimmed). Rejects on non-zero exit.
function runGit(repo, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); return; }
      resolve(String(stdout || '').replace(/\s+$/, ''));
    });
  });
}

// Parse `git diff --name-status` output into typed change records. Lines look like:
//   M\tlib/foo.js
//   A\tlib/bar.js
//   D\tlib/gone.js
//   R096\tlib/old.js\tlib/new.js    (rename, with similarity score)
//   C075\tlib/src.js\tlib/copy.js   (copy)
// Returns [{ status:'A'|'M'|'D'|'R'|'C'|..., file, oldFile? }]. Tab-separated; the status letter is the
// first char (the trailing digits on R/C are a similarity %, not part of the status).
function parseNameStatus(out) {
  const changes = [];
  for (const line of String(out || '').split('\n')) {
    const t = line.replace(/\s+$/, '');
    if (!t) continue;
    const parts = t.split('\t');
    if (parts.length < 2) continue;
    const code = parts[0].trim();
    const status = code[0].toUpperCase();
    if (status === 'R' || status === 'C') {
      // parts: [code, oldPath, newPath]
      changes.push({ status, oldFile: parts[1], file: parts[2] || parts[1] });
    } else {
      changes.push({ status, file: parts[1] });
    }
  }
  return changes;
}

// ── default HTTP daemon client ───────────────────────────────────────────────────────────────────
// Minimal request helper: send `body` (or null) to <daemonUrl><pathAndQuery> with `method`, resolve the
// parsed JSON (reject on non-2xx / bad JSON). DELETE carries a JSON body, which Node's http supports.
function requestJSON(daemonUrl, method, pathAndQuery, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(`${String(daemonUrl).replace(/\/$/, '')}${pathAndQuery}`); } catch (e) { reject(e); return; }
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = data.length;
    const req = mod.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers,
    }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = s ? JSON.parse(s) : null; } catch { /* leave null */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(new Error(`${method} ${pathAndQuery} HTTP ${res.statusCode}: ${parsed ? JSON.stringify(parsed) : s}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${pathAndQuery} timeout`)));
    if (data) req.write(data);
    req.end();
  });
}

// The default daemon client used by syncRepo when no `opts.daemon` is injected — three calls the sync
// needs, each hitting the additive code-index routes. workspace rides the body (the routes resolve the
// overlay from it).
function httpDaemonClient(daemonUrl) {
  return {
    // Replace one file's code_nodes wholesale: delete-by-file + bulk-upsert the supplied nodes.
    replaceFile: ({ file, nodes, workspace }) =>
      requestJSON(daemonUrl, 'POST', '/overlay/code-nodes/replace', { file, nodes, workspace }),
    // Remove one file's code_nodes (deleted source file).
    deleteFile: ({ file, workspace }) =>
      requestJSON(daemonUrl, 'DELETE', '/overlay/code-nodes', { file, workspace }),
    // Replace one file's code EDGES wholesale (the changed file's recomputed AST edges).
    replaceEdges: ({ file, edges, workspace }) =>
      requestJSON(daemonUrl, 'POST', '/overlay/code-edges/replace', { file, edges, workspace }),
    // Remove one file's code EDGES (deleted source file).
    deleteEdges: ({ file, workspace }) =>
      requestJSON(daemonUrl, 'DELETE', '/overlay/code-edges', { file, workspace }),
    // Advance the persisted lastIndexedCommit watermark for this workspace/repo.
    setLastIndexedCommit: ({ key, commit, workspace }) =>
      requestJSON(daemonUrl, 'POST', '/config', { last_indexed_commit: { key, commit }, workspace }),
    // Read the persisted lastIndexedCommit for a key (null when unset). GET /config returns the whole
    // overlay.config map; the watermark lives under config.lastIndexedCommit[key].
    getLastIndexedCommit: async ({ key, workspace }) => {
      const resp = await requestJSON(daemonUrl, 'GET', `/config?workspace=${encodeURIComponent(workspace)}`, null);
      const m = resp && resp.config && resp.config.lastIndexedCommit;
      return (m && m[key]) || null;
    },
  };
}

// ── syncRepo ───────────────────────────────────────────────────────────────────────────────────
// Incrementally bring `workspace`'s code-index in step with `repo`'s HEAD.
//   repo       — abs path of the git repo whose code is indexed. Required.
//   workspace  — the workspace the code_nodes belong to. Required.
//   daemon     — base URL of a running daemon (e.g. http://localhost:8799). Required UNLESS opts.daemon
//                (an injected client) is supplied.
//   lastCommit — explicit prior watermark (overrides opts.getLastIndexedCommit). Absent ⇒ resolved via
//                opts.getLastIndexedCommit, else treated as "no prior index" -> full_onboard_needed.
// Options (seams): opts.git(repo,args)->Promise<stdout>, opts.daemon (client), opts.getLastIndexedCommit
//   (key)->commit|null, opts.async (boot tree-sitter before extracting), opts.commitKey (the key the
//   watermark is stored under; defaults to the repo abs path), opts.readFile(absPath)->string.
// Returns:
//   { full_onboard_needed:true, reason }                              when there is no prior watermark
//   { changed_files:[...], upserted, deleted, files_replaced, files_deleted, from, head, skipped:[...] }
async function syncRepo({ repo, workspace, daemon, lastCommit } = {}, opts = {}) {
  if (!repo) throw new Error('repo required');
  if (!workspace) throw new Error('workspace required');

  const repoAbs = path.resolve(repo);
  const git = (typeof opts.git === 'function') ? (args) => opts.git(repoAbs, args) : (args) => runGit(repoAbs, args);
  const client = opts.daemon || (daemon ? httpDaemonClient(daemon) : null);
  if (!client) throw new Error('daemon URL or injected opts.daemon client required');
  const commitKey = opts.commitKey || repoAbs;
  const readFile = (typeof opts.readFile === 'function')
    ? opts.readFile
    : (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } };

  // Resolve the prior watermark: explicit lastCommit > injected opts reader > the daemon client's
  // persisted read (GET /config). The CLI relies on the last path — the watermark was persisted by a
  // prior full onboard via POST /config, so syncRepo must read it back from the daemon, not assume none.
  let from = lastCommit != null ? lastCommit : null;
  if (from == null && typeof opts.getLastIndexedCommit === 'function') {
    from = await opts.getLastIndexedCommit(commitKey);
  }
  if (from == null && typeof client.getLastIndexedCommit === 'function') {
    try { from = await client.getLastIndexedCommit({ key: commitKey, workspace }); } catch { from = null; }
  }
  if (!from) {
    return { full_onboard_needed: true, reason: 'no lastIndexedCommit recorded for this repo — run a full onboard first' };
  }

  // Current HEAD.
  const head = await git(['rev-parse', 'HEAD']);
  if (head === from) {
    return { changed_files: [], upserted: 0, deleted: 0, files_replaced: 0, files_deleted: 0, from, head, skipped: [], up_to_date: true };
  }

  // Diff the two commits by name+status.
  const diffOut = await git(['diff', `${from}..${head}`, '--name-status']);
  const changes = parseNameStatus(diffOut);

  if (opts.async) { try { await initTreeSitter(); } catch { /* extractFile will count unparsable files */ } }

  const changed_files = [];
  const skipped = [];
  let upserted = 0;
  let deleted = 0;
  let filesReplaced = 0;
  let filesDeleted = 0;
  // Files whose code EDGES must be recomputed (added/modified/renamed-new) vs removed (deleted/
  // renamed-old). Edges are resolved repo-wide AFTER the per-file node changes (see below), because a
  // changed file's call edges resolve to definitions in OTHER (possibly unchanged) files and its import
  // edges resolve to other files' exported symbols — so a single-file view cannot resolve them.
  const edgeReplaceFiles = new Set();
  const edgeDeleteFiles = new Set();

  // Re-extract one repo-relative file at HEAD (the working tree already holds HEAD on a normal sync)
  // and REPLACE its code_nodes. Returns the upserted count.
  async function replacePath(rel) {
    const abs = path.join(repoAbs, rel);
    const src = readFile(abs);
    const extracted = extractFile(rel, src);
    const nodes = symbolsToCodeNodes(extracted.symbols);
    const resp = await client.replaceFile({ file: rel, nodes, workspace });
    const created = resp && typeof resp.created === 'number' ? resp.created : nodes.length;
    upserted += created;
    filesReplaced++;
    return created;
  }
  async function deletePath(rel) {
    const resp = await client.deleteFile({ file: rel, workspace });
    const gone = resp && typeof resp.deleted === 'number' ? resp.deleted : 0;
    deleted += gone;
    filesDeleted++;
    return gone;
  }

  for (const ch of changes) {
    if (ch.status === 'D') {
      if (!isCodeFile(ch.file)) { skipped.push(ch.file); continue; }
      await deletePath(ch.file);
      edgeDeleteFiles.add(ch.file);
      changed_files.push(ch.file);
    } else if (ch.status === 'R' || ch.status === 'C') {
      // Rename/copy: drop the old path's nodes (rename only — a copy leaves the source in place, but
      // git already emits a separate change for the source if it was modified; deleting the old path on
      // a pure copy would be wrong, so only do it for renames) and re-onboard the new path.
      if (ch.status === 'R' && ch.oldFile && isCodeFile(ch.oldFile)) {
        await deletePath(ch.oldFile);
        edgeDeleteFiles.add(ch.oldFile);
        changed_files.push(ch.oldFile);
      }
      if (isCodeFile(ch.file)) { await replacePath(ch.file); edgeReplaceFiles.add(ch.file); changed_files.push(ch.file); }
      else skipped.push(ch.file);
    } else {
      // A (added) or M (modified) — and any other in-place status (T type-change) is safe to re-onboard.
      if (!isCodeFile(ch.file)) { skipped.push(ch.file); continue; }
      await replacePath(ch.file);
      edgeReplaceFiles.add(ch.file);
      changed_files.push(ch.file);
    }
  }

  // ── CODE-EDGE recompute ───────────────────────────────────────────────────────────────────────
  // A changed file's resolved code edges (calls → defining symbols anywhere in the repo; local imports
  // → the imported file's exported symbols) depend on the WHOLE repo's symbol set, not just the changed
  // file. So once node changes are applied, re-resolve edges repo-wide and push ONLY the changed files'
  // edges (per-file replace) — deterministic and consistent with what a full onboard would produce.
  // The repo-wide resolve is a symbols+edges AST walk (no embeds, no HTTP); embeddings — the expensive
  // part of onboard — are NOT redone here. Seam: opts.resolveAll() overrides the walk for stubbed tests.
  let edgesReplaced = 0;
  let edgesDeleted = 0;
  // BACK-COMPAT: only recompute edges when the daemon client actually supports the edge ops. An older
  // injected client (or a daemon predating the code_edges routes) lacks replaceEdges/deleteEdges — in
  // that case skip edge recompute entirely (node sync still works exactly as before). Each call is also
  // individually guarded so a client supporting only one op degrades gracefully.
  const canReplaceEdges = typeof client.replaceEdges === 'function';
  const canDeleteEdges = typeof client.deleteEdges === 'function';
  if ((canReplaceEdges || canDeleteEdges) && (edgeReplaceFiles.size || edgeDeleteFiles.size)) {
    // Deleted (and renamed-old) files: drop their edges. Do this first so a path that is both deleted
    // and re-added (shouldn't happen in one diff, but be safe) ends up with the replace winning.
    if (canDeleteEdges) {
      for (const rel of edgeDeleteFiles) {
        if (edgeReplaceFiles.has(rel)) continue; // replace below will overwrite; skip the delete
        const resp = await client.deleteEdges({ file: rel, workspace });
        if (resp && typeof resp.deleted === 'number') edgesDeleted += resp.deleted;
      }
    }

    if (canReplaceEdges && edgeReplaceFiles.size) {
      // Resolve repo-wide. opts.resolveAll lets a test inject the resolved edge list without a real walk.
      let resolved;
      if (typeof opts.resolveAll === 'function') {
        resolved = await opts.resolveAll();
      } else {
        const extracted = opts.async ? await extractRepoAsync(repoAbs, opts.extractOpts || {}) : extractRepo(repoAbs, opts.extractOpts || {});
        resolved = resolveCodeEdges({ symbols: extracted.symbols, edges: extracted.edges }).codeEdges;
      }
      // Bucket resolved edges by from_file so each changed file gets exactly its outgoing edges.
      const byFile = new Map();
      for (const e of (Array.isArray(resolved) ? resolved : [])) {
        const f = String(e.from_file || '').trim();
        if (!f) continue;
        if (!byFile.has(f)) byFile.set(f, []);
        byFile.get(f).push(e);
      }
      for (const rel of edgeReplaceFiles) {
        const edges = byFile.get(rel) || []; // empty ⇒ the file now has no outgoing edges (cleared)
        const resp = await client.replaceEdges({ file: rel, edges, workspace });
        if (resp && typeof resp.created === 'number') edgesReplaced += resp.created;
      }
    }
  }

  // Advance the watermark to HEAD so the next sync diffs from here.
  await client.setLastIndexedCommit({ key: commitKey, commit: head, workspace });

  return { changed_files, upserted, deleted, files_replaced: filesReplaced, files_deleted: filesDeleted, edges_replaced: edgesReplaced, edges_deleted: edgesDeleted, from, head, skipped };
}

module.exports = { syncRepo, parseNameStatus, isCodeFile, runGit, requestJSON, httpDaemonClient, CODE_EXTS };
