#!/usr/bin/env node
'use strict';
/**
 * onboard.js — DROP-IN onboarding entry point. One command bootstraps a KB for ANY repo on
 * first run, then STOPS at a human review gate. It NEVER injects into the live graph.
 *
 * This is the entry the setup flow triggers (see skills/setup/SKILL.md §6) so a fresh repo gets
 * KB-bootstrapped the first time the orchestrator runs there. It chains the pieces built by the
 * earlier onboarding tasks into a single, gated pipeline:
 *
 *   1. MINE  — run the 4 static miners (onboard-mine-{structure,git,docs,assets}.js --repo <abs>) into
 *              bench/onboard/<basename(repo)>/  (no graph mutation, no commit).
 *   2. LEARN — run scripts/onboard-learn.js --repo <abs>: a read-only agent validates the noisy
 *              mined candidates against actual source and writes onboard-notes.json (KEPT/REJECTED).
 *              Still NO graph mutation — the learner only writes a JSON file.
 *   3. GATE  — emit ONBOARD-REVIEW.md (a candidate-bundle review doc modeled on
 *              bench/ingest/CANDIDATE-KB.md) summarizing the KEPT notes for HUMAN keep/drop
 *              approval, and PRINT the exact (unrun) inject command. Then STOP.
 *
 * NO AUTO-INJECT — BY DESIGN. Injection into the live graph is a SEPARATE, explicit human step
 * that reuses the existing reversible '[ingest]' overlay-note gate:
 *
 *   node scripts/onboard-learn.js --repo <abs> --inject            # dry-run plan (no mutation)
 *   node scripts/onboard-learn.js --repo <abs> --inject --confirm  # perform reversible injection
 *
 * onboard.js has NO --confirm and NO inject path of its own: the review gate cannot be bypassed
 * from this entry point.
 *
 * First-run / idempotency: a '.onboarded' marker is written in the out-dir after a successful
 * bundle. Re-running is a no-op unless --force is passed, so the setup-flow trigger can call this
 * unconditionally without re-mining an already-onboarded repo.
 *
 *   node scripts/onboard.js --repo <abs> [--out <dir>] [--model opus] [--max-keep 20]
 *   node scripts/onboard.js --repo <abs> --force          # re-onboard even if marker present
 *   node scripts/onboard.js --repo <abs> --skip-learn     # mine + bundle the raw candidates only
 *                                                          # (no agent spawn; for sandboxed/offline)
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SELF_REPO = path.resolve(__dirname, '..');
const SCRIPTS = __dirname;

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes('--' + name);

function loadJSON(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}

// Run one node script synchronously, inheriting stdio so the user sees miner/learner output.
function node(script, args) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    stdio: 'inherit',
    cwd: SELF_REPO,
  });
  return r.status;
}

// ---- the review bundle: candidate-bundle gate doc (mirrors bench/ingest/CANDIDATE-KB.md) -----
function writeReviewBundle(repoAbs, outDir, notes, rejected, injectCmd) {
  const byKind = notes.reduce((m, n) => ((m[n.kind || 'note'] = (m[n.kind || 'note'] || 0) + 1), m), {});
  const kindRows = Object.entries(byKind)
    .map(([k, v]) => `| ${k} | ${v} |`).join('\n') || '| (none) | 0 |';
  const noteRows = notes.map((n, i) =>
    `### ${i + 1}. [${n.kind || 'note'}] ${n.title}\n\n` +
    `${n.summary}\n\n` +
    `> evidence: \`${n.evidence || '?'}\`  ·  source: ${n.source || '?'}\n`).join('\n');

  const md = `# Onboarding Review — ${path.basename(repoAbs)}

Candidate knowledge-base bootstrapped from \`${repoAbs}\` by \`scripts/onboard.js\`.
**Nothing here has touched the live orchestrator graph.** This doc is the human review gate:
read it, keep/drop notes, then run the inject command below to commit the approved set.

📊 Dashboard: http://localhost:8787/graph

## 1. Counts

| Kind | Kept notes |
|---|---|
${kindRows}

**Total candidate delta: ${notes.length} note node(s).** Rejected by the learner: ${rejected.length}.

## 2. Kept candidates (review for keep/drop)

${noteRows || '_(no notes kept — nothing to inject)_'}

## 3. Inject gate (NOT auto-run)

\`onboard.js\` stops here on purpose — it never mutates the graph. To inject the approved set,
review the notes above, drop any you don't want from \`onboard-notes.json\`, then run the
existing reversible \`[ingest]\` gate yourself:

\`\`\`
${injectCmd} --inject            # dry-run plan (no mutation)
${injectCmd} --inject --confirm  # perform the reversible injection
\`\`\`

Every injected node is titled \`[ingest] …\` and stays filterable/removable.
`;
  const p = path.join(outDir, 'ONBOARD-REVIEW.md');
  fs.writeFileSync(p, md);
  return p;
}

(async () => {
  const repo = arg('repo');
  if (!repo) {
    console.error('usage: onboard.js --repo <abs> [--out <dir>] [--model opus] [--max-keep 20] [--force] [--skip-learn]');
    process.exit(2);
  }
  const repoAbs = path.resolve(repo);
  if (!fs.existsSync(repoAbs) || !fs.existsSync(path.join(repoAbs, '.git'))) {
    console.error(`[onboard] not a git repo: ${repoAbs}`);
    process.exit(2);
  }
  const outDir = path.resolve(arg('out', path.join(repoAbs, '.graph', 'onboard')));
  const marker = path.join(repoAbs, '.graph', '.onboarded');

  // ---- first-run gate: skip an already-onboarded repo unless --force ----
  if (fs.existsSync(marker) && !has('force')) {
    console.log(`[onboard] ${path.basename(repoAbs)} already onboarded (${marker}).`);
    console.log('[onboard] Re-run with --force to re-mine, or review the existing bundle:');
    console.log(`           ${path.join(outDir, 'ONBOARD-REVIEW.md')}`);
    process.exit(0);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const model = arg('model', 'opus');
  const maxKeep = arg('max-keep', '20');

  // ---- 1. MINE (no graph mutation, no commit) ----
  console.error(`[onboard] 1/3 mining ${repoAbs} -> ${outDir}`);
  // config miner included: shipped defaults (timeouts/thresholds/feature flags) are exactly the
  // non-recoverable knowledge the learner prompt prioritizes (onboard-loop.js already mines it).
  for (const m of ['onboard-mine-structure.js', 'onboard-mine-git.js', 'onboard-mine-docs.js', 'onboard-mine-assets.js', 'onboard-mine-config.js']) {
    const st = node(m, ['--repo', repoAbs, '--out', outDir]);
    if (st !== 0) { console.error(`[onboard] FAILED: ${m} exited ${st}`); process.exit(1); }
  }

  // ---- 2. LEARN (agentic validation -> onboard-notes.json; still no graph mutation) ----
  const notesFile = path.join(outDir, 'onboard-notes.json');
  if (has('skip-learn')) {
    console.error('[onboard] 2/3 --skip-learn: bundling RAW mined candidates (no agent validation).');
    // Build a minimal notes.json from the raw mine so the gate still has something to review.
    const git = loadJSON(path.join(outDir, 'git-notes.json'), []);
    const docs = loadJSON(path.join(outDir, 'doc-notes.json'), []);
    const kept = [...git, ...docs].map((n) => ({
      title: n.title, summary: n.summary, kind: n.kind || 'note',
      evidence: n.source || '?', source: 'raw-mine (unvalidated)',
    }));
    fs.writeFileSync(notesFile, JSON.stringify({ kept, rejected: [] }, null, 2) + '\n');
  } else {
    console.error(`[onboard] 2/3 agentic validation (model=${model})…`);
    const st = node('onboard-learn.js', ['--repo', repoAbs, '--in', outDir, '--model', model, '--max-keep', maxKeep]);
    if (st !== 0 || !fs.existsSync(notesFile)) {
      console.error('[onboard] FAILED: learner did not produce onboard-notes.json.');
      console.error('[onboard] (sandboxed? retry with --skip-learn to bundle raw candidates for review.)');
      process.exit(1);
    }
  }

  // ---- 3. GATE: emit review bundle, STOP (no inject) ----
  const data = loadJSON(notesFile, { kept: [], rejected: [] });
  const kept = Array.isArray(data.kept) ? data.kept : [];
  const rejected = Array.isArray(data.rejected) ? data.rejected : [];
  const injectCmd = `node scripts/onboard-learn.js --repo ${repoAbs} --in ${outDir}`;
  const bundle = writeReviewBundle(repoAbs, outDir, kept, rejected, injectCmd);

  // Mark onboarded so the setup-flow trigger is idempotent.
  fs.mkdirSync(path.join(repoAbs, '.graph'), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ repo: repoAbs, at: new Date().toISOString(), kept: kept.length }) + '\n');

  console.error('');
  console.error(`[onboard] 3/3 DONE — ${kept.length} candidate note(s) kept, ${rejected.length} rejected.`);
  console.error(`[onboard] REVIEW GATE (human keep/drop required — nothing injected):`);
  console.error(`           ${bundle}`);
  console.error('[onboard] After review, inject the approved set with the explicit gate:');
  console.error(`           ${injectCmd} --inject --confirm`);
  process.exit(0);
})();
