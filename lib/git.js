// Thin, dependency-free wrapper over the git CLI, scoped to a repo path. Foundation layer
// for the self-learning harness: an isolated git worktree per experiment/attempt. Every call
// shells out via execFileSync (arg array, NEVER a shell string) and tolerates the not-a-repo case.
//
// The first arg (`ws`) is the TARGET REPO ROOT to run `git -C` against. It is NOT required to be the
// daemon workspace — callers resolve it (explicit repoPath > task's repo field > workspace) so the
// loop can branch/merge/measure on an arbitrary repo distinct from the daemon's own workspace.
// Worktrees + branches are keyed by a hash of this path, so distinct repos never collide on disk.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execFile } = require('child_process');
const runtimePaths = require('./runtime-paths');

const WORKTREE_DIR = runtimePaths.resolveWorktreeDir();

// Same sha1 convention as lib/overlay.js, so distinct repos never collide on disk.
function wsHash(ws) {
  return crypto.createHash('sha1').update(String(ws || '')).digest('hex').slice(0, 16);
}
// taskKey -> filesystem-safe slug (collapse '/' and anything else to '-').
function slugify(key) {
  return String(key || '').replace(/[^A-Za-z0-9._-]/g, '-');
}
function worktreePath(ws, taskKey) {
  return path.join(WORKTREE_DIR, wsHash(ws), slugify(taskKey));
}
function branchName(taskKey) {
  return `orch/attempt/${slugify(taskKey)}`;
}
// Feature tier (stay-remote two-tier topology): a long-lived integration branch + worktree per
// feature. Workers' attempt branches fork FROM it (base) and auto-merge INTO it (tier-1, cheap);
// the feature->main merge is a separate dispatcher-gated step (tier-2). Distinct prefix/path so a
// feature branch never collides with an attempt branch keyed by the same slug.
function featureBranchName(key) {
  return `orch/feature/${slugify(key)}`;
}
function featureWorktreePath(ws, key) {
  return path.join(WORKTREE_DIR, wsHash(ws), `feature-${slugify(key)}`);
}

function realPath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

function findWorktree(trees, expectedPath, branch) {
  const expectedReal = realPath(expectedPath);
  return trees.find((w) => w.branch === branch || realPath(w.path) === expectedReal);
}

// ---- per-path lease ------------------------------------------------------
// Two agents must never claim the SAME worktree path concurrently. A lease is a sidecar file
// <wt>.lease holding the owner's identity + pid + timestamp, created atomically with the 'wx'
// (O_EXCL) flag so the first writer wins and a second writer gets EEXIST. A lease whose owner
// process is gone AND older than LEASE_STALE_MS is treated as abandoned and reclaimable, so a
// crashed agent never wedges a path forever.
const LEASE_STALE_MS = Number(process.env.ORCH_LEASE_STALE_MS) || 3600000; // 1h default

function leasePath(wt) {
  return `${wt}.lease`;
}
// True if a pid is alive on this host (signal 0 probes without killing). Unknown pid -> assume alive.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function readLease(wt) {
  try { return JSON.parse(fs.readFileSync(leasePath(wt), 'utf8')); } catch { return null; }
}
// A lease is stale (reclaimable) when its owning process is dead AND it has aged past the window.
function leaseStale(lease) {
  if (!lease) return true;
  const aged = Date.now() - (Number(lease.ts) || 0) > LEASE_STALE_MS;
  return aged && !pidAlive(Number(lease.pid));
}
// Acquire the lease for wt atomically. Returns { ok:true, lease } on success, or
// { ok:false, held:lease } if a live lease is held by someone else. Reclaims stale leases.
function acquireLease(wt, owner) {
  const lp = leasePath(wt);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  const payload = JSON.stringify({ owner: owner || 'unknown', pid: process.pid, ts: Date.now() });
  try {
    fs.writeFileSync(lp, payload, { flag: 'wx' });
    return { ok: true, lease: JSON.parse(payload) };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const existing = readLease(wt);
    // Re-entrant: same pid already owns it -> treat as held by us.
    if (existing && Number(existing.pid) === process.pid) return { ok: true, lease: existing };
    if (leaseStale(existing)) {
      // Steal the stale lease (best-effort atomic replace).
      try { fs.writeFileSync(lp, payload, { flag: 'w' }); return { ok: true, lease: JSON.parse(payload), reclaimed: true }; }
      catch { /* fall through to held */ }
    }
    return { ok: false, held: existing };
  }
}
function releaseLease(wt) {
  try { fs.rmSync(leasePath(wt), { force: true }); } catch { /* idempotent */ }
}

