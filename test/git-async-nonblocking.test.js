#!/usr/bin/env node
'use strict';
// Regression: the daemon must NOT run git on its event-loop thread. A synchronous `git worktree add`
// (~5s on a large/Windows repo) or `git merge` froze EVERY request — /health included — for the
// op's whole duration, which presented as the daemon "wedging" during subconscious assignment-
// prepare / branch_task / the automode judge-merge. The fix: lib/git.js exposes async (execFile)
// variants and the (already-async) route handlers await them, so the loop stays live while git runs.
//
// Test 1 (the contract that fixes the wedge): the /git/worktree route AWAITS an async git primitive,
//         so the event loop is free to service other work (e.g. /health) while the op is in flight.
// Test 2 (correctness): the async variants create/diff/merge a real temp repo just like the sync ones.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const git = require('../lib/git');
const makeGitRoute = require('../routes/git');

let pass = 0;
let fail = 0;
const tests = [];
const test = (label, fn) => tests.push({ label, fn });
const sh = (ws, args) => execFileSync('git', ['-C', ws, ...args], { encoding: 'utf8', windowsHide: true });

test('git/worktree route awaits async git — event loop stays live during the op', async () => {
  // routes/git.js uses the MODULE-level git (required at top), accessed by property at call time, so
  // we monkeypatch the module: a worktree create we control (stays PENDING until released) + an
  // isRepo that passes. `entered` fires the moment the handler is inside the still-pending git op, so
  // the test deterministically observes whether the loop is free WHILE git runs — no timing guesswork.
  let releaseGit;
  let signalEntered;
  const entered = new Promise((r) => { signalEntered = r; });
  const orig = { isRepoAsync: git.isRepoAsync, createWorktreeAsync: git.createWorktreeAsync, createWorktree: git.createWorktree };
  git.isRepoAsync = async () => true;
  git.createWorktreeAsync = () => new Promise((res) => {
    releaseGit = () => res({ branch: 'orch/attempt/sess-x', worktree: '/wt/sess-x', head: 'deadbeef' });
    signalEntered();
  });
  // If the route is ever reverted to the SYNC primitive, it would call this and fail the test loudly.
  git.createWorktree = () => { throw new Error('regression: /git/worktree used the SYNC git.createWorktree'); };

  const captured = {};
  const ctx = {
    send: (res, code, body) => { captured.code = code; captured.body = body; },
    readBody: async () => ({ key: 'sess/x', repo_path: '/repo' }),
    notifyChange: () => {},
    targetOverlay: () => ({ ws: '/ws', ov: { git: {} }, save: () => {} }),
    resolveRepo: () => '/repo',
  };
  const handler = makeGitRoute(ctx);
  const u = new URL('http://127.0.0.1/git/worktree');

  let handlerDone = false;
  try {
    const p = handler('/git/worktree', 'POST', {}, {}, u).then((handled) => { handlerDone = true; return handled; });

    await entered; // handler is now awaiting the pending git op

    // The git op is in flight. Prove the event loop is FREE by running a macrotask (what /health would
    // ride): with the old synchronous git the loop would be frozen here and this would never resolve
    // until git finished. The handler must NOT have completed yet (it is awaiting, not blocking-through).
    let loopServicedWork = false;
    await new Promise((r) => setImmediate(() => { loopServicedWork = true; r(); }));
    assert.equal(loopServicedWork, true, 'event loop serviced other work while the git op was in flight');
    assert.equal(handlerDone, false, 'handler is still awaiting the async git op (not blocked-through)');

    releaseGit();
    const handled = await p;
    assert.equal(handled, true, 'route handled the request');
    assert.equal(handlerDone, true);
    assert.equal(captured.code, 200);
    assert.equal(captured.body.worktree, '/wt/sess-x');
  } finally {
    Object.assign(git, orig);
  }
});

test('async git variants create / diff / merge a real repo (parity with sync)', async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-git-async-')));
  try {
    git.initRepo(ws); // sync setup is fine

    const created = await git.createWorktreeAsync(ws, 'sess/a');
    assert.equal(created.branch, 'orch/attempt/sess-a');
    assert.ok(created.worktree && fs.existsSync(created.worktree), 'worktree dir created');
    assert.ok(created.head, 'worktree has a HEAD');

    // idempotent: a second call returns the existing worktree
    const again = await git.createWorktreeAsync(ws, 'sess/a');
    assert.equal(again.worktree, created.worktree);

    // make a commit on the attempt branch so there is something to diff/merge
    fs.writeFileSync(path.join(created.worktree, 'change.txt'), 'hello async git\n');
    sh(created.worktree, ['add', 'change.txt']);
    sh(created.worktree, ['commit', '-m', 'attempt change']);

    const diff = await git.attemptDiffAsync(ws, 'sess/a', { base: 'HEAD' });
    assert.equal(diff.ok, true);
    assert.ok(diff.diff.includes('change.txt'), 'attemptDiffAsync shows the attempt change');

    const merged = await git.mergeBranchAsync(ws, 'sess/a');
    assert.equal(merged.merged, true, 'mergeBranchAsync merged the attempt');
    assert.ok(merged.head, 'merge produced a head sha');

    const removed = await git.removeWorktreeAsync(ws, 'sess/a');
    assert.equal(removed.removed, true);

    // not-a-repo is tolerated, not thrown
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-git-async-bare-')));
    assert.equal((await git.createWorktreeAsync(bare, 'sess/b')).head, null);
    assert.equal((await git.mergeBranchAsync(bare, 'sess/b')).merged, false);
    fs.rmSync(bare, { recursive: true, force: true });
  } finally {
    try { await git.removeWorktreeAsync(ws, 'sess/a'); } catch {}
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

(async () => {
  for (const { label, fn } of tests) {
    try { await fn(); console.log(`PASS  ${label}`); pass++; }
    catch (err) { console.log(`FAIL  ${label}`); console.error(err && err.stack ? err.stack : err); fail++; }
  }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
