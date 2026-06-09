#!/usr/bin/env node
'use strict';
// ingest-git.js — mine git history into candidate knowledge notes.
// The "delta over reading current code": each note captures a problem→resolution
// or gotcha derived from a commit message + the files it touched, NOT what the
// code does. Output → bench/ingest/git-notes.json. Does NOT inject into the graph.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = process.argv[2] || '__INSTALL_DIR__';
const OUT_DIR = path.join(REPO, 'bench', 'ingest');
const OUT_FILE = path.join(OUT_DIR, 'git-notes.json');

const REC_SEP = '\x1e'; // record separator
const FLD_SEP = '\x1f'; // field separator

function git(args) {
  const r = spawnSync('git', ['-C', REPO, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.status}`);
  }
  return r.stdout;
}

// One git call: sha, subject, body, then --name-status block, per commit.
function readLog() {
  const fmt = `${REC_SEP}%H${FLD_SEP}%s${FLD_SEP}%b${FLD_SEP}`;
  const out = git(['log', `--pretty=format:${fmt}`, '--name-status']);
  const records = out.split(REC_SEP).filter((r) => r.trim());
  return records.map((rec) => {
    const [sha, subject, rest] = rec.split(FLD_SEP);
    // `rest` = body, then a blank line, then the name-status lines.
    const idx = rest.indexOf(FLD_SEP); // the trailing FLD_SEP after %b
    const body = idx >= 0 ? rest.slice(0, idx) : rest;
    const after = idx >= 0 ? rest.slice(idx + 1) : '';
    const files = after
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[A-Z]\d*\t/.test(l))
      .map((l) => {
        const parts = l.split('\t');
        return { status: parts[0], path: parts[parts.length - 1] };
      });
    return {
      sha: (sha || '').trim(),
      subject: (subject || '').trim(),
      body: (body || '').trim(),
      files,
    };
  });
}

// High-signal heuristic: subject/body matches a problem-pattern, OR substantive
// multi-line body. (Initial-commit snapshots are low-delta — demote unless they
// also match a pattern.)
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

// Classify the note kind from the message shape.
function classifyKind(c) {
  const hay = `${c.subject}\n${c.body}`.toLowerCase();
  if (/\brevert|no-?win|null\b|verdict|supersede|win-guard|metric|measured|finding|parity/.test(hay)) {
    return 'verdict';
  }
  if (/fix|bug|broke|regress|hijack|race|stale|collision|phantom|loophole|defect|trap|false.?positive|gotcha|workaround|dogfood/.test(hay)) {
    return 'gotcha';
  }
  return 'decision';
}

// Build a tight problem→resolution summary. We don't paraphrase "what the code
// does"; we lead with the precise problem/finding and its resolution, and append
// the touched files as evidence of locality.
function buildSummary(c) {
  const body = c.body.replace(/\n+Co-Authored-By:.*$/is, '').trim();
  // First two sentences of the body usually state problem + resolution.
  const sentences = body
    .replace(/\s+/g, ' ')
    .split(/(?<=[.;])\s+(?=[A-Z(])/)
    .filter(Boolean);
  let core = sentences.slice(0, 3).join(' ').trim();
  if (!core) core = c.subject;
  // Trim to ~3 sentences worth, hard cap length.
  if (core.length > 420) core = core.slice(0, 417).trimEnd() + '...';
  const touched = c.files.slice(0, 5).map((f) => f.path);
  const fileNote = touched.length
    ? ` [touched: ${touched.join(', ')}${c.files.length > 5 ? ', …' : ''}]`
    : '';
  return core + fileNote;
}

function main() {
  const commits = readLog();
  const high = commits.filter(isHighSignal);
  const notes = high.map((c) => ({
    title: c.subject,
    summary: buildSummary(c),
    source: c.sha,
    kind: classifyKind(c),
  }));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(notes, null, 2) + '\n');

  console.error(`scanned=${commits.length} emitted=${notes.length} -> ${OUT_FILE}`);
  // Print 3 examples to stderr for the report.
  notes.slice(0, 3).forEach((n, i) => {
    console.error(`\n[${i + 1}] (${n.kind}) ${n.title}\n    ${n.summary}`);
  });
}

main();
