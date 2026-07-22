#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-git-route-target-')));
process.env.CLAUDE_PLUGIN_DATA = sandbox;
const git = require('../lib/git');
const overlayStore = require('../lib/overlay');
const repoTarget = require('../lib/repo-target');
const routeFactory = require('../routes/git');

function makeCtx(workspace, ov, resolveRepoTarget) {
  let body = null;
  return {
    git,
    resolveRepoTarget,
    resolveRepo: (key, explicit) => explicit || ov.repos[key] || workspace,
    targetOverlay: () => ({ ws: workspace, ov, save() {} }),
    readBody: async () => body,
    setBody: (value) => { body = value; },
    send: (res, status, payload) => { res.status = status; res.body = payload; },
    notifyChange() {},
    now: () => new Date().toISOString(),
    buildGraph: () => ({ tasks: [{ id: 'task/target' }] }),
    nodeExistsInGraph: () => true,
  };
}

async function callRoute(ctx, pathname, body) {
  ctx.setBody(body);
  const res = {};
  const u = new URL(`http://127.0.0.1${pathname}`);
  const handled = await routeFactory(ctx)(u.pathname, 'POST', {}, res, u);
  assert.equal(handled, true);
  return res;
}

test('git worktree route rejects ambiguous fallback before calling Git', async () => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-git-route-ws-')));
  const ov = overlayStore.EMPTY();
  const ctx = makeCtx(workspace, ov, async () => ({
    ok: false,
    status: 409,
    code: 'ambiguous_repo_target',
    error: 'pass repo_path',
  }));

  const res = await callRoute(ctx, '/git/worktree', { key: 'task/target', workspace });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ambiguous_repo_target');
  assert.equal(ov.git['task/target'], undefined);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('attempt and feature routes reject worktrees from another Git common-dir', async () => {
  const repoA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-git-route-a-')));
  const repoB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-git-route-b-')));
  git.initRepo(repoA);
  git.initRepo(repoB);
  const attempt = git.createWorktree(repoA, 'task/target');
  const feature = git.createFeatureWorktree(repoA, 'task/feature');
  const identity = await repoTarget.identityFor(repoB, git);
  const target = { provenance: 'task', ...identity };
  const ov = overlayStore.EMPTY();
  overlayStore.setRepo(ov, 'task/target', repoB);
  overlayStore.setRepo(ov, 'task/feature', repoB);
  overlayStore.setGit(ov, 'task/target', attempt);
  overlayStore.setFeature(ov, 'task/feature', { feature_worktree: feature.worktree, feature_branch: feature.branch });
  const ctx = makeCtx(repoB, ov, async () => ({ ok: true, repo: repoB, target }));

  const attemptRes = await callRoute(ctx, '/git/merge', { key: 'task/target', workspace: repoB });
  assert.equal(attemptRes.status, 409);
  assert.equal(attemptRes.body.code, 'worktree_target_mismatch');

  const featureRes = await callRoute(ctx, '/feature/merge', { key: 'task/feature', workspace: repoB });
  assert.equal(featureRes.status, 409);
  assert.equal(featureRes.body.code, 'feature_worktree_target_mismatch');

  git.removeWorktree(repoA, 'task/target');
  git.removeFeatureWorktree(repoA, 'task/feature');
  fs.rmSync(repoA, { recursive: true, force: true });
  fs.rmSync(repoB, { recursive: true, force: true });
});

test.after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});
