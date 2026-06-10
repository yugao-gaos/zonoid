#!/usr/bin/env node
// Held-out single-arm bench runner for the orchestrator-MCP A/B benchmark.
//
// THE FIX (vs bench-arm.js): no acceptance test ever enters the agent's worktree. The agent solves
// from a PROSE SPEC ONLY ("write your best impl and stop" — no test, no "make it pass", no rubric).
// After it finishes we FREEZE the produced artifact and grade it with an EXTERNAL held-out suite the
// agent never saw. `solved` := passes the held-out grader. Edge-case rows are tracked separately.
// Cold and warm run the IDENTICAL solve+freeze+grade; the ONLY difference is graph/MCP access.
//
// Usage:
//   node scripts/bench-heldout.js --candidate silent-cap --arm on|off --trial 0 [--consult=search] [--model opus]
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = '__INSTALL_DIR__';
const CLAUDE = '/opt/homebrew/bin/claude';
const HT = path.join(REPO, 'bench', 'heldout');
const ORCH_WORKSPACE = '__WORKSPACE__';
const TIMEOUT_S = 600;

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function consultMode() {
  const eq = process.argv.find((a) => a.startsWith('--consult='));
  let v = eq ? eq.split('=')[1] : arg('consult', process.env.BENCH_CONSULT || 'search');
  return ['search', 'dagrag', 'mandatory', 'lean', 'permissive'].includes(v) ? v : 'search';
}
const MODEL = arg('model', 'opus');

// Per-candidate config: prose spec (no test), the artifact file the agent must write, any deps to
// stage into the solve worktree (the dependency module — NOT a test/grader), and the held-out grader.
const CANDIDATES = {
  'silent-cap': {
    spec: 'bench/heldout/specs/silent-cap.md',
    artifact: 'bench/sandbox/process-all.js',
    deps: [['bench/heldout/deps/batch.js', 'bench/sandbox/batch.js']],   // [src in repo, dest in worktree]
    grader: 'bench/heldout/graders/silent-cap.grader.js',
  },
  'task-transcript': {
    spec: 'bench/heldout/specs/task-transcript.md',
    artifact: 'bench/sandbox/resolve-owner-ht.js',
    deps: [],
    grader: 'bench/heldout/graders/task-transcript.grader.js',
  },
};

// Warm-arm preambles. Default = search (semantic RAG): the agent MUST search_knowledge and apply any
// retrieved note before coding — the only channel through which the seeded empirical fact reaches it.
const PREAMBLE = {
  search:
    'You have the orchestrator-graph MCP. Before writing code you MUST call search_knowledge with a ' +
    'query describing this task, and apply any relevant retrieved note (a recorded decision/gotcha). ' +
    'Graph is READ-ONLY — do NOT create, modify, claim, or complete any tasks/nodes.\n\n',
  dagrag:
    'You have the orchestrator-graph MCP. Before writing any code you MUST consult BOTH: ' +
    '(a) this task\'s DAG context via get_task_detail; AND (b) the knowledge base — call ' +
    'search_knowledge with a query describing this task and apply any relevant retrieved note. ' +
    'Combine both before coding. Graph is READ-ONLY — do NOT create/modify/claim/complete nodes.\n\n',
};

