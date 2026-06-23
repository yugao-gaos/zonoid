#!/usr/bin/env node
'use strict';
// P6 — ON-DEMAND JUDGE-DRAIN CLI (the strict JUDGING-gate un-gate).
//
// Usage: node scripts/judge-drain-once.js --node <key> --workspace <ws> [--budget N]
//
// The P6 JUDGING→READY gate is STRICT: a node carrying any unjudged autowire candidate edge is held
// not_ready with NO time-based auto-release (see lib/judge.js judgingState). The happy path drains it
// automatically — the EAGER judge dispatches on node-add. This CLI is the manual recovery path for
// when the eager judge has stalled (crashed / not running / repeatedly erroring): it synchronously
// drives the SAME in-process judge against the node's candidate edge-set until it drains (or the
// budget/round ceiling), so an operator can always un-gate a held node deterministically — there is no
// state in which a node is held with no way to judge it.
//
// This REUSES lib/headless-drain.runJudgeDrainSync (the exact core the POST /judge/drain route wraps,
// P1) — zero second judge implementation, same prompt + verdict path as the eager/background drain.
//
// Prints the { judged, kept, pruned, idle } result as JSON and exits 0 on completion (including a
// clean skip, e.g. no authed backend — reported via `skipped`). Exits non-zero only on a usage error
// (missing --node) or an unexpected throw.

const path = require('path');

function parseArgs(argv) {
  const out = { node: null, workspace: null, budget: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--node' || a === '-n') out.node = next();
    else if (a === '--workspace' || a === '--ws' || a === '-w') out.workspace = next();
    else if (a === '--budget' || a === '-b') out.budget = Number(next());
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--node=')) out.node = a.slice('--node='.length);
    else if (a.startsWith('--workspace=')) out.workspace = a.slice('--workspace='.length);
    else if (a.startsWith('--budget=')) out.budget = Number(a.slice('--budget='.length));
  }
  return out;
}

const USAGE = 'Usage: node scripts/judge-drain-once.js --node <key> --workspace <ws> [--budget N]';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (!args.node) {
    console.error('error: --node <key> is required\n' + USAGE);
    process.exit(2);
  }
  // Default the workspace to CWD when omitted (the daemon pins the canonical workspace independently,
  // but runJudgeDrainSync drives the overlay at workspaceRoot, so pass an explicit path when in doubt).
  const workspaceRoot = args.workspace ? path.resolve(args.workspace) : process.cwd();

  const { runJudgeDrainSync } = require('../lib/headless-drain');
  const result = await runJudgeDrainSync({
    workspaceRoot,
    node: String(args.node),
    budget: args.budget,
  });

  // Print the {judged, kept, pruned, idle} result (carry rounds/skipped through for operator context).
  const out = {
    judged: result.judged,
    kept: result.kept,
    pruned: result.pruned,
    idle: result.idle,
    rounds: result.rounds,
  };
  if (result.skipped) out.skipped = result.skipped;
  console.log(JSON.stringify(out));
  process.exit(0);
}

main().catch((err) => {
  console.error('judge-drain-once failed:', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
