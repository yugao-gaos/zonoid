#!/usr/bin/env node
// Idempotent one-shot: rename existing colon-bearing .graph/nodes/ files to their
// Windows-safe '%3A' form (matching lib/graph-store.js idToFile). Node IDs like
// 'note:note-XXXX.jsonl' and 'system:repos.jsonl' contain ':', which Windows forbids
// in filenames (breaks git checkout). The on-disk name changes; the in-memory node ID
// (with ':') is unchanged, so all edges/checkpoint refs still resolve.
//
// '/' is an intentional subdir separator and is preserved (not encoded).
//
// Usage: node scripts/migrate-graph-filenames.js [.graph/nodes dir]
//        (defaults to .graph/nodes under cwd)
//
// Prefers `git mv` for tracked files so the rename is recorded; falls back to
// fs.renameSync for untracked files. Skips files already in '%3A' form or with no ':'.
'use strict';
const fs            = require('fs');
const path          = require('path');
const { execFileSync } = require('child_process');

const nodesDir = process.argv[2] || path.join(process.cwd(), '.graph', 'nodes');

function isGitTracked(file) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', file], {
      cwd: path.dirname(file), stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function gitMv(src, dest) {
  execFileSync('git', ['mv', path.basename(src), path.basename(dest)], {
    cwd: path.dirname(src), stdio: 'ignore',
  });
}

function main() {
  let files;
  try {
    files = fs.readdirSync(nodesDir, { recursive: true });
  } catch (e) {
    console.error(`cannot read ${nodesDir}: ${e.message}`);
    process.exit(1);
  }

  let renamed = 0, skipped = 0;
  for (const rel of files) {
    if (!rel.endsWith('.jsonl')) continue;
    const base = path.basename(rel);
    if (!base.includes(':')) { skipped++; continue; } // already safe / no colon
    const srcAbs  = path.join(nodesDir, rel);
    const destRel = rel.split(path.sep).join('/').replace(/:/g, '%3A');
    const destAbs = path.join(nodesDir, destRel);
    if (fs.existsSync(destAbs)) { skipped++; continue; } // target already exists — idempotent

    try {
      if (isGitTracked(srcAbs)) gitMv(srcAbs, destAbs);
      else                      fs.renameSync(srcAbs, destAbs);
      renamed++;
    } catch (e) {
      console.error(`failed to rename ${rel}: ${e.message}`);
    }
  }

  console.log(`migrate-graph-filenames: renamed ${renamed}, skipped ${skipped} (dir: ${nodesDir})`);
}

main();
