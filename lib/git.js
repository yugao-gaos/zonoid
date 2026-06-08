// Thin, dependency-free wrapper over the git CLI, scoped to a workspace path. Foundation layer
// for the self-learning harness: an isolated git worktree per experiment/attempt. Every call
// shells out via execFileSync (arg array, NEVER a shell string) and tolerates the not-a-repo case.
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
// worktree if branch/path already present. -> { branch, worktree, head }.
function createWorktree(ws, taskKey) {
  const branch = branchName(taskKey);
  const wt = worktreePath(ws, taskKey);
  if (!isRepo(ws)) return { branch, worktree: wt, head: null };
  const existing = listWorktrees(ws).find((w) => w.path === wt || w.branch === branch);
  if (existing) return { branch, worktree: wt, head: existing.head };
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(ws, ['worktree', 'add', '-b', branch, wt, 'HEAD']);
  return { branch, worktree: wt, head: gitSafe(wt, ['rev-parse', 'HEAD']) };
}

// Remove the worktree + delete its branch. Idempotent (never throws if already gone). -> { removed }.
function removeWorktree(ws, taskKey) {
  if (!isRepo(ws)) return { removed: false };
  const wt = worktreePath(ws, taskKey);
  const present = listWorktrees(ws).some((w) => w.path === wt);
  gitSafe(ws, ['worktree', 'remove', '--force', wt]);
  gitSafe(ws, ['worktree', 'prune']);
  gitSafe(ws, ['branch', '-D', branchName(taskKey)]);
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

module.exports = { isRepo, initRepo, createWorktree, removeWorktree, listWorktrees, worktreePath, branchName, currentBranch, mergeBranch };
