#!/usr/bin/env node
// Plain Node test for the target-repo decoupling: git.js operating on a repo path that is NOT a
// daemon workspace, plus overlay.setRepo / the explicit > task-field > workspace resolution order.
// No framework; matches the style of test/git.test.js. Run: node test/repo-target.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Sandbox BASE so worktrees + overlays land in a temp dir (BASE is read at require-time).
// realpath the temp dir: on macOS os.tmpdir() is a /var -> /private/var symlink, so `git worktree
// list` reports the resolved path while our path helpers keep the symlink form — normalize to match.
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-repo-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const git = require('../lib/git');
const overlay = require('../lib/overlay');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Mirror the daemon's resolveRepo precedence for a direct unit assertion.
function resolveRepo(ov, key, explicit, workspace) {
  return explicit || (key && ov.repos && ov.repos[key]) || workspace;
}

// A "workspace" that is NOT a git repo (mirrors the dogfood finding: daemon workspace != repo).
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ws-')));
// A separate target repo, distinct from the workspace.
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-repo-')));
const KEY = 'sess-xyz/3';
try {
  // --- overlay.setRepo + resolution order ---
  const ov = overlay.EMPTY();
  ok('repos map present in EMPTY()', ov.repos && typeof ov.repos === 'object');
  ok('resolve falls back to workspace when nothing set', resolveRepo(ov, KEY, null, workspace) === workspace);
  overlay.setRepo(ov, KEY, repo);
  ok('setRepo records the path', ov.repos[KEY] === repo);
  ok('resolve uses task repo field over workspace', resolveRepo(ov, KEY, null, workspace) === repo);
  ok('resolve: explicit beats task field', resolveRepo(ov, KEY, '/explicit/path', workspace) === '/explicit/path');
  overlay.setRepo(ov, KEY, '');
  ok('setRepo with empty path clears the field', ov.repos[KEY] === undefined);
  ok('resolve back to workspace after clear', resolveRepo(ov, KEY, null, workspace) === workspace);

  // setRepo survives a save/load round-trip (persistence).
  overlay.setRepo(ov, KEY, repo);
  overlay.save(workspace, ov);
  ok('repo field persists across load', overlay.load(workspace).repos[KEY] === repo);

  // --- git.js drives the arbitrary repo, NOT the workspace ---
  ok('workspace is not a repo (dogfood case)', git.isRepo(workspace) === false);
  const init = git.initRepo(repo);
  ok('initRepo works on arbitrary repo path', /^[0-9a-f]{7,40}$/.test(init.head || ''));
  ok('isRepo true on the target repo', git.isRepo(repo) === true);
  ok('workspace STILL not a repo (untouched)', git.isRepo(workspace) === false);

  const created = git.createWorktree(repo, KEY);
  ok('worktree created for target repo', fs.existsSync(created.worktree));
  // Worktree path is keyed by the REPO hash, so distinct repos never collide on disk.
  ok('worktree path differs from a workspace-keyed path', created.worktree !== git.worktreePath(workspace, KEY));
  ok('listWorktrees on target repo shows the attempt', git.listWorktrees(repo).some((t) => t.branch === git.branchName(KEY)));
  ok('listWorktrees on workspace is [] (no repo there)', git.listWorktrees(workspace).length === 0);

  const rm = git.removeWorktree(repo, KEY);
  ok('removeWorktree on target repo removed=true', rm.removed === true);
} finally {
  for (const d of [workspace, repo, SANDBOX, git.worktreePath(repo, KEY)]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
