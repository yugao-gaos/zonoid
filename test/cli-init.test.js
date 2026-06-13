#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const { parseInitArgs, mergeCursorHooks, VALID_HARNESSES } = require('../packages/cli/bin/zonoid.js');

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

process.exit(failed ? 1 : 0);
