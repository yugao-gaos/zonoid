#!/usr/bin/env node
// Refresh the frozen KB snapshot from the live .graph for held-out retrieval bench reproducibility.
//
// Usage: node scripts/bench-snapshot-refresh.js
'use strict';
const fs = require('fs');
const path = require('path');
const { ensureSnapshot, SNAPSHOT_WS, SNAPSHOT_GRAPH } = require('./bench-snapshot-daemon');

const MANIFEST_PATH = path.join(SNAPSHOT_WS, 'manifest.json');

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error('manifest missing at ' + MANIFEST_PATH);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function writeManifest(manifest) {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  const tmp = MANIFEST_PATH + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(tmp, MANIFEST_PATH);
}

try {
  ensureSnapshot(true);
  const manifest = loadManifest();
  manifest.refreshed_at = new Date().toISOString();
  writeManifest(manifest);
  console.log(SNAPSHOT_GRAPH);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
