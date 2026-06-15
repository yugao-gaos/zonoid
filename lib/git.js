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
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BASE = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'orchestrator');

// Same sha1/BASE conventions as lib/overlay.js, for consistent on-disk layout.
function wsHash(ws) {
  return crypto.createHash('sha1').update(String(ws || '')).digest('hex').slice(0, 16);
}
// taskKey -> filesystem-safe slug (collapse '/' and anything else to '-').
function slugify(key) {
  return String(key || '').replace(/[^A-Za-z0-9._-]/g, '-');
}
function worktreePath(ws, taskKey) {
  return path.join(BASE, 'worktrees', wsHash(ws), slugify(taskKey));
}
function branchName(taskKey) {
  return `orch/attempt/${slugify(taskKey)}`;
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
  return execFileSync('git', ['-C', ws, ...args], { encoding: 'utf8' }).trim();
}
// Like git() but swallows failure → returns null (for probes / idempotent cleanup).
function gitSafe(ws, args) {
  try { return git(ws, args); } catch { return null; }
}

function isRepo(ws) {
  return gitSafe(ws, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

// Idempotent: init if needed, ensure identity + .gitignore, guarantee an initial commit. -> { initialized, head }.
function initRepo(ws) {
  fs.mkdirSync(ws, { recursive: true });
  let initialized = false;
  if (!isRepo(ws)) {
    git(ws, ['init']);
    initialized = true;
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
// worktree, head, leased } | { branch, worktree, contended:true, held }.
function createWorktree(ws, taskKey, opts = {}) {
  const branch = branchName(taskKey);
  const wt = worktreePath(ws, taskKey);
  if (!isRepo(ws)) return { branch, worktree: wt, head: null };
  const existing = listWorktrees(ws).find((w) => w.path === wt || w.branch === branch);
  if (existing) return { branch, worktree: wt, head: existing.head };
  // Acquire the per-path lease before touching git: this is the point two parallel agents
  // would otherwise both run `git worktree add` against the same path.
  const lease = acquireLease(wt, opts.owner);
  if (!lease.ok) return { branch, worktree: wt, contended: true, held: lease.held };
  try {
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(ws, ['worktree', 'add', '-b', branch, wt, opts.base || 'HEAD']);
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
  const wt = worktreePath(ws, taskKey);
  // Compare realpaths: `git worktree list` prints symlink-resolved paths, while worktreePath
  // may go through a symlinked BASE (e.g. ~/.claude/orchestrator -> repo), so a plain string
  // compare misses and removeWorktree would always report removed:false.
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const wtReal = real(wt);
  const present = listWorktrees(ws).some((w) => real(w.path) === wtReal);
  gitSafe(ws, ['worktree', 'remove', '--force', wt]);
  gitSafe(ws, ['worktree', 'prune']);
  gitSafe(ws, ['branch', '-D', branchName(taskKey)]);
  releaseLease(wt); // free the path so it can be re-leased
  return { removed: present };
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

// Parse `git worktree list --porcelain` -> [{ path, head, branch }].
function listWorktrees(ws) {
  const out = gitSafe(ws, ['worktree', 'list', '--porcelain']);
  if (!out) return [];
  const trees = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), head: null, branch: null }; trees.push(cur); }
    else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return trees;
}

module.exports = { isRepo, initRepo, createWorktree, removeWorktree, listWorktrees, worktreePath, branchName, currentBranch, mergeBranch, attemptDiff, leasePath, acquireLease, releaseLease, readLease };
