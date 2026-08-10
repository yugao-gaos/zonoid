'use strict';

const fs = require('fs');
const path = require('path');
const { RUNTIME_DIRNAME } = require('./runtime-paths');

function workspaceName(workspaceRoot) {
  const clean = String(workspaceRoot || '').replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || 'workspace';
}

function workspaceRoot(workspaceRootArg) {
  return path.resolve(workspaceRootArg || process.cwd());
}

function onboardRuntimeRoot(workspaceRootArg) {
  return path.join(workspaceRoot(workspaceRootArg), RUNTIME_DIRNAME, 'onboard');
}

function defaultOnboardOutDir(workspaceRootArg) {
  const root = workspaceRoot(workspaceRootArg);
  return path.join(root, RUNTIME_DIRNAME, 'onboard', workspaceName(root));
}

function legacyGraphOnboardOutDir(workspaceRootArg) {
  return path.join(workspaceRoot(workspaceRootArg), '.graph', 'onboard');
}

function legacyBenchOnboardRoot(workspaceRootArg) {
  return path.join(workspaceRoot(workspaceRootArg), 'bench', 'onboard');
}

function legacyBenchOnboardOutDir(workspaceRootArg) {
  const root = workspaceRoot(workspaceRootArg);
  return path.join(root, 'bench', 'onboard', workspaceName(root));
}

/**
 * Keep workspace-local onboarding state out of `git status` without editing a project's
 * committed .gitignore. Git's per-repository exclude file is local metadata, so this is safe for
 * existing projects and also works for linked worktrees where `.git` is a pointer file.
 */
function ensureOnboardRuntimeIgnored(workspaceRootArg) {
  const root = workspaceRoot(workspaceRootArg);
  const marker = path.join(root, '.git');
  let gitDir = null;
  try {
    if (fs.statSync(marker).isDirectory()) {
      gitDir = marker;
    } else {
      const match = fs.readFileSync(marker, 'utf8').match(/^gitdir:\s*(.+?)\s*$/im);
      if (match) gitDir = path.resolve(root, match[1]);
    }
  } catch { return false; }
  if (!gitDir) return false;

  // Linked worktrees keep info/exclude in the common Git directory, while submodules and normal
  // repositories use their own gitdir. Resolve `commondir` exactly as Git does without spawning a
  // process on the latency-sensitive enqueue route.
  let commonDir = gitDir;
  try {
    const reported = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (reported) commonDir = path.resolve(gitDir, reported);
  } catch { /* normal repositories have no commondir file */ }
  const excludeFile = path.join(commonDir, 'info', 'exclude');
  const rule = `${RUNTIME_DIRNAME}/`;
  let existing = '';
  try { existing = fs.readFileSync(excludeFile, 'utf8'); } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  if (existing.split(/\r?\n/).some((line) => line.trim() === rule)) return true;

  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(excludeFile, `${prefix}${rule}\n`);
  return true;
}

module.exports = {
  workspaceName,
  workspaceRoot,
  onboardRuntimeRoot,
  defaultOnboardOutDir,
  legacyGraphOnboardOutDir,
  legacyBenchOnboardRoot,
  legacyBenchOnboardOutDir,
  ensureOnboardRuntimeIgnored,
};
