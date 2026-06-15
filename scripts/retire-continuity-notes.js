#!/usr/bin/env node
// One-time BACKFILL (task 3b): retire the existing auto-generated
// "Continuity: stale claim reset" note nodes that pollute search_knowledge (RAG recall)
// and judge clustering. Task 3a already stopped releaseClaim from creating new ones.
//
// MECHANISM: these notes carry zero durable knowledge value (auto-generated transients),
// and the store has NO hard-delete event type. We reuse the EXISTING retirement primitive:
// append a `note_superseded` event with `validTo` set but NO `supersededBy` (a retire-without-
// replacement — there is no successor note). graph-store.js replays note_superseded by setting
// node.validTo from ev.validTo independently of supersededBy, so the note becomes non-current.
// A non-current (validTo != null) note is excluded from BOTH:
//   - default search_knowledge        (routes/graph.js: `else ok = !node.validTo`)
//   - the gated RAG candidate pool     (routes/graph.js: `... || n.validTo || ...` skip)
//   - judge buildQueue orphan/edge set (lib/judge.js: `if (n.validTo != null) continue`)
//   - judge dup-cluster pass           (lib/judge.js: `.filter(n => n.validTo == null ...)`)
// while preserving the node + edges as bitemporal history (recoverable via ?history=1 / ?asOf).
//
// IDEMPOTENT: skips notes that already have validTo set. Targets the store path given on argv
// (the LIVE main checkout .graph, NOT the worktree copy). Requires a daemon reload/restart to
// take effect in the running daemon's in-memory overlay (the daemon reads state.overlay, and
// note_nodes are NOT in overlay LOCAL_FIELDS — they live only in the graph-store event log).
//
// Usage:
//   node scripts/retire-continuity-notes.js <graphDir> [--apply]
// Default is DRY-RUN; pass --apply to write the note_superseded events.

const path = require('path');
const graphStore = require(path.join(__dirname, '..', 'lib', 'graph-store.js'));

const TITLE_PREFIX = 'Continuity: stale claim reset';

function main() {
  const graphDir = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!graphDir) {
    console.error('usage: node scripts/retire-continuity-notes.js <graphDir> [--apply]');
    process.exit(2);
  }

  const store = graphStore.open(graphDir);
  const { nodes } = graphStore.loadGraph(store);

  const allContinuity = [];
  const targets = []; // current (validTo == null) continuity notes — the retire set
  for (const [key, node] of Object.entries(nodes)) {
    if (node.kind !== 'note' || !node.note) continue;
    const title = node.note.title || '';
    if (!title.startsWith(TITLE_PREFIX)) continue;
    allContinuity.push(key);
    if (!node.validTo) targets.push(key);
  }

  console.log(`graphDir:                 ${graphDir}`);
  console.log(`continuity notes (total): ${allContinuity.length}`);
  console.log(`already retired:          ${allContinuity.length - targets.length}`);
  console.log(`CURRENT (to retire):      ${targets.length}`);
  console.log(`mode:                     ${apply ? 'APPLY' : 'DRY-RUN'}`);

  if (!apply) {
    console.log('\n-- dry run, no writes. Re-run with --apply to retire. --');
    for (const k of targets) console.log(`  would retire ${k}`);
    return;
  }

  const at = new Date().toISOString();
  let retired = 0;
  for (const key of targets) {
    const bareId = key.startsWith('note:') ? key.slice('note:'.length) : key;
    // note_superseded with validTo set, NO supersededBy → retire-without-replacement.
    graphStore.appendEvent(store, key, {
      evt: 'note_superseded',
      id: bareId,
      validTo: at,
      ts: at,
      actor: 'continuity-note-purge',
    });
    retired++;
  }
  console.log(`\nretired: ${retired} note(s) at ${at}`);

  // Verify round-trip: reload the store and confirm the targets are now non-current.
  const { nodes: after } = graphStore.loadGraph(graphStore.open(graphDir));
  let stillCurrent = 0;
  for (const key of targets) {
    const n = after[key];
    if (n && !n.validTo) stillCurrent++;
  }
  console.log(`post-reload still current: ${stillCurrent} (expect 0)`);
  if (stillCurrent !== 0) process.exit(1);
}

main();
