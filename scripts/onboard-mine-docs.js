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
const crypto = require('crypto');

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

function slug(s) {
  return String(s || 'section')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section';
}

function stableId(parts) {
  const raw = parts.join('\0');
  return slug(parts.filter(Boolean).join('-')) + '-' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10);
}

function keyFor(type, id) {
  return `knowledge:${type}:${id}`;
}

function cleanMarkdownText(line) {
  return String(line || '')
    .replace(/^[-*+>]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*?([^*]+)\*\*?/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

function extractSections(md) {
  const sections = [];
  let current = null;
  let paragraph = [];
  let inFence = false;

  function ensureSection() {
    if (!current) {
      current = { heading: 'Document', level: 0, chunks: [] };
      sections.push(current);
    }
    return current;
  }

  function flushParagraph() {
    const text = paragraph.join(' ').replace(/\s+/g, ' ').trim();
    paragraph = [];
    if (text.length >= 30) ensureSection().chunks.push(text.slice(0, 1200));
  }

  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      flushParagraph();
      current = { heading: cleanMarkdownText(heading[2]), level: heading[1].length, chunks: [] };
      sections.push(current);
      continue;
    }
    if (!line || /^\|/.test(line) || /^[-=]{3,}$/.test(line)) {
      flushParagraph();
      continue;
    }
    const clean = cleanMarkdownText(line);
    if (clean) paragraph.push(clean);
  }
  flushParagraph();
  return sections.filter((s) => s.heading || s.chunks.length);
}

function firstSummary(sections, fallback) {
  for (const s of sections) {
    for (const c of s.chunks) return c.slice(0, 500);
  }
  return fallback;
}

function buildDocStructure(repoAbs, docs) {
  const nodes = [];
  const edges = [];
  for (const rel of docs) {
    let md;
    try { md = fs.readFileSync(path.join(repoAbs, rel), 'utf8'); } catch { continue; }
    const sections = extractSections(md);
    const docId = stableId(['doc', rel]);
    const docKey = keyFor('source_doc', docId);
    nodes.push({
      key: docKey,
      type: 'source_doc',
      id: docId,
      label: rel,
      summary: firstSummary(sections, `Source document ${rel}`),
      source_path: rel,
      metadata: { origin: 'onboard-doc-miner' },
    });
    sections.forEach((section, si) => {
      const sectionId = stableId(['section', rel, String(si), section.heading]);
      const sectionKey = keyFor('source_section', sectionId);
      nodes.push({
        key: sectionKey,
        type: 'source_section',
        id: sectionId,
        label: `${rel}#${section.heading}`,
        summary: section.chunks[0] || section.heading,
        source_path: rel,
        section_ref: `${si}:${section.heading}`,
        metadata: { origin: 'onboard-doc-miner', parent_key: docKey, level: section.level },
      });
      edges.push({ from: docKey, to: sectionKey, kind: 'context', weight: 1.0 });
      section.chunks.forEach((chunk, ci) => {
        const chunkId = stableId(['chunk', rel, String(si), String(ci), chunk]);
        const chunkKey = keyFor('source_chunk', chunkId);
        nodes.push({
          key: chunkKey,
          type: 'source_chunk',
          id: chunkId,
          label: `${rel}#${section.heading} chunk ${ci + 1}`,
          summary: chunk,
          source_path: rel,
          section_ref: `${si}:${section.heading}`,
          chunk_ref: `${ci + 1}`,
          metadata: { origin: 'onboard-doc-miner', parent_key: sectionKey },
        });
        edges.push({ from: sectionKey, to: chunkKey, kind: 'context', weight: 1.0 });
      });
    });
  }
  return { nodes, edges };
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
  const STRUCTURE_OUT = path.join(outDir, 'doc-structure.json');
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
  const structure = buildDocStructure(repoAbs, docs);
  fs.writeFileSync(STRUCTURE_OUT, JSON.stringify(structure, null, 2) + '\n');
  console.error(`repo=${repoAbs} docs=${docs.length} emitted=${notes.length} structure_nodes=${structure.nodes.length} -> ${OUT}`);
  notes.slice(0, 3).forEach((n, i) => console.error(`\n[${i + 1}] (${n.kind}) ${n.title}\n    ${n.summary}`));
}

if (require.main === module) main();

module.exports = { buildDocStructure, extractSections, keyFor };
