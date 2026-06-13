'use strict';
const overlayStore = require('../lib/overlay');
const git = require('../lib/git');

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, readBody, notifyChange, targetOverlay, resolveRepo, now } = ctx;

  if (p === '/git/repo' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    overlayStore.setRepo(T.ov, b.key, b.repo_path);
    T.save(); notifyChange();
    send(res, 200, { ok: true, key: b.key, repo: T.ov.repos[b.key] || null }); return true;
  }

  if (p === '/git/init' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    const repo = resolveRepo(b.key, b.repo_path, T.ov);
    if (!repo) { send(res, 400, { ok: false, error: 'no repo: set a workspace or pass repo_path' }); return true; }
    const r = git.initRepo(repo);
    notifyChange();
    send(res, 200, { ...r, repo }); return true;
  }

  if (p === '/git/status') {
    const T = targetOverlay(null, u);
    const repo = resolveRepo(u.searchParams.get('key'), u.searchParams.get('repo_path'), T.ov, T.ws);
    if (!repo) { send(res, 200, { isRepo: false }); return true; }
    send(res, 200, { repo, isRepo: git.isRepo(repo), worktrees: git.listWorktrees(repo), test_cmd: overlayStore.testCmdFor(T.ov, repo) }); return true;
  }

  if (p === '/git/worktree' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const repo = resolveRepo(b.key, b.repo_path, T.ov);
    if (!repo || !git.isRepo(repo)) { send(res, 409, { ok: false, error: 'target repo is not a git repo: POST /git/init first (branch_task auto-inits)' }); return true; }
    const info = git.createWorktree(repo, b.key, { base: b.base });
    overlayStore.setGit(T.ov, b.key, info);
    T.save(); notifyChange();
    send(res, 200, { ...info, repo }); return true;
  }

  if (p === '/git/worktree/remove' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const repo = resolveRepo(b.key, b.repo_path, T.ov);
    if (repo) git.removeWorktree(repo, b.key);
    delete T.ov.git[b.key];
    T.save(); notifyChange();
    send(res, 200, { ok: true }); return true;
  }

  if (p === '/git/merge' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const repo = resolveRepo(b.key, b.repo_path, T.ov);
    if (!repo || !git.isRepo(repo)) { send(res, 409, { ok: false, error: 'target repo is not a git repo: POST /git/init first (branch_task auto-inits)' }); return true; }
    const result = git.mergeBranch(repo, b.key, { message: b.message });
    if (result.merged) {
      overlayStore.setGit(T.ov, b.key, { merged: true, merge_sha: result.head || null, merged_at: now() });
      T.save();
    }
    notifyChange();
    send(res, 200, result); return true;
  }

  return false;
};
