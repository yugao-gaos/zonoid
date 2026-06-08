#!/usr/bin/env node
// Plain Node test for the merge half of lib/git.js (currentBranch, mergeBranch).
// No framework; matches the style of test/git.test.js. Run: node test/git-merge.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const git = require('../lib/git');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Commit a file inside a worktree (or any repo dir) and return nothing.
function commitFile(dir, name, contents, msg) {
  fs.writeFileSync(path.join(dir, name), contents);
  execFileSync('git', ['-C', dir, 'add', name], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'commit', '-m', msg], { encoding: 'utf8' });
}
const baseStatus = (ws) => execFileSync('git', ['-C', ws, 'status', '--porcelain'], { encoding: 'utf8' }).trim();

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-merge-'));
const A = 'sess-m/clean';   // non-conflicting attempt
const B = 'sess-m/other';   // second non-conflicting attempt
const C = 'sess-m/confa';   // conflicting pair
const D = 'sess-m/confb';
const keys = [A, B, C, D];
try {
  git.initRepo(ws);
  // A base file all attempts branch from.
  commitFile(ws, 'base.txt', 'base\n', 'base file');
  ok('currentBranch returns a base branch', typeof git.currentBranch(ws) === 'string' && git.currentBranch(ws).length > 0);
  // Baseline working-tree state (initRepo leaves .gitignore untracked); a clean merge/abort must
  // not change it. Asserting against this baseline isolates merge behaviour from pre-existing noise.
  const cleanState = baseStatus(ws);

  // --- clean merge: two attempts touching DIFFERENT files ---
  const wtA = git.createWorktree(ws, A).worktree;
  commitFile(wtA, 'feat-a.txt', 'a\n', 'attempt A');
  const rA = git.mergeBranch(ws, A);
  ok('clean mergeBranch merged:true', rA.merged === true);
  ok('clean mergeBranch returns head sha', /^[0-9a-f]{7,40}$/.test(rA.head || ''));
  ok('merged file present on base', fs.existsSync(path.join(ws, 'feat-a.txt')));
  ok('base tree clean after merge', baseStatus(ws) === cleanState);

  const wtB = git.createWorktree(ws, B).worktree;
  commitFile(wtB, 'feat-b.txt', 'b\n', 'attempt B');
  const rB = git.mergeBranch(ws, B, { message: 'orch: custom merge B' });
  ok('second clean merge merged:true', rB.merged === true);
  ok('second merged file present on base', fs.existsSync(path.join(ws, 'feat-b.txt')));

  // --- conflicting pair: both edit the SAME file off the same base ---
  // Branch both BEFORE either is merged so they share a common ancestor and truly conflict.
  const wtC = git.createWorktree(ws, C).worktree;
  const wtD = git.createWorktree(ws, D).worktree;
  commitFile(wtC, 'shared.txt', 'from C\n', 'attempt C edits shared');
  commitFile(wtD, 'shared.txt', 'from D\n', 'attempt D edits shared');
  const rC = git.mergeBranch(ws, C);
  ok('first conflicting attempt merges clean', rC.merged === true);
  const rD = git.mergeBranch(ws, D);
  ok('conflicting mergeBranch merged:false', rD.merged === false);
  ok('conflicting mergeBranch conflict:true', rD.conflict === true);
  ok('conflict reports the conflicted file', Array.isArray(rD.files) && rD.files.includes('shared.txt'));
  ok('base tree clean after abort', baseStatus(ws) === cleanState);

  // --- best-effort edge cases (no throw) ---
  const missing = git.mergeBranch(ws, 'sess-m/never-branched');
  ok('missing branch -> merged:false with reason', missing.merged === false && typeof missing.reason === 'string');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-merge-bare-'));
  ok('not-a-repo -> merged:false no throw', git.mergeBranch(bare, A).merged === false);
  ok('currentBranch null on non-repo', git.currentBranch(bare) === null);
  fs.rmSync(bare, { recursive: true, force: true });
} finally {
  for (const k of keys) { try { git.removeWorktree(ws, k); } catch {} fs.rmSync(git.worktreePath(ws, k), { recursive: true, force: true }); }
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