// Run git -C <ws> <args...>. Returns trimmed stdout. Throws on non-zero exit (callers guard).
function git(ws, args) {
  return execFileSync('git', ['-C', ws, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}
// Like git() but swallows failure → returns null (for probes / idempotent cleanup).
function gitSafe(ws, args) {
  try { return git(ws, args); } catch { return null; }
}

function isRepo(ws) {
  return gitSafe(ws, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

function canonicalPath(value) {
  if (!value) return null;
  let resolved;
  try { resolved = path.resolve(value); } catch { return null; }
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function commonDir(ws) {
  const raw = gitSafe(ws, ['rev-parse', '--git-common-dir']);
  if (!raw) return null;
  return canonicalPath(path.isAbsolute(raw) ? raw : path.resolve(ws, raw));
}

function repoIdentity(ws) {
  return { canonical_path: canonicalPath(ws), git_common_dir: commonDir(ws) };
}

function verifyWorktreeTarget(ws, worktree) {
  const target = repoIdentity(ws);
  const actual = repoIdentity(worktree);
  const ok = !!target.git_common_dir && target.git_common_dir === actual.git_common_dir;
  return {
    ok,
    target,
    worktree: actual,
    error: ok ? null : 'worktree belongs to a different Git repository',
  };
}

function worktreeIdentityError(branch, worktree, verification) {
  return {
    branch,
    worktree,
    target_mismatch: true,
    error: verification.error,
    target_identity: verification.target,
    worktree_identity: verification.worktree,
  };
}

// Idempotent: init if needed, ensure identity + .gitignore, guarantee an initial commit. -> { initialized, head }.
function initRepo(ws) {
  fs.mkdirSync(ws, { recursive: true });
  let initialized = false;
  if (!isRepo(ws)) {
    git(ws, ['init']);
    initialized = true;
    // Pin the initial branch to `main`. Plain `git init` inherits the MACHINE's init.defaultBranch,
    // which is still `master` on many installs — but this module's own feature tier defaults its
    // base to `main` (createFeatureWorktree opts.base), so a repo initialized here would fail every
    // `worktree add -b orch/feature/<slug> <path> main` with "invalid reference: main". Rewriting
    // the symbolic ref (rather than passing `git init -b`) works on every git version and is a
    // no-op rename: it runs only on a fresh init, before any commit exists.
    if (!gitSafe(ws, ['rev-parse', 'HEAD'])) gitSafe(ws, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  // Local identity fallback so commits don't fail when no global git config exists.
  if (!gitSafe(ws, ['config', 'user.name'])) git(ws, ['config', 'user.name', 'orchestrator']);
  if (!gitSafe(ws, ['config', 'user.email'])) git(ws, ['config', 'user.email', 'orchestrator@localhost']);
  const ignore = path.join(ws, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '.claude/\nnode_modules/\n');
  // Ensure there's at least one commit so worktrees have a HEAD to branch from.
  if (!gitSafe(ws, ['rev-parse', 'HEAD'])) git(ws, ['commit', '--allow-empty', '-m', 'orch: init']);
  return { initialized, head: gitSafe(ws, ['rev-parse', 'HEAD']) };
}

// Create branch orch/attempt/<slug> + a worktree OUTSIDE ws. Idempotent: returns the existing
// worktree if branch/path already present. Lease-guarded: a second agent racing for the SAME
// path gets { contended:true, held } instead of a colliding `git worktree add`. -> { branch,
// worktree, head, leased } | { branch, worktree:null, contended:true, held }.
function createWorktree(ws, taskKey, opts = {}) {
  const branch = branchName(taskKey);
  const wt = worktreePath(ws, taskKey);
  if (!isRepo(ws)) return { branch, worktree: wt, head: null };
  const existing = findWorktree(listWorktrees(ws), wt, branch);
  if (existing) {
    const verification = verifyWorktreeTarget(ws, existing.path);
    if (!verification.ok) return worktreeIdentityError(branch, existing.path, verification);
    return { branch, worktree: existing.path, head: existing.head };
  }
  if (fs.existsSync(wt)) {
    const verification = verifyWorktreeTarget(ws, wt);
    if (!verification.ok) return worktreeIdentityError(branch, wt, verification);
    return { branch, worktree: wt, worktree_conflict: true, error: 'worktree path exists but is not registered with the target repository' };
  }
  // Acquire the per-path lease before touching git: this is the point two parallel agents
  // would otherwise both run `git worktree add` against the same path.
  const lease = acquireLease(wt, opts.owner);
  if (!lease.ok) return { branch, worktree: null, contended: true, held: lease.held };
  try {
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(ws, ['worktree', 'add', '-b', branch, wt, opts.base || 'HEAD']);
    const verification = verifyWorktreeTarget(ws, wt);
    if (!verification.ok) return worktreeIdentityError(branch, wt, verification);
    return { branch, worktree: wt, head: gitSafe(wt, ['rev-parse', 'HEAD']), leased: true };
  } catch (e) {
    // `worktree add` failed -> we never produced a worktree, so don't hold the lease.
    releaseLease(wt);
    throw e;
  }
}

// Remove the worktree + delete its branch. Idempotent (never throws if already gone). -> { removed }.
function removeWorktree(ws, taskKey) {
  if (!isRepo(ws)) return { removed: false };
  const expectedPath = worktreePath(ws, taskKey);
  const existing = findWorktree(listWorktrees(ws), expectedPath, branchName(taskKey));
  const wt = existing ? existing.path : expectedPath;
  gitSafe(ws, ['worktree', 'remove', '--force', wt]);
  gitSafe(ws, ['worktree', 'prune']);
  gitSafe(ws, ['branch', '-D', branchName(taskKey)]);
  releaseLease(wt); // free the path so it can be re-leased
  return { removed: Boolean(existing) };
}

// The currently checked-out branch of ws, or null if not a repo / detached probe fails.
function currentBranch(ws) {
  return gitSafe(ws, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

// Merge an attempt's branch (orch/attempt/<slug>) into the currently checked-out base branch with
// --no-ff. Best-effort: returns { merged:false, reason } on the not-a-repo / missing-branch case.
// On conflict: aborts and returns { merged:false, conflict:true, files:[...conflicted...] }.
// On success: { merged:true, head:<sha>, branch }.
function mergeBranch(ws, taskKey, opts = {}) {
  const branch = branchName(taskKey);
  if (!isRepo(ws)) return { merged: false, reason: 'not a git repo' };
  if (!gitSafe(ws, ['rev-parse', '--verify', branch])) return { merged: false, reason: `branch not found: ${branch}` };
  const message = opts.message || `orch: merge attempt ${slugify(taskKey)}`;
  try {
    git(ws, ['merge', '--no-ff', branch, '-m', message]);
    return { merged: true, head: gitSafe(ws, ['rev-parse', 'HEAD']), branch };
  } catch {
    // Conflict (or other merge failure): collect conflicted paths, then abort to leave a clean tree.
    const conflicted = gitSafe(ws, ['diff', '--name-only', '--diff-filter=U']);
    gitSafe(ws, ['merge', '--abort']);
    return { merged: false, conflict: true, files: conflicted ? conflicted.split('\n').filter(Boolean) : [], branch };
  }
}

// Create the feature integration branch orch/feature/<slug> + a worktree OUTSIDE ws, branched off
// `base` (default 'main'). Lease-guarded + idempotent, mirroring createWorktree. Workers branch
// their attempts off this branch (branch_task base=<featureBranch>) and merge back into it. ->
// { branch, worktree, head, leased } | existing | { branch, worktree:null, contended:true, held }.
function createFeatureWorktree(ws, key, opts = {}) {
  const branch = featureBranchName(key);
  const wt = featureWorktreePath(ws, key);
  if (!isRepo(ws)) return { branch, worktree: wt, head: null };
  const existing = findWorktree(listWorktrees(ws), wt, branch);
  if (existing) {
    const verification = verifyWorktreeTarget(ws, existing.path);
    if (!verification.ok) return worktreeIdentityError(branch, existing.path, verification);
    return { branch, worktree: existing.path, head: existing.head };
  }
  if (fs.existsSync(wt)) {
    const verification = verifyWorktreeTarget(ws, wt);
    if (!verification.ok) return worktreeIdentityError(branch, wt, verification);
    return { branch, worktree: wt, worktree_conflict: true, error: 'feature worktree path exists but is not registered with the target repository' };
  }
  const lease = acquireLease(wt, opts.owner);
  if (!lease.ok) return { branch, worktree: null, contended: true, held: lease.held };
  try {
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(ws, ['worktree', 'add', '-b', branch, wt, opts.base || 'main']);
    const verification = verifyWorktreeTarget(ws, wt);
    if (!verification.ok) return worktreeIdentityError(branch, wt, verification);
    return { branch, worktree: wt, head: gitSafe(wt, ['rev-parse', 'HEAD']), leased: true };
  } catch (e) {
    releaseLease(wt);
    throw e;
  }
}

// Merge a feature branch (orch/feature/<slug>) into the currently checked-out branch (main) with
// --no-ff. This is the GATED tier-2 feature->main step — dispatcher decision only, NEVER an auto/
// loop path. Conflict handling mirrors mergeBranch EXACTLY: collect conflicted paths, abort to a
// clean tree, return { merged:false, conflict:true, files }. Success: { merged:true, head, branch }.
function mergeFeature(ws, key, opts = {}) {
  const branch = featureBranchName(key);
  if (!isRepo(ws)) return { merged: false, reason: 'not a git repo' };
  if (!gitSafe(ws, ['rev-parse', '--verify', branch])) return { merged: false, reason: `branch not found: ${branch}` };
  const message = opts.message || `orch: merge feature ${slugify(key)}`;
  try {
    git(ws, ['merge', '--no-ff', branch, '-m', message]);
    return { merged: true, head: gitSafe(ws, ['rev-parse', 'HEAD']), branch };
  } catch {
    const conflicted = gitSafe(ws, ['diff', '--name-only', '--diff-filter=U']);
    gitSafe(ws, ['merge', '--abort']);
    return { merged: false, conflict: true, files: conflicted ? conflicted.split('\n').filter(Boolean) : [], branch };
  }
}

// Remove a feature worktree + delete its branch. Idempotent (never throws if already gone). Mirrors
// removeWorktree (realpath compare for symlinked BASE). -> { removed }.
function removeFeatureWorktree(ws, key) {
  if (!isRepo(ws)) return { removed: false };
  const expectedPath = featureWorktreePath(ws, key);
  const existing = findWorktree(listWorktrees(ws), expectedPath, featureBranchName(key));
  const wt = existing ? existing.path : expectedPath;
  gitSafe(ws, ['worktree', 'remove', '--force', wt]);
  gitSafe(ws, ['worktree', 'prune']);
  gitSafe(ws, ['branch', '-D', featureBranchName(key)]);
  releaseLease(wt);
  return { removed: Boolean(existing) };
}

// Read-only: the three-dot (merge-base) diff of an attempt's branch (orch/attempt/<slug>) against
// base, so the judge can review what the attempt changed without mutating anything. Three-dot diff
// implicitly uses the merge-base, so it shows only the attempt's own commits. Best-effort: returns
// { ok:false, reason } on not-a-repo / missing-branch. On success: { ok:true, branch, base, stat, diff }.
function attemptDiff(ws, taskKey, opts = {}) {
  const branch = branchName(taskKey);
  if (!isRepo(ws)) return { ok: false, reason: 'not a git repo' };
  if (!gitSafe(ws, ['rev-parse', '--verify', branch])) return { ok: false, reason: `branch not found: ${branch}` };
  const base = opts.base || currentBranch(ws) || 'HEAD';
  const range = `${base}...${branch}`;
  return {
    ok: true,
    branch,
    base,
    stat: gitSafe(ws, ['diff', range, '--stat']) || '',
    diff: gitSafe(ws, ['diff', range]) || '',
  };
}

// Parse `git worktree list --porcelain` -> [{ path, head, branch }]. Pure: shared by the sync and
// async (gitA) list variants.
// `git worktree list --porcelain` prints paths with POSIX separators on EVERY platform, including
// Windows (`C:/Users/.../sess-abc-7`). worktreePath()/featureWorktreePath() build NATIVE paths via
// path.join (`C:\Users\...`). Handing the raw git string back means createWorktree returns a
// backslash path the first time (freshly created, from worktreePath) and a forward-slash path every
// time after (reused, from git) — the same worktree under two spellings. Callers that compare or
// store the path string then miss: the claim gate matches a claim against the REGISTERED worktree
// path, and the execution permit's allowed_paths is a string list, so an agent that re-resolved its
// worktree got a path that no longer equals the registered one. Normalize to native form at the
// parse boundary, which is also the form canonicalPath()/commonDir() already produce.
function toNativePath(p) {
  if (!p) return p;
  try { return path.resolve(p); } catch { return p; }
}
function parseWorktrees(out) {
  if (!out) return [];
  const trees = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: toNativePath(line.slice(9)), head: null, branch: null }; trees.push(cur); }
    else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return trees;
}
function listWorktrees(ws) {
  return parseWorktrees(gitSafe(ws, ['worktree', 'list', '--porcelain']));
}

// Register the built-in `ours` merge driver for this clone so the `.graph/** merge=ours` gitattribute
// actually takes effect. Without it, git silently falls back to a normal merge and an attempt branch's
// stale .graph snapshot can clobber the daemon's live state on merge (the FU-2 desync — "edge removes
// didn't stick"). `true` is git's no-op driver: keep OUR (current-branch) copy of every .graph file
// wholesale. Idempotent + safe (gitSafe swallows non-repo / failure); cheap to call per workspace setup.
function ensureMergeDriver(ws) {
  if (!isRepo(ws)) return false;
  gitSafe(ws, ['config', 'merge.ours.driver', 'true']);
  return true;
}

// ---- async (non-blocking) variants --------------------------------------------------------------
// The daemon runs git on its SINGLE event-loop thread. A synchronous `git worktree add` (~5s on a
// large repo / Windows, where the new working tree is checked out + AV-scanned) or `git merge`
// freezes EVERY request — /health included — for its full duration. Observed live: a multi-second
// daemon "wedge" whenever subconscious assignment-prepare / branch_task / the automode judge-merge
// created a worktree (probe showed 6-7s event-loop stalls 1:1 with each `git worktree add`). These
// variants shell out via async execFile so the loop stays live while git runs; the daemon's
// (already-async) route handlers await them. The sync versions above are kept VERBATIM for
// CLI/tests/non-loop callers — keep the two in lockstep when editing either.
function gitA(ws, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', ws, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout).trim());
    });
  });
}
async function gitSafeA(ws, args) { try { return await gitA(ws, args); } catch { return null; } }

async function isRepoAsync(ws) {
  return (await gitSafeA(ws, ['rev-parse', '--is-inside-work-tree'])) === 'true';
}
async function commonDirAsync(ws) {
  const raw = await gitSafeA(ws, ['rev-parse', '--git-common-dir']);
  if (!raw) return null;
  return canonicalPath(path.isAbsolute(raw) ? raw : path.resolve(ws, raw));
}
async function repoIdentityAsync(ws) {
  return { canonical_path: canonicalPath(ws), git_common_dir: await commonDirAsync(ws) };
}
async function verifyWorktreeTargetAsync(ws, worktree) {
  const target = await repoIdentityAsync(ws);
  const actual = await repoIdentityAsync(worktree);
  const ok = !!target.git_common_dir && target.git_common_dir === actual.git_common_dir;
  return {
    ok,
    target,
    worktree: actual,
    error: ok ? null : 'worktree belongs to a different Git repository',
  };
}
async function listWorktreesAsync(ws) {
  return parseWorktrees(await gitSafeA(ws, ['worktree', 'list', '--porcelain']));
}
async function currentBranchAsync(ws) {
  return gitSafeA(ws, ['rev-parse', '--abbrev-ref', 'HEAD']);
}
async function initRepoAsync(ws) {
  fs.mkdirSync(ws, { recursive: true });
  let initialized = false;
  if (!(await isRepoAsync(ws))) { await gitA(ws, ['init']); initialized = true; }
  if (!(await gitSafeA(ws, ['config', 'user.name']))) await gitA(ws, ['config', 'user.name', 'orchestrator']);
  if (!(await gitSafeA(ws, ['config', 'user.email']))) await gitA(ws, ['config', 'user.email', 'orchestrator@localhost']);
  const ignore = path.join(ws, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '.claude/\nnode_modules/\n');
  if (!(await gitSafeA(ws, ['rev-parse', 'HEAD']))) await gitA(ws, ['commit', '--allow-empty', '-m', 'orch: init']);
  return { initialized, head: await gitSafeA(ws, ['rev-parse', 'HEAD']) };
}
async function createWorktreeAsync(ws, taskKey, opts = {}) {
  const branch = branchName(taskKey);
  const wt = worktreePath(ws, taskKey);
  if (!(await isRepoAsync(ws))) return { branch, worktree: wt, head: null };
  const existing = findWorktree(await listWorktreesAsync(ws), wt, branch);
  if (existing) {
    const verification = await verifyWorktreeTargetAsync(ws, existing.path);
    if (!verification.ok) return worktreeIdentityError(branch, existing.path, verification);
    return { branch, worktree: existing.path, head: existing.head };
  }
  if (fs.existsSync(wt)) {
    const verification = await verifyWorktreeTargetAsync(ws, wt);
    if (!verification.ok) return worktreeIdentityError(branch, wt, verification);
    return { branch, worktree: wt, worktree_conflict: true, error: 'worktree path exists but is not registered with the target repository' };
  }
  const lease = acquireLease(wt, opts.owner);
  if (!lease.ok) return { branch, worktree: null, contended: true, held: lease.held };
  try {
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    await gitA(ws, ['worktree', 'add', '-b', branch, wt, opts.base || 'HEAD']);
    const verification = await verifyWorktreeTargetAsync(ws, wt);
    if (!verification.ok) return worktreeIdentityError(branch, wt, verification);
    return { branch, worktree: wt, head: await gitSafeA(wt, ['rev-parse', 'HEAD']), leased: true };
  } catch (e) { releaseLease(wt); throw e; }
}
async function removeWorktreeAsync(ws, taskKey) {
  if (!(await isRepoAsync(ws))) return { removed: false };
  const expectedPath = worktreePath(ws, taskKey);
  const existing = findWorktree(await listWorktreesAsync(ws), expectedPath, branchName(taskKey));
  const wt = existing ? existing.path : expectedPath;
  await gitSafeA(ws, ['worktree', 'remove', '--force', wt]);
  await gitSafeA(ws, ['worktree', 'prune']);
  await gitSafeA(ws, ['branch', '-D', branchName(taskKey)]);
  releaseLease(wt);
  return { removed: Boolean(existing) };
}
async function mergeBranchAsync(ws, taskKey, opts = {}) {
  const branch = branchName(taskKey);
  if (!(await isRepoAsync(ws))) return { merged: false, reason: 'not a git repo' };
  if (!(await gitSafeA(ws, ['rev-parse', '--verify', branch]))) return { merged: false, reason: `branch not found: ${branch}` };
  const message = opts.message || `orch: merge attempt ${slugify(taskKey)}`;
  try {
    await gitA(ws, ['merge', '--no-ff', branch, '-m', message]);
    return { merged: true, head: await gitSafeA(ws, ['rev-parse', 'HEAD']), branch };
  } catch {
    const conflicted = await gitSafeA(ws, ['diff', '--name-only', '--diff-filter=U']);
    await gitSafeA(ws, ['merge', '--abort']);
    return { merged: false, conflict: true, files: conflicted ? conflicted.split('\n').filter(Boolean) : [], branch };
  }
}
async function createFeatureWorktreeAsync(ws, key, opts = {}) {
  const branch = featureBranchName(key);
  const wt = featureWorktreePath(ws, key);
  if (!(await isRepoAsync(ws))) return { branch, worktree: wt, head: null };
  const existing = findWorktree(await listWorktreesAsync(ws), wt, branch);
  if (existing) {
    const verification = await verifyWorktreeTargetAsync(ws, existing.path);
    if (!verification.ok) return worktreeIdentityError(branch, existing.path, verification);
    return { branch, worktree: existing.path, head: existing.head };
  }
  if (fs.existsSync(wt)) {
    const verification = await verifyWorktreeTargetAsync(ws, wt);
    if (!verification.ok) return worktreeIdentityError(branch, wt, verification);
    return { branch, worktree: wt, worktree_conflict: true, error: 'feature worktree path exists but is not registered with the target repository' };
  }
  const lease = acquireLease(wt, opts.owner);
  if (!lease.ok) return { branch, worktree: null, contended: true, held: lease.held };
  try {
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    await gitA(ws, ['worktree', 'add', '-b', branch, wt, opts.base || 'main']);
    const verification = await verifyWorktreeTargetAsync(ws, wt);
    if (!verification.ok) return worktreeIdentityError(branch, wt, verification);
    return { branch, worktree: wt, head: await gitSafeA(wt, ['rev-parse', 'HEAD']), leased: true };
  } catch (e) { releaseLease(wt); throw e; }
}
async function mergeFeatureAsync(ws, key, opts = {}) {
  const branch = featureBranchName(key);
  if (!(await isRepoAsync(ws))) return { merged: false, reason: 'not a git repo' };
  if (!(await gitSafeA(ws, ['rev-parse', '--verify', branch]))) return { merged: false, reason: `branch not found: ${branch}` };
  const message = opts.message || `orch: merge feature ${slugify(key)}`;
  try {
    await gitA(ws, ['merge', '--no-ff', branch, '-m', message]);
    return { merged: true, head: await gitSafeA(ws, ['rev-parse', 'HEAD']), branch };
  } catch {
    const conflicted = await gitSafeA(ws, ['diff', '--name-only', '--diff-filter=U']);
    await gitSafeA(ws, ['merge', '--abort']);
    return { merged: false, conflict: true, files: conflicted ? conflicted.split('\n').filter(Boolean) : [], branch };
  }
}
async function removeFeatureWorktreeAsync(ws, key) {
  if (!(await isRepoAsync(ws))) return { removed: false };
  const expectedPath = featureWorktreePath(ws, key);
  const existing = findWorktree(await listWorktreesAsync(ws), expectedPath, featureBranchName(key));
  const wt = existing ? existing.path : expectedPath;
  await gitSafeA(ws, ['worktree', 'remove', '--force', wt]);
  await gitSafeA(ws, ['worktree', 'prune']);
  await gitSafeA(ws, ['branch', '-D', featureBranchName(key)]);
  releaseLease(wt);
  return { removed: Boolean(existing) };
}
async function attemptDiffAsync(ws, taskKey, opts = {}) {
  const branch = branchName(taskKey);
  if (!(await isRepoAsync(ws))) return { ok: false, reason: 'not a git repo' };
  if (!(await gitSafeA(ws, ['rev-parse', '--verify', branch]))) return { ok: false, reason: `branch not found: ${branch}` };
  const base = opts.base || (await currentBranchAsync(ws)) || 'HEAD';
  const range = `${base}...${branch}`;
  return {
    ok: true,
    branch,
    base,
    stat: (await gitSafeA(ws, ['diff', range, '--stat'])) || '',
    diff: (await gitSafeA(ws, ['diff', range])) || '',
  };
}

module.exports = {
  isRepo, commonDir, repoIdentity, verifyWorktreeTarget, initRepo, createWorktree, removeWorktree, listWorktrees, worktreePath, branchName, currentBranch, mergeBranch, attemptDiff, leasePath, acquireLease, releaseLease, readLease, featureBranchName, featureWorktreePath, createFeatureWorktree, mergeFeature, removeFeatureWorktree, ensureMergeDriver, gitSafe,
  // async (non-blocking) variants — used by the daemon's async route handlers so git never freezes
  // the event loop. parseWorktrees is exported for tests.
  parseWorktrees, isRepoAsync, commonDirAsync, repoIdentityAsync, verifyWorktreeTargetAsync, listWorktreesAsync, currentBranchAsync, initRepoAsync, createWorktreeAsync, removeWorktreeAsync, mergeBranchAsync, createFeatureWorktreeAsync, mergeFeatureAsync, removeFeatureWorktreeAsync, attemptDiffAsync,
};
