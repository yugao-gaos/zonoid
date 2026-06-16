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

const REPO = process.env.ZONOID_REPO || path.resolve(__dirname, '..');
const CLAUDE = '/opt/homebrew/bin/claude';
const HT = path.join(REPO, 'bench', 'heldout');
const ORCH_WORKSPACE = process.env.ZONOID_WORKSPACE || process.cwd();
const TIMEOUT_S = 600;
const CANDIDATE_TIMEOUT = { 'cron-next': 900 };
const snapDaemon = require('./bench-snapshot-daemon');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function consultMode() {
  const eq = process.argv.find((a) => a.startsWith('--consult='));
  let v = eq ? eq.split('=')[1] : arg('consult', process.env.BENCH_CONSULT || 'search');
  return ['search', 'dagrag', 'mandatory', 'lean', 'permissive', 'gated', 'autonomous', 'iterative'].includes(v) ? v : 'search';
}
const MODEL = arg('model', 'sonnet');

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
  'locale-sum': {
    spec: 'bench/heldout/specs/locale-sum.md',
    artifact: 'bench/sandbox/sum-amounts-ht.js',
    deps: [],
    grader: 'bench/heldout/graders/locale-sum.grader.js',
  },
  // ---- Phase 1 proxy-validation candidates (task #12). deps:[] everywhere (no oracle in worktree).
  'native-store': {
    spec: 'bench/heldout/specs/native-store.md',
    artifact: 'bench/sandbox/task-store-ht.js',
    deps: [],
    grader: 'bench/heldout/graders/native-store.grader.js',
  },
  'claim-task': {
    spec: 'bench/heldout/specs/claim-task.md',
    artifact: 'bench/sandbox/claim-task-ht.js',
    deps: [],
    grader: 'bench/heldout/graders/claim-task.grader.js',
  },
  'wt-gc': {
    spec: 'bench/heldout/specs/wt-gc.md',
    artifact: 'bench/sandbox/gc-plan-ht.js',
    deps: [],
    grader: 'bench/heldout/graders/wt-gc.grader.js',
  },
  'tls-local': {
    spec: 'bench/heldout/specs/tls-local.md',
    artifact: 'bench/sandbox/local-https-ht.js',
    deps: [],
    grader: 'bench/heldout/graders/tls-local.grader.js',
  },
  'ctl-loop-next': {
    spec: 'bench/heldout/specs/ctl-loop-next.md',
    artifact: 'bench/sandbox/loop-next-ht.js',
    deps: [],
    grader: 'bench/heldout/graders/ctl-loop-next.grader.js',
  },
  'ctl-stale-claims': {
    spec: 'bench/heldout/specs/ctl-stale-claims.md',
    artifact: 'bench/sandbox/stale-claims-ht.js',
    deps: [],
    grader: 'bench/heldout/graders/ctl-stale-claims.grader.js',
  },
  'ctl-agg-report': {
    spec: 'bench/heldout/specs/ctl-agg-report.md',
    artifact: 'bench/sandbox/agg-report-ht.js',
    deps: [],
    grader: 'bench/heldout/graders/ctl-agg-report.grader.js',
  },
  // ---- Phase 2 classifier-validation candidates (task #13). Easy + hard coding.
  'sum-basic': {
    spec: 'bench/heldout/specs/sum-basic.md',
    artifact: 'bench/sandbox/format-duration-ht.js',
    deps: [],
    grader: 'bench/heldout/graders/sum-basic.grader.js',
  },
  'overlay-save': {
    spec: 'bench/heldout/specs/overlay-save.md',
    artifact: 'lib/overlay.js',
    deps: [],
    grader: 'bench/heldout/graders/overlay-save.grader.js',
  },
  'bench-metric': {
    spec: 'bench/heldout/specs/bench-metric.md',
    artifact: 'bench/sandbox/compute-ratio-ht.js',
    deps: [],
    grader: 'bench/heldout/graders/bench-metric.grader.js',
  },
  'interval-merge': {
    spec: 'bench/heldout/specs/interval-merge.md',
    artifact: 'bench/sandbox/merge-intervals-ht.js',
    deps: [],
    grader: 'bench/heldout/graders/interval-merge.grader.js',
  },
  'cron-next': {
    spec: 'bench/heldout/specs/cron-next.md',
    artifact: 'bench/sandbox/cron-next-ht.js',
    deps: [],
    grader: 'bench/heldout/graders/cron-next.grader.js',
  },
  'legacy-id': {
    spec: 'bench/heldout/specs/legacy-id.md',
    artifact: 'bench/sandbox/parse-task-id-ht.js',
    deps: [],
    grader: 'bench/heldout/graders/legacy-id.grader.js',
  },
  'api-contract': {
    spec: 'bench/heldout/specs/api-contract.md',
    artifact: 'bench/sandbox/build-event-ht.js',
    deps: [],
    grader: 'bench/heldout/graders/api-contract.grader.js',
  },
  'flaky-dep': {
    spec: 'bench/heldout/specs/flaky-dep.md',
    artifact: 'bench/sandbox/process-records-ht.js',
    deps: [['bench/heldout/fixtures/batch.js', 'bench/fixtures/batch.js']],
    grader: 'bench/heldout/graders/flaky-dep.grader.js',
  },
};

