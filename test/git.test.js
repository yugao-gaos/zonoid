#!/usr/bin/env node
// Plain Node test for lib/git.js (no framework; matches the style of test/smoke.sh).
// Run: node test/git.test.js  — exits non-zero on any failed assertion.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const git = require('../lib/git');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };
const isWorkTree = (dir) => { try { return execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim() === 'true'; } catch { return false; } };

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-git-'));
const KEY = 'sess-abc/7';
try {
  const init = git.initRepo(ws);
  ok('initRepo returns head sha', /^[0-9a-f]{7,40}$/.test(init.head || ''));
  ok('initRepo initialized=true on fresh dir', init.initialized === true);
  ok('isRepo true after init', git.isRepo(ws) === true);
  ok('initRepo idempotent (initialized=false)', git.initRepo(ws).initialized === false);

  const expectedPath = git.worktreePath(ws, KEY);
  const expectedBranch = git.branchName(KEY);
  ok('branch name sanitized', expectedBranch === 'orch/attempt/sess-abc-7');

  const created = git.createWorktree(ws, KEY);
  ok('createWorktree path matches', created.worktree === expectedPath);
  ok('createWorktree branch matches', created.branch === expectedBranch);
  ok('worktree dir exists', fs.existsSync(expectedPath));
  ok('worktree is a git work tree', isWorkTree(expectedPath));
  const wtBranch = execFileSync('git', ['-C', expectedPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  ok('worktree on expected branch', wtBranch === expectedBranch);

  ok('createWorktree idempotent (same path)', git.createWorktree(ws, KEY).worktree === expectedPath);

  const trees = git.listWorktrees(ws);
  ok('listWorktrees shows 2 entries', trees.length === 2);
  ok('listWorktrees includes attempt branch', trees.some((t) => t.branch === expectedBranch));

  const rm = git.removeWorktree(ws, KEY);
  ok('removeWorktree removed=true', rm.removed === true);
  ok('worktree dir gone', !fs.existsSync(expectedPath));
  ok('listWorktrees back to 1 entry', git.listWorktrees(ws).length === 1);
  ok('removeWorktree idempotent (removed=false)', git.removeWorktree(ws, KEY).removed === false);

  // not-a-repo case
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bare-'));
  ok('isRepo false on non-repo', git.isRepo(bare) === false);
  ok('listWorktrees [] on non-repo', git.listWorktrees(bare).length === 0);
  ok('createWorktree no-throw on non-repo', git.createWorktree(bare, KEY).head === null);
  fs.rmSync(bare, { recursive: true, force: true });
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(git.worktreePath(ws, KEY), { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
