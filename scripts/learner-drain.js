#!/usr/bin/env node
'use strict';

// learner-drain.js — thin CLI driver: calls onboard-learn.js --drain with ORCH_GATE_OFF=1
// injected into the child env so the orch-gate hook does not block the learner's writes.
//
//   node scripts/learner-drain.js --repo <abs_path> [--batch 50] [--workspace <abs>]

const { spawnSync } = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

// ---- args ----------------------------------------------------------------
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const repo = arg('repo', null);
const batch = arg('batch', '50');

if (!repo) {
  console.error('Usage: node scripts/learner-drain.js --repo <abs_path> [--batch N] [--workspace <abs>]');
  process.exit(2);
}

if (!path.isAbsolute(repo)) {
  console.error('--repo must be an absolute path, got: ' + repo);
  process.exit(2);
}

// ---- check queue status --------------------------------------------------
const statusResult = spawnSync(
  'node',
  ['scripts/onboard-learn.js', '--repo', repo, '--queue-status'],
  { cwd: repoRoot, env: { ...process.env, ORCH_GATE_OFF: '1' }, encoding: 'utf8', stdio: 'pipe' }
);

if (statusResult.status === 0) {
  try {
    const status = JSON.parse(statusResult.stdout);
    if (status.done) {
      console.log('queue complete, nothing to drain');
      process.exit(0);
    }
  } catch {
    // not parseable JSON — fall through to drain
  }
}

// ---- drain next batch ----------------------------------------------------
const drainResult = spawnSync(
  'node',
  ['scripts/onboard-learn.js', '--repo', repo, '--drain', '--batch', String(batch)],
  { cwd: repoRoot, env: { ...process.env, ORCH_GATE_OFF: '1' }, encoding: 'utf8', stdio: 'pipe' }
);

if (drainResult.status !== 0) {
  if (drainResult.stdout) process.stdout.write(drainResult.stdout);
  if (drainResult.stderr) process.stderr.write(drainResult.stderr);
  process.exit(1);
}

// ---- print summary -------------------------------------------------------
if (drainResult.stdout) process.stdout.write(drainResult.stdout);

// Try to surface remaining candidates from a trailing queue-status call
const postStatus = spawnSync(
  'node',
  ['scripts/onboard-learn.js', '--repo', repo, '--queue-status'],
  { cwd: repoRoot, env: { ...process.env, ORCH_GATE_OFF: '1' }, encoding: 'utf8', stdio: 'pipe' }
);

if (postStatus.status === 0) {
  try {
    const s = JSON.parse(postStatus.stdout);
    const remaining = (s.total || 0) - (s.cursor || 0);
    if (s.done) {
      console.log('drain complete — all candidates processed');
    } else {
      console.log(`drain batch done — ${remaining} candidates remaining (cursor ${s.cursor}/${s.total})`);
    }
  } catch {
    // stdout not JSON, already printed above
  }
}

process.exit(0);
