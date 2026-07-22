'use strict';

const fs = require('fs');
const path = require('path');

function cleanPath(value) {
  if (!value || typeof value !== 'string') return null;
  try { return path.resolve(value); } catch { return null; }
}

function canonicalPath(value) {
  const resolved = cleanPath(value);
  if (!resolved) return null;
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

async function identityFor(repoPath, git) {
  const canonical = canonicalPath(repoPath);
  const gitCommonDir = canonical && git && typeof git.commonDirAsync === 'function'
    ? await git.commonDirAsync(canonical)
    : null;
  return {
    repo_path: canonical,
    canonical_path: canonical,
    git_common_dir: gitCommonDir || null,
  };
}

function identityKey(identity) {
  return identity && (identity.git_common_dir || identity.canonical_path) || null;
}

async function namedWorkspaceForRepo(registry, repoPath, git) {
  const target = await identityFor(repoPath, git);
  const targetKey = identityKey(target);
  if (!targetKey) return null;

  for (const [name, entry] of Object.entries((registry && registry.workspaces) || {})) {
    const identities = [];
    for (const member of (entry && Array.isArray(entry.repos) ? entry.repos : [])) {
      const identity = await identityFor(member, git);
      if (identityKey(identity)) identities.push(identity);
    }
    if (!identities.some((identity) => identityKey(identity) === targetKey)) continue;

    const unique = [];
    const seen = new Set();
    for (const identity of identities) {
      const key = identityKey(identity);
      if (!seen.has(key)) { seen.add(key); unique.push(identity); }
    }
    return { name, repos: unique };
  }
  return null;
}

async function resolveRepoTarget({ key, explicit, overlay, workspace, registry, git } = {}) {
  const explicitPath = cleanPath(explicit);
  const storedPath = key && overlay && overlay.repos && cleanPath(overlay.repos[key]);
  const workspacePath = cleanPath(workspace);
  const provenance = explicitPath ? 'explicit' : (storedPath ? 'task' : 'workspace');
  const candidate = explicitPath || storedPath || workspacePath;

  if (!candidate) {
    return { ok: false, status: 400, code: 'repo_target_required', error: 'repo_path or workspace required' };
  }

  if (provenance === 'workspace') {
    const named = await namedWorkspaceForRepo(registry, workspacePath, git);
    if (named && named.repos.length > 1) {
      return {
        ok: false,
        status: 409,
        code: 'ambiguous_repo_target',
        error: `workspace "${named.name}" contains multiple Git repositories; pass repo_path or configure the task repo before creating a worktree`,
        workspace_name: named.name,
        repos: named.repos,
      };
    }
  }

  const identity = await identityFor(candidate, git);
  return {
    ok: true,
    repo: identity.repo_path,
    target: {
      provenance,
      ...identity,
    },
  };
}

async function verifyWorktreeTarget(target, worktree, git) {
  if (!worktree) return { ok: true, skipped: true };
  if (!git || typeof git.verifyWorktreeTargetAsync !== 'function') {
    return { ok: false, error: 'Git worktree identity verification is unavailable' };
  }
  const verification = await git.verifyWorktreeTargetAsync(target && target.repo_path, worktree);
  if (verification.ok) return verification;
  return {
    ...verification,
    ok: false,
    error: verification.error || 'worktree belongs to a different Git repository',
  };
}

module.exports = {
  canonicalPath,
  identityFor,
  namedWorkspaceForRepo,
  resolveRepoTarget,
  verifyWorktreeTarget,
};
