// Single source of truth for workspace <-> repo resolution.
//
// Workspace model (see note:note-mqj0wcabtxh): a workspace is a NAMED entity grouping many repos
// ({ name -> repos[] }); it holds NO graph of its own. Each repo keeps its own in-repo .graph (the
// repo stays the graph-bearing unit). The old single global pointer (~/.claude/orchestrator/workspace)
// and the process.cwd()-as-workspace fallback are gone; resolution walks cwd -> containing repo
// (nearest ancestor with .graph or .git) -> that repo's graph, plus a derived repo->workspace index.
//
// Pure-Node, dependency-free, require-able from daemon.js / hooks / CLI. Introduces NO behavior change
// on its own — it is the foundation later units import. Uses graph-store's atomic temp+rename write
// idiom (no new write primitive) and the overlay <name>-<hash> naming convention for collision-safe
// workspace keys during v1->v2 migration.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ── atomic write (graph-store idiom: temp file + rename, pid-tagged temp) ──────
function atomicWrite(dest, content) {
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, dest);
}

// Short content hash suffix for basename-collision disambiguation — mirrors the overlay
// <name>-<hash> convention (lib/overlay.js fileFor): sha1 of the source string, first 16 hex chars.
function shortHash(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 16);
}

// ── container-root guard ─────────────────────────────────────────────────────────
// A "container root" is a filesystem location that legitimately accumulates incidental `.graph`/`.git`
// markers belonging to UNRELATED projects — the system temp dir, the user's home dir, and the
// filesystem root itself. An incidental marker left in one of these must NEVER be adopted as a repo
// root: doing so would re-home a fresh top-level workspace dir (or a hooks/CLI cwd) onto a stray
// ancestor marker. This guard was originally a LOCAL guard in routes/meta.js (POST /workspace climb
// logic); it is hoisted here (note note-mqj20ekamwy) so EVERY repoRoot caller — daemon, hooks (U4),
// and CLI (U5) — benefits, not just the one HTTP route.
function normDir(s) { return path.resolve(s).replace(/[/\\]+$/, ''); }
function isContainerRoot(dir) {
  const d = normDir(dir);
  if (path.dirname(d) === d) return true;                  // filesystem root (e.g. C:\ or /)
  let tmp = null; let home = null;
  try { tmp = normDir(os.tmpdir()); } catch { /* */ }
  try { home = normDir(os.homedir()); } catch { /* */ }
  return d === tmp || d === home;
}

// ── repoRoot ───────────────────────────────────────────────────────────────────
// Walk UP from startDir to the nearest ancestor that is a repo. A repo is a dir containing `.graph`
// OR `.git` — `.graph` is preferred (checked first at each level). In a git worktree `.git` is a FILE
// (a gitdir pointer written by `git worktree add`), not a dir; that still marks a repo and we resolve
// to the dir holding it. EXCLUDE orchestrator attempt/feature worktrees exactly like routes/meta.js:
// a worktree's `.git` is a FILE and it has NO `.graph` of its own — so a dir whose only marker is a
// `.git` FILE (no `.graph`) is a worktree and must not register as a new workspace/repo. Also EXCLUDE
// "container roots" (system temp / home / fs root): an incidental marker there is never adopted (the
// hoisted guard, note note-mqj20ekamwy). Returns the repo dir (absolute) or null when no adoptable
// marker is found up to the filesystem root.
function repoRoot(startDir) {
  if (!startDir || typeof startDir !== 'string') return null;
  let dir;
  try { dir = path.resolve(startDir); } catch { return null; }

  while (true) {
    // Never adopt a marker that sits AT a container root (system temp / home / fs root) — an
    // incidental ancestor `.graph`/`.git` there must not re-home a fresh workspace dir. Skip the
    // marker check at this level and keep walking up (the fs-root case still terminates below).
    const atContainer = isContainerRoot(dir);

    if (!atContainer) {
      const graphPath = path.join(dir, '.graph');
      let hasGraph = false;
      try { hasGraph = fs.existsSync(graphPath); } catch { hasGraph = false; }
      if (hasGraph) return dir;            // .graph preferred — a true graph-bearing repo

      const gitPath = path.join(dir, '.git');
      let gitStat = null;
      try { gitStat = fs.statSync(gitPath); } catch { gitStat = null; }
      if (gitStat) {
        // `.git` is a DIRECTORY -> ordinary repo clone, accept.
        if (gitStat.isDirectory()) return dir;
        // `.git` is a FILE -> git worktree (gitdir pointer). With no `.graph` here (checked above) this
        // is an orchestrator attempt/feature worktree — exclude it (same rule as routes/meta.js), keep
        // walking up to the real graph-bearing repo it was forked from.
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) return null;     // reached filesystem root, no marker found
    dir = parent;
  }
}

// ── v2 schema helpers ───────────────────────────────────────────────────────────
function emptyRegistry() {
  return { version: 2, workspaces: {} };
}

// Coerce arbitrary parsed JSON into a well-formed v2 registry shape. Garbage/missing fields collapse
// to an empty registry rather than throwing — callers treat unreadable state as "no workspaces".
function coerceV2(parsed) {
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 2 || !parsed.workspaces
      || typeof parsed.workspaces !== 'object') {
    return emptyRegistry();
  }
  const out = { version: 2, workspaces: {} };
  for (const [name, ws] of Object.entries(parsed.workspaces)) {
    const repos = ws && Array.isArray(ws.repos) ? ws.repos.filter((r) => typeof r === 'string' && r) : [];
    // De-dupe member repos defensively (first-seen order preserved).
    out.workspaces[name] = { repos: [...new Set(repos)] };
  }
  return out;
}

