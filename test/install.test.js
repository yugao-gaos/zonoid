#!/usr/bin/env node
'use strict';
// Dependency-free tests for bin/install.js — auto-discovered by scripts/run-tests.js.
// Mirrors the assertion style of test/cli-init.test.js: a tiny ok() counter, os.tmpdir()
// fixtures (no network), and injectable stubs to force OS-primitive fallback branches.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  linkSkill,
  prePushTestCommand,
  prePushTestHookScript,
  installPrePushTestHook,
  installClaudeInstructions,
  renderClaudeInstructions,
  dashboardUrl,
} = require('../bin/install.js');

const installJs = path.join(__dirname, '..', 'bin', 'install.js');
let failed = 0;

function ok(label, cond) {
  if (cond) console.log('ok', label);
  else { console.error('FAIL', label); failed++; }
}

// ── renderClaudeInstructions / dashboardUrl ──────────────────────────────────
{
  const ws = path.join(os.tmpdir(), 'install client repo');
  const url = dashboardUrl(ws, '8787');
  ok('dashboardUrl pins and URL-encodes workspace path',
    url === `http://localhost:8787/graph?workspace=${encodeURIComponent(path.resolve(ws))}`);

  const rendered = renderClaudeInstructions(
    'A http://localhost:8787/graph\nB http://localhost:8787/graph?workspace=%2Fold%2Frepo',
    ws,
    '8788'
  );
  const expected = `http://localhost:8788/graph?workspace=${encodeURIComponent(path.resolve(ws))}`;
  ok('renderClaudeInstructions rewrites generic dashboard URL', rendered.includes(`A ${expected}`));
  ok('renderClaudeInstructions rewrites existing pinned dashboard URL', rendered.includes(`B ${expected}`));
}

