#!/usr/bin/env node
/**
 * bench-kb-dedup-audit.js — offline clone-cluster audit for retrieval bench diagnostics.
 *
 * Loads note_nodes from bench/snapshot/.graph when present, else the live workspace overlay.
 * Clusters current notes (validTo==null, with vec) by title-vec cosine >= threshold (default 0.70).
 * Writes bench/retrieval/clone-audit.json listing clusters of size >= 2.
 *
 *   node scripts/bench-kb-dedup-audit.js
 *   node scripts/bench-kb-dedup-audit.js --threshold=0.70 --no-write
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { cosine } = require('../lib/embed');
const overlay = require('../lib/overlay');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT_WS = path.join(ROOT, 'bench', 'snapshot');
const SNAPSHOT_GRAPH = path.join(SNAPSHOT_WS, '.graph');
const OUT_PATH = path.join(ROOT, 'bench', 'retrieval', 'clone-audit.json');
const LIVE_WS = process.env.ZONOID_WORKSPACE || ROOT;

const THRESHOLD = (() => {
  const a = process.argv.find((x) => x.startsWith('--threshold='));
  return a ? Number(a.slice('--threshold='.length)) : 0.70;
})();
const WRITE = !process.argv.includes('--no-write');

const HIGHLIGHT_RE = /locale[- ]?sum|de-de|de_de|amount feed|sum-amounts/i;

function loadOverlay() {
  if (fs.existsSync(SNAPSHOT_GRAPH)) {
    return { ov: overlay.load(SNAPSHOT_WS), source: 'bench/snapshot/.graph' };
  }
  return { ov: overlay.load(LIVE_WS), source: 'live' };
}

function clusterNotes(noteNodes, threshold) {
  const notes = Object.values(noteNodes || {})
    .filter((n) => n.validTo == null && Array.isArray(n.vec) && n.vec.length)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const N = notes.length;
  const parent = notes.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const uni = (a, b) => { parent[find(a)] = find(b); };
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (cosine(notes[i].vec, notes[j].vec) >= threshold) uni(i, j);
    }
  }
  const comps = new Map();
  for (let i = 0; i < N; i++) {
    const r = find(i);
    (comps.get(r) || comps.set(r, []).get(r)).push(i);
  }
  const clusters = [];
  for (const members of comps.values()) {
    if (members.length < 2) continue;
    const items = members.map((i) => ({
      key: 'note:' + notes[i].id,
      id: notes[i].id,
      title: notes[i].title || '',
    }));
    items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const titles = items.map((x) => x.title);
    const text = titles.join(' ');
    clusters.push({
      size: items.length,
      signature: items.map((x) => x.key).join('|'),
      keys: items.map((x) => x.key),
      titles,
      highlight: HIGHLIGHT_RE.test(text),
    });
  }
  clusters.sort((a, b) => b.size - a.size || (a.signature < b.signature ? -1 : 1));
  return { notesWithVec: N, clusters };
}

function main() {
  const { ov, source } = loadOverlay();
  const { notesWithVec, clusters } = clusterNotes(ov.note_nodes, THRESHOLD);
  const highlights = clusters.filter((c) => c.highlight);
  const report = {
    generated_at: new Date().toISOString(),
    source,
    threshold: THRESHOLD,
    notes_with_vec: notesWithVec,
    cluster_count: clusters.length,
    clone_note_count: clusters.reduce((s, c) => s + c.size, 0),
    highlights: highlights.map(({ size, signature, titles }) => ({ size, signature, titles })),
    clusters: clusters.map(({ size, signature, keys, titles, highlight }) => ({
      size, signature, keys, titles, highlight,
    })),
  };
  if (WRITE) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({
    source,
    threshold: THRESHOLD,
    notes_with_vec: notesWithVec,
    cluster_count: clusters.length,
    highlight_count: highlights.length,
    top: clusters.slice(0, 5).map((c) => ({ size: c.size, highlight: c.highlight, titles: c.titles.slice(0, 3) })),
    out: WRITE ? OUT_PATH : null,
  }, null, 2));
}

main();
