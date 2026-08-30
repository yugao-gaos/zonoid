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
const { withFileLock } = require('./onboard-state');

const REGISTRY_LOCK_WAIT_MS = 10000;
const REGISTRY_LOCK_STALE_MS = 30000;

// ── atomic write (graph-store idiom: temp file + rename, pid-tagged temp) ──────
function atomicWrite(dest, content) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, dest);
}

function cleanupAtomicTemps(dest) {
  let names;
  try { names = fs.readdirSync(path.dirname(dest)); } catch { return; }
  const base = path.basename(dest).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${base}\\.\\d+(?:\\.[a-f0-9]+)?\\.tmp$`);
  for (const name of names) {
    if (!pattern.test(name)) continue;
    try { fs.unlinkSync(path.join(path.dirname(dest), name)); } catch { /* another cleanup won */ }
  }
}

// Serialize the registry's read-modify-write with the same unique-owner directory lease used by
// onboarding queues. Release/recovery can remove only the caller's owner record, never a successor.
function withRegistryLock(file, fn, opts = {}) {
  if (!file || typeof file !== 'string') throw new Error('registry lock: file is required');
  return withFileLock(file, () => {
    // All registry writers use this lock, so any atomic temp visible after acquisition belongs to a
    // writer that exited before rename. It is never a live transaction and is safe to reap.
    cleanupAtomicTemps(file);
    return fn();
  }, {
    fsImpl: fs,
    waitMs: opts.waitMs == null ? REGISTRY_LOCK_WAIT_MS : opts.waitMs,
    staleMs: opts.staleMs == null ? REGISTRY_LOCK_STALE_MS : opts.staleMs,
  });
}

// Registry history intentionally retains relocated/unmounted repositories. Only paths that are
// directories right now may enter daemon boot/maintenance/open/port enumeration; stat follows a
// directory symlink, while broken links and regular files stay inactive until a valid remount.
function isActiveRepoPath(repo) {
  if (!repo || typeof repo !== 'string') return false;
  try { return fs.statSync(repo).isDirectory(); } catch { return false; }
}

function activeRepoRoot(repo, opts) {
  if (!isActiveRepoPath(repo)) return null;
  const resolved = repoRoot(repo, opts);
  return resolved && isActiveRepoPath(resolved) ? resolved : path.resolve(repo);
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
function normDir(s) {
  const resolved = path.resolve(s).replace(/[/\\]+$/, '');
  try { return fs.realpathSync(resolved).replace(/[/\\]+$/, ''); }
  catch { return resolved; }
}
function isContainerRoot(dir) {
  const d = normDir(dir);
  if (path.dirname(d) === d) return true;                  // filesystem root (e.g. C:\ or /)
  let tmp = null; let home = null;
  try { tmp = normDir(os.tmpdir()); } catch { /* */ }
  try { home = normDir(os.homedir()); } catch { /* */ }
  return d === tmp || d === home;
}

function gitLayout(repoDir) {
  const gitPath = path.join(repoDir, '.git');
  let gitStat;
  try { gitStat = fs.statSync(gitPath); } catch { return null; }
  if (gitStat.isDirectory()) {
    const gitDir = normDir(gitPath);
    return { gitDir, commonDir: gitDir, gitType: 'dir', linkedWorktree: false };
  }
  if (!gitStat.isFile()) return { gitType: 'invalid', linkedWorktree: false };

  let raw;
  try { raw = fs.readFileSync(gitPath, 'utf8'); } catch {
    return { gitType: 'invalid', linkedWorktree: false };
  }
  const match = raw.match(/^gitdir:\s*(.+?)\s*$/mi);
  if (!match) return { gitType: 'invalid', linkedWorktree: false };

  const gitDir = normDir(path.isAbsolute(match[1]) ? match[1] : path.resolve(repoDir, match[1]));
  let commonRaw;
  try { commonRaw = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim(); }
  catch { return { gitDir, commonDir: gitDir, gitType: 'file', linkedWorktree: false }; }
  if (!commonRaw) return { gitType: 'invalid', linkedWorktree: false };

  const commonDir = normDir(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(gitDir, commonRaw));
  return { gitDir, commonDir, gitType: 'file', linkedWorktree: true };
}

function canonicalWorktreeRoot(repoDir, layout, registeredRepos) {
  if (!layout || !layout.linkedWorktree || !layout.commonDir) return null;
  if (path.basename(layout.commonDir) === '.git') {
    const primary = normDir(path.dirname(layout.commonDir));
    try {
      if (fs.statSync(path.join(primary, '.git')).isDirectory()) return primary;
    } catch { /* fall through to registry comparison */ }
  }

  for (const repo of Array.isArray(registeredRepos) ? registeredRepos : []) {
    if (typeof repo !== 'string' || !repo) continue;
    const candidate = normDir(repo);
    if (candidate === normDir(repoDir)) continue;
    const candidateLayout = gitLayout(candidate);
    if (candidateLayout && !candidateLayout.linkedWorktree
        && candidateLayout.commonDir === layout.commonDir) return candidate;
  }
  return null;
}

// ── repoRoot ───────────────────────────────────────────────────────────────────
// Walk UP from startDir to the nearest ancestor that is a repo. A repo is a dir containing `.graph`
// OR `.git`. A `.git` FILE is checked before `.graph`: tracked graph state can exist in every linked
// worktree, but the graph identity must still resolve through gitdir/commondir to the primary checkout.
// EXCLUDE orchestrator attempt/feature worktrees exactly like routes/meta.js: a linked worktree must
// never register as a new workspace/repo, including when it contains a tracked `.graph`. Also EXCLUDE
// "container roots" (system temp / home / fs root): an incidental marker there is never adopted (the
// hoisted guard, note note-mqj20ekamwy). Returns the repo dir (absolute) or null when no adoptable
// marker is found up to the filesystem root.
function repoRoot(startDir, opts) {
  if (!startDir || typeof startDir !== 'string') return null;
  const o = Array.isArray(opts) ? { registeredRepos: opts } : (opts && typeof opts === 'object' ? opts : {});
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

      const layout = gitLayout(dir);
      if (layout) {
        // `.git` is a FILE -> linked worktree. Resolve to the verified primary checkout before
        // considering `.graph`, because tracked graph files are present in the worktree too.
        if (layout.gitType === 'file' && layout.linkedWorktree) {
          const primary = canonicalWorktreeRoot(dir, layout, o.registeredRepos);
          if (primary && !isContainerRoot(primary)) return primary;
          // An unresolved linked worktree is still not an independent repo marker. Never return
          // this directory merely because it also contains a copied `.graph`; keep walking instead.
          const parent = path.dirname(dir);
          if (parent === dir) return null;
          dir = parent;
          continue;
        }
        // `.git` is a DIRECTORY -> ordinary repo clone, accept.
        if (layout.gitType === 'dir') return dir;
        // A valid gitdir file without `commondir` is a standalone/nested repository, not a linked
        // worktree. Keep it distinct (for example, submodule-style gitdir indirection).
        if (layout.gitType === 'file') return dir;
        // Malformed gitfiles are never promoted via a neighboring `.graph`.
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
        continue;
      }

      if (hasGraph) return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) return null;     // reached filesystem root, no marker found
    dir = parent;
  }
}

// Resolve a registration request without creating `.graph` or otherwise touching the candidate.
// Only a strict containing repo may replace the requested directory; fresh top-level directories
// remain their own registration target.
function registrationRepoRoot(requestedPath, opts) {
  const requested = path.resolve(requestedPath);
  const resolved = repoRoot(requested, opts);
  return resolved && normDir(resolved) !== normDir(requested) && !isContainerRoot(resolved)
    ? resolved
    : requested;
}

function isLegacyPathWorkspaceId(value) {
  if (typeof value !== 'string' || !value) return false;
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

// Preserve first-writer ordering except when the existing key is a legacy absolute path and a later
// human-readable workspace ID names the same repo. Selection changes; registry history does not.
function preferWorkspaceId(current, candidate) {
  if (!current) return candidate || null;
  if (isLegacyPathWorkspaceId(current) && candidate && !isLegacyPathWorkspaceId(candidate)) {
    return candidate;
  }
  return current;
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
function loadRegistry(file, opts = {}) {
  if (!file || typeof file !== 'string') return emptyRegistry();

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return emptyRegistry(); }

  let parsed;
  try { parsed = JSON.parse(raw); } catch { return emptyRegistry(); }

  // v1 flat array -> migrate, back up the original once, persist v2 atomically.
  if (Array.isArray(parsed)) {
    // Migration is a mutation too. Re-read under the same registry lock so it cannot overwrite a
    // concurrent v2 registration that landed after the initial legacy read.
    if (!opts.locked) return withRegistryLock(file, () => loadRegistry(file, { locked: true }));
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
// Derived reverse index Map<repoPath, workspaceName>. First-writer-wins on duplicate human names,
// but a human name supersedes a duplicate legacy absolute-path key without mutating registry history.
function repoToWorkspace(reg) {
  const map = new Map();
  const workspaces = (reg && reg.workspaces) || {};
  for (const [name, ws] of Object.entries(workspaces)) {
    const repos = (ws && Array.isArray(ws.repos)) ? ws.repos : [];
    for (const r of repos) {
      if (typeof r === 'string' && r) map.set(r, preferWorkspaceId(map.get(r), name));
    }
  }
  return map;
}

// ── addRepo ──────────────────────────────────────────────────────────────────────
// Register `repo` under the named `workspace` (creating the workspace if new). Atomic write; idempotent
// (re-adding the same repo to the same workspace is a no-op, no duplicate). Loads the current registry
// (migrating v1 along the way via loadRegistry), mutates, persists, and returns the updated v2 registry.
function addRepo(file, { workspace, repo } = {}, opts = {}) {
  if (!file || typeof file !== 'string') throw new Error('addRepo: file is required');
  if (!workspace || typeof workspace !== 'string') throw new Error('addRepo: workspace is required');
  if (!repo || typeof repo !== 'string') throw new Error('addRepo: repo is required');

  const commit = () => {
    const reg = loadRegistry(file, { locked: true });
    if (!reg.workspaces[workspace]) reg.workspaces[workspace] = { repos: [] };
    const repos = reg.workspaces[workspace].repos;
    if (!repos.includes(repo)) {
      repos.push(repo);
      atomicWrite(file, JSON.stringify(reg, null, 2));
    }

    // Do not acknowledge registration from the in-memory object. Re-open the committed file while
    // still holding the lock; every successful caller therefore proves its repo survived the RMW.
    const committed = loadRegistry(file, { locked: true });
    if (!committed.workspaces[workspace]
        || !committed.workspaces[workspace].repos.includes(repo)) {
      throw new Error(`workspace registration was not durably persisted for ${repo}`);
    }
    return committed;
  };
  return opts.locked ? commit() : withRegistryLock(file, commit, opts);
}

module.exports = {
  repoRoot,
  registrationRepoRoot,
  loadRegistry,
  allRepos,
  repoToWorkspace,
  preferWorkspaceId,
  withRegistryLock,
  isActiveRepoPath,
  activeRepoRoot,
  addRepo,
};
