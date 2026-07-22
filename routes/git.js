'use strict';
const overlayStore = require('../lib/overlay');
const git = require('../lib/git');
const repoTarget = require('../lib/repo-target');

async function resolveTarget(ctx, key, explicit, T) {
  if (typeof ctx.resolveRepoTarget === 'function') return ctx.resolveRepoTarget(key, explicit, T.ov, T.ws);
  const repo = explicit || (typeof ctx.resolveRepo === 'function' && ctx.resolveRepo(key, explicit, T.ov, T.ws));
  if (!repo) return { ok: false, status: 400, error: 'repo_path or workspace required' };
  const identity = await repoTarget.identityFor(repo, ctx.git || git);
  return {
    ok: true,
    repo: identity.repo_path,
    target: {
      provenance: explicit ? 'explicit' : (key && T.ov.repos && T.ov.repos[key] ? 'task' : 'workspace'),
      ...identity,
    },
  };
}

async function verifyStoredWorktree(target, worktree, gitImpl) {
  return repoTarget.verifyWorktreeTarget(target, worktree, gitImpl || git);
}

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, readBody, notifyChange, targetOverlay, now, buildGraph, nodeExistsInGraph } = ctx;

  if (p === '/git/repo' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    if (!nodeExistsInGraph(buildGraph(T.ws), b.key)) {
      send(res, 404, { ok: false, error: `unknown task: ${b.key}` }); return true;
    }
    let target = null;
    let repo = null;
    if (b.repo_path) {
      const resolved = await resolveTarget(ctx, b.key, b.repo_path, T);
      if (!resolved.ok) { send(res, resolved.status || 409, resolved); return true; }
      repo = resolved.repo;
      target = resolved.target;
    }
    overlayStore.setRepo(T.ov, b.key, repo);
    T.save(); notifyChange();
    send(res, 200, { ok: true, key: b.key, repo: T.ov.repos[b.key] || null, target }); return true;
  }

  if (p === '/git/init' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    const resolved = await resolveTarget(ctx, b.key, b.repo_path, T);
    if (!resolved.ok) { send(res, resolved.status || 409, resolved); return true; }
    const repo = resolved.repo;
    const r = await git.initRepoAsync(repo);
    const identity = await repoTarget.identityFor(repo, git);
    const target = { ...resolved.target, ...identity };
    notifyChange();
    send(res, 200, { ...r, repo, target }); return true;
  }

  if (p === '/git/status') {
    const T = targetOverlay(null, u);
    const resolved = await resolveTarget(ctx, u.searchParams.get('key'), u.searchParams.get('repo_path'), T);
    if (!resolved.ok) { send(res, resolved.status || 409, resolved); return true; }
    const repo = resolved.repo;
    send(res, 200, { repo, target: resolved.target, isRepo: await git.isRepoAsync(repo), worktrees: await git.listWorktreesAsync(repo), test_cmd: overlayStore.testCmdFor(T.ov, repo) }); return true;
  }

  if (p === '/git/worktree' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const resolved = await resolveTarget(ctx, b.key, b.repo_path, T);
    if (!resolved.ok) { send(res, resolved.status || 409, resolved); return true; }
    const repo = resolved.repo;
    if (!repo || !(await git.isRepoAsync(repo))) { send(res, 409, { ok: false, error: 'target repo is not a git repo: POST /git/init first (branch_task auto-inits)' }); return true; }
    const info = await git.createWorktreeAsync(repo, b.key, { base: b.base });
    if (info && info.contended) {
      send(res, 409, { ...info, ok: false, repo, error: 'worktree path is currently leased by another creator; retry branch_task' }); return true;
    }
    if (info && info.error) { send(res, 409, { ...info, ok: false, repo, target: resolved.target }); return true; }
    overlayStore.setGit(T.ov, b.key, { ...info, target: resolved.target });
    T.save(); notifyChange();
    send(res, 200, { ...info, repo, target: resolved.target }); return true;
  }

  if (p === '/git/worktree/remove' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const resolved = await resolveTarget(ctx, b.key, b.repo_path, T);
    if (!resolved.ok) { send(res, resolved.status || 409, resolved); return true; }
    const repo = resolved.repo;
    const stored = T.ov.git && T.ov.git[b.key];
    if (stored && stored.worktree) {
      const verification = await verifyStoredWorktree(resolved.target, stored.worktree, git);
      if (!verification.ok) {
        send(res, 409, { ok: false, code: 'worktree_target_mismatch', repo, worktree: stored.worktree, error: verification.error, verification }); return true;
      }
    }
    if (repo) await git.removeWorktreeAsync(repo, b.key);
    delete T.ov.git[b.key];
    T.save(); notifyChange();
    send(res, 200, { ok: true }); return true;
  }

  if (p === '/git/merge' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const resolved = await resolveTarget(ctx, b.key, b.repo_path, T);
    if (!resolved.ok) { send(res, resolved.status || 409, resolved); return true; }
    const repo = resolved.repo;
    if (!repo || !(await git.isRepoAsync(repo))) { send(res, 409, { ok: false, error: 'target repo is not a git repo: POST /git/init first (branch_task auto-inits)' }); return true; }
    const stored = T.ov.git && T.ov.git[b.key];
    if (stored && stored.worktree) {
      const verification = await verifyStoredWorktree(resolved.target, stored.worktree, git);
      if (!verification.ok) {
        send(res, 409, { ok: false, code: 'worktree_target_mismatch', repo, worktree: stored.worktree, error: verification.error, verification }); return true;
      }
    }
    const result = await git.mergeBranchAsync(repo, b.key, { message: b.message });
    if (result.merged) {
      const mergedAt = now();
      overlayStore.setGit(T.ov, b.key, { merged: true, merge_sha: result.head || null, merged_at: mergedAt });
      overlayStore.setReviewLifecycle(T.ov, b.key, { merge_state: 'merged', merge_sha: result.head || null, merged_at: mergedAt });
      T.save();
    } else if (result.conflict) {
      const files = Array.isArray(result.files) && result.files.length ? result.files.join(', ') : 'unknown files';
      overlayStore.setReviewLifecycle(T.ov, b.key, {
        merge_state: 'conflict',
        review_reason: `Merge conflict in ${files}`,
        review_note: `Merge conflict in ${files}`,
      });
      T.save();
    } else if (result.error || result.reason) {
      overlayStore.setReviewLifecycle(T.ov, b.key, { merge_state: 'failed' });
      T.save();
    }
    notifyChange();
    send(res, 200, { ...result, repo, target: resolved.target }); return true;
  }

  // ---- feature tier (stay-remote two-tier topology) ------------------------
  // A feature branch orch/feature/<key> + worktree is the integration surface: workers fork attempts
  // off it (branch_task base=<featureBranch>, repo_path=<feature worktree>) and auto-merge back into
  // it (tier-1, cheap). The feature->main merge below is a SEPARATE dispatcher-GATED step (tier-2).
  if (p === '/feature/create' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const resolved = await resolveTarget(ctx, b.key, b.repo_path, T);
    if (!resolved.ok) { send(res, resolved.status || 409, resolved); return true; }
    const repo = resolved.repo;
    if (!repo || !(await git.isRepoAsync(repo))) { send(res, 409, { ok: false, error: 'target repo is not a git repo: POST /git/init first (branch_task auto-inits)' }); return true; }
    const info = await git.createFeatureWorktreeAsync(repo, b.key, { base: b.base });
    if (info && info.contended) {
      send(res, 409, { ...info, ok: false, repo, error: 'feature worktree path is currently leased by another creator; retry create_feature' }); return true;
    }
    if (info && info.error) { send(res, 409, { ...info, ok: false, repo, target: resolved.target }); return true; }
    overlayStore.setFeature(T.ov, b.key, { feature_branch: info.branch, feature_worktree: info.worktree, base: b.base || 'main', target: resolved.target });
    T.save(); notifyChange();
    send(res, 200, { ...info, repo, target: resolved.target }); return true;
  }

  // GATED tier-2: merge the feature branch into main. Dispatcher decision ONLY — never auto/loop.
  if (p === '/feature/merge' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const resolved = await resolveTarget(ctx, b.key, b.repo_path, T);
    if (!resolved.ok) { send(res, resolved.status || 409, resolved); return true; }
    const repo = resolved.repo;
    if (!repo || !(await git.isRepoAsync(repo))) { send(res, 409, { ok: false, error: 'target repo is not a git repo: POST /git/init first (branch_task auto-inits)' }); return true; }
    const feature = T.ov.features && T.ov.features[b.key];
    if (feature && feature.feature_worktree) {
      const verification = await verifyStoredWorktree(resolved.target, feature.feature_worktree, git);
      if (!verification.ok) {
        send(res, 409, { ok: false, code: 'feature_worktree_target_mismatch', repo, worktree: feature.feature_worktree, error: verification.error, verification }); return true;
      }
    }
    const result = await git.mergeFeatureAsync(repo, b.key, { message: b.message });
    if (result.merged) {
      overlayStore.setFeature(T.ov, b.key, { merged: true, merge_sha: result.head || null, merged_at: now() });
      T.save();
    }
    notifyChange();
    send(res, 200, { ...result, repo, target: resolved.target }); return true;
  }

  if (p === '/feature/remove' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!b.key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const resolved = await resolveTarget(ctx, b.key, b.repo_path, T);
    if (!resolved.ok) { send(res, resolved.status || 409, resolved); return true; }
    const repo = resolved.repo;
    const feature = T.ov.features && T.ov.features[b.key];
    if (feature && feature.feature_worktree) {
      const verification = await verifyStoredWorktree(resolved.target, feature.feature_worktree, git);
      if (!verification.ok) {
        send(res, 409, { ok: false, code: 'feature_worktree_target_mismatch', repo, worktree: feature.feature_worktree, error: verification.error, verification }); return true;
      }
    }
    if (repo) await git.removeFeatureWorktreeAsync(repo, b.key);
    if (T.ov.features) delete T.ov.features[b.key];
    T.save(); notifyChange();
    send(res, 200, { ok: true }); return true;
  }

  return false;
};
