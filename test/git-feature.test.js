#!/usr/bin/env node
// Plain Node test for the FEATURE tier of lib/git.js (createFeatureWorktree, mergeFeature,
// removeFeatureWorktree) + the attempt->feature reuse path (createWorktree base=<featureBranch>,
// mergeBranch run in the feature worktree). No framework; matches test/git-merge.test.js style.
// Run: node test/git-feature.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const git = require('../lib/git');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };
const g = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
function commitFile(dir, name, contents, msg) {
  fs.writeFileSync(path.join(dir, name), contents);
  g(dir, ['add', name]);
  g(dir, ['commit', '-m', msg]);
}
const baseStatus = (ws) => g(ws, ['status', '--porcelain']);

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-feat-'));
const FK = 'feat/login';            // feature key
const A = 'feat-att/aa';            // attempt forked off the feature branch
const FC = 'feat/conflict';         // feature key for the conflict case
const cleanup = [];
try {
  git.initRepo(ws);
  // Ensure the base branch is literally 'main' (createFeatureWorktree defaults base to 'main').
  g(ws, ['branch', '-M', 'main']);
  commitFile(ws, 'base.txt', 'base\n', 'base file');
  const cleanState = baseStatus(ws);

  // --- createFeatureWorktree: orch/feature/<key> off main + a worktree ---
  const f = git.createFeatureWorktree(ws, FK);
  cleanup.push(() => git.removeFeatureWorktree(ws, FK));
  ok('feature branch name is orch/feature/<slug>', f.branch === git.featureBranchName(FK) && f.branch === 'orch/feature/feat-login');
  ok('feature worktree created on disk', fs.existsSync(f.worktree));
  ok('feature branch exists in repo', g(ws, ['rev-parse', '--verify', f.branch]) === g(ws, ['rev-parse', 'main']));
  // idempotent re-call returns the existing worktree, no throw
  const f2 = git.createFeatureWorktree(ws, FK);
  ok('createFeatureWorktree idempotent (same worktree)', f2.worktree === f.worktree && f2.branch === f.branch);

  // --- attempt->feature reuse: fork an attempt off the FEATURE branch, commit, merge into FEATURE ---
  // base=feature branch + repo_path=feature worktree is exactly how the dispatcher wires tier-1.
  const wtA = git.createWorktree(ws, A, { base: f.branch }).worktree;
  cleanup.push(() => git.removeWorktree(ws, A));
  commitFile(wtA, 'login.txt', 'login\n', 'attempt on feature');
  const mainBefore = g(ws, ['rev-parse', 'main']);
  const featBefore = g(f.worktree, ['rev-parse', 'HEAD']);
  // mergeBranch merges orch/attempt/<A> into the CURRENT branch of the given dir (the feature wt).
  const rAtt = git.mergeBranch(f.worktree, A);
  ok('attempt merged into feature (merged:true)', rAtt.merged === true);
  const featAfter = g(f.worktree, ['rev-parse', 'HEAD']);
  ok('feature branch advanced after attempt merge', featAfter !== featBefore);
  ok('attempt file landed on the FEATURE branch', g(f.worktree, ['cat-file', '-t', `${f.branch}:login.txt`]) === 'blob');
  ok('main UNTOUCHED by attempt->feature merge', g(ws, ['rev-parse', 'main']) === mainBefore);
  ok('attempt file NOT on main', !fs.existsSync(path.join(ws, 'login.txt')));

  // --- mergeFeature clean: feature -> main ---
  const rF = git.mergeFeature(ws, FK);
  ok('mergeFeature merged:true (clean)', rF.merged === true);
  ok('mergeFeature returns head sha', /^[0-9a-f]{7,40}$/.test(rF.head || ''));
  ok('feature content now on main', fs.existsSync(path.join(ws, 'login.txt')));
  ok('main tree clean after feature merge', baseStatus(ws) === cleanState);

  // --- mergeFeature conflict: AUTO-ABORT to clean tree, return {conflict, files} ---
  // main now has login.txt. Make a feature off the PRE-conflict main, then have main and the feature
  // both edit the SAME file so feature->main conflicts.
  const fc = git.createFeatureWorktree(ws, FC);
  cleanup.push(() => git.removeFeatureWorktree(ws, FC));
  commitFile(fc.worktree, 'race.txt', 'from feature\n', 'feature edits race');
  commitFile(ws, 'race.txt', 'from main\n', 'main edits race');     // divergent edit on main
  const mainTipBefore = g(ws, ['rev-parse', 'main']);
  const cleanBeforeConflict = baseStatus(ws);                       // known-clean working tree
  const rConf = git.mergeFeature(ws, FC);
  ok('conflicting mergeFeature merged:false', rConf.merged === false);
  ok('conflicting mergeFeature conflict:true', rConf.conflict === true);
  ok('conflict reports the conflicted file', Array.isArray(rConf.files) && rConf.files.includes('race.txt'));
  ok('main tip unchanged after abort', g(ws, ['rev-parse', 'main']) === mainTipBefore);
  ok('main tree clean after conflict abort', baseStatus(ws) === cleanBeforeConflict);
  ok('no MERGE_HEAD lingering (aborted)', !fs.existsSync(path.join(ws, '.git', 'MERGE_HEAD')));
  ok('conflict re-run still aborts cleanly', git.mergeFeature(ws, FC).conflict === true);

  // --- edge cases ---
  const missing = git.mergeFeature(ws, 'feat/never');
  ok('missing feature branch -> merged:false with reason', missing.merged === false && typeof missing.reason === 'string');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-feat-bare-'));
  ok('not-a-repo -> mergeFeature merged:false no throw', git.mergeFeature(bare, FK).merged === false);
  ok('not-a-repo -> createFeatureWorktree head null no throw', git.createFeatureWorktree(bare, FK).head === null);
  fs.rmSync(bare, { recursive: true, force: true });

  // --- removeFeatureWorktree idempotent ---
  const rm1 = git.removeFeatureWorktree(ws, FK);
  ok('removeFeatureWorktree removes present worktree', rm1.removed === true);
  ok('feature branch deleted', g(ws, ['branch', '--list', f.branch]) === '');
  const rm2 = git.removeFeatureWorktree(ws, FK);
  ok('removeFeatureWorktree idempotent (already gone)', rm2.removed === false);
} finally {
  for (const fn of cleanup) { try { fn(); } catch {} }
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