// Migrate a v1 flat array of repo paths into v2 { version:2, workspaces:{ name:{ repos:[] } } }.
// Each path becomes its own single-repo workspace keyed by basename(path); basename collisions get a
// `-<shorthash>` suffix (overlay <name>-<hash> convention) so distinct paths never clobber one key.
function migrateV1(arr) {
  const reg = emptyRegistry();
  for (const raw of arr) {
    if (typeof raw !== 'string' || !raw) continue;
    const repo = raw;
    let name = path.basename(repo.replace(/[/\\]+$/, '')) || 'ws';
    if (reg.workspaces[name]) {
      // Same path already registered under this name -> idempotent skip.
      if (reg.workspaces[name].repos.includes(repo)) continue;
      // Different path, same basename -> disambiguate with a short hash of the path.
      name = `${name}-${shortHash(repo)}`;
    }
    if (!reg.workspaces[name]) reg.workspaces[name] = { repos: [] };
    if (!reg.workspaces[name].repos.includes(repo)) reg.workspaces[name].repos.push(repo);
  }
  return reg;
}

// ── loadRegistry ─────────────────────────────────────────────────────────────────
// Read + parse the WORKSPACES_FILE and return a v2 registry. Behavior:
//   - Missing/garbage/unparseable file -> { version:2, workspaces:{} }.
//   - v1 flat Array<string> -> lazily migrated to v2, written back ATOMICALLY, with a one-shot
//     `<file>.bak` of the original recorded BEFORE the first rewrite. Idempotent: a second load reads
//     the already-v2 file and rewrites nothing (no second .bak, no churn).
//   - Already-v2 -> coerced to a clean v2 shape and returned (no rewrite).
function loadRegistry(file) {
  if (!file || typeof file !== 'string') return emptyRegistry();

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return emptyRegistry(); }

  let parsed;
  try { parsed = JSON.parse(raw); } catch { return emptyRegistry(); }

  // v1 flat array -> migrate, back up the original once, persist v2 atomically.
  if (Array.isArray(parsed)) {
    const reg = migrateV1(parsed);
    const bak = `${file}.bak`;
    try { if (!fs.existsSync(bak)) fs.writeFileSync(bak, raw); } catch { /* best effort backup */ }
    try { atomicWrite(file, JSON.stringify(reg, null, 2)); } catch { /* in-memory result still valid */ }
    return reg;
  }

  // Already an object — coerce to a clean v2 shape (no rewrite; idempotent re-loads are no-ops).
  return coerceV2(parsed);
}

// ── allRepos ─────────────────────────────────────────────────────────────────────
// Flat, de-duped array of every member repo path across all workspaces. This is what
// registeredWorkspaces() consumes — it MUST stay a flat list of repo PATHS (≈10 sweep/claim callers
// depend on the flat Set<repoPath> shape).
function allRepos(reg) {
  const out = [];
  const seen = new Set();
  const workspaces = (reg && reg.workspaces) || {};
  for (const ws of Object.values(workspaces)) {
    const repos = (ws && Array.isArray(ws.repos)) ? ws.repos : [];
    for (const r of repos) {
      if (typeof r === 'string' && r && !seen.has(r)) { seen.add(r); out.push(r); }
    }
  }
  return out;
}

// ── repoToWorkspace ────────────────────────────────────────────────────────────────
// Derived reverse index Map<repoPath, workspaceName>. First-writer-wins on a repo that (anomalously)
// appears under more than one workspace — a stable, deterministic choice so resolution is repeatable.
function repoToWorkspace(reg) {
  const map = new Map();
  const workspaces = (reg && reg.workspaces) || {};
  for (const [name, ws] of Object.entries(workspaces)) {
    const repos = (ws && Array.isArray(ws.repos)) ? ws.repos : [];
    for (const r of repos) {
      if (typeof r === 'string' && r && !map.has(r)) map.set(r, name);
    }
  }
  return map;
}

// ── addRepo ──────────────────────────────────────────────────────────────────────
// Register `repo` under the named `workspace` (creating the workspace if new). Atomic write; idempotent
// (re-adding the same repo to the same workspace is a no-op, no duplicate). Loads the current registry
// (migrating v1 along the way via loadRegistry), mutates, persists, and returns the updated v2 registry.
function addRepo(file, { workspace, repo } = {}) {
  if (!file || typeof file !== 'string') throw new Error('addRepo: file is required');
  if (!workspace || typeof workspace !== 'string') throw new Error('addRepo: workspace is required');
  if (!repo || typeof repo !== 'string') throw new Error('addRepo: repo is required');

  const reg = loadRegistry(file);
  if (!reg.workspaces[workspace]) reg.workspaces[workspace] = { repos: [] };
  const repos = reg.workspaces[workspace].repos;
  if (!repos.includes(repo)) repos.push(repo);

  atomicWrite(file, JSON.stringify(reg, null, 2));
  return reg;
}

module.exports = {
  repoRoot,
  loadRegistry,
  allRepos,
  repoToWorkspace,
  addRepo,
};