// Warm-arm preambles. Default = search (semantic RAG): the agent MUST search_knowledge and apply any
// retrieved note before coding — the only channel through which the seeded empirical fact reaches it.
const PREAMBLE = {
  search:
    'You have the orchestrator-graph MCP. Before writing code you MUST call search_knowledge with a ' +
    'query describing this task, and apply any relevant retrieved note (a recorded decision/gotcha). ' +
    'Graph is READ-ONLY — do NOT create, modify, claim, complete, or record_decision on any tasks/nodes.\n\n',
  dagrag:
    'You have the orchestrator-graph MCP. Before writing any code you MUST consult BOTH: ' +
    '(a) this task\'s DAG context via get_task_detail; AND (b) the knowledge base — call ' +
    'search_knowledge with a query describing this task and apply any relevant retrieved note. ' +
    'Combine both before coding. Graph is READ-ONLY — do NOT create/modify/claim/complete/record_decision on nodes.\n\n',
  autonomous:
    'You have the orchestrator-graph MCP available. Graph is READ-ONLY — do NOT create, modify, claim, complete, or record_decision on any tasks/nodes.\n\n',
  // GATE-FIRST consult: ask the context-need gate, retrieve only on decision:"inject".
  gated:
    'You have the orchestrator-graph MCP. Call search_knowledge EXACTLY ONCE with gated:true before writing code. ' +
    'decision:"inject" → apply the returned note then write code. ' +
    'decision:"abstain" → write code immediately, DO NOT call search_knowledge again under any circumstances. ' +
    'Graph is READ-ONLY — do NOT create, modify, claim, complete, or record_decision on any tasks/nodes.\n\n',
  // ITERATIVE consult: plateau-based multi-round retrieval driven by the daemon's continue verdict.
  iterative:
    'You have the orchestrator-graph MCP. Before writing code call search_knowledge with a query describing this task ' +
    '(NO gated:true — use ungated retrieval). ' +
    'The response includes continue:true/false. If continue:true you MAY call search_knowledge again ONCE with a DIFFERENT ' +
    'phrasing and pass exclude_keys = the note keys you already received, and round = 2 (then 3 for a third attempt). Stop searching when ' +
    'continue:false or after 3 rounds. Apply all relevant retrieved notes, then write code. ' +
    'Graph is READ-ONLY — do NOT create, modify, claim, complete, or record_decision on any tasks/nodes.\n\n',
};

