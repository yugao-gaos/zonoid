#!/usr/bin/env node
'use strict';
/**
 * warm_start.js — WARM-START prep for the SWE-Bench-CL Zonoid arm.
 *
 * Onboards a target repo (e.g. pytest-dev/pytest checked out at the CL sequence's BASE commit)
 * and INJECTS the learnt KB into the SEQUENCE's Zonoid workspace, so the Zonoid arm's task 1
 * already retrieves repo knowledge — a WARM start, not a cold empty store.
 *
 * It ties together the existing onboard scripts (does NOT reinvent them):
 *   scripts/onboard-mine-{git,docs,config,structure}.js  — cheap candidate mining
 *   scripts/onboard-learn.js --drain  (repeat until queue empty)  — agentic validate/enrich
 *   scripts/onboard-learn.js --inject --confirm --workspace <ABS seq path>  — reversible inject
 *
 * The injected workspace path MUST match the per-sequence absolute workspace the Python adapter
 * (zonoid_memory.py) computes, so the warm seed and the eval land on the SAME store. That path is
 *     <workspace_root>/<slug>          where  slug = slugify(`${sequence_id}-${arm}`)
 * and slugify replaces every char NOT in [A-Za-z0-9._-] with '-'. This script reproduces that
 * EXACTLY (see slugifyWorkspace) — keep it in lockstep with zonoid_memory.py.__init__.
 *
 * KNOWN ONBOARDING FIXES (applied automatically; see self-learning-harness-roadmap memory):
 *   - ORCH_GATE_OFF=1  in the child env  — ungate the onboard test/learn writes.
 *   - --model sonnet                       — the onboarding model pin.
 *   - --workspace <abs seq path>           — inject into the sequence workspace, not the daemon's.
 *
 * USAGE
 *   node bench/swe-bench-cl/warm_start.js \
 *     --repo /abs/path/to/pytest \                # repo checked out at the CL base commit
 *     --sequence pytest-dev_pytest_sequence \     # the CL sequence id (matches the eval loop)
 *     [--workspace-root /tmp/zonoid-cl] \         # MUST match the adapter's workspace_root
 *     [--arm zonoid] \                            # MUST match the adapter's arm
 *     [--daemon http://localhost:8787] \
 *     [--batch 50] \
 *     [--dry-run]                                 # mine + learn + print the inject plan, no mutation
 *
 * After it prints "WARM-START COMPLETE … workspace <abs>", construct the Python adapter with
 * warm=True and the SAME sequence_id / workspace_root / arm, so clear_memory() is a no-op and the
 * seed survives into task 1.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');   // the zonoid repo root (…/zonoid)
const SCRIPTS = path.join(REPO_ROOT, 'scripts');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function has(name) { return process.argv.includes(`--${name}`); }

// EXACT mirror of zonoid_memory.py: slug = re.sub(r"[^A-Za-z0-9._-]", "-", f"{seq}-{arm}").
function slugifyWorkspace(sequenceId, arm) {
  return `${sequenceId}-${arm}`.replace(/[^A-Za-z0-9._-]/g, '-');
}

function run(label, file, args, env) {
  process.stderr.write(`\n[warm-start] ${label}: node ${path.basename(file)} ${args.join(' ')}\n`);
  const r = spawnSync(process.execPath, [file, ...args], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    env: { ...process.env, ORCH_GATE_OFF: '1', ...env },   // ungate onboard writes (known fix)
  });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
}

function queueStatus(repo, outDir, daemon) {
  const r = spawnSync(process.execPath,
    [path.join(SCRIPTS, 'onboard-learn.js'), '--repo', repo, '--in', outDir, '--queue-status'],
    { stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO_ROOT, encoding: 'utf8',
      env: { ...process.env, ORCH_GATE_OFF: '1', ORCH_DAEMON: daemon } });
  try { return JSON.parse(r.stdout || ''); } catch { return null; }
}

function main() {
  const repo = arg('repo');
  const sequenceId = arg('sequence');
  if (!repo || !sequenceId) {
    process.stderr.write('usage: warm_start.js --repo <abs> --sequence <id> ' +
      '[--workspace-root /tmp/zonoid-cl] [--arm zonoid] [--daemon URL] [--batch 50] [--dry-run]\n');
    process.exit(2);
  }
  const repoAbs = path.resolve(repo);
  const workspaceRoot = path.resolve(arg('workspace-root', '/tmp/zonoid-cl'));
  const arm = arg('arm', 'zonoid');
  const daemon = arg('daemon', 'http://localhost:8787');
  const batch = arg('batch', '50');
  const model = arg('model', 'sonnet');   // onboarding model pin (known fix)
  const dryRun = has('dry-run');

  // The per-sequence absolute workspace the Python adapter will read (finding #1: absolute path).
  const slug = slugifyWorkspace(sequenceId, arm);
  const seqWorkspace = path.join(workspaceRoot, slug);
  fs.mkdirSync(seqWorkspace, { recursive: true });

  // Candidate-mining output dir for this repo.
  const outDir = path.join(REPO_ROOT, 'bench', 'onboard', path.basename(repoAbs));
  fs.mkdirSync(outDir, { recursive: true });

  process.stderr.write(
    `[warm-start] repo=${repoAbs}\n` +
    `[warm-start] sequence=${sequenceId} arm=${arm}\n` +
    `[warm-start] seq workspace (inject target) = ${seqWorkspace}\n` +
    `[warm-start] daemon=${daemon}  model=${model}  dryRun=${dryRun}\n`
  );

  const childEnv = { ORCH_DAEMON: daemon };

  // 1. MINE — cheap candidate extraction (git history, docs, config, structure).
  for (const s of ['onboard-mine-git.js', 'onboard-mine-docs.js', 'onboard-mine-config.js', 'onboard-mine-structure.js']) {
    run(`mine ${s}`, path.join(SCRIPTS, s), ['--repo', repoAbs, '--out', outDir], childEnv);
  }

  // 2. LEARN (enqueue) — register candidates for agentic validation/enrichment.
  run('learn enqueue', path.join(SCRIPTS, 'onboard-learn.js'),
    ['--repo', repoAbs, '--in', outDir, '--model', model, '--enqueue'], childEnv);

  // 3. DRAIN — run the agentic learner in batches until the queue empties.
  let guard = 0;
  for (;;) {
    const st = queueStatus(repoAbs, outDir, daemon);
    if (!st || (st.remaining || 0) === 0) break;
    process.stderr.write(`[warm-start] drain: ${st.remaining}/${st.total} remaining\n`);
    run('learn drain', path.join(SCRIPTS, 'onboard-learn.js'),
      ['--repo', repoAbs, '--in', outDir, '--model', model, '--drain', '--batch', batch], childEnv);
    if (++guard > 50) { process.stderr.write('[warm-start] drain guard hit (50 batches) — stopping\n'); break; }
  }

  // 4. INJECT — reversible [ingest] notes into the SEQUENCE workspace (the warm seed).
  //    --workspace overrides the default (repo path) so the KB lands where the adapter reads it.
  const injectArgs = ['--repo', repoAbs, '--in', outDir, '--inject', '--workspace', seqWorkspace];
  if (!dryRun) injectArgs.push('--confirm');
  run(dryRun ? 'inject (DRY RUN)' : 'inject --confirm',
    path.join(SCRIPTS, 'onboard-learn.js'), injectArgs, childEnv);

  process.stderr.write(
    `\n[warm-start] WARM-START ${dryRun ? 'DRY-RUN ' : ''}COMPLETE\n` +
    `[warm-start] seeded workspace: ${seqWorkspace}\n` +
    `[warm-start] Construct the Python adapter with:\n` +
    `[warm-start]   ZonoidMemorySystem(sequence_id="${sequenceId}", workspace_root="${workspaceRoot}", arm="${arm}", warm=True)\n`
  );
  // Emit the resolved workspace on stdout for scripting (the eval can read it back).
  process.stdout.write(seqWorkspace + '\n');
}

main();
