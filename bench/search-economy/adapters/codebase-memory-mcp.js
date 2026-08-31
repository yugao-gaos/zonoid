'use strict';

// Adapter for the `codebase-memory-mcp` binary (v0.8.x).
//
// codebase-memory-mcp indexes a repo into a CODE GRAPH (Function / Class / Variable /
// Route / File nodes + call/import/def edges) and exposes tools over it. Normally those
// tools are reached over stdio MCP, but the binary also ships a single-shot escape hatch:
//
//     codebase-memory-mcp cli <tool> '<json-args>'
//
// which runs one tool and prints the JSON result on STDOUT (its structured logs go to
// STDERR, so stdout is clean JSON). That is the seam this adapter uses — no MCP session,
// no handshake, no long-lived child process. Each call is one process.
//
// This module is deliberately free of any bench-specific logic: it knows how to find the
// binary, resolve a project, and call tools. Turning tool output into a context bundle is
// the arm's job (see ../retrieval/arms.js).
//
// Public API:
//   available()                        -> { ok, bin, version, error }
//   callTool(tool, args, opts?)        -> parsed JSON (throws on failure)
//   listProjects()                     -> [{ name, root_path, nodes, edges, size_bytes }]
//   resolveProject(rootPath)           -> { name, root_path, ... } | null
//   searchGraph(project, query, opts?) -> { total, search_mode, results[], has_more }
//   getCodeSnippet(project, qname)     -> { name, qualified_name, file_path, source, ... }
//   indexStatus(project)               -> raw index_status payload
//   detectChanges(project)             -> raw detect_changes payload

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_BUFFER = 32 * 1024 * 1024; // graph payloads can be large

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

// Where the installer puts it on Windows; overridable for other hosts / CI.
function defaultBinPath() {
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const p = path.join(local, 'codebase-memory-mcp', 'codebase-memory-mcp.exe');
    if (fs.existsSync(p)) return p;
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    for (const rel of [
      ['.local', 'bin', 'codebase-memory-mcp'],
      ['.codebase-memory-mcp', 'codebase-memory-mcp'],
    ]) {
      const p = path.join(home, ...rel);
      if (fs.existsSync(p)) return p;
    }
  }
  // Last resort: let the OS resolve it on PATH.
  return process.platform === 'win32' ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp';
}

function binPath() {
  return process.env.ORCH_CMM_BIN || defaultBinPath();
}

let _available = null;

// Cheap capability probe (cached per process): does the binary exist and answer --version?
function available() {
  if (_available) return _available;
  const bin = binPath();
  try {
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    _available = { ok: true, bin, version: String(out).trim(), error: null };
  } catch (e) {
    _available = { ok: false, bin, version: null, error: String((e && e.message) || e) };
  }
  return _available;
}

// ---------------------------------------------------------------------------
// Tool invocation
// ---------------------------------------------------------------------------

// The binary logs to stderr and prints the tool result to stdout, but be defensive:
// take the LAST line of stdout that parses as JSON. A tool that fails argument
// validation prints a bare message ("pattern is required") rather than JSON — that
// surfaces here as a thrown error, not a silent empty result.
function parseToolOutput(stdout, tool) {
  const lines = String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line[0] !== '{' && line[0] !== '[') continue;
    try {
      return JSON.parse(line);
    } catch {
      // keep scanning upward
    }
  }
  const tail = lines.length ? lines[lines.length - 1] : '(empty)';
  throw new Error(`codebase-memory-mcp ${tool}: no JSON on stdout (last line: ${tail})`);
}

function callTool(tool, args = {}, opts = {}) {
  const probe = available();
  if (!probe.ok) throw new Error(`codebase-memory-mcp unavailable: ${probe.error}`);
  let stdout;
  try {
    stdout = execFileSync(probe.bin, ['cli', tool, JSON.stringify(args)], {
      encoding: 'utf8',
      timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'], // drop the stderr log stream
    });
  } catch (e) {
    // Non-zero exit still often carries a usable JSON error body on stdout.
    if (e && e.stdout) {
      try {
        return parseToolOutput(e.stdout, tool);
      } catch {
        // fall through to rethrow below
      }
    }
    throw new Error(`codebase-memory-mcp ${tool} failed: ${String((e && e.message) || e)}`);
  }
  return parseToolOutput(stdout, tool);
}

// ---------------------------------------------------------------------------
// Project resolution
// ---------------------------------------------------------------------------

function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function listProjects() {
  const out = callTool('list_projects', {});
  return Array.isArray(out && out.projects) ? out.projects : [];
}

// Find the indexed project that covers `rootPath`. Exact root match wins; otherwise the
// DEEPEST indexed ancestor (a project rooted at repo/lib still answers for repo/lib/x.js,
// but a project rooted at the repo answers for more of it — prefer the tighter match only
// when it actually contains the path). Returns null when nothing covers it.
function resolveProject(rootPath, projects) {
  const want = normPath(rootPath);
  if (!want) return null;
  const all = Array.isArray(projects) ? projects : listProjects();

  const exact = all.find((p) => normPath(p.root_path) === want);
  if (exact) return exact;

  let best = null;
  for (const p of all) {
    const root = normPath(p.root_path);
    if (!root) continue;
    if (want === root || want.startsWith(root + '/')) {
      if (!best || root.length > normPath(best.root_path).length) best = p;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Tool wrappers
// ---------------------------------------------------------------------------

// BM25 over graph node names/qualified names. NOTE: `search_mode` is accepted but ignored
// by v0.8.1 — it always reports (and runs) bm25. Callers that want term-level control must
// preprocess the query themselves.
function searchGraph(project, query, opts = {}) {
  const args = { project, query: String(query || ''), limit: opts.limit || 10 };
  if (opts.label) args.label = opts.label;
  return callTool('search_graph', args, opts);
}

// Full source text for one graph node, addressed by qualified_name.
function getCodeSnippet(project, qualifiedName, opts = {}) {
  return callTool('get_code_snippet', { project, qualified_name: qualifiedName }, opts);
}

function indexStatus(project, opts = {}) {
  return callTool('index_status', { project }, opts);
}

function detectChanges(project, opts = {}) {
  return callTool('detect_changes', { project }, opts);
}

// Cypher-dialect query over the code graph, e.g.
//   MATCH (n:Function) WHERE n.name = 'createWorktree' RETURN n LIMIT 2
// Not used by the retrieval arm (which is search+snippet); exposed because it is the
// seam a future graph-expansion arm would build on.
function queryGraph(project, cypher, opts = {}) {
  return callTool('query_graph', { project, query: String(cypher || '') }, opts);
}

module.exports = {
  available,
  binPath,
  callTool,
  listProjects,
  resolveProject,
  searchGraph,
  getCodeSnippet,
  indexStatus,
  detectChanges,
  queryGraph,
  normPath,
};
