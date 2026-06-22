'use strict';

// Search-economy retrieval arms.
//
// An "arm" is a context-assembly mechanism. Given a code-navigation query it returns
//   { bundleText, tokens, hitSymbols }
// where bundleText is the context an agent would be handed, tokens is its token cost,
// and hitSymbols is the set of identifier-like tokens that actually appear in the bundle
// (used by run.js to score recall/precision against the corpus ground-truth symbols).
//
// Phase 1 implements TWO arms that run NOW in pure Node:
//   - naive:        grep the repo for the query's key terms, read the top candidate files
//                   (char-capped), concatenate. The "just assemble raw code" baseline.
//   - subconscious: query the running daemon's agentic/RAG search bundle (GET /search).
//                   Measures the token economy of the subconscious memory substrate.
//
// graphify (AST subgraph) and terminal-bench (e2e) arms are DEFERRED (need Python, not
// installed). They are registered as stubs so they slot in WITHOUT refactoring run.js:
// add a real implementation to the registry and it is picked up automatically.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const { makeCounter } = require('./tokens');

// Repo root = three levels up from this file (bench/search-economy/retrieval/ -> repo).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Daemon + workspace defaults (overridable via env so the harness is portable).
const DAEMON_URL = process.env.ORCH_DAEMON_URL || 'http://localhost:8787';
const SEARCH_WORKSPACE = process.env.ORCH_SEARCH_WORKSPACE || 'D:\\zonoid';

const NAIVE_CHAR_CAP = 12000; // total chars of file content the naive arm may concatenate
const NAIVE_MAX_FILES = 6;    // cap candidate files read
const NAIVE_PER_FILE_CAP = 4000;
const NAIVE_WINDOW = 900;     // chars of context to read AROUND each term match in a file

// Generated/state/vendored paths the naive arm must not waste its char budget on.
// (.graph + data hold huge daemon state JSON; node_modules/.git are vendored/VCS.)
const NAIVE_EXCLUDE_RE = /(^|[\\/])(node_modules|\.git|\.graph|data|public|patches|packages[\\/].*[\\/]node_modules)([\\/]|$)/i;

// ---------------------------------------------------------------------------
// Symbol extraction: identifier-like tokens (function/const names, snake_case,
// camelCase, UPPER_CONST). This is what we intersect with corpus relevant_symbols.
// ---------------------------------------------------------------------------
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;

function extractSymbols(text) {
  const out = new Set();
  if (!text) return out;
  const m = String(text).match(IDENT_RE);
  if (!m) return out;
  for (const tok of m) out.add(tok);
  return out;
}

// Pull the meaningful search terms out of a natural-language query.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'does', 'how', 'what', 'which',
  'where', 'when', 'why', 'who', 'whom', 'are', 'was', 'were', 'has', 'have', 'had', 'its', 'it',
  'a', 'an', 'of', 'to', 'in', 'on', 'is', 'be', 'or', 'at', 'by', 'as', 'do', 'use', 'used',
  'follow', 'trace', 'find', 'show', 'tell', 'me', 'instead', 'versus', 'vs', 'plus',
]);

