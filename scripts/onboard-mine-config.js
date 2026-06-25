#!/usr/bin/env node
'use strict';
// onboard-mine-config.js — static miner for CONFIG-DEFAULT definitions.
//
// The git/docs/structure miners are recall-leaning over prose and module roles, but they MISS a
// class of high-value onboarding knowledge that lives only in code: the DEFAULT VALUES a system
// ships with — escalation triggers, timeouts, thresholds, protocol versions, weights. These are
// non-obvious ("what does it do out of the box?"), individually tunable, and a new engineer only
// learns them by reading the right const. This miner surfaces them as candidate hypotheses so the
// agentic learner (onboard-learn.js) can validate the ones that are genuinely load-bearing.
//
// PROBE-AGNOSTIC: it scans for a generic code SHAPE (top-level const definitions whose name implies
// a default/config: *_DEFAULTS, DEFAULT_*, *_THRESHOLD, *_TIMEOUT*, *_WEIGHT, *_PROTOCOL, etc.).
// It does NOT know anything about the probe set — escalation defaults are one match among timeouts,
// thresholds, weights, and protocol versions.
//
//   node scripts/onboard-mine-config.js --repo <abs> [--out <dir>]
//
// Emits <out>/config-notes.json = [{title, summary, kind:'config', source}] (same shape the other
// miners use, so onboard-learn.js's gatherCandidates picks it up). No graph mutation, no commit.

const fs = require('fs');
const path = require('path');
const { defaultOnboardOutDir } = require('../lib/onboard-paths');

const SKIP_DIRS = new Set(['node_modules', 'worktrees', '.git', 'dist', 'build', 'coverage', 'vendor', '.next', 'out', 'tmp', '__pycache__', 'test', 'bench']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

// Generic "this const looks like a shipped default/config" name test. No probe-specific names.
const CONFIG_NAME = /^(?:[A-Z][A-Z0-9_]*_DEFAULTS|DEFAULT_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_(?:THRESHOLD|TIMEOUT|TIMEOUT_MS|WEIGHT|PROTOCOL|LIMIT|MAX|INTERVAL|BUDGET))$/;

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function walk(repo, dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(repo, full, out); }
    else if (e.isFile() && CODE_EXT.has(path.extname(e.name))) out.push(path.relative(repo, full).split(path.sep).join('/'));
  }
  return out;
}

function trailingComment(line) {
  const m = line.match(/\/\/\s?(.+)$/);
  return m ? m[1].trim() : '';
}

function rhsOf(line) {
  const m = line.match(/=\s*(.+?);?\s*(?:\/\/.*)?$/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function mineFile(repo, rel, out) {
  let src;
  try { src = fs.readFileSync(path.join(repo, rel), 'utf8'); } catch { return; }
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^const\s+([A-Z][A-Z0-9_]*)\s*=/);
    if (!m) continue;
    const name = m[1];
    if (!CONFIG_NAME.test(name)) continue;
    let rhs = rhsOf(line);
    if (rhs && !/[;)]\s*$/.test(line) && (rhs.includes('{') || rhs.includes('('))) {
      const more = [];
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        more.push(lines[j].trim());
        if (/[}\)];?\s*$/.test(lines[j])) break;
      }
      rhs = (rhs + ' ' + more.join(' ')).replace(/\s+/g, ' ').trim();
    }
    if (rhs.length > 240) rhs = rhs.slice(0, 237) + '...';
    const comment = trailingComment(line) ||
      (lines[i - 1] && lines[i - 1].trim().startsWith('//') ? lines[i - 1].trim().replace(/^\/\/\s?/, '') : '');
    out.push({
      title: `Config default: ${name} (${rel})`,
      summary: `${rel}: \`const ${name} = ${rhs}\`.${comment ? ' ' + comment : ''} This is a shipped default — verify what it controls and why this value, then keep only if non-obvious.`,
      kind: 'config',
      source: `${rel}:${i + 1}`,
    });
  }
}

function main() {
  const repo = arg('repo');
  if (!repo || !fs.existsSync(repo)) { console.error('usage: onboard-mine-config.js --repo <abs> [--out <dir>]'); process.exit(2); }
  const repoAbs = path.resolve(repo);
  const outDir = path.resolve(arg('out', defaultOnboardOutDir(repoAbs)));
  const OUT = path.join(outDir, 'config-notes.json');

  const files = walk(repoAbs, repoAbs, []).sort();
  const out = [];
  for (const rel of files) mineFile(repoAbs, rel, out);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${OUT}`);
  console.log(`repo=${repoAbs} config-default candidates=${out.length}`);
  for (const c of out.slice(0, 12)) console.log(`  ${c.source}  ${c.title.replace(/^Config default: /, '')}`);
}

main();
