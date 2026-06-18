#!/usr/bin/env node
// purge-gate-journal.js — remove rows with null/missing task_key from gate-journal.jsonl.
// These rows are permanently unlabelable (label drain requires task_key to correlate outcomes).
// Run: node scripts/purge-gate-journal.js [--workspace <path>] [--dry-run]
'use strict';
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const hasflag = (name) => process.argv.includes('--' + name);

const ws = arg('workspace', process.cwd());
const dryRun = hasflag('dry-run');
const file = path.join(ws, '.graph', 'gate-journal.jsonl');

if (!fs.existsSync(file)) { console.log('gate-journal.jsonl not found, nothing to purge'); process.exit(0); }

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const keep = [], drop = [];
for (const line of lines) {
  let row; try { row = JSON.parse(line); } catch { keep.push(line); continue; }
  if (row && row.task_key) keep.push(line); else drop.push(line);
}

console.log(`Total: ${lines.length}  Keep (has task_key): ${keep.length}  Drop (null task_key): ${drop.length}`);
if (dryRun) { console.log('dry-run — no changes written'); process.exit(0); }
fs.writeFileSync(file, keep.join('\n') + (keep.length ? '\n' : ''), 'utf8');
console.log('purged. gate-journal.jsonl now has', keep.length, 'rows');