function main() {
  const candidate = arg('candidate');
  const arm = arg('arm');
  const trial = parseInt(arg('trial', '0'), 10);
  const cfg = CANDIDATES[candidate];
  if (!cfg || !['on', 'off'].includes(arm)) {
    console.error('usage: bench-heldout.js --candidate <silent-cap|task-transcript> --arm on|off --trial <int> [--consult=search]');
    process.exit(2);
  }
  const cm = consultMode();
  const armLabel = arm === 'on' ? `on-${cm}` : 'off';

  // (a) isolated worktree off HEAD
  const wtRel = `worktrees/bench/ht-${candidate}-${armLabel}-${trial}`;
  const wt = path.join(REPO, wtRel);
  const branch = `orch/bench/ht-${candidate}-${armLabel}-${trial}`;
  spawnSync('git', ['-C', REPO, 'worktree', 'remove', '--force', wtRel], { stdio: 'ignore' });
  spawnSync('git', ['-C', REPO, 'branch', '-D', branch], { stdio: 'ignore' });
  const add = spawnSync('git', ['-C', REPO, 'worktree', 'add', '-b', branch, wtRel, 'HEAD'], { encoding: 'utf8' });
  if (add.status !== 0) { console.error('worktree add failed: ' + add.stderr); process.exit(1); }

  // (b) stage deps (dependency module only — NEVER a test or grader). Make sandbox dir.
  fs.mkdirSync(path.join(wt, 'bench', 'sandbox'), { recursive: true });
  for (const [src, dest] of cfg.deps) {
    fs.copyFileSync(path.join(REPO, src), path.join(wt, dest));
  }

  // (c) prompt = prose spec, repo-path redirected to THIS worktree (so the agent codes in isolation).
  const specBody = fs.readFileSync(path.join(REPO, cfg.spec), 'utf8').split(REPO).join(wt);
  const onPreamble = PREAMBLE[cm] || PREAMBLE.search;
  const prompt = (arm === 'on' ? onPreamble : '') + specBody;
  const mcpConfig = path.join(REPO, `bench/mcp-${arm}.json`);
  const sessionId = crypto.randomUUID();

  // (d) headless solve, guarded by perl alarm (macOS has no `timeout`)
  const args = [
    '-e', `alarm ${TIMEOUT_S}; exec @ARGV`, '--',
    CLAUDE, '-p', prompt,
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--session-id', sessionId, '--model', MODEL,
    '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions', '--add-dir', wt,
  ];
  const env = arm === 'on' ? { ...process.env, ORCH_WORKSPACE } : process.env;
  const t0 = Date.now();
  const run = spawnSync('perl', args, { cwd: wt, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const wallMs = Date.now() - t0;
  const exitCode = run.status === null ? 124 : run.status;

  // (e) locate transcript
  const slug = wt.replace(/[^A-Za-z0-9]/g, '-');
  let transcriptPath = path.join(process.env.HOME, '.claude', 'projects', slug, `${sessionId}.jsonl`);
  if (!fs.existsSync(transcriptPath)) {
    const projRoot = path.join(process.env.HOME, '.claude', 'projects');
    try {
      for (const d of fs.readdirSync(projRoot)) {
        const cand = path.join(projRoot, d, `${sessionId}.jsonl`);
        if (fs.existsSync(cand)) { transcriptPath = cand; break; }
      }
    } catch { /* ignore */ }
  }

  // (f) FREEZE the produced artifact OUT of the worktree, then GRADE with the external held-out suite.
  const producedPath = path.join(wt, cfg.artifact);
  const frozenDir = path.join(HT, 'frozen', `${candidate}-${armLabel}-${trial}`);
  fs.rmSync(frozenDir, { recursive: true, force: true });
  fs.mkdirSync(frozenDir, { recursive: true });
  let artifactPresent = fs.existsSync(producedPath);
  let frozenArtifact = path.join(frozenDir, path.basename(cfg.artifact));
  if (artifactPresent) fs.copyFileSync(producedPath, frozenArtifact);
  // freeze the agent's local copy of each dep too (so the grader can detect tampering); grader
  // stages its OWN fresh dep, so a tampered copy cannot help the agent pass.
  for (const [, dest] of cfg.deps) {
    const p = path.join(wt, dest);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(frozenDir, path.basename(dest)));
  }

  let grade = { ok: false, pass: 0, total: 0, edgePass: 0, edgeTotal: 0, error: artifactPresent ? null : 'no artifact produced' };
  if (artifactPresent) {
    const g = spawnSync('node', [path.join(REPO, cfg.grader), frozenArtifact], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    try { grade = JSON.parse((g.stdout || '').trim().split('\n').filter(Boolean).pop()); }
    catch (e) { grade = { ok: false, pass: 0, total: 0, edgePass: 0, edgeTotal: 0, error: 'grader parse fail: ' + (g.stderr || e.message).slice(0, 200) }; }
  }

  // (g) work proxy W = artifact size (chars) — corroborates that warm isn't merely writing less.
  let diffChars = 0;
  try { if (artifactPresent) diffChars = fs.statSync(producedPath).size; } catch { /* 0 */ }

  process.stdout.write(JSON.stringify({
    candidate, arm, consult: arm === 'on' ? cm : null, armLabel, trial, sessionId, transcriptPath,
    worktree: wt, frozenArtifact: artifactPresent ? frozenArtifact : null, model: MODEL,
    exitCode, wallMs, artifactPresent, diffChars, diffTokens: Math.round(diffChars / 4),
    solved: !!grade.ok, pass: grade.pass, total: grade.total,
    edgePass: grade.edgePass, edgeTotal: grade.edgeTotal, gradeError: grade.error || null,
    cases: grade.cases || [],
  }) + '\n');
}

main();
