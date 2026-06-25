#!/usr/bin/env node
// Backfill orphan NOTE nodes: every note currently with ZERO edges is replayed through the daemon's
// provider auto-wiring (POST /overlay/note/rewire), which writes note -> neighbor context edges
// (score >= threshold, skips `done` targets, top-5). The daemon owns the scoring so we never
// duplicate scoreMatches here. DRY-RUN by default; pass --confirm to apply. Idempotent (addEdge
// dedupes; already-wired notes are skipped because they have edges).
//
// Usage: node scripts/rewire-notes.js [--confirm] [--daemon http://localhost:8787]
'use strict';
const http = require('http');

const DAEMON = process.env.ORCH_DAEMON || arg('daemon', 'http://localhost:8787');
const CONFIRM = process.argv.includes('--confirm');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

// Same http helper shape as scripts/onboard-learn.js.
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, DAEMON);
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(u, {
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json; try { json = data ? JSON.parse(data) : {}; } catch { json = { raw: data }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else reject(new Error(`${method} ${urlPath} -> ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Count edges touching each node id (either endpoint). An "orphan note" has zero.
function orphanNotes(state) {
  const tasks = state.tasks || [];
  const edges = state.edges || [];
  const touched = new Set();
  for (const e of edges) { touched.add(e.from); touched.add(e.to); }
  return tasks.filter((t) => t.kind === 'note' && !touched.has(t.id));
}

function counts(state) {
  const notes = (state.tasks || []).filter((t) => t.kind === 'note');
  const orphans = orphanNotes(state);
  const isIngest = (n) => /\[ingest\]/i.test(n.label || '') || /\[ingest\]/i.test(n.summary || '');
  const byKind = {};
  for (const e of (state.edges || [])) byKind[e.kind || 'blocking'] = (byKind[e.kind || 'blocking'] || 0) + 1;
  return {
    notes: notes.length,
    orphanNotes: orphans.length,
    ingestOrphans: orphans.filter(isIngest).length,
    edgesByKind: byKind,
  };
}

(async () => {
  let state;
  try { state = await request('GET', '/state'); }
  catch (e) { console.error(`FATAL: could not read /state from ${DAEMON}: ${e.message}`); process.exit(2); }

  const before = counts(state);
  const orphans = orphanNotes(state);
  console.log(`=== rewire-notes ${CONFIRM ? 'CONFIRMED' : 'DRY RUN'} (daemon: ${DAEMON}) ===`);
  console.log('BEFORE:', JSON.stringify(before));
  console.log(`Found ${orphans.length} orphan note node(s) with zero edges.`);

  if (!CONFIRM) {
    orphans.slice(0, 12).forEach((n, i) => console.log(`  ${i + 1}. ${n.id} — ${(n.label || '').slice(0, 70)}`));
    if (orphans.length > 12) console.log(`  … and ${orphans.length - 12} more`);
    console.log('\nNo changes made. Re-run with --confirm to wire these as context providers.');
    return;
  }

  let wired = 0, edgesAdded = 0, failed = 0;
  for (const n of orphans) {
    try {
      const r = await request('POST', '/overlay/note/rewire', { key: n.id });
      if (r.autowired > 0) { wired++; edgesAdded += r.autowired; }
    } catch (e) {
      failed++;
      console.error(`  FAIL ${n.id}: ${e.message}`);
    }
  }
  console.log(`Notes that gained >=1 edge: ${wired}; total edges added: ${edgesAdded}; failures: ${failed}`);

  // Re-read for an authoritative after-picture.
  const after = counts(await request('GET', '/state'));
  console.log('AFTER: ', JSON.stringify(after));
  console.log(`orphan notes: ${before.orphanNotes} -> ${after.orphanNotes}`);
  console.log(`[ingest] orphans: ${before.ingestOrphans} -> ${after.ingestOrphans}`);
})();
