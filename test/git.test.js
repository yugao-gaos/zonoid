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

  // ---- per-path lease (Item 1: two agents cannot claim the same worktree path) ----
  // createWorktree leaves a lease file alongside the worktree.
  const c2 = git.createWorktree(ws, KEY, { owner: 'agent-A' });
  ok('createWorktree reports leased=true', c2.leased === true);
  ok('lease file exists after create', fs.existsSync(git.leasePath(c2.worktree)));
  const heldLease = git.readLease(c2.worktree);
  ok('lease records owner', heldLease && heldLease.owner === 'agent-A');
  ok('lease records pid', heldLease && heldLease.pid === process.pid);

  // A SECOND, different owner (simulated via a live foreign pid) cannot steal a live lease.
  // We hand-write a competing lease for a fresh path and try to acquire it.
  const KEY2 = 'sess-abc/contend';
  const wt2 = git.worktreePath(ws, KEY2);
  fs.mkdirSync(path.dirname(wt2), { recursive: true });
  // pid 1 (init/launchd) is always alive and is NOT this process -> a live, foreign lease.
  fs.writeFileSync(git.leasePath(wt2), JSON.stringify({ owner: 'agent-B', pid: 1, ts: Date.now() }), { flag: 'wx' });
  const contend = git.createWorktree(ws, KEY2, { owner: 'agent-C' });
  ok('createWorktree contended on held live lease', contend.contended === true);
  ok('contended worktree NOT created on disk', !fs.existsSync(path.join(wt2, '.git')));
  ok('held lease owner surfaced', contend.held && contend.held.owner === 'agent-B');
  fs.rmSync(git.leasePath(wt2), { force: true });

  // A STALE lease (dead pid + aged ts) is reclaimable.
  const KEY3 = 'sess-abc/stale';
  const wt3 = git.worktreePath(ws, KEY3);
  fs.mkdirSync(path.dirname(wt3), { recursive: true });
  // pid 2^31-1 is effectively never a live process; ts far in the past beats the stale window.
  fs.writeFileSync(git.leasePath(wt3), JSON.stringify({ owner: 'crashed', pid: 2147483647, ts: 1 }), { flag: 'wx' });
  const acq = git.acquireLease(wt3, 'agent-D');
  ok('stale lease reclaimed', acq.ok === true && acq.reclaimed === true);
  ok('reclaimed lease owned by new owner', git.readLease(wt3).owner === 'agent-D');
  git.releaseLease(wt3);
  ok('releaseLease removes file', !fs.existsSync(git.leasePath(wt3)));

  // removeWorktree frees the lease so the path can be re-leased.
  git.removeWorktree(ws, KEY);
  ok('removeWorktree frees lease', !fs.existsSync(git.leasePath(c2.worktree)));

  // not-a-repo case
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bare-'));
  ok('isRepo false on non-repo', git.isRepo(bare) === false);
  ok('listWorktrees [] on non-repo', git.listWorktrees(bare).length === 0);
  ok('createWorktree no-throw on non-repo', git.createWorktree(bare, KEY).head === null);
  fs.rmSync(bare, { recursive: true, force: true });
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
  for (const k of [KEY, 'sess-abc/contend', 'sess-abc/stale']) {
    fs.rmSync(git.worktreePath(ws, k), { recursive: true, force: true });
    fs.rmSync(git.leasePath(git.worktreePath(ws, k)), { force: true });
  }
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
