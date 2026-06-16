#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const {
  parseInitArgs,
  mergeCursorHooks,
  VALID_HARNESSES,
  scheduleWakeupScriptPath,
  opencodePluginHasScheduleWakeup,
  INSTALL_DIR,
  dirHasLiveData,
  resolveInstallDir,
  linkSkill,
} = require('../packages/cli/bin/zonoid.js');
const fs = require('fs');

const zonoid = path.join(__dirname, '..', 'packages', 'cli', 'bin', 'zonoid.js');
let failed = 0;

function ok(label, cond) {
  if (cond) console.log('ok', label);
  else { console.error('FAIL', label); failed++; }
}

ok('default harness is claude', parseInitArgs(['node', 'zonoid', 'init']).harness === 'claude');
ok('cursor harness parsed', parseInitArgs(['node', 'zonoid', 'init', '--harness', 'cursor']).harness === 'cursor');
ok('opencode harness parsed', parseInitArgs(['node', 'zonoid', 'init', '--harness', 'opencode']).harness === 'opencode');
ok('--service flag parsed', parseInitArgs(['node', 'zonoid', 'init', '--service', '--harness', 'codex']).service === true);
ok('invalid harness not in VALID_HARNESSES', !VALID_HARNESSES.has('invalid'));

const merged = mergeCursorHooks(
  { version: 1, hooks: { postToolUse: [{ command: '/keep/me.sh' }] } },
  { version: 1, hooks: { preToolUse: [{ command: '/new/gate.sh', matcher: 'Write' }] } },
  [{ event: 'postToolUse', entries: [{ command: '/new/todo.sh' }] }]
);
ok('merge preserves existing hook', merged.hooks.postToolUse.some((e) => e.command === '/keep/me.sh'));
ok('merge adds sample hook', merged.hooks.preToolUse.some((e) => e.command === '/new/gate.sh'));
ok('merge appends extra hook', merged.hooks.postToolUse.some((e) => e.command === '/new/todo.sh'));
ok('merge skips duplicate command', merged.hooks.postToolUse.length === 2);

const bad = spawnSync(process.execPath, [zonoid, 'init', '--harness', 'invalid'], { encoding: 'utf8' });
ok('invalid --harness exits non-zero', bad.status !== 0);
ok('invalid --harness prints error', (bad.stderr || bad.stdout || '').includes('Unknown --harness'));

const help = spawnSync(process.execPath, [zonoid], { encoding: 'utf8' });
const usage = help.stdout || '';
ok('usage lists cursor', usage.includes('cursor'));
ok('usage lists opencode', usage.includes('opencode'));
ok('usage lists codex', usage.includes('codex'));
ok('usage lists --service', usage.includes('--service'));

const swScript = scheduleWakeupScriptPath();
ok('scheduleWakeupScriptPath under adapters/common', swScript.replace(/\\/g, '/').endsWith('adapters/common/schedule-wakeup.sh'));
ok('scheduleWakeupScriptPath uses INSTALL_DIR', swScript.startsWith(INSTALL_DIR));

const pluginTs = path.join(__dirname, '..', 'packages', 'opencode-plugin', 'zonoid.ts');
ok('repo opencode plugin has schedule_wakeup', opencodePluginHasScheduleWakeup(fs.readFileSync(pluginTs, 'utf8')));

