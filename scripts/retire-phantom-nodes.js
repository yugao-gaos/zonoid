#!/usr/bin/env node
// Soft-retire overlay-only phantom nodes that were created by the unknown-key bug
// (task d42ebe37-ee9f-46b6-ae21-f6f82464d482/13): write ops accepted bare numeric
// keys like "1", "3", etc. (which never matched any real native task key) and set
// status/assignee on phantom entries in the overlay's in-memory maps, creating ghost
// state that pollutes the graph and confuses the dispatch loop.
//
// MECHANISM: phantom task nodes have graph-store JSONL files (status_changed events
// were written to them by overlay-sync). We retire them by appending a status_changed
// event with status "canceled" to each JSONL file — the same event graph-store emits
// when a task is canceled — so a reload correctly reads them as terminal and ignores
// them for dispatch/ready decisions.
//
// IDEMPOTENT: skips nodes whose last status is already "canceled".
// REVERSIBLE: no data is deleted; the JSONL event log is append-only.
// SCOPE: only bare-integer-keyed nodes (no '/' separator, all digits) that have no
// corresponding native task in the current workspace. Requires the graph dir as argv.
//
// Usage:
//   node scripts/retire-phantom-nodes.js <graphDir> [--apply]
// Default is DRY-RUN; pass --apply to write the status_changed events.

'use strict';
const fs   = require('fs');
const path = require('path');

// Inline the codec from graph-store to avoid a full daemon require:
function idToFile(id) {
  return id.replace(/:/g, '%3A') + '.jsonl';
}

// A node key is a "bare integer phantom" if:
//   1. The key is entirely digits (no UUID, no '/' separator, no 'note:' prefix).
//   2. The JSONL file exists (meaning overlay-sync wrote events to it — it was touched
//      by the write-op bug).
function isBareIntegerKey(key) {
  return /^\d+$/.test(key);
}

// Read the last status from a JSONL event log (linear scan — files are small).
function lastStatusFromJsonl(filePath) {
  let last = null;
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.evt === 'status_changed' && ev.status) last = ev.status;
      } catch { /* skip malformed line */ }
    }
  } catch { /* file unreadable — treat as unknown */ }
  return last;
}

const TERMINAL = new Set(['done', 'tested', 'failed', 'canceled']);

function main() {
  const graphDir = process.argv[2];
  const apply    = process.argv.includes('--apply');
  if (!graphDir) {
    console.error('usage: node scripts/retire-phantom-nodes.js <graphDir> [--apply]');
    process.exit(2);
  }

  const nodesDir = path.join(graphDir, 'nodes');
  if (!fs.existsSync(nodesDir)) {
    console.log(`nodesDir does not exist: ${nodesDir}`);
    process.exit(0);
  }

  // Enumerate JSONL files directly in nodesDir (not recursive — phantom nodes are top-level).
  let files;
  try {
    files = fs.readdirSync(nodesDir).filter((f) => f.endsWith('.jsonl'));
  } catch (e) {
    console.error(`cannot read nodesDir: ${e.message}`);
    process.exit(1);
  }

  const candidates = []; // bare-integer phantom keys to inspect
  for (const f of files) {
    const key = f.slice(0, -'.jsonl'.length); // strip .jsonl
    if (isBareIntegerKey(key)) candidates.push(key);
  }

  console.log(`graphDir:              ${graphDir}`);
  console.log(`phantom candidates:    ${candidates.length} (bare-integer-keyed JSONL files)`);

  const toRetire = [];
  const alreadyTerminal = [];
  for (const key of candidates) {
    const filePath = path.join(nodesDir, idToFile(key));
    const lastStatus = lastStatusFromJsonl(filePath);
    if (TERMINAL.has(lastStatus)) {
      alreadyTerminal.push({ key, status: lastStatus });
    } else {
      toRetire.push({ key, lastStatus });
    }
  }

  console.log(`already terminal:      ${alreadyTerminal.length}`);
  console.log(`to retire (non-terminal): ${toRetire.length}`);
  console.log(`mode:                  ${apply ? 'APPLY' : 'DRY-RUN'}`);

  if (!apply) {
    console.log('\n-- dry run, no writes. Re-run with --apply to retire. --');
    for (const { key, lastStatus } of toRetire) {
      console.log(`  would retire ${key} (last status: ${lastStatus || 'none'})`);
    }
    return;
  }

  const at = new Date().toISOString();
  let retired = 0;
  for (const { key } of toRetire) {
    const filePath = path.join(nodesDir, idToFile(key));
    const event = JSON.stringify({
      evt: 'status_changed',
      id: key,
      status: 'canceled',
      actor: 'retire-phantom-nodes',
      note: 'phantom node retired: key was a bare integer with no matching native task (unknown-key bug, task d42ebe37/13)',
      ts: at,
    }) + '\n';
    fs.appendFileSync(filePath, event);
    retired++;
  }
  console.log(`\nretired: ${retired} phantom node(s) at ${at}`);

  // Verify round-trip: re-read and confirm they now read as "canceled".
  let stillActive = 0;
  for (const { key } of toRetire) {
    const filePath = path.join(nodesDir, idToFile(key));
    const status = lastStatusFromJsonl(filePath);
    if (status !== 'canceled') stillActive++;
  }
  console.log(`post-reload still active: ${stillActive} (expect 0)`);
  if (stillActive !== 0) process.exit(1);
}

main();
