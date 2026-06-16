#!/usr/bin/env node
/**
 * bench-mine-journals.js — bulk KB miner for bench held-out journals.
 *
 * Reads bench/heldout/results-heldout.jsonl, finds the archived journal for each
 * row, runs extract-decisions.js on it, merges all candidates, and writes
 * bench/heldout/journals/CANDIDATES.json.
 *
 * Usage:
 *   node scripts/bench-mine-journals.js                    # dry-run (default)
 *   node scripts/bench-mine-journals.js --confirm          # also inject into KB
 *   node scripts/bench-mine-journals.js --results <path>   # alternate results file
 *   node scripts/bench-mine-journals.js --all              # include arm=off rows
 *   node scripts/bench-mine-journals.js --include-failed   # include solved=false rows
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = process.env.ZONOID_REPO || path.resolve(__dirname, '..');

function flag(name) { return process.argv.includes(name); }
function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const CONFIRM = flag('--confirm');
const ALL_ARMS = flag('--all');
const INCLUDE_FAILED = flag('--include-failed');
const resultsPath = argVal('--results') || path.join(REPO, 'bench', 'heldout', 'results-heldout.jsonl');
const extractScript = path.join(REPO, 'scripts', 'extract-decisions.js');
const journalDir = path.join(REPO, 'bench', 'heldout', 'journals');
const candidatesOut = path.join(journalDir, 'CANDIDATES.json');

// ---- read results -----------------------------------------------------------
let rows;
try {
  rows = fs.readFileSync(resultsPath, 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => JSON.parse(l));
} catch (e) {
  console.error('Cannot read results file:', e.message);
  process.exit(1);
}

// ---- filter rows ------------------------------------------------------------
const filtered = rows.filter((row) => {
  if (!ALL_ARMS && row.arm === 'off') return false;
  if (!INCLUDE_FAILED && !row.solved) return false;
  return true;
});

console.log(`Results: ${rows.length} total, ${filtered.length} after filters (arm=off excluded: ${!ALL_ARMS}, failed excluded: ${!INCLUDE_FAILED})`);

// ---- process journals -------------------------------------------------------
const allCandidates = [];
let processed = 0;
let skipped = 0;

for (const row of filtered) {
  // prefer archived journal, fall back to original transcript path
  const journalPath = row.journalPath || row.transcriptPath;
  if (!journalPath || !fs.existsSync(journalPath)) {
    skipped++;
    continue;
  }

  const result = spawnSync('node', [extractScript, journalPath, '--no-dedup'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });

  if (result.status !== 0) {
    console.warn(`  [warn] extract-decisions failed for ${path.basename(journalPath)}: ${(result.stderr || '').slice(0, 200)}`);
    skipped++;
    continue;
  }

  // extract-decisions writes CANDIDATES.json to its default location; we capture stdout for
  // the candidate list. The script also prints a dry-run summary to stdout — parse JSON lines.
  let candidates = [];
  try {
    // The script may write to a --out path; without --out it writes to bench/extract/CANDIDATES.json.
    // Run with explicit --out to a temp path so we can read back the structured data.
    const tmpOut = path.join(journalDir, `_tmp_${path.basename(journalPath, '.jsonl')}.json`);
    const r2 = spawnSync('node', [extractScript, journalPath, '--no-dedup', '--out', tmpOut], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    if (fs.existsSync(tmpOut)) {
      candidates = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));
      fs.rmSync(tmpOut);
    }
  } catch { /* fall through with empty */ }

  // Annotate each candidate with source provenance
  for (const c of candidates) {
    c._source = {
      sessionId: row.sessionId,
      candidate: row.candidate,
      arm: row.armLabel || row.arm,
      trial: row.trial,
      journalPath,
    };
  }

  allCandidates.push(...candidates);
  processed++;
  console.log(`  [ok] ${row.candidate} arm=${row.armLabel || row.arm} trial=${row.trial} → ${candidates.length} candidates`);
}

// ---- write merged CANDIDATES.json -------------------------------------------
fs.mkdirSync(journalDir, { recursive: true });
fs.writeFileSync(candidatesOut, JSON.stringify(allCandidates, null, 2));

console.log(`\nSummary: ${processed} journals processed, ${skipped} skipped, ${allCandidates.length} candidates extracted`);
console.log(`Merged candidates written to: ${candidatesOut}`);

if (CONFIRM) {
  console.log('\n--confirm: injecting candidates into KB (running extract-decisions --confirm per journal)...');
  let injected = 0;
  for (const row of filtered) {
    const journalPath = row.journalPath || row.transcriptPath;
    if (!journalPath || !fs.existsSync(journalPath)) continue;
    const r = spawnSync('node', [extractScript, journalPath, '--confirm'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (r.status === 0) injected++;
  }
  console.log(`Injection complete: ${injected} journals processed.`);
} else {
  console.log(`\nRun with --confirm to inject into KB, or:`);
  console.log(`  node scripts/extract-decisions.js ${candidatesOut} --confirm`);
}
