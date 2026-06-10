#!/usr/bin/env node
'use strict';
// onboard-mine-docs.js — generalized rationale-doc miner for ANY repo.
//
// scripts/ingest-docs.js distills docs via a CURATED map hardcoded to this orchestrator's
// files. That doesn't generalize. This miner instead HEURISTICALLY extracts durable-rationale
// sentences (must / never / because / chose X over Y / gotcha / WARNING / invariant) from the
// markdown of an arbitrary repo, keyed by source path. It is deliberately recall-leaning and
// noisy: the agentic learner (task /8) is what VALIDATES and rejects restatements. This is only
// the cheap static seed.
//
//   node scripts/onboard-mine-docs.js --repo <abs> [--out <dir>] [--max <n>]
//
// Emits <out>/doc-notes.json = [{ title, summary, source, kind }]. No graph mutation, no commit.

const fs = require('fs');
const path = require('path');

const SELF_REPO = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'worktrees', '.git', 'dist', 'build', 'coverage', 'vendor']);

// Sentence carries durable rationale if it matches a "why / must / never / tradeoff" cue.
const CUE_RE = /\b(must|never|always|do not|don'?t|because|instead of|rather than|chose|prefer|avoid|gotcha|caveat|warning|note that|invariant|requires?|ensure|so that|otherwise|the reason|key insight|trade-?off|deliberately|by design)\b/i;
// Pure restatement-of-usage cues we demote (install/run/clone how-to, not rationale).
const NOISE_RE = /^(install|npm install|yarn|run |to run|clone|cd |usage:|example:|see also|table of contents|©|copyright|license)/i;

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function globDocs(repo, dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.claude-plugin') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) continue; globDocs(repo, full, out); }
    else if (e.isFile() && /\.(md|mdx|markdown)$/i.test(e.name)) {
      out.push(path.relative(repo, full).split(path.sep).join('/'));
    }
  }
  return out;
}

function classifyKind(s) {
  const t = s.toLowerCase();
  if (/\b(must|never|always|do not|don'?t|requires?|ensure|invariant|warning|caveat)\b/.test(t)) return 'constraint';
  if (/\b(chose|prefer|instead of|rather than|trade-?off|deliberately|by design|the reason)\b/.test(t)) return 'decision';
  return 'doc';
}

// Split markdown into candidate "rationale" sentences. We strip headings/code fences/list
// bullets to plain prose, then sentence-split and keep cue-matching, non-noise sentences.
function extractSentences(md) {
  const out = [];
  let inFence = false;
  for (let raw of md.split('\n')) {
    const line = raw.trim();
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!line || /^#{1,6}\s/.test(line) || /^\|/.test(line) || /^[-=]{3,}$/.test(line)) continue;
    // strip leading list/quote markers and inline md emphasis/links
    const clean = line
      .replace(/^[-*+>]\s+/, '')
      .replace(/^\d+\.\s+/, '')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*?([^*]+)\*\*?/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .trim();
    if (!clean) continue;
    for (const s of clean.split(/(?<=[.!?])\s+(?=[A-Z(])/)) {
      const sent = s.trim();
      if (sent.length < 25 || sent.length > 400) continue;
      if (NOISE_RE.test(sent)) continue;
      if (!CUE_RE.test(sent)) continue;
      out.push(sent);
    }
  }
  return out;
}

function titleFrom(sent) {
  // first clause / up to ~70 chars, no trailing punctuation
  let t = sent.split(/[—:;.]/)[0].trim();
  if (t.length > 80) t = t.slice(0, 77).trimEnd() + '...';
  return t;
}

function main() {
  const repo = arg('repo');
  if (!repo || !fs.existsSync(repo)) {
    console.error('usage: onboard-mine-docs.js --repo <abs path> [--out <dir>] [--max <n>]');
    process.exit(2);
  }
  const repoAbs = path.resolve(repo);
  const outDir = path.resolve(arg('out', path.join(SELF_REPO, 'bench', 'onboard', path.basename(repoAbs))));
  const OUT = path.join(outDir, 'doc-notes.json');
  const max = parseInt(arg('max', '0'), 10) || 0;

  const docs = globDocs(repoAbs, repoAbs, []);
  const notes = [];
  const seen = new Set();
  for (const rel of docs) {
    let md;
    try { md = fs.readFileSync(path.join(repoAbs, rel), 'utf8'); } catch { continue; }
    for (const sent of extractSentences(md)) {
      const key = sent.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);
      notes.push({ title: titleFrom(sent), summary: sent, source: rel, kind: classifyKind(sent) });
      if (max && notes.length >= max) break;
    }
    if (max && notes.length >= max) break;
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(notes, null, 2) + '\n');
  console.error(`repo=${repoAbs} docs=${docs.length} emitted=${notes.length} -> ${OUT}`);
  notes.slice(0, 3).forEach((n, i) => console.error(`\n[${i + 1}] (${n.kind}) ${n.title}\n    ${n.summary}`));
}

main();
