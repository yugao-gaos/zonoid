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

// Load a private copy of the module whose `os` reports a STUBBED tmpdir/homedir (so we can exercise
// the container-root guard against real on-disk markers we control), while `fs` stays REAL. Used to
// prove repoRoot never adopts an incidental `.graph`/`.git` sitting AT a container root.
function repoRootWithContainers(startDir, { tmpdir, homedir }) {
  const Module = require('module');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'workspace-registry.js'), 'utf8');
  const m = new Module('ws-reg-containers', module);
  m.filename = path.join(__dirname, '..', 'lib', 'workspace-registry.js');
  m.paths = Module._nodeModulePaths(path.dirname(m.filename));
  const realOs = require('os');
  const stubOs = new Proxy(realOs, { get(t, k) {
    if (k === 'tmpdir') return () => tmpdir;
    if (k === 'homedir') return () => homedir;
    return t[k];
  }});
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'os') return stubOs;
    return origLoad.call(this, req, parent, isMain);
  };
  try { m._compile(src, m.filename); } finally { Module._load = origLoad; }
  return m.exports.repoRoot(startDir);
}

function workspaceRegistryWithFs(stubFs) {
  const Module = require('module');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'workspace-registry.js'), 'utf8');
  const m = new Module('ws-reg-stub-fs', module);
  m.filename = path.join(__dirname, '..', 'lib', 'workspace-registry.js');
  m.paths = Module._nodeModulePaths(path.dirname(m.filename));
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'fs') return stubFs;
    return origLoad.call(this, req, parent, isMain);
  };
  try { m._compile(src, m.filename); } finally { Module._load = origLoad; }
  return m.exports;
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
const linkWorktree = (primaryRepo, worktreeRoot, name) => {
  const gitRoot = touchDir(primaryRepo, '.git');
  const gitdir = touchDir(touchDir(gitRoot, 'worktrees'), name);
  touchFile(worktreeRoot, '.git', `gitdir: ${gitdir}\n`);
  touchFile(gitdir, 'commondir', '../..\n');
  return gitdir;
};

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
  linkWorktree(realRepo, worktree, 'wt-attempt');
  ok('repoRoot excludes a gitdir-FILE worktree (no .graph) and walks up to the real repo',
    reg.repoRoot(worktree) === fs.realpathSync(realRepo));
  // A dir nested inside the worktree also resolves up past the worktree to the real repo.
  const inWorktree = touchDir(worktree, 'lib');
  ok('repoRoot from inside a worktree resolves to the real graph-bearing repo',
    reg.repoRoot(inWorktree) === fs.realpathSync(realRepo));

  // A linked worktree can contain `.graph` because graph history is tracked. Its `.git` FILE must
  // take precedence over that copied marker: resolve through gitdir/commondir to the primary
  // checkout instead of registering the disposable worktree as a second graph repo.
  const linkedPrimary = mk('linkedPrimary');
  touchDir(linkedPrimary, '.graph');
  const linkedGitDir = mk('linkedPrimary', '.git', 'worktrees', 'tracked-graph');
  touchFile(linkedGitDir, 'commondir', '../..\n');
  const linkedWorktree = mk('external-worktrees', 'tracked-graph');
  touchDir(linkedWorktree, '.graph');
  touchFile(linkedWorktree, '.git', `gitdir: ${linkedGitDir}\n`);
  ok('repoRoot maps a linked worktree with tracked .graph to its primary checkout',
    reg.repoRoot(linkedWorktree) === fs.realpathSync(linkedPrimary));
  ok('activeRepoRoot maps a registered linked worktree to its primary checkout',
    reg.activeRepoRoot(linkedWorktree) === fs.realpathSync(linkedPrimary));
  const nestedLinked = touchDir(linkedWorktree, 'src');
  ok('repoRoot maps a nested path in a tracked-graph worktree to its primary checkout',
    reg.repoRoot(nestedLinked) === fs.realpathSync(linkedPrimary));

  // A valid gitdir file without `commondir` is a standalone/nested repository, not a linked
  // worktree. It must remain distinct from its containing graph repo.
  const nestedHost = mk('nested-host');
  touchDir(nestedHost, '.graph');
  const nestedRepo = touchDir(nestedHost, 'vendor-submodule');
  const nestedGitDir = mk('nested-host', '.git', 'modules', 'vendor-submodule');
  touchFile(nestedRepo, '.git', `gitdir: ${nestedGitDir}\n`);
  ok('repoRoot keeps a nested gitdir repository without commondir distinct',
    reg.repoRoot(nestedRepo) === fs.realpathSync(nestedRepo));
  ok('repoRoot keeps paths inside a nested gitdir repository distinct',
    reg.repoRoot(touchDir(nestedRepo, 'pkg')) === fs.realpathSync(nestedRepo));

  // A separate-git-dir primary cannot be inferred from `<commonDir>/..`; use the registered repo
  // list to match the shared common-dir deterministically.
  const separatePrimary = mk('separate-primary');
  const separateCommon = mk('separate-common');
  touchFile(separatePrimary, '.git', `gitdir: ${separateCommon}\n`);
  const separateWt = mk('external-worktrees', 'separate-common');
  const separateWtGit = mk('separate-common', 'worktrees', 'linked');
  touchFile(separateWtGit, 'commondir', '../..\n');
  touchFile(separateWt, '.git', `gitdir: ${separateWtGit}\n`);
  ok('repoRoot uses registered repos to resolve a separate-git-dir linked worktree',
    reg.repoRoot(separateWt, { registeredRepos: [separatePrimary] }) === fs.realpathSync(separatePrimary));

  // ── repoRoot: malformed gitdir-FILE is NEVER treated as a repo root ────────────
  // A malformed `.git` file must not register as a repo or borrow a neighboring `.graph`.
  const orphan = mk('orphanArea');
  const orphanWt = touchDir(orphan, 'lonewt');
  touchFile(orphanWt, '.git', 'not a gitdir pointer\n');
  ok('repoRoot never returns a malformed gitdir-FILE directory itself',
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

  // ── repoRoot: container-root guard (hoisted from routes/meta.js, note note-mqj20ekamwy) ──────
  // An incidental `.graph`/`.git` sitting AT a container root (system temp / home / fs root) must
  // NEVER be adopted as a repo root — otherwise a fresh top-level workspace dir (or a hooks/CLI cwd)
  // nested under temp would be silently re-homed onto a stray ancestor marker. We stub os.tmpdir/
  // os.homedir to dirs we control and give each an incidental `.graph`, then assert repoRoot walking
  // up from a markerless child does NOT return the container dir.
  {
    // (1) tmpdir as container: child under a stubbed-tmpdir that itself has an incidental .graph.
    const fakeTmp = mk('containers', 'fakeTmp');
    touchDir(fakeTmp, '.graph');                       // incidental marker AT the container root
    const childUnderTmp = mk('containers', 'fakeTmp', 'proj', 'src');  // markerless descendant
    ok('container guard: incidental .graph AT stubbed tmpdir is NOT adopted',
      repoRootWithContainers(childUnderTmp, { tmpdir: fs.realpathSync(fakeTmp), homedir: path.join(SANDBOX, 'no-home') }) !== fs.realpathSync(fakeTmp));

    // (2) homedir as container: same, but the incidental marker is a .git DIRECTORY at home.
    const fakeHome = mk('containers', 'fakeHome');
    touchDir(fakeHome, '.git');
    const childUnderHome = mk('containers', 'fakeHome', 'work', 'a');
    ok('container guard: incidental .git AT stubbed homedir is NOT adopted',
      repoRootWithContainers(childUnderHome, { tmpdir: path.join(SANDBOX, 'no-tmp'), homedir: fs.realpathSync(fakeHome) }) !== fs.realpathSync(fakeHome));

    // (2b) tmpdir may be reported through a symlink (/var) while callers pass realpaths
    // (/private/var). The guard must compare realpaths so the container is still excluded.
    const realTmp = mk('containers', 'realTmp');
    const linkedTmp = path.join(SANDBOX, 'containers', 'linkedTmp');
    try { fs.symlinkSync(realTmp, linkedTmp, 'dir'); } catch { /* symlinks may be unavailable */ }
    if (fs.existsSync(linkedTmp)) {
      touchDir(realTmp, '.graph');
      const childUnderRealTmp = mk('containers', 'realTmp', 'fresh-workspace');
      ok('container guard: symlinked tmpdir and realpathed child still do NOT adopt tmp root',
        repoRootWithContainers(childUnderRealTmp, { tmpdir: linkedTmp, homedir: path.join(SANDBOX, 'no-home-2') }) !== fs.realpathSync(realTmp));
    }

    // (3) POSITIVE control: a REAL repo NESTED BELOW the container (not AT it) is still adopted —
    // the guard excludes only the container dir itself, never its legitimate sub-repos.
    const realUnderTmp = mk('containers', 'fakeTmp2', 'realproj');
    touchDir(realUnderTmp, '.graph');
    const deepInReal = mk('containers', 'fakeTmp2', 'realproj', 'lib', 'x');
    ok('container guard: a real .graph repo NESTED below the container IS still adopted',
      repoRootWithContainers(deepInReal, { tmpdir: fs.realpathSync(mk('containers', 'fakeTmp2')), homedir: path.join(SANDBOX, 'no-home') }) === fs.realpathSync(realUnderTmp));
  }

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

  // A pre-v2 absolute-path workspace key may coexist with a later human name. Keep both entries in
  // history, but expose the human name as the canonical reverse lookup even when legacy was first.
  const legacyAndNamed = { version: 2, workspaces: {
    '/r/shared': { repos: ['/r/shared'] },
    product: { repos: ['/r/shared'] },
  } };
  const preferred = reg.repoToWorkspace(legacyAndNamed);
  ok('repoToWorkspace prefers a human workspace ID over a duplicate absolute-path key',
    preferred.get('/r/shared') === 'product');
  ok('repoToWorkspace preference does not delete legacy registry history',
    Object.prototype.hasOwnProperty.call(legacyAndNamed.workspaces, '/r/shared'));

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

  // Deterministic stale-owner recovery: age the lock explicitly rather than racing a timeout.
  const staleLock = `${addFile}.lock`;
  fs.writeFileSync(staleLock, JSON.stringify({ pid: process.pid, owner: 'stale-test-owner', at: 1 }));
  fs.utimesSync(staleLock, new Date(0), new Date(0));
  const recovered = reg.addRepo(addFile, { workspace: 'second', repo: '/repos/four' }, { staleMs: 1, waitMs: 1000 });
  ok('addRepo reclaims an explicitly stale live-owner lock', recovered.workspaces.second.repos.includes('/repos/four'));
  ok('addRepo removes its replacement lock after stale-owner recovery', !fs.existsSync(staleLock));

  // Empty/truncated/malformed locks can be the brief create-before-owner-write window. A fresh one
  // must remain untouched, while an unchanged sufficiently stale one is safe to recover.
  for (const [label, contents] of [['empty', ''], ['truncated', '{"pid":'], ['malformed', '{}']]) {
    const malformedFile = path.join(SANDBOX, `malformed-${label}.json`);
    const malformedLock = `${malformedFile}.lock`;
    fs.writeFileSync(malformedLock, contents);
    fs.utimesSync(malformedLock, new Date(0), new Date(0));
    const value = reg.addRepo(malformedFile, { workspace: 'recovered', repo: `/repos/${label}` },
      { staleMs: 1, waitMs: 500 });
    ok(`addRepo reclaims an unchanged stale ${label} lock`,
      value.workspaces.recovered.repos.includes(`/repos/${label}`));
    ok(`addRepo releases its owner lock after stale ${label} recovery`, !fs.existsSync(malformedLock));
  }

  const freshMalformedFile = path.join(SANDBOX, 'fresh-malformed.json');
  const freshMalformedLock = `${freshMalformedFile}.lock`;
  fs.writeFileSync(freshMalformedLock, '{"pid":');
  let freshMalformedTimedOut = false;
  try {
    reg.addRepo(freshMalformedFile, { workspace: 'blocked', repo: '/repos/blocked' },
      { staleMs: 60000, waitMs: 35 });
  } catch (err) { freshMalformedTimedOut = /timed out waiting/.test(String(err && err.message)); }
  ok('addRepo never reclaims a fresh truncated lock',
    freshMalformedTimedOut && fs.readFileSync(freshMalformedLock, 'utf8') === '{"pid":');
  fs.unlinkSync(freshMalformedLock);

  const liveToMalformedFile = path.join(SANDBOX, 'live-to-malformed.json');
  const liveToMalformedLock = `${liveToMalformedFile}.lock`;
  fs.writeFileSync(liveToMalformedLock,
    JSON.stringify({ pid: process.pid, owner: 'live-before-corruption', at: Date.now() }));
  fs.writeFileSync(liveToMalformedLock, '{"pid":');
  let liveToMalformedTimedOut = false;
  try {
    reg.addRepo(liveToMalformedFile, { workspace: 'blocked', repo: '/repos/live-corrupt' },
      { staleMs: 60000, waitMs: 35 });
  } catch (err) { liveToMalformedTimedOut = /timed out waiting/.test(String(err && err.message)); }
  ok('a live lock that becomes malformed is protected while fresh',
    liveToMalformedTimedOut && fs.readFileSync(liveToMalformedLock, 'utf8') === '{"pid":');
  fs.utimesSync(liveToMalformedLock, new Date(0), new Date(0));
  const corruptRecovered = reg.addRepo(liveToMalformedFile,
    { workspace: 'recovered', repo: '/repos/live-corrupt' }, { staleMs: 1, waitMs: 500 });
  ok('the unchanged live-to-malformed lock becomes recoverable only after staleness',
    corruptRecovered.workspaces.recovered.repos.includes('/repos/live-corrupt'));

  const deadOwnerFile = path.join(SANDBOX, 'dead-owner.json');
  const deadOwnerLock = `${deadOwnerFile}.lock`;
  fs.writeFileSync(deadOwnerLock, JSON.stringify({ pid: 2147483647, owner: 'dead-owner', at: Date.now() }));
  const deadRecovered = reg.addRepo(deadOwnerFile, { workspace: 'recovered', repo: '/repos/dead' },
    { staleMs: 60000, waitMs: 500 });
  ok('addRepo reclaims a well-formed lock whose owner process is dead',
    deadRecovered.workspaces.recovered.repos.includes('/repos/dead'));

  const liveOwnerFile = path.join(SANDBOX, 'live-owner.json');
  const liveOwnerLock = `${liveOwnerFile}.lock`;
  const liveOwnerBytes = JSON.stringify({ pid: process.pid, owner: 'live-owner', at: Date.now() });
  fs.writeFileSync(liveOwnerLock, liveOwnerBytes);
  let liveOwnerTimedOut = false;
  try {
    reg.addRepo(liveOwnerFile, { workspace: 'blocked', repo: '/repos/live' },
      { staleMs: 60000, waitMs: 35 });
  } catch (err) { liveOwnerTimedOut = /timed out waiting/.test(String(err && err.message)); }
  ok('addRepo leaves a fresh live-owner lock intact',
    liveOwnerTimedOut && fs.readFileSync(liveOwnerLock, 'utf8') === liveOwnerBytes);
  fs.unlinkSync(liveOwnerLock);

  // Deterministically replace a stale malformed incumbent between its first snapshot and reclaim
  // check. The changed inode/content must protect the fresh live lock from the old recovery pass.
  const replaceFile = path.join(SANDBOX, 'replaced-lock.json');
  const replaceLock = `${replaceFile}.lock`;
  fs.writeFileSync(replaceLock, '');
  fs.utimesSync(replaceLock, new Date(0), new Date(0));
  const replacementBytes = JSON.stringify({ pid: process.pid, owner: 'replacement-live', at: Date.now() });
  let incumbentFd = null;
  let replaced = false;
  const swappingFs = new Proxy(fs, { get(target, key) {
    if (key === 'openSync') return (file, flags, ...args) => {
      const opened = target.openSync(file, flags, ...args);
      if (file === replaceLock && flags === 'r') incumbentFd = opened;
      return opened;
    };
    if (key === 'readFileSync') return (file, ...args) => {
      const value = target.readFileSync(file, ...args);
      if (!replaced && file === incumbentFd) {
        replaced = true;
        target.unlinkSync(replaceLock);
        target.writeFileSync(replaceLock, replacementBytes);
      }
      return value;
    };
    return target[key];
  }});
  let replacementTimedOut = false;
  try {
    workspaceRegistryWithFs(swappingFs).addRepo(replaceFile,
      { workspace: 'blocked', repo: '/repos/replaced' }, { staleMs: 60000, waitMs: 35 });
  } catch (err) { replacementTimedOut = /timed out waiting/.test(String(err && err.message)); }
  ok('stale malformed recovery never removes a replaced live lock',
    replaced && replacementTimedOut && fs.readFileSync(replaceLock, 'utf8') === replacementBytes);
  if (fs.existsSync(replaceLock)) fs.unlinkSync(replaceLock);

  const releaseFile = path.join(SANDBOX, 'release-token.json');
  const releaseLock = `${releaseFile}.lock`;
  const releaseReplacement = JSON.stringify({ pid: process.pid, owner: 'release-replacement', at: Date.now() });
  reg.withRegistryLock(releaseFile, () => {
    const held = path.join(releaseLock, 'held');
    const own = fs.readdirSync(held).map((name) => path.join(held, name))[0];
    fs.unlinkSync(own);
    fs.rmdirSync(held);
    fs.mkdirSync(held);
    fs.writeFileSync(path.join(held, 'owner-00000000000000000000000000000000.json'), releaseReplacement);
  });
  ok('an old owner release never unlinks a replacement lock',
    fs.readFileSync(path.join(releaseLock, 'held', 'owner-00000000000000000000000000000000.json'), 'utf8') === releaseReplacement);
  fs.rmSync(releaseLock, { recursive: true, force: true });

  const ownerFaultFile = path.join(SANDBOX, 'owner-write-fault.json');
  let ownerFd = null;
  let ownerPath = null;
  let ownerFdClosed = false;
  let ownerPathRemoved = false;
  const ownerFaultFs = new Proxy(fs, { get(target, key) {
    if (key === 'openSync') return (file, flags, ...args) => {
      const opened = target.openSync(file, flags, ...args);
      if (flags === 'wx' && /\.lock\/held\/owner-[a-f0-9]+\.json$/.test(String(file))) {
        ownerFd = opened;
        ownerPath = file;
      }
      return opened;
    };
    if (key === 'writeFileSync') return (file, ...args) => {
      if (file === ownerFd) throw Object.assign(new Error('injected owner record failure'), { code: 'EIO' });
      return target.writeFileSync(file, ...args);
    };
    if (key === 'closeSync') return (fd, ...args) => {
      if (fd === ownerFd) ownerFdClosed = true;
      return target.closeSync(fd, ...args);
    };
    if (key === 'unlinkSync') return (file, ...args) => {
      if (file === ownerPath) ownerPathRemoved = true;
      return target.unlinkSync(file, ...args);
    };
    return target[key];
  }});
  let ownerFaultThrown = false;
  try {
    workspaceRegistryWithFs(ownerFaultFs).addRepo(ownerFaultFile,
      { workspace: 'fault', repo: '/repos/fault' });
  } catch (err) { ownerFaultThrown = err && err.code === 'EIO'; }
  ok('registry owner-record write failure surfaces the original error', ownerFaultThrown);
  ok('registry owner-record write failure closes its descriptor', ownerFd != null && ownerFdClosed);
  ok('registry owner-record write failure removes only its empty owned lock',
    ownerPathRemoved && !fs.existsSync(`${ownerFaultFile}.lock`));

  const activeDir = mk('active-repo-path');
  const inactiveFile = touchFile(SANDBOX, 'inactive-repo-file');
  ok('isActiveRepoPath accepts an existing directory', reg.isActiveRepoPath(activeDir));
  ok('isActiveRepoPath rejects a regular file', !reg.isActiveRepoPath(inactiveFile));
  ok('isActiveRepoPath rejects an absent path', !reg.isActiveRepoPath(path.join(SANDBOX, 'absent-repo')));
  ok('activeRepoRoot keeps an existing markerless registered directory active',
    reg.activeRepoRoot(activeDir) === path.resolve(activeDir));
  ok('activeRepoRoot leaves an absent registered path inactive',
    reg.activeRepoRoot(path.join(SANDBOX, 'absent-repo')) === null);
  const activeLink = path.join(SANDBOX, 'active-repo-link');
  try { fs.symlinkSync(activeDir, activeLink, 'dir'); } catch { /* symlinks may be unavailable */ }
  if (fs.existsSync(activeLink)) {
    ok('isActiveRepoPath accepts a symlink to an existing directory', reg.isActiveRepoPath(activeLink));
  }

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
