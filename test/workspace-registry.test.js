#!/usr/bin/env node
// Tests for lib/workspace-registry.js — the workspace<->repo resolution foundation.
//   - repoRoot walk-up: .graph vs .git, git-worktree gitdir-FILE case, attempt/feature-worktree exclusion
//   - loadRegistry v1->v2 migration: flat array in, v2 out, .bak written, idempotent re-load
//   - addRepo idempotency + new-workspace creation
//   - repoToWorkspace reverse index (first-writer-wins)
//
// No test framework; run: node test/workspace-registry.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const reg = require('../lib/workspace-registry');

// Load a private copy of the module whose `fs` reports NO markers anywhere (existsSync->false,
// statSync->throws), so repoRoot's walk runs to the filesystem root and returns null deterministically
// regardless of what lives above the OS temp dir on the host. Compiled from the same source file with
// a stubbed `require('fs')`, so it exercises the real loop without touching the host filesystem.
function repoRootNoMarkers(startDir) {
  const Module = require('module');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'workspace-registry.js'), 'utf8');
  const m = new Module('ws-reg-nomarkers', module);
  m.filename = path.join(__dirname, '..', 'lib', 'workspace-registry.js');
  m.paths = Module._nodeModulePaths(path.dirname(m.filename));
  const stubFs = new Proxy(fs, { get(t, k) {
    if (k === 'existsSync') return () => false;
    if (k === 'statSync') return () => { throw new Error('ENOENT'); };
    return t[k];
  }});
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'fs') return stubFs;
    return origLoad.call(this, req, parent, isMain);
  };
  try { m._compile(src, m.filename); } finally { Module._load = origLoad; }
  return m.exports.repoRoot(startDir);
}

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ws-reg-')));
const mk = (...p) => { const d = path.join(SANDBOX, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const touchDir = (parent, name) => { const d = path.join(parent, name); fs.mkdirSync(d, { recursive: true }); return d; };
const touchFile = (parent, name, content = '') => { const f = path.join(parent, name); fs.writeFileSync(f, content); return f; };

try {
  // ── repoRoot: .graph preferred ──────────────────────────────────────────────
  const repoG = mk('repoGraph');
  touchDir(repoG, '.graph');
  const nestedG = mk('repoGraph', 'src', 'deep');
  ok('repoRoot finds .graph from a nested dir', reg.repoRoot(nestedG) === fs.realpathSync(repoG));
  ok('repoRoot at the repo root itself returns it', reg.repoRoot(repoG) === fs.realpathSync(repoG));

  // ── repoRoot: .git directory (ordinary clone, no .graph) ──────────────────────
  const repoGit = mk('repoGit');
  touchDir(repoGit, '.git');
  const nestedGit = mk('repoGit', 'a', 'b');
  ok('repoRoot finds .git DIRECTORY when no .graph', reg.repoRoot(nestedGit) === fs.realpathSync(repoGit));

  // ── repoRoot: .graph preferred over .git when both at same level ──────────────
  const both = mk('repoBoth');
  touchDir(both, '.graph');
  touchDir(both, '.git');
  ok('repoRoot returns dir with .graph even when .git also present', reg.repoRoot(both) === fs.realpathSync(both));

  // ── repoRoot: git-worktree gitdir-FILE under a real repo => excluded, walks up ─
  // Simulate: realRepo has .graph; a worktree dir lives inside it whose .git is a FILE (gitdir
  // pointer) and has NO .graph of its own. repoRoot must SKIP the worktree and resolve to realRepo.
  const realRepo = mk('realRepo');
  touchDir(realRepo, '.graph');
  const worktree = touchDir(realRepo, 'wt-attempt');
  touchFile(worktree, '.git', 'gitdir: /some/where/.git/worktrees/wt-attempt\n');
  ok('repoRoot excludes a gitdir-FILE worktree (no .graph) and walks up to the real repo',
    reg.repoRoot(worktree) === fs.realpathSync(realRepo));
  // A dir nested inside the worktree also resolves up past the worktree to the real repo.
  const inWorktree = touchDir(worktree, 'lib');
  ok('repoRoot from inside a worktree resolves to the real graph-bearing repo',
    reg.repoRoot(inWorktree) === fs.realpathSync(realRepo));

  // ── repoRoot: standalone worktree (gitdir-FILE) is NEVER treated as a repo root ──
  // The gitdir-FILE+no-.graph dir must not register as a repo; repoRoot resolves PAST it. (We assert
  // "not this dir" rather than strict null because the OS tmp tree may have an unrelated .graph
  // ancestor on some machines — the contract under test is the worktree EXCLUSION, not the ancestor.)
  const orphan = mk('orphanArea');
  const orphanWt = touchDir(orphan, 'lonewt');
  touchFile(orphanWt, '.git', 'gitdir: /elsewhere\n');
  ok('repoRoot never returns a gitdir-FILE worktree dir itself (excluded)',
    reg.repoRoot(orphanWt) !== fs.realpathSync(orphanWt));

  // ── repoRoot: a markerless dir is NEVER returned as its own root ────────────────
  const bare = mk('noMarkers', 'x', 'y');
  ok('repoRoot never returns a markerless dir as its own root', reg.repoRoot(bare) !== fs.realpathSync(bare));
  ok('repoRoot returns null on empty input', reg.repoRoot('') === null);
  ok('repoRoot returns null on non-string input', reg.repoRoot(null) === null);

  // True "no marker anywhere up the tree => null". We can't rely on the OS temp ancestry being clean
  // (a stray .graph may exist above tmp on some machines), so exercise the loop's filesystem-root
  // termination against an isolated FS view where NO level has a marker. repoRoot must return null.
  ok('repoRoot returns null when no marker exists up to the fs root',
    repoRootNoMarkers(path.join(SANDBOX, 'noMarkers', 'x', 'y')) === null);

  // ── loadRegistry: missing file => empty v2 ────────────────────────────────────
  const missing = path.join(SANDBOX, 'does-not-exist.json');
  const empty = reg.loadRegistry(missing);
  ok('loadRegistry missing file => { version:2, workspaces:{} }',
    empty.version === 2 && empty.workspaces && Object.keys(empty.workspaces).length === 0);

  // ── loadRegistry: garbage file => empty v2 ─────────────────────────────────────
  const garbage = path.join(SANDBOX, 'garbage.json');
  fs.writeFileSync(garbage, 'this is not json {{{');
  const g = reg.loadRegistry(garbage);
  ok('loadRegistry garbage => empty v2', g.version === 2 && Object.keys(g.workspaces).length === 0);

  // ── loadRegistry: v1 flat array migration ──────────────────────────────────────
  const v1file = path.join(SANDBOX, 'workspaces.json');
  const repoA = '/home/u/projects/alpha';
  const repoB = '/home/u/projects/beta';
  const repoC = '/home/u/other/alpha';   // basename collision with repoA -> must get hash suffix
  const v1arr = [repoA, repoB, repoC];
  fs.writeFileSync(v1file, JSON.stringify(v1arr, null, 2));
  const orig = fs.readFileSync(v1file, 'utf8');

  const migrated = reg.loadRegistry(v1file);
  ok('migration: result is v2', migrated.version === 2);
  ok('migration: keyed by basename for unique names',
    migrated.workspaces.alpha && migrated.workspaces.alpha.repos.includes(repoA));
  ok('migration: beta workspace present', migrated.workspaces.beta && migrated.workspaces.beta.repos.includes(repoB));
  ok('migration: basename collision disambiguated with -<hash> suffix',
    Object.keys(migrated.workspaces).some((k) => k.startsWith('alpha-') && migrated.workspaces[k].repos.includes(repoC)));
  ok('migration: every repo is its own single-repo workspace',
    Object.values(migrated.workspaces).every((w) => w.repos.length === 1));

  // .bak written with the ORIGINAL content, BEFORE the rewrite
  const bak = `${v1file}.bak`;
  ok('migration: .bak written', fs.existsSync(bak));
  ok('migration: .bak holds the original v1 array content', fs.readFileSync(bak, 'utf8') === orig);

  // The file on disk is now v2
  const onDisk = JSON.parse(fs.readFileSync(v1file, 'utf8'));
  ok('migration: file rewritten to v2 on disk', onDisk.version === 2);

  // ── loadRegistry: idempotent re-load (no second migration, no .bak churn) ───────
  const bakMtime = fs.statSync(bak).mtimeMs;
  const reloaded = reg.loadRegistry(v1file);
  ok('idempotent: re-load still v2 with same workspaces',
    reloaded.version === 2 && Object.keys(reloaded.workspaces).length === Object.keys(migrated.workspaces).length);
  ok('idempotent: .bak not rewritten on second load', fs.statSync(bak).mtimeMs === bakMtime);

  // ── allRepos: flat de-duped path list ───────────────────────────────────────────
  const repos = reg.allRepos(migrated);
  ok('allRepos returns a flat array', Array.isArray(repos));
  ok('allRepos contains all three repo paths', repos.includes(repoA) && repos.includes(repoB) && repos.includes(repoC));
  ok('allRepos length is 3 (de-duped)', repos.length === 3);
  ok('allRepos([])-style empty registry => []', reg.allRepos(reg.loadRegistry(missing)).length === 0);

  // ── repoToWorkspace: reverse index ───────────────────────────────────────────────
  const rev = reg.repoToWorkspace(migrated);
  ok('repoToWorkspace is a Map', rev instanceof Map);
  ok('repoToWorkspace maps repoA -> alpha', rev.get(repoA) === 'alpha');
  ok('repoToWorkspace maps repoB -> beta', rev.get(repoB) === 'beta');

  // first-writer-wins on a dup repo across workspaces
  const dupReg = { version: 2, workspaces: { wsX: { repos: ['/r/shared'] }, wsY: { repos: ['/r/shared'] } } };
  ok('repoToWorkspace first-writer-wins on duplicate repo', reg.repoToWorkspace(dupReg).get('/r/shared') === 'wsX');

  // ── addRepo: create new workspace + idempotency ──────────────────────────────────
  const addFile = path.join(SANDBOX, 'add.json');
  let r1 = reg.addRepo(addFile, { workspace: 'proj', repo: '/repos/one' });
  ok('addRepo creates a new workspace', r1.workspaces.proj && r1.workspaces.proj.repos.includes('/repos/one'));
  ok('addRepo persisted to disk', JSON.parse(fs.readFileSync(addFile, 'utf8')).workspaces.proj.repos.includes('/repos/one'));

  let r2 = reg.addRepo(addFile, { workspace: 'proj', repo: '/repos/two' });
  ok('addRepo adds a second repo to the same workspace', r2.workspaces.proj.repos.length === 2);

  let r3 = reg.addRepo(addFile, { workspace: 'proj', repo: '/repos/one' });
  ok('addRepo idempotent: re-adding same repo does not duplicate', r3.workspaces.proj.repos.length === 2);

  let r4 = reg.addRepo(addFile, { workspace: 'second', repo: '/repos/three' });
  ok('addRepo creates an additional named workspace', r4.workspaces.second && r4.workspaces.second.repos.includes('/repos/three'));
  ok('addRepo allRepos sees all members across workspaces', reg.allRepos(r4).length === 3);

  // addRepo validates inputs
  let threw = false;
  try { reg.addRepo(addFile, { workspace: '', repo: '/x' }); } catch { threw = true; }
  ok('addRepo throws on missing workspace', threw);

} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* */ }
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
