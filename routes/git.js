'use strict';
const overlayStore = require('../lib/overlay');
const git = require('../lib/git');

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, readBody, notifyChange, targetOverlay, resolveRepo, now, buildGraph, nodeExistsInGraph } = ctx;

  if (p === '/git/repo' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    if (!nodeExistsInGraph(buildGraph(T.ws), b.key)) {
      send(res, 404, { ok: false, error: `unknown task: ${b.key}` }); return true;
    }
    overlayStore.setRepo(T.ov, b.key, b.repo_path);
    T.save(); notifyChange();
    send(res, 200, { ok: true, key: b.key, repo: T.ov.repos[b.key] || null }); return true;
  }

  if (p === '/git/init' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    const repo = resolveRepo(b.key, b.repo_path, T.ov, T.ws);
    if (!repo) { send(res, 400, { ok: false, error: 'no repo: set a workspace or pass repo_path' }); return true; }
    const r = await git.initRepoAsync(repo);
    notifyChange();
    send(res, 200, { ...r, repo }); return true;
  }

  if (p === '/git/status') {
    const T = targetOverlay(null, u);
    const repo = resolveRepo(u.searchParams.get('key'), u.searchParams.get('repo_path'), T.ov, T.ws);
    if (!repo) { send(res, 200, { isRepo: false }); return true; }
    send(res, 200, { repo, isRepo: await git.isRepoAsync(repo), worktrees: await git.listWorktreesAsync(repo), test_cmd: overlayStore.testCmdFor(T.ov, repo) }); return true;
  }

  if (p === '/git/worktree' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const repo = resolveRepo(b.key, b.repo_path, T.ov, T.ws);
    if (!repo || !(await git.isRepoAsync(repo))) { send(res, 409, { ok: false, error: 'target repo is not a git repo: POST /git/init first (branch_task auto-inits)' }); return true; }
    const info = await git.createWorktreeAsync(repo, b.key, { base: b.base });
    if (info && info.contended) {
      send(res, 409, { ...info, ok: false, repo, error: 'worktree path is currently leased by another creator; retry branch_task' }); return true;
    }
    overlayStore.setGit(T.ov, b.key, info);
    T.save(); notifyChange();
    send(res, 200, { ...info, repo }); return true;
  }

  if (p === '/git/worktree/remove' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const repo = resolveRepo(b.key, b.repo_path, T.ov, T.ws);
    if (repo) await git.removeWorktreeAsync(repo, b.key);
    delete T.ov.git[b.key];
    T.save(); notifyChange();
    send(res, 200, { ok: true }); return true;
  }

  if (p === '/git/merge' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const repo = resolveRepo(b.key, b.repo_path, T.ov, T.ws);
    if (!repo || !(await git.isRepoAsync(repo))) { send(res, 409, { ok: false, error: 'target repo is not a git repo: POST /git/init first (branch_task auto-inits)' }); return true; }
    const result = await git.mergeBranchAsync(repo, b.key, { message: b.message });
    if (result.merged) {
      overlayStore.setGit(T.ov, b.key, { merged: true, merge_sha: result.head || null, merged_at: now() });
      T.save();
    }
    notifyChange();
    send(res, 200, result); return true;
  }

  // ---- feature tier (stay-remote two-tier topology) ------------------------
  // A feature branch orch/feature/<key> + worktree is the integration surface: workers fork attempts
  // off it (branch_task base=<featureBranch>, repo_path=<feature worktree>) and auto-merge back into
  // it (tier-1, cheap). The feature->main merge below is a SEPARATE dispatcher-GATED step (tier-2).
  if (p === '/feature/create' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const repo = resolveRepo(b.key, b.repo_path, T.ov, T.ws);
    if (!repo || !(await git.isRepoAsync(repo))) { send(res, 409, { ok: false, error: 'target repo is not a git repo: POST /git/init first (branch_task auto-inits)' }); return true; }
    const info = await git.createFeatureWorktreeAsync(repo, b.key, { base: b.base });
    if (info && info.contended) {
      send(res, 409, { ...info, ok: false, repo, error: 'feature worktree path is currently leased by another creator; retry create_feature' }); return true;
    }
    overlayStore.setFeature(T.ov, b.key, { feature_branch: info.branch, feature_worktree: info.worktree, base: b.base || 'main' });
    T.save(); notifyChange();
    send(res, 200, { ...info, repo }); return true;
  }

  // GATED tier-2: merge the feature branch into main. Dispatcher decision ONLY — never auto/loop.
  if (p === '/feature/merge' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const repo = resolveRepo(b.key, b.repo_path, T.ov, T.ws);
    if (!repo || !(await git.isRepoAsync(repo))) { send(res, 409, { ok: false, error: 'target repo is not a git repo: POST /git/init first (branch_task auto-inits)' }); return true; }
    const result = await git.mergeFeatureAsync(repo, b.key, { message: b.message });
    if (result.merged) {
      overlayStore.setFeature(T.ov, b.key, { merged: true, merge_sha: result.head || null, merged_at: now() });
      T.save();
    }
    notifyChange();
    send(res, 200, result); return true;
  }

  if (p === '/feature/remove' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const repo = resolveRepo(b.key, b.repo_path, T.ov, T.ws);
    if (repo) await git.removeFeatureWorktreeAsync(repo, b.key);
    if (T.ov.features) delete T.ov.features[b.key];
    T.save(); notifyChange();
    send(res, 200, { ok: true }); return true;
  }

  return false;
};