function queryTerms(query) {
  const raw = String(query || '').toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
  const seen = new Set();
  const terms = [];
  for (const t of raw) {
    if (STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    terms.push(t);
  }
  return terms;
}

// ---------------------------------------------------------------------------
// NAIVE arm: ripgrep (fallback: git grep) the repo for query terms, rank files
// by hit count, read the top files (capped), concatenate.
// ---------------------------------------------------------------------------
function rgAvailable() {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function grepHits(term) {
  // Returns a list of ABSOLUTE file paths that contain `term`, with generated/state
  // dirs filtered out. Prefer ripgrep; fall back to `git grep` (always in a checkout).
  let files = [];
  const args = ['--files-with-matches', '--no-messages', '-i',
    '--glob', '!node_modules', '--glob', '!.git', '--glob', '!.graph', '--glob', '!data',
    '--glob', '!bench/**', '--glob', '*.{js,json,md}', term, REPO_ROOT];
  try {
    if (grepHits._rg == null) grepHits._rg = rgAvailable();
    if (grepHits._rg) {
      const out = execFileSync('rg', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      files = out.split('\n').map((s) => s.trim()).filter(Boolean)
        .map((f) => (path.isAbsolute(f) ? f : path.resolve(REPO_ROOT, f)));
    }
  } catch (e) {
    // rg exits 1 when no matches — that's not an error, just empty.
    if (!(e && e.status === 1)) files = [];
  }
  if (!grepHits._rg) {
    // git grep fallback
    try {
      const out = execFileSync('git', ['-C', REPO_ROOT, 'grep', '-l', '-i', '-e', term, '--',
        '*.js', '*.json', '*.md', ':!node_modules', ':!bench', ':!.graph', ':!data'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      files = out.split('\n').map((s) => s.trim()).filter(Boolean)
        .map((rel) => path.resolve(REPO_ROOT, rel));
    } catch (e) {
      if (!(e && e.status === 1)) files = [];
    }
  }
  return files.filter((f) => !NAIVE_EXCLUDE_RE.test(path.relative(REPO_ROOT, f)));
}

// Read up to `cap` chars of `content`, centered on windows around each query-term match,
// so symbols defined mid-file are surfaced (not just the file head). Falls back to the
// head when no term matches inside the file.
function windowedExtract(content, terms, cap) {
  const lower = content.toLowerCase();
  const centers = [];
  for (const term of terms) {
    let idx = lower.indexOf(term);
    let guard = 0;
    while (idx !== -1 && guard < 50) {
      centers.push(idx);
      idx = lower.indexOf(term, idx + term.length);
      guard += 1;
    }
  }
  if (!centers.length) return content.slice(0, cap);
  centers.sort((a, b) => a - b);

  // Merge overlapping [center-W, center+W] windows.
  const half = Math.floor(NAIVE_WINDOW / 2);
  const ranges = [];
  for (const c of centers) {
    const start = Math.max(0, c - half);
    const end = Math.min(content.length, c + half);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  let out = '';
  for (const r of ranges) {
    if (out.length >= cap) break;
    const piece = content.slice(r.start, r.end);
    out += (out ? '\n…\n' : '') + piece;
  }
  return out.slice(0, cap);
}

function naiveAssemble(query, counter) {
  const terms = queryTerms(query);
  // Rank candidate files by how many distinct query terms hit them.
  const score = new Map();
  for (const term of terms) {
    for (const file of grepHits(term)) {
      const abs = path.isAbsolute(file) ? file : path.resolve(REPO_ROOT, file);
      score.set(abs, (score.get(abs) || 0) + 1);
    }
  }
  const ranked = [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([file]) => file)
    .slice(0, NAIVE_MAX_FILES);

  const parts = [];
  let total = 0;
  const filesRead = [];
  for (const file of ranked) {
    if (total >= NAIVE_CHAR_CAP) break;
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const room = Math.min(NAIVE_PER_FILE_CAP, NAIVE_CHAR_CAP - total);
    const slice = windowedExtract(content, terms, room);
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    parts.push(`// ===== ${rel} =====\n${slice}`);
    total += slice.length;
    filesRead.push(rel);
  }

  const bundleText = parts.join('\n\n');
  return {
    bundleText,
    tokens: counter(bundleText),
    hitSymbols: [...extractSymbols(bundleText)],
    meta: { filesRead, terms, grep: grepHits._rg ? 'ripgrep' : 'git-grep' },
  };
}

// ---------------------------------------------------------------------------
// SUBCONSCIOUS arm: query the running daemon's /search (the agentic/RAG bundle).
// Falls back gracefully to an empty bundle if the daemon is unreachable.
// ---------------------------------------------------------------------------
function httpGetJson(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: JSON.parse(body) });
        } catch (e) {
          resolve({ ok: false, status: res.statusCode, error: 'parse: ' + e.message, raw: body });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

async function subconsciousAssemble(query, counter, opts = {}) {
  const workspace = opts.workspace || SEARCH_WORKSPACE;
  const k = opts.k || 8;
  const url = `${DAEMON_URL}/search?workspace=${encodeURIComponent(workspace)}&q=${encodeURIComponent(query)}&k=${k}`;
  const resp = await httpGetJson(url);

  const results = (resp && resp.json && Array.isArray(resp.json.results)) ? resp.json.results : [];
  // The bundle an agent would actually receive: the title+summary of each recalled note,
  // in rank order. This is the subconscious memory context — NOT raw source files.
  const parts = [];
  for (const r of results) {
    const title = r.title || r.label || r.key || '';
    const summary = r.summary || '';
    const tier = r.tier || '';
    const score = (typeof r.score === 'number') ? r.score.toFixed(3) : '';
    parts.push(`[${tier} ${score}] ${title}\n${summary}`);
  }
  const bundleText = parts.join('\n\n');

  return {
    bundleText,
    tokens: counter(bundleText),
    hitSymbols: [...extractSymbols(bundleText)],
    meta: {
      daemon: DAEMON_URL,
      workspace,
      reachable: !!(resp && resp.ok),
      error: resp && resp.error ? resp.error : null,
      nResults: results.length,
      k,
    },
  };
}

// ---------------------------------------------------------------------------
// DEFERRED arms (need Python — not installed). Registered as stubs so they slot
// into run.js without refactor. run.js skips arms whose `implemented` is false.
// ---------------------------------------------------------------------------
function deferredStub(name, reason) {
  return async function stub(/* query, counter, opts */) {
    return {
      bundleText: '',
      tokens: 0,
      hitSymbols: [],
      meta: { deferred: true, reason },
    };
  };
}

// ---------------------------------------------------------------------------
// Arm registry — the single extension point. Add a new arm here.
// ---------------------------------------------------------------------------
const ARMS = {
  naive: {
    implemented: true,
    describe: 'grep query terms across the repo, read top candidate files (~12k char cap), concatenate raw source',
    run: (query, counter, opts) => naiveAssemble(query, counter, opts),
  },
  subconscious: {
    implemented: true,
    describe: 'query the running daemon /search for the agentic/RAG memory bundle (title+summary of recalled notes)',
    run: (query, counter, opts) => subconsciousAssemble(query, counter, opts),
  },
  graphify: {
    implemented: false,
    describe: 'AST subgraph assembly (graphify) — DEFERRED, needs Python',
    run: deferredStub('graphify', 'graphify AST arm needs Python (not installed); scaffolded, run deferred'),
  },
  'terminal-bench': {
    implemented: false,
    describe: 'Terminal-Bench end-to-end task arm — DEFERRED, needs Python',
    run: deferredStub('terminal-bench', 'terminal-bench e2e arm needs Python (not installed); scaffolded, run deferred'),
  },
};

function listArms() {
  return Object.keys(ARMS);
}

function implementedArms() {
  return Object.keys(ARMS).filter((name) => ARMS[name].implemented);
}

function armInfo(armName) {
  return ARMS[armName] || null;
}

// Primary entry point used by run.js.
// Returns { bundleText, tokens, hitSymbols, meta }.
async function assembleContext(query, armName, opts = {}) {
  const arm = ARMS[armName];
  if (!arm) throw new Error(`unknown arm: ${armName} (known: ${listArms().join(', ')})`);
  const counter = opts.counter || makeCounter(opts.tokenizer ? { tokenizer: opts.tokenizer } : {});
  const result = await arm.run(query, counter, opts);
  // Normalize shape defensively.
  return {
    bundleText: result.bundleText || '',
    tokens: typeof result.tokens === 'number' ? result.tokens : counter(result.bundleText || ''),
    hitSymbols: Array.isArray(result.hitSymbols) ? result.hitSymbols : [],
    meta: result.meta || {},
  };
}

module.exports = {
  assembleContext,
  listArms,
  implementedArms,
  armInfo,
  extractSymbols,
  queryTerms,
  REPO_ROOT,
  DAEMON_URL,
  SEARCH_WORKSPACE,
  ARMS,
};
