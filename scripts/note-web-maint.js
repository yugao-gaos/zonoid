#!/usr/bin/env node
// One-shot maintenance for the SEMANTIC note-web upgrade, run against the cloude overlay WITHOUT
// going through the live daemon (which is loaded on a DIFFERENT workspace, so the cloude overlay
// file has no concurrent writer — no clobber). Replicates the new daemon endpoints' logic using the
// daemon's exported functions + overlayStore directly.
// Usage: node scripts/note-web-maint.js <reembed|tune|rewire> [--threshold 0.55] [--confirm]
'use strict';
const http = require('http');
const ov = require('../lib/overlay');
const { embed, DIMS } = require('../lib/embed');
const { autowireNoteProvider, SEMANTIC_AUTOWIRE_THRESHOLD } = require('../daemon');

const WS = process.env.ZONOID_WORKSPACE || process.cwd();
const DAEMON = process.env.ORCH_DAEMON || 'http://localhost:8787';

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const MODE = process.argv[2];
const CONFIRM = process.argv.includes('--confirm');
const THRESHOLD = parseFloat(arg('threshold', String(SEMANTIC_AUTOWIRE_THRESHOLD)));

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(new URL(urlPath, DAEMON), (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function buildGraph(overlay) {
  const state = await get(`/state?workspace=${encodeURIComponent(WS)}`);
  const realTasks = (state.tasks || []).filter((t) => t.kind !== 'note');
  const noteTasks = Object.values(overlay.note_nodes || {}).map((n) => ({
    id: 'note:' + n.id, label: n.title, kind: 'note', status: 'note',
    summary: n.summary, vec: Array.isArray(n.vec) ? n.vec : null,
    validTo: n.validTo || null, context_deps: [], deps: [],
  }));
  return { tasks: [...realTasks, ...noteTasks] };
}

(async () => {
  const overlay = ov.load(WS);

  if (MODE === 'reembed') {
    let embedded = 0, skipped = 0, failed = 0;
    for (const n of Object.values(overlay.note_nodes || {})) {
      if (Array.isArray(n.vec) && n.vec.length === DIMS) { skipped++; continue; }
      const v = await embed(`${n.title || ''} ${n.summary || ''}`);
      if (v) { n.vec = v; embedded++; } else failed++;
    }
    ov.save(WS, overlay);
    const all = Object.values(overlay.note_nodes || {});
    const withVec = all.filter((n) => Array.isArray(n.vec) && n.vec.length === DIMS).length;
    console.log(JSON.stringify({ ok: true, embedded, skipped, failed, total: all.length, withVec384: withVec }, null, 2));
    return;
  }

  if (MODE === 'tune') {
    const g = await buildGraph(overlay);
    const notes = g.tasks.filter((t) => t.kind === 'note' && t.validTo == null);
    console.log(`Tuning on ${notes.length} current notes (real tasks: ${g.tasks.filter((t) => t.kind !== 'note').length})\n`);
    console.log('thresh | edges | note->note | note->task | notes_wired | max_outdeg | mean_outdeg');
    for (const th of [0.45, 0.55, 0.65, 0.75]) {
      const sim = ov.EMPTY();
      for (const n of notes) autowireNoteProvider(sim, g, n.id, n.label, n.summary, n.vec, th);
      const noteIds = new Set(notes.map((n) => n.id));
      let n2n = 0, n2t = 0; const outdeg = {};
      for (const e of sim.edges) { outdeg[e.from] = (outdeg[e.from] || 0) + 1; if (noteIds.has(e.to)) n2n++; else n2t++; }
      const degs = Object.values(outdeg);
      const maxd = degs.length ? Math.max(...degs) : 0;
      const meand = degs.length ? (degs.reduce((a, b) => a + b, 0) / degs.length) : 0;
      console.log(`${th.toFixed(2)}   | ${String(sim.edges.length).padStart(5)} | ${String(n2n).padStart(10)} | ${String(n2t).padStart(10)} | ${String(degs.length).padStart(11)} | ${String(maxd).padStart(10)} | ${meand.toFixed(2)}`);
    }
    return;
  }

  if (MODE === 'rewire') {
    const g = await buildGraph(overlay);
    const touched = new Set();
    for (const e of overlay.edges) { touched.add(e.from); touched.add(e.to); }
    const orphans = g.tasks.filter((t) => t.kind === 'note' && t.validTo == null && !touched.has(t.id));
    const isIngest = (n) => /\[ingest\]/i.test(n.label || '') || /\[ingest\]/i.test(n.summary || '');
    const countOrphans = () => {
      const tch = new Set(); for (const e of overlay.edges) { tch.add(e.from); tch.add(e.to); }
      const orph = g.tasks.filter((t) => t.kind === 'note' && t.validTo == null && !tch.has(t.id));
      return { orphanNotes: orph.length, ingestOrphans: orph.filter(isIngest).length };
    };
    const byKind = () => { const k = {}; for (const e of overlay.edges) k[e.kind || 'blocking'] = (k[e.kind || 'blocking'] || 0) + 1; return k; };
    const before = { ...countOrphans(), edgesByKind: byKind(), totalEdges: overlay.edges.length };
    console.log(`=== note-web rewire ${CONFIRM ? 'CONFIRMED' : 'DRY RUN'} @ threshold ${THRESHOLD} ===`);
    console.log('BEFORE:', JSON.stringify(before));
    console.log(`orphan notes to rewire: ${orphans.length}\n`);
    if (!CONFIRM) { console.log('DRY RUN — re-run with --confirm to apply.'); return; }
    const titleOf = (id) => { const t = g.tasks.find((x) => x.id === id); return t ? t.label : id; };
    const noteIds = new Set(g.tasks.filter((t) => t.kind === 'note').map((t) => t.id));
    const beforeEdgeKeys = new Set(overlay.edges.map((e) => e.from + ' ' + e.to));
    let wired = 0, edgesAdded = 0;
    for (const n of orphans) {
      const added = autowireNoteProvider(overlay, g, n.id, n.label, n.summary, n.vec, THRESHOLD);
      if (added > 0) { wired++; edgesAdded += added; }
    }
    ov.save(WS, overlay);
    const after = { ...countOrphans(), edgesByKind: byKind(), totalEdges: overlay.edges.length };
    console.log(`notes that gained >=1 edge: ${wired}; edges added: ${edgesAdded}`);
    console.log('AFTER: ', JSON.stringify(after));
    const newNoteEdges = overlay.edges.filter((e) => !beforeEdgeKeys.has(e.from + ' ' + e.to) && noteIds.has(e.from) && noteIds.has(e.to));
    console.log(`\n=== ${newNoteEdges.length} NEW note->note edges (showing up to 12, with cosine weight) ===`);
    for (const e of newNoteEdges.slice(0, 12)) {
      console.log(`  [${e.weight.toFixed(3)}] ${titleOf(e.from).slice(0, 58)}  ->  ${titleOf(e.to).slice(0, 58)}`);
    }
    const outdeg = {}; for (const e of overlay.edges) if (noteIds.has(e.from)) outdeg[e.from] = (outdeg[e.from] || 0) + 1;
    const maxOut = Object.values(outdeg).length ? Math.max(...Object.values(outdeg)) : 0;
    console.log(`\nmax note out-degree (all note-origin edges): ${maxOut}`);
    return;
  }
  console.error('usage: note-web-maint.js <reembed|tune|rewire> [--threshold X] [--confirm]');
  process.exit(1);
})();
