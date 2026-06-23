#!/usr/bin/env node
'use strict';
// scripts/onboard-code.js — the native code onboarder CLI (Phase 4). Feeds a repo's AST-extracted
// symbols into the daemon's dedicated code-index layer (overlay.code_nodes), which /search retrieves
// directly by cosine — the productized form of the benchmarked cmm-onboard pipeline.
//
//   node scripts/onboard-code.js --repo <abs> --workspace <ws> [--daemon <url>] [--sync] [--async]
//
// MODES:
//   (default) FULL onboard  — extract the WHOLE repo and bulk-ingest every symbol into the code-index
//                             (/overlay/code-nodes/bulk), then record lastIndexedCommit = HEAD so a
//                             later --sync has a baseline to diff from.
//   --sync    INCREMENTAL   — `git diff <lastIndexedCommit>..HEAD --name-status`; re-onboard only the
//                             changed files (replace added/modified, remove deleted) and advance the
//                             watermark. If no watermark exists yet (never fully onboarded), it
//                             transparently falls back to a FULL onboard.
//
// FLAGS:
//   --repo <abs>       (required) absolute path of the git repo to index.
//   --workspace <ws>   (required) workspace the code_nodes belong to (the /search namespace).
//   --daemon <url>     daemon base URL (default http://localhost:8787).
//   --sync             incremental git-diff sync instead of a full onboard.
//   --async            boot the tree-sitter WASM backend so non-JS/TS files (.py/.go/.rs/...) parse.
//                      Without it, only JS/TS/JSX symbols are extracted (babel needs no async init).
//   --help             print this usage.

const path = require('path');
const { execFileSync } = require('child_process');
const { ingestRepo } = require('../lib/code-extract/ingest');
const { syncRepo, httpDaemonClient } = require('../lib/code-extract/sync');

function parseArgs(argv) {
  const out = { daemon: 'http://localhost:8787', sync: false, async: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--workspace') out.workspace = argv[++i];
    else if (a === '--daemon') out.daemon = argv[++i];
    else if (a === '--sync') out.sync = true;
    else if (a === '--async') out.async = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const USAGE = `Usage: node scripts/onboard-code.js --repo <abs> --workspace <ws> [--daemon <url>] [--sync] [--async]

  --repo <abs>      absolute path of the git repo to index (required)
  --workspace <ws>  workspace the code_nodes belong to (required)
  --daemon <url>    daemon base URL (default http://localhost:8787)
  --sync            incremental git-diff sync (default is a full onboard)
  --async           boot tree-sitter so non-JS/TS files parse
  --help            show this message`;

function headCommit(repoAbs) {
  try { return String(execFileSync('git', ['-C', repoAbs, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()) || null; }
  catch { return null; }
}

// FULL onboard: extract the whole repo, bulk-ingest, then stamp lastIndexedCommit = HEAD.
async function fullOnboard({ repoAbs, workspace, daemon, async }) {
  const result = await ingestRepo(repoAbs, { daemonUrl: daemon, workspace, async });
  const head = headCommit(repoAbs);
  if (head) {
    try { await httpDaemonClient(daemon).setLastIndexedCommit({ key: repoAbs, commit: head, workspace }); }
    catch (e) { console.warn(`[onboard-code] warning: failed to record lastIndexedCommit: ${e.message}`); }
  }
  return { mode: 'full', repo: result.repo, symbols: result.symbols, created: result.created, edges: result.edges, edges_added: result.edges_added, batches: result.batches, stats: result.stats, head };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (!args.repo || !args.workspace) {
    console.error('error: --repo and --workspace are required\n');
    console.error(USAGE);
    process.exit(2);
  }
  const repoAbs = path.resolve(args.repo);
  const { workspace, daemon } = args;

  if (args.sync) {
    const sync = await syncRepo({ repo: repoAbs, workspace, daemon }, { async: args.async });
    if (sync.full_onboard_needed) {
      console.log(`[onboard-code] no prior index (${sync.reason}); running a FULL onboard instead.`);
      const full = await fullOnboard({ repoAbs, workspace, daemon, async: args.async });
      printSummary(full, { workspace, daemon });
      return;
    }
    printSummary({ mode: 'sync', repo: repoAbs, ...sync }, { workspace, daemon });
    return;
  }

  const full = await fullOnboard({ repoAbs, workspace, daemon, async: args.async });
  printSummary(full, { workspace, daemon });
}

function printSummary(r, { workspace, daemon }) {
  console.log('');
  console.log(`  onboard-code: ${r.mode.toUpperCase()}`);
  console.log(`  repo:       ${r.repo}`);
  console.log(`  workspace:  ${workspace}`);
  console.log(`  daemon:     ${daemon}`);
  if (r.mode === 'full') {
    console.log(`  symbols:    ${r.symbols}`);
    console.log(`  ingested:   ${r.created} (in ${r.batches} batch${r.batches === 1 ? '' : 'es'})`);
    if (r.edges != null) console.log(`  edges:      ${r.edges} resolved -> ${r.edges_added != null ? r.edges_added : r.edges} added (code↔code)`);
    if (r.stats && r.stats.by_language) {
      const langs = Object.entries(r.stats.by_language)
        .map(([ext, s]) => `${ext}:${s.symbols}`).join(' ');
      if (langs) console.log(`  by ext:     ${langs}`);
    }
    if (r.head) console.log(`  HEAD:       ${r.head}  (recorded as lastIndexedCommit)`);
  } else {
    if (r.up_to_date) {
      console.log(`  up to date: HEAD ${r.head} already indexed (no changes).`);
    } else {
      console.log(`  diff:       ${r.from}..${r.head}`);
      console.log(`  changed:    ${r.changed_files.length} file(s)`);
      console.log(`  replaced:   ${r.files_replaced} file(s) -> ${r.upserted} symbol(s) upserted`);
      console.log(`  deleted:    ${r.files_deleted} file(s) -> ${r.deleted} symbol(s) removed`);
      if (r.edges_replaced != null || r.edges_deleted != null) console.log(`  edges:      ${r.edges_replaced || 0} replaced, ${r.edges_deleted || 0} removed (code↔code)`);
      if (r.skipped && r.skipped.length) console.log(`  skipped:    ${r.skipped.length} non-code file(s)`);
      console.log(`  HEAD:       ${r.head}  (advanced lastIndexedCommit)`);
    }
  }
  console.log('');
}

main().catch((e) => { console.error(`[onboard-code] ${e && e.stack ? e.stack : e}`); process.exit(1); });