// ── linkSkill: stub-injected fallback branch coverage ────────────────────────
// (a) symlink fails for 2-arg call but succeeds for 'junction' → returns 'junction'
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'install-skill-'));
  try {
    const src  = path.join(base, 'src-skill');
    const dest = path.join(base, 'dest-skill');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'skill.md'), '# junction test');

    const stubSymlink = (s, d, type) => {
      if (!type) throw Object.assign(new Error('EPERM stub'), { code: 'EPERM' });
      fs.symlinkSync(s, d, type);
    };
    const result = linkSkill(src, dest, stubSymlink, fs.cpSync);
    ok('linkSkill junction branch: returns junction', result === 'junction');
    ok('linkSkill junction branch: dest exists', fs.existsSync(dest));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// (b) symlinkFn throws for BOTH symlink and junction; cpFn wraps fs.cpSync → 'copy'
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'install-skill-'));
  try {
    const src  = path.join(base, 'src-skill');
    const dest = path.join(base, 'dest-skill');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'skill.md'), '# copy test');

    const stubSymlink = () => { throw Object.assign(new Error('EPERM stub'), { code: 'EPERM' }); };
    const stubCp = (s, d, opts) => fs.cpSync(s, d, opts);
    const result = linkSkill(src, dest, stubSymlink, stubCp);
    ok('linkSkill copy branch: returns copy', result === 'copy');
    ok('linkSkill copy branch: dest dir exists', fs.existsSync(dest) && fs.statSync(dest).isDirectory());
    ok('linkSkill copy branch: skill.md present in dest', fs.existsSync(path.join(dest, 'skill.md')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// (c) total failure: every primitive throws → returns null
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'install-skill-'));
  try {
    const src  = path.join(base, 'src-skill');
    const dest = path.join(base, 'dest-skill');
    fs.mkdirSync(src, { recursive: true });
    const boom = () => { throw new Error('boom'); };
    const result = linkSkill(src, dest, boom, boom);
    ok('linkSkill total failure: returns null', result === null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// (d) default happy path (no stubs) → non-null strategy, dest exists
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'install-skill-'));
  try {
    const src  = path.join(base, 'src-skill');
    const dest = path.join(base, 'dest-skill');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'skill.md'), '# happy path');
    const result = linkSkill(src, dest);
    ok('linkSkill happy path: returns a non-null strategy', result !== null);
    ok('linkSkill happy path: dest exists after chain', fs.existsSync(dest));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ── prePushTestCommand: test:all vs test vs neither ──────────────────────────
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'install-pre-push-'));
  try {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
      scripts: { test: 'node test/basic.test.js', 'test:all': 'node scripts/run-tests.js' },
    }, null, 2));
    ok('prePushTestCommand prefers test:all', prePushTestCommand(repo) === 'npm run test:all');

    const script = prePushTestHookScript(prePushTestCommand(repo));
    ok('prePushTestHookScript includes marker', script.includes('Zonoid pre-push test guard'));
    ok('prePushTestHookScript runs selected command', script.includes('npm run test:all'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'install-pre-push-'));
  try {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }, null, 2));
    ok('prePushTestCommand falls back to test', prePushTestCommand(repo) === 'npm test');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'install-pre-push-'));
  try {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { build: 'node build.js' } }));
    ok('prePushTestCommand skips repos without test scripts', prePushTestCommand(repo) === null);

    // No package.json at all → null
    const repo2 = path.join(base, 'repo2');
    fs.mkdirSync(repo2, { recursive: true });
    ok('prePushTestCommand skips repos without package.json', prePushTestCommand(repo2) === null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ── installPrePushTestHook: writes guard, then foreign-hook non-overwrite ─────
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'install-pre-push-hook-'));
  try {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    spawnSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
      scripts: { 'test:all': 'node scripts/run-tests.js' },
    }, null, 2));

    installPrePushTestHook(repo);
    const hookPath = path.join(repo, '.git', 'hooks', 'pre-push');
    ok('installPrePushTestHook writes pre-push hook', fs.existsSync(hookPath));
    const hook = fs.readFileSync(hookPath, 'utf8');
    ok('installPrePushTestHook writes test:all guard',
      hook.includes('Zonoid pre-push test guard') && hook.includes('npm run test:all'));

    // Second run is idempotent — content unchanged.
    const before = fs.readFileSync(hookPath, 'utf8');
    installPrePushTestHook(repo);
    ok('installPrePushTestHook idempotent (managed hook unchanged)',
      fs.readFileSync(hookPath, 'utf8') === before);

    // Foreign hook is NOT overwritten.
    const foreign = '#!/bin/sh\necho "my own hook"\n';
    fs.writeFileSync(hookPath, foreign);
    installPrePushTestHook(repo);
    ok('installPrePushTestHook does not overwrite a foreign pre-push hook',
      fs.readFileSync(hookPath, 'utf8') === foreign);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// installPrePushTestHook skips cleanly when not a git repo (has test script).
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'install-pre-push-nogit-'));
  try {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
      scripts: { test: 'node t.js' },
    }, null, 2));
    // Should not throw and should not create a .git/hooks/pre-push.
    installPrePushTestHook(repo);
    ok('installPrePushTestHook skips cleanly outside a git repo',
      !fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-push')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ── installClaudeInstructions: idempotent append ─────────────────────────────
// The install dir's CLAUDE.md contains an "Orchestrator dashboard" section, so a
// second run must detect it and no-op (no duplicate append).
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'install-claude-'));
  try {
    const ws = path.join(base, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# My project rules\n');

    installClaudeInstructions(ws);
    const dest = path.join(ws, 'CLAUDE.md');
    const after1 = fs.readFileSync(dest, 'utf8');
    ok('installClaudeInstructions preserves existing project content',
      after1.startsWith('# My project rules'));
    ok('installClaudeInstructions appends orchestrator section',
      after1.includes('Orchestrator dashboard'));

    // Second run: section already present → byte-identical (no duplicate append).
    installClaudeInstructions(ws);
    const after2 = fs.readFileSync(dest, 'utf8');
    ok('installClaudeInstructions idempotent (second run no-ops)', after1 === after2);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ── --dry-run writes nothing new ─────────────────────────────────────────────
// Spawn the script with --dry-run against a fresh temp workspace and assert NO
// new files/links were created (no .mcp.json, no CLAUDE.md, no pre-push hook,
// no ~/.claude/skills writes), but it still exits 0.
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'install-dry-'));
  try {
    const ws = path.join(base, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    spawnSync('git', ['init'], { cwd: ws, stdio: 'ignore' });
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({
      scripts: { test: 'node t.js' },
    }, null, 2));

    const res = spawnSync(process.execPath,
      [installJs, '--dry-run', '--workspace', ws, '--port', '8787'],
      { encoding: 'utf8', windowsHide: true });

    ok('--dry-run exits 0', res.status === 0);
    ok('--dry-run wrote no .mcp.json', !fs.existsSync(path.join(ws, '.mcp.json')));
    ok('--dry-run wrote no CLAUDE.md', !fs.existsSync(path.join(ws, 'CLAUDE.md')));
    ok('--dry-run wrote no settings.json', !fs.existsSync(path.join(ws, '.claude', 'settings.json')));
    ok('--dry-run wrote no pre-push hook', !fs.existsSync(path.join(ws, '.git', 'hooks', 'pre-push')));
    ok('--dry-run prints planned actions',
      (res.stdout || '').includes('would write') || (res.stdout || '').includes('dry-run'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

process.exit(failed ? 1 : 0);
