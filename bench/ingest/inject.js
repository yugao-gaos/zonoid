#!/usr/bin/env node
/**
 * inject.js — populate the orchestrator graph with the ingest candidate knowledge-base.
 *
 * Reads bench/ingest/{git-notes,doc-notes,structure}.json and, on --confirm, posts each
 * KEPT note as an overlay note node (POST /overlay/note) with its title prefixed '[ingest] '
 * so injected nodes stay distinguishable and reversible. Each structural depends-on edge
 * becomes a context edge (POST /overlay/edge kind:context) between the corresponding
 * ingested struct-nodes.
 *
 * DEFAULT IS A DRY RUN: without --confirm this prints exactly what it WOULD create
 * (counts + first few) and exits 0 with NO network/graph mutation.
 *
 * Idempotent-ish: with --confirm it first reads GET /state and skips any note whose
 * '[ingest]' title already exists.
 *
 *   node bench/ingest/inject.js            # dry run (default, no mutation)
 *   node bench/ingest/inject.js --confirm  # perform the injection
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const DAEMON = process.env.ORCH_DAEMON || 'http://localhost:8787';
const CONFIRM = process.argv.includes('--confirm');
const PREFIX = '[ingest] ';
const HERE = __dirname;

// ---- load inputs ----------------------------------------------------------
function loadJSON(name) {
  const p = path.join(HERE, name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const gitNotes = loadJSON('git-notes.json');
const docNotes = loadJSON('doc-notes.json');
const structure = loadJSON('structure.json');

// ---- selection ------------------------------------------------------------
// KEEP doc-notes (distilled durable knowledge) + structural nodes/edges in full.
// From git-notes, DROP the transient benchmark-study checkpoints (v1-v4 process
// notes) and the README-findings commit that the doc-notes already cover in
// distilled form; KEEP the git-notes that capture a durable architectural
// decision/finding not otherwise represented. Sources are git SHAs.
const GIT_DROP_SOURCES = new Set([
  'f5c4bbadf0e641510b7a79a1670dc630ebb0092e', // v4 NO-WIN checkpoint (study process)
  '7f329ec1116c85a958007f0cf599717671a061f3', // v4 decomposition metric (study process)
  '28164d708a7a6c2157b20744e00fbacd559cd66a', // v4-hard task (study process)
  'a068e6aff77be7e4afbad557924e9457cfdae2e0', // README bench findings (dup of doc-notes)
  '91028c626fd835bb53215ab8f4ee7e727398351d', // v3 lean-consult run (study process)
  '185d77e26fa622c302f668612e727e2caa91db27', // bench tooling commit (study process)
  'b8a1d6bf494801f2aa49f26a00295e05731cc65a', // v1 baseline harness (study process)
]);

const keptGit = gitNotes.filter((n) => !GIT_DROP_SOURCES.has(n.source));
const keptNotes = [
  ...keptGit.map((n) => ({ ...n, _origin: 'git' })),
  ...docNotes.map((n) => ({ ...n, _origin: 'doc' })),
];

// Structural nodes become note nodes too (so edges have endpoints in the graph),
// titled by their module id with a one-line role summary.
const structNotes = structure.nodes.map((n) => ({
  title: n.id,
  summary: n.role,
  source: 'structure.json',
  kind: 'structure',
  _origin: 'struct',
}));

const allNoteCandidates = [...keptNotes, ...structNotes];
const structEdges = structure.edges; // depends-on -> context edges

// ---- http helpers ---------------------------------------------------------
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, DAEMON);
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      u,
      {
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json;
          try { json = data ? JSON.parse(data) : {}; } catch { json = { raw: data }; }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(`${method} ${urlPath} -> ${res.statusCode}: ${data}`));
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const titleFor = (n) => PREFIX + n.title;

// ---- dry-run report -------------------------------------------------------
function printPlan() {
  console.log('=== inject.js DRY RUN (no --confirm) ===');
  console.log(`daemon target: ${DAEMON}`);
  console.log('');
  console.log('Inputs:');
  console.log(`  git-notes:        ${gitNotes.length}  (kept ${keptGit.length}, dropped ${gitNotes.length - keptGit.length})`);
  console.log(`  doc-notes:        ${docNotes.length}  (kept ${docNotes.length})`);
  console.log(`  structure nodes:  ${structure.nodes.length}  (kept ${structNotes.length})`);
  console.log(`  structure edges:  ${structEdges.length}  -> ${structEdges.length} context edges`);
  console.log('');
  console.log(`WOULD CREATE ${allNoteCandidates.length} note nodes (each title prefixed '${PREFIX}') and ${structEdges.length} context edges.`);
  console.log('');
  console.log('First note nodes that would be created:');
  allNoteCandidates.slice(0, 6).forEach((n, i) => console.log(`  ${i + 1}. [${n._origin}] ${titleFor(n)}`));
  console.log('');
  console.log('First context edges that would be created (struct depends-on -> context):');
  structEdges.slice(0, 4).forEach((e, i) => console.log(`  ${i + 1}. ${PREFIX}${e.from}  --context-->  ${PREFIX}${e.to}`));
  console.log('');
  console.log('No network calls were made. Re-run with --confirm to inject.');
}

// ---- confirmed injection --------------------------------------------------
async function inject() {
  console.log('=== inject.js CONFIRMED injection ===');
  console.log(`daemon target: ${DAEMON}`);

  // Idempotency: map existing '[ingest]' titles -> note key.
  const existing = new Map(); // title (with prefix) -> 'note:<id>'
  try {
    const state = await request('GET', '/state');
    for (const t of state.tasks || []) {
      if (typeof t.label === 'string' && t.label.startsWith(PREFIX)) existing.set(t.label, t.id);
    }
  } catch (e) {
    console.error(`WARN: could not read /state for idempotency (${e.message}); proceeding without skip-set.`);
  }

  // Title -> note key, seeded with what already exists so edges can resolve endpoints.
  const keyByTitle = new Map(existing);
  let created = 0, skipped = 0;

  for (const n of allNoteCandidates) {
    const title = titleFor(n);
    if (keyByTitle.has(title)) { skipped++; continue; }
    const r = await request('POST', '/overlay/note', {
      title,
      summary: n.summary,
      knowledge: [`source:${n.source}`, `kind:${n.kind}`, `origin:${n._origin}`],
      created_by: 'ingest',
    });
    keyByTitle.set(title, r.key);
    created++;
  }

  // Structural edges -> context edges between the ingested struct note nodes.
  let edgesAdded = 0, edgesSkipped = 0;
  for (const e of structEdges) {
    const from = keyByTitle.get(PREFIX + e.from);
    const to = keyByTitle.get(PREFIX + e.to);
    if (!from || !to) { edgesSkipped++; continue; }
    await request('POST', '/overlay/edge', { from, to, kind: 'context' });
    edgesAdded++;
  }

  console.log('');
  console.log('Injection summary:');
  console.log(`  notes created:   ${created}`);
  console.log(`  notes skipped:   ${skipped}  (already present)`);
  console.log(`  context edges added:   ${edgesAdded}`);
  console.log(`  context edges skipped: ${edgesSkipped}  (missing endpoint)`);
  console.log('');
  console.log('Done. Ingested nodes are titled with the [ingest] prefix for easy filtering/removal.');
}

// ---- main -----------------------------------------------------------------
(async () => {
  if (!CONFIRM) { printPlan(); process.exit(0); }
  try { await inject(); }
  catch (e) { console.error('Injection FAILED:', e.message); process.exit(1); }
})();
