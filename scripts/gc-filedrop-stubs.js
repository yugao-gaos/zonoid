#!/usr/bin/env node
'use strict';

// gc-filedrop-stubs.js — file-drop stub retention sweep.
//
// Scans <dataDir>/tasks/<workspace-key>/** for mint stub JSON files, adopts any missing
// overlay snapshots, and removes stubs that are terminal (overlay done/tested/failed/canceled
// or snapshot status completed with no in_progress override).
//
// DRY RUN by default. --confirm executes removals and saves overlay when adoptions occurred.
// Flags: --workspace <abs path> (required), --confirm.
//
// Dependency-free. Node >= 16.

const fs = require('fs');
const path = require('path');
const overlayStore = require('../lib/overlay');
const filedropGc = require('../lib/filedrop-gc');

function parseArgs(argv) {
  const opts = { confirm: false, workspace: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') opts.confirm = true;
    else if (a === '--workspace') opts.workspace = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: gc-filedrop-stubs.js --workspace <abs path> [--confirm]');
    process.exit(0);
  }
  if (!opts.workspace) {
    console.error('--workspace <abs path> is required');
    process.exit(2);
  }
  let workspace = opts.workspace;
  try { workspace = fs.realpathSync(workspace); } catch { workspace = path.resolve(workspace); }

  const ov = overlayStore.load(workspace);
  const result = filedropGc.sweepWorkspaceStubs(workspace, ov, { dryRun: !opts.confirm });
  if (opts.confirm && result.adopted.length) overlayStore.save(workspace, ov);

  const summary = {
    dry_run: !opts.confirm,
    workspace,
    adopted: result.adopted,
    removed: result.removed,
    skipped: result.skipped,
  };
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main();