// ── Invariant 1: dirHasLiveData ──────────────────────────────────────────────
// Use os.tmpdir() fixtures — no network required.
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-test-'));
  try {
    // Empty dir → no live data
    ok('dirHasLiveData: empty dir is false', !dirHasLiveData(base));

    // Dir with overlay/ subdir → live data
    const withOverlay = path.join(base, 'with-overlay');
    fs.mkdirSync(path.join(withOverlay, 'overlay'), { recursive: true });
    ok('dirHasLiveData: overlay/ detected', dirHasLiveData(withOverlay));

    // Dir with sessions/ subdir → live data
    const withSessions = path.join(base, 'with-sessions');
    fs.mkdirSync(path.join(withSessions, 'sessions'), { recursive: true });
    ok('dirHasLiveData: sessions/ detected', dirHasLiveData(withSessions));

    // Dir with worktrees/ subdir → live data
    const withWorktrees = path.join(base, 'with-worktrees');
    fs.mkdirSync(path.join(withWorktrees, 'worktrees'), { recursive: true });
    ok('dirHasLiveData: worktrees/ detected', dirHasLiveData(withWorktrees));

    // Dir with `workspace` file → live data
    const withWorkspace = path.join(base, 'with-workspace');
    fs.mkdirSync(withWorkspace, { recursive: true });
    fs.writeFileSync(path.join(withWorkspace, 'workspace'), '{}');
    ok('dirHasLiveData: workspace file detected', dirHasLiveData(withWorkspace));

    // Dir with `token` file → live data
    const withToken = path.join(base, 'with-token');
    fs.mkdirSync(withToken, { recursive: true });
    fs.writeFileSync(path.join(withToken, 'token'), 'abc');
    ok('dirHasLiveData: token file detected', dirHasLiveData(withToken));

    // Dir with only unrelated files → no live data
    const withOther = path.join(base, 'with-other');
    fs.mkdirSync(withOther, { recursive: true });
    fs.writeFileSync(path.join(withOther, 'package.json'), '{}');
    ok('dirHasLiveData: unrelated files are false', !dirHasLiveData(withOther));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ── Invariant 3: resolveInstallDir ──────────────────────────────────────────
// The repo root (3 levels above packages/cli/bin) IS a checkout because the
// test itself runs from the repo, so resolveInstallDir() must prefer it.
{
  const repoRoot = path.resolve(__dirname, '..');
  const hasDaemon  = fs.existsSync(path.join(repoRoot, 'daemon.js'));
  const hasMcp     = fs.existsSync(path.join(repoRoot, 'mcp-graph.js'));
  const hasPkg     = fs.existsSync(path.join(repoRoot, 'package.json'));
  if (hasDaemon && hasMcp && hasPkg) {
    // Full checkout — resolveInstallDir() should return repoRoot (or its realpath)
    const resolved = fs.realpathSync(resolveInstallDir());
    const expected = fs.realpathSync(repoRoot);
    ok('resolveInstallDir prefers local checkout', resolved === expected);
  } else {
    // Not a full checkout (e.g. running from an npm install) — just verify it
    // returns a string and does not throw.
    ok('resolveInstallDir returns a string', typeof resolveInstallDir() === 'string');
  }
}

// ── Invariant 2: linkSkill() — stub-injected fallback branch coverage ────────
// These tests inject synthetic symlinkFn / cpFn stubs so that the junction and
// copy branches of linkSkill() actually execute on this host regardless of OS
// privilege level.  A broken fallback path will cause the wrong strategy to be
// returned and the corresponding ok() assertion to fail.

// (a) symlink fails for 2-arg call but succeeds for 'junction' → returns 'junction'
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-skill-test-'));
  try {
    const src  = path.join(base, 'src-skill');
    const dest = path.join(base, 'dest-skill');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'skill.md'), '# junction test');

    // symlinkFn throws only when called WITHOUT the 'junction' type arg
    const stubSymlink = (s, d, type) => {
      if (!type) throw Object.assign(new Error('EPERM stub'), { code: 'EPERM' });
      // 'junction' call: delegate to the real fs.symlinkSync
      fs.symlinkSync(s, d, type);
    };

    const result = linkSkill(src, dest, stubSymlink, fs.cpSync);
    ok('linkSkill junction branch: returns junction', result === 'junction');
    ok('linkSkill junction branch: dest is a junction/symlink', fs.existsSync(dest));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// (b) symlinkFn throws for BOTH symlink and junction; cpFn wraps fs.cpSync → returns 'copy'
//     AND dest is a real dir with skill.md present
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-skill-test-'));
  try {
    const src  = path.join(base, 'src-skill');
    const dest = path.join(base, 'dest-skill');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'skill.md'), '# copy test');

    // symlinkFn always throws
    const stubSymlink = () => { throw Object.assign(new Error('EPERM stub'), { code: 'EPERM' }); };
    // cpFn delegates to real fs.cpSync
    const stubCp = (s, d, opts) => fs.cpSync(s, d, opts);

    const result = linkSkill(src, dest, stubSymlink, stubCp);
    ok('linkSkill copy branch: returns copy', result === 'copy');
    ok('linkSkill copy branch: dest dir exists', fs.existsSync(dest) && fs.statSync(dest).isDirectory());
    ok('linkSkill copy branch: skill.md present in dest', fs.existsSync(path.join(dest, 'skill.md')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// (c) default happy path (no stubs) → returns 'symlink' (or at minimum a non-null strategy)
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-skill-test-'));
  try {
    const src  = path.join(base, 'src-skill');
    const dest = path.join(base, 'dest-skill');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'skill.md'), '# happy path test');

    const result = linkSkill(src, dest);
    ok('linkSkill happy path: returns a non-null strategy', result !== null);
    ok('linkSkill happy path: dest exists after chain', fs.existsSync(dest));
    const resolvedDest = (result === 'copy') ? dest : fs.realpathSync(dest);
    ok('linkSkill happy path: skill.md readable via dest', fs.existsSync(path.join(resolvedDest, 'skill.md')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

process.exit(failed ? 1 : 0);
