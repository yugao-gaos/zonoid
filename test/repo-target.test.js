#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-repo-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const git = require('../lib/git');
const overlay = require('../lib/overlay');
const repoTarget = require('../lib/repo-target');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ws-repo-')));
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-target-repo-')));
const KEY = 'sess-xyz/3';
const COLLISION_KEY = 'sess-xyz/collision';

async function main() {
  const ov = overlay.EMPTY();
  git.initRepo(workspace);
  git.initRepo(repo);

  const multiRegistry = {
    version: 2,
    workspaces: { product: { repos: [workspace, repo] } },
  };
  const singleRegistry = {
    version: 2,
    workspaces: { product: { repos: [workspace] } },
  };

  const ambiguous = await repoTarget.resolveRepoTarget({ key: KEY, overlay: ov, graphRepo: workspace, registry: multiRegistry, git });
  ok('multi-repo graph identity is never reused as a Git target', ambiguous.ok === false && ambiguous.code === 'repo_target_required');
  ok('missing-target error preserves graph repo context', ambiguous.graph_repo === workspace);

  const noFallback = await repoTarget.resolveRepoTarget({ key: KEY, overlay: ov, graphRepo: workspace, registry: singleRegistry, git });
  ok('single-repo convenience is not inferred by the daemon', noFallback.ok === false && noFallback.code === 'repo_target_required');
  ok('missing target names canonical and deprecated fields', /target_repo/.test(noFallback.error) && /repo_path/.test(noFallback.error));

  overlay.setRepo(ov, KEY, repo);
  const stored = await repoTarget.resolveRepoTarget({ key: KEY, overlay: ov, graphRepo: workspace, registry: multiRegistry, git });
  ok('stored task repo supplies the Git target', stored.ok === true && stored.repo === repo && stored.target.provenance === 'task');

  const explicit = await repoTarget.resolveRepoTarget({ key: KEY, targetRepo: workspace, overlay: ov, graphRepo: workspace, registry: multiRegistry, git });
  ok('explicit target_repo beats stored task repo', explicit.ok === true && explicit.repo === workspace && explicit.target.provenance === 'explicit');
  ok('canonical target identity is exposed with repo_path alias', explicit.target.target_repo === workspace && explicit.target.repo_path === workspace);

  overlay.save(workspace, ov);
  ok('stored repo path survives overlay save/load', overlay.load(workspace).repos[KEY] === repo);

  const created = git.createWorktree(repo, KEY);
  ok('worktree created for selected target repo', fs.existsSync(created.worktree));
  ok('worktree path remains keyed by the selected operation path', created.worktree !== git.worktreePath(workspace, KEY));
  const verified = git.verifyWorktreeTarget(repo, created.worktree);
  ok('attempt worktree shares the selected repo common-dir', verified.ok === true && verified.target.git_common_dir === verified.worktree.git_common_dir);
  ok('same worktree is rejected for a different target repo', git.verifyWorktreeTarget(workspace, created.worktree).ok === false);
  git.removeWorktree(repo, KEY);

  const collisionPath = git.worktreePath(repo, COLLISION_KEY);
  fs.mkdirSync(path.dirname(collisionPath), { recursive: true });
  execFileSync('git', ['-C', workspace, 'worktree', 'add', '-b', 'wrong-collision', collisionPath], { stdio: 'ignore' });
  const collision = git.createWorktree(repo, COLLISION_KEY);
  ok('foreign checkout at deterministic path is rejected before creation', collision.target_mismatch === true);
  ok('foreign checkout is left in place', fs.existsSync(collisionPath));
  execFileSync('git', ['-C', workspace, 'worktree', 'remove', '--force', collisionPath], { stdio: 'ignore' });
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  fail++;
}).finally(() => {
  for (const dir of [workspace, repo, SANDBOX]) fs.rmSync(dir, { recursive: true, force: true });
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
});