async function main() {
  const candidate = arg('candidate');
  const arm = arg('arm');
  const trial = parseInt(arg('trial', '0'), 10);
  const cfg = CANDIDATES[candidate];
  if (!cfg || !['on', 'off'].includes(arm)) {
    console.error('usage: bench-heldout.js --candidate <name> --arm on|off --trial <int> [--consult=search] [--model opus]');
    process.exit(2);
  }
  const cm = consultMode();
  const armLabel = arm === 'on' ? `on-${cm}` : 'off';

  // Isolated snapshot mode (opt-in): the ON arm RAGs against a private daemon booted over a FROZEN
  // .graph snapshot instead of the live churning :8787 — for reproducibility. OFF arm makes no KB
  // call, so it's unaffected. Off by default → existing live behavior is unchanged.
  let isolatedPort = null;
  if (process.env.ZONOID_BENCH_ISOLATED === '1') {
    isolatedPort = await snapDaemon.ensureRunning();
  }

  // (a) isolated worktree off HEAD
  const wtRel = `worktrees/bench/ht-${candidate}-${armLabel}-${trial}`;
  const wt = path.join(REPO, wtRel);
  const branch = `orch/bench/ht-${candidate}-${armLabel}-${trial}`;
  spawnSync('git', ['-C', REPO, 'worktree', 'remove', '--force', wtRel], { stdio: 'ignore', windowsHide: true });
  spawnSync('git', ['-C', REPO, 'branch', '-D', branch], { stdio: 'ignore', windowsHide: true });
  const add = spawnSync('git', ['-C', REPO, 'worktree', 'add', '-b', branch, wtRel, 'HEAD'], { encoding: 'utf8', windowsHide: true });
  if (add.status !== 0) { console.error('worktree add failed: ' + add.stderr); process.exit(1); }

  // (b-pre) Strip oracle material from the solve worktree so the agent cannot inspect graders or
  // other candidates' specs to reverse-engineer the rubric. Grading runs from the main REPO path,
  // not the worktree, so removing these files here has no effect on scoring.
  fs.rmSync(path.join(wt, 'bench', 'heldout', 'graders'), { recursive: true, force: true });
  fs.rmSync(path.join(wt, 'bench', 'heldout', 'frozen'), { recursive: true, force: true });
  // Strip the graph store (KB materialized as raw JSONL files) so OFF-arm agents cannot read notes
  // through the filesystem back-door. ON-arm agents access KB via MCP → live daemon, which is correct.
  fs.rmSync(path.join(wt, '.graph'), { recursive: true, force: true });
  // Strip prior bench results — contains solve/fail status of prior trials.
  fs.rmSync(path.join(wt, 'bench', 'heldout', 'results-heldout.jsonl'), { force: true });
  const specsDir = path.join(wt, 'bench', 'heldout', 'specs');
  const thisSpec = path.resolve(path.join(wt, cfg.spec));
  try {
    for (const f of fs.readdirSync(specsDir)) {
      const full = path.join(specsDir, f);
      if (path.resolve(full) !== thisSpec) fs.rmSync(full, { force: true });
    }
  } catch { /* specsDir may not exist */ }

  // (b) stage deps (dependency module only — NEVER a test or grader). Make sandbox dir.
  fs.mkdirSync(path.join(wt, 'bench', 'sandbox'), { recursive: true });
  for (const [src, dest] of cfg.deps) {
    const destAbs = path.join(wt, dest);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(path.join(REPO, src), destAbs);
  }

  // (c) prompt = prose spec, repo-path redirected to THIS worktree (so the agent codes in isolation).
  const specBody = fs.readFileSync(path.join(REPO, cfg.spec), 'utf8').split(REPO).join(wt);
  const onPreamble = PREAMBLE[cm] || PREAMBLE.search;
  const prompt = (arm === 'on' ? onPreamble : '') + specBody;
  const mcpConfig = path.join(REPO, `bench/mcp-${arm}.json`);
  const sessionId = crypto.randomUUID();

  // (d) headless solve, guarded by perl alarm (macOS has no `timeout`)
  const args = [
    '-e', `alarm ${CANDIDATE_TIMEOUT[candidate] || TIMEOUT_S}; exec @ARGV`, '--',
    CLAUDE, '-p', prompt,
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--session-id', sessionId, '--model', MODEL,
    '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions', '--add-dir', wt,
  ];
  const env = arm === 'on'
    ? { ...process.env, ORCH_WORKSPACE, ORCH_GATE_OFF: '1', ...(isolatedPort ? { ORCH_PORT: String(isolatedPort) } : {}) }
    : { ...process.env, ORCH_GATE_OFF: '1' };
  const t0 = Date.now();
  const run = spawnSync('perl', args, { cwd: wt, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
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

  // (e2) extract token usage from transcript
  function extractTokens(tPath) {
    try {
      const lines = fs.readFileSync(tPath, 'utf8').trim().split('\n').filter(Boolean);
      let inputTokens = 0, outputTokens = 0, cacheRead = 0;
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          const usage = obj?.message?.usage || obj?.usage;
          if (usage) {
            inputTokens += usage.input_tokens || 0;
            outputTokens += usage.output_tokens || 0;
            cacheRead += usage.cache_read_input_tokens || 0;
          }
        } catch { /* skip malformed lines */ }
      }
      return { inputTokens, outputTokens, cacheRead, totalTokens: inputTokens + outputTokens };
    } catch { return { inputTokens: 0, outputTokens: 0, cacheRead: 0, totalTokens: 0 }; }
  }
  const tokenUsage = extractTokens(transcriptPath);

  // (e3) archive journal alongside results so it survives ~/.claude cache rotation
  const journalDir = path.join(REPO, 'bench', 'heldout', 'journals');
  fs.mkdirSync(journalDir, { recursive: true });
  let journalPath = null;
  if (fs.existsSync(transcriptPath)) {
    journalPath = path.join(journalDir, `${sessionId}.jsonl`);
    fs.copyFileSync(transcriptPath, journalPath);
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
    const g = spawnSync('node', [path.join(REPO, cfg.grader), frozenArtifact, wt], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    try { grade = JSON.parse((g.stdout || '').trim().split('\n').filter(Boolean).pop()); }
    catch (e) { grade = { ok: false, pass: 0, total: 0, edgePass: 0, edgeTotal: 0, error: 'grader parse fail: ' + (g.stderr || e.message).slice(0, 200) }; }
  }

  // (g) work proxy W = artifact size (chars) — corroborates that warm isn't merely writing less.
  let diffChars = 0;
  try { if (artifactPresent) diffChars = fs.statSync(producedPath).size; } catch { /* 0 */ }

  const row = JSON.stringify({
    candidate, arm, consult: arm === 'on' ? cm : null, armLabel, trial, sessionId, transcriptPath,
    journalPath,
    worktree: wt, frozenArtifact: artifactPresent ? frozenArtifact : null, model: MODEL,
    exitCode, wallMs, artifactPresent, diffChars, diffTokens: Math.round(diffChars / 4),
    inputTokens: tokenUsage.inputTokens, outputTokens: tokenUsage.outputTokens,
    cacheReadTokens: tokenUsage.cacheRead, totalTokens: tokenUsage.totalTokens,
    solved: !!grade.ok, pass: grade.pass, total: grade.total,
    edgePass: grade.edgePass, edgeTotal: grade.edgeTotal, gradeError: grade.error || null,
    cases: grade.cases || [],
  }) + '\n';
  process.stdout.write(row);
  // Always append to canonical results file regardless of how the script is invoked.
  fs.appendFileSync(path.join(REPO, 'bench', 'heldout', 'results-heldout.jsonl'), row);
  if (isolatedPort) snapDaemon.teardown();
}

main().catch((e) => { try { snapDaemon.teardown(); } catch { /* best effort */ } console.error(e && e.message ? e.message : e); process.exit(1); });
