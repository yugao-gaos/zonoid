#!/usr/bin/env node
'use strict';
// onboard-mine-git.js — generalized git-history miner for ANY repo.
//
// Same high-signal heuristic as scripts/ingest-git.js (problem→resolution / gotcha from a
// commit message + touched files — the delta over reading current code), but the target repo
// and output dir are flags and the output is the per-subject onboard dir, so it can mine an
// arbitrary client project instead of only this orchestrator.
//
//   node scripts/onboard-mine-git.js --repo <abs> [--out <dir>] [--max <n>]
//
// Emits <out>/git-notes.json. Does NOT inject into the graph and does NOT commit.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { defaultOnboardOutDir } = require('../lib/onboard-paths');

const REC_SEP = '\x1e';
const FLD_SEP = '\x1f';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function gitResult(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

function gitError(args, result) {
  const detail = result && (result.stderr || (result.error && result.error.message) || result.status);
  return new Error(`git ${args.join(' ')} failed: ${detail}`);
}

function readLog(repo, max) {
  const probeArgs = ['rev-parse', '--is-inside-work-tree'];
  const probe = gitResult(repo, probeArgs);
  if (probe.status !== 0 || String(probe.stdout || '').trim() !== 'true') {
    // Plain non-Git directories are valid onboarding targets. A present-but-broken .git marker is
    // different: hiding that corruption as "no history" would silently discard useful evidence.
    if (fs.existsSync(path.join(repo, '.git'))) throw gitError(probeArgs, probe);
    return [];
  }

  const headArgs = ['rev-parse', '--verify', 'HEAD'];
  const head = gitResult(repo, headArgs);
  if (head.status !== 0) {
    // An unborn repository has no HEAD but is otherwise healthy. `git status` is the authoritative
    // discriminator: it succeeds for an unborn repo and fails for corrupted Git metadata.
    const statusArgs = ['status', '--porcelain=v1'];
    const status = gitResult(repo, statusArgs);
    if (status.status === 0) return [];
    throw gitError(headArgs, head);
  }

  const fmt = `${REC_SEP}%H${FLD_SEP}%s${FLD_SEP}%b${FLD_SEP}`;
  const logArgs = ['log', `--pretty=format:${fmt}`, '--name-status'];
  if (max) logArgs.push(`-n${max}`);
  const logged = gitResult(repo, logArgs);
  if (logged.status !== 0) throw gitError(logArgs, logged);
  const out = logged.stdout;
  const records = out.split(REC_SEP).filter((r) => r.trim());
  return records.map((rec) => {
    const [sha, subject, rest] = rec.split(FLD_SEP);
    const idx = rest.indexOf(FLD_SEP);
    const body = idx >= 0 ? rest.slice(0, idx) : rest;
    const after = idx >= 0 ? rest.slice(idx + 1) : '';
    const files = after.split('\n').map((l) => l.trim())
      .filter((l) => /^[A-Z]\d*\t/.test(l))
      .map((l) => { const p = l.split('\t'); return { status: p[0], path: p[p.length - 1] }; });
    return { sha: (sha || '').trim(), subject: (subject || '').trim(), body: (body || '').trim(), files };
  });
}

const SIGNAL_RE = /revert|fix|bug|broke|regress|because|instead|workaround|gotcha|hijack|false.?positive|race|stale|collision|null|loophole|defect|trap|hold-?merge|dedup|phantom|sweep|decoupl/i;

function bodyLineCount(body) {
  return body.split('\n').map((l) => l.trim()).filter(Boolean).length;
}
function isHighSignal(c) {
  const hay = `${c.subject}\n${c.body}`;
  if (SIGNAL_RE.test(hay)) return true;
  if (bodyLineCount(c.body) >= 3) return true;
  return false;
}
function classifyKind(c) {
  const hay = `${c.subject}\n${c.body}`.toLowerCase();
  if (/\brevert|no-?win|null\b|verdict|supersede|win-guard|metric|measured|finding|parity/.test(hay)) return 'verdict';
  if (/fix|bug|broke|regress|hijack|race|stale|collision|phantom|loophole|defect|trap|false.?positive|gotcha|workaround|dogfood/.test(hay)) return 'gotcha';
  return 'decision';
}
function buildSummary(c) {
  const body = c.body.replace(/\n+Co-Authored-By:.*$/is, '').trim();
  const sentences = body.replace(/\s+/g, ' ').split(/(?<=[.;])\s+(?=[A-Z(])/).filter(Boolean);
  let core = sentences.slice(0, 3).join(' ').trim();
  if (!core) core = c.subject;
  if (core.length > 420) core = core.slice(0, 417).trimEnd() + '...';
  const touched = c.files.slice(0, 5).map((f) => f.path);
  const fileNote = touched.length ? ` [touched: ${touched.join(', ')}${c.files.length > 5 ? ', …' : ''}]` : '';
  return core + fileNote;
}

function main() {
  const repo = arg('repo');
  if (!repo || !fs.existsSync(repo)) {
    console.error('usage: onboard-mine-git.js --repo <abs path> [--out <dir>] [--max <n>]');
    process.exit(2);
  }
  const repoAbs = path.resolve(repo);
  const outDir = path.resolve(arg('out', defaultOnboardOutDir(repoAbs)));
  const OUT = path.join(outDir, 'git-notes.json');
  const max = parseInt(arg('max', '0'), 10) || 0;

  const commits = readLog(repoAbs, max);
  const high = commits.filter(isHighSignal);
  const notes = high.map((c) => ({
    title: c.subject, summary: buildSummary(c), source: c.sha, kind: classifyKind(c),
  }));

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(notes, null, 2) + '\n');
  console.error(`repo=${repoAbs} scanned=${commits.length} emitted=${notes.length} -> ${OUT}`);
  notes.slice(0, 3).forEach((n, i) => console.error(`\n[${i + 1}] (${n.kind}) ${n.title}\n    ${n.summary}`));
}

main();
