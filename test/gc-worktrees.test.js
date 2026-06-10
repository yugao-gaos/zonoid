#!/usr/bin/env node
// Plain Node test for scripts/gc-worktrees.js — focuses on the dirty-worktree GC guard
// (Item 4: never reap a worktree that holds uncommitted work, even if it was classified
// GC-ELIGIBLE earlier in the same sweep). No framework; matches test/git.test.js style.
// Run: node test/gc-worktrees.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const gc = require('../scripts/gc-worktrees');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gc-'));
try {
  // Bootstrap a repo with a main branch + an initial commit.
  sh(repo, ['init', '-q']);
  sh(repo, ['config', 'user.name', 't']);
  sh(repo, ['config', 'user.email', 't@t']);
  sh(repo, ['checkout', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  sh(repo, ['add', '.']); sh(repo, ['commit', '-q', '-m', 'base']);

  // Create a worktree that is fully merged + clean (would classify GC-ELIGIBLE).
  const wtDir = path.join(repo, 'worktrees', 'self', 'reap-me');
  fs.mkdirSync(path.dirname(wtDir), { recursive: true });
  sh(repo, ['worktree', 'add', '-q', '-b', 'orch/attempt/reap-me', wtDir, 'main']);
  const item = { dir: wtDir, branch: 'orch/attempt/reap-me' };

  // --- guard fires: dirty worktree must NOT be reaped, even on confirm ---
  fs.writeFileSync(path.join(wtDir, 'uncommitted.txt'), 'WORK IN PROGRESS\n');
  const dirtyRes = gc.gcWorktree(repo, item, true);
  ok('dirty worktree NOT reaped (done=false)', dirtyRes.done === false);
  ok('skip note mentions uncommitted', /uncommitted/.test(dirtyRes.note));
  ok('dirty worktree still on disk', fs.existsSync(path.join(wtDir, '.git')));
  ok('uncommitted work preserved', fs.existsSync(path.join(wtDir, 'uncommitted.txt')));

  // --- clean worktree IS reaped on confirm ---
  fs.rmSync(path.join(wtDir, 'uncommitted.txt'));
  const cleanStatus = gc.git(wtDir, ['status', '--porcelain']);
  ok('worktree clean again', cleanStatus.ok && cleanStatus.stdout.length === 0);
  const cleanRes = gc.gcWorktree(repo, item, true);
  ok('clean worktree reaped (done=true)', cleanRes.done === true);
  ok('reaped worktree gone from disk', !fs.existsSync(path.join(wtDir, '.git')));

  // --- dry-run never reaps regardless ---
  const wtDir2 = path.join(repo, 'worktrees', 'self', 'dry');
  sh(repo, ['worktree', 'add', '-q', '-b', 'orch/attempt/dry', wtDir2, 'main']);
  const dry = gc.gcWorktree(repo, { dir: wtDir2, branch: 'orch/attempt/dry' }, false);
  ok('dry-run done=false', dry.done === false);
  ok('dry-run leaves worktree', fs.existsSync(path.join(wtDir2, '.git')));
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
