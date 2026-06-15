#!/usr/bin/env node
// Single-arm bench runner for the orchestrator-MCP A/B benchmark.
//
// Runs ONE headless `claude -p` agent against a fixed spec, inside an ISOLATED git worktree so
// arms never collide, then runs the spec's acceptance test and emits ONE JSON result line.
//
// Usage:
//   node scripts/bench-arm.js --spec bench/specs/greenfield.md --arm on|off --trial 0 --problem greenfield
//
// ARM ON  : prompt = 1-line orchestrator-MCP preamble + spec body; mcp-config = bench/mcp-on.json
// ARM OFF : prompt = spec body VERBATIM;                            mcp-config = bench/mcp-off.json
// Same spec either way — the only treatment is MCP availability + the preamble.
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = process.env.ZONOID_REPO || path.resolve(__dirname, '..');
const CLAUDE = '/opt/homebrew/bin/claude';
const MODEL = (function () {       // PINNED for ALL runs (A/B parity); default opus per user choice.
  const i = process.argv.indexOf('--model');
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : 'opus';
})();
const TIMEOUT_S = 600;

// Per-problem acceptance test commands, run with cwd = worktree root (relative paths resolve there).
const ACCEPTANCE = {
  greenfield:    [['node', 'bench/sandbox/parse-duration.test.js']],
  'greenfield-ci0':[['node', 'bench/sandbox/parse-duration.test.js']],
  'greenfield-ci1':[['node', 'bench/sandbox/parse-duration.test.js']],
  'greenfield-ci2':[['node', 'bench/sandbox/parse-duration.test.js']],
  'greenfield-ci3':[['node', 'bench/sandbox/parse-duration.test.js']],
  'context-rich':[['node', 'test/summarize-rejected.test.js'], ['node', 'test/rejected-digest.test.js']],
  'graph-dependent':[['node', 'bench/sandbox/resolve-owner.test.js']],
  'v4-hard':[['node', 'bench/sandbox/task-tokens.test.js']],
  'v5-grounded':[['node', 'bench/sandbox/resolve-deps.test.js']],
  'wincase-c':[['node', 'bench/sandbox/wincase-resolve.test.js']],
  // v7 per-arm aliases: distinct problem label => distinct worktree, so the 4 arms (off + 3 ON
  // consult modes, all arm=on) never collide on one worktree. Same acceptance test as their base.
  'v1-off':[['node', 'bench/sandbox/resolve-owner.test.js']],
  'v1-dagrag':[['node', 'bench/sandbox/resolve-owner.test.js']],
  'v1-search':[['node', 'bench/sandbox/resolve-owner.test.js']],
  'v1-lean':[['node', 'bench/sandbox/resolve-owner.test.js']],
  'v4-off':[['node', 'bench/sandbox/task-tokens.test.js']],
  'v4-dagrag':[['node', 'bench/sandbox/task-tokens.test.js']],
  'v4-search':[['node', 'bench/sandbox/task-tokens.test.js']],
  'v4-lean':[['node', 'bench/sandbox/task-tokens.test.js']],
};

// ON arm joins the REAL cloude graph (read context) without hijacking the daemon workspace.
const ORCH_WORKSPACE = process.env.ZONOID_WORKSPACE || process.cwd();
// Permissive (default): the agent MAY consult the graph. Mandatory (--consult=mandatory): the agent
// MUST call get_learnings and apply prior verdicts/rejected approaches before writing any code. Both
// keep the graph strictly READ-ONLY. OFF arm gets no preamble in either mode.
const ON_PREAMBLE_PERMISSIVE =
  'You have the orchestrator-graph MCP. You MAY consult get_learnings / get_task_detail / ' +
  'get_full_graph for relevant prior context, but treat the graph as READ-ONLY — do NOT create, ' +
  'modify, claim, or complete any tasks/nodes.\n\n';
const ON_PREAMBLE_MANDATORY =
  'You have the orchestrator-graph MCP. Before writing any code you MUST call get_learnings and ' +
  'apply what it says about prior verdicts / rejected approaches for this problem (you may also ' +
  'consult get_task_detail / get_full_graph). The graph is strictly READ-ONLY — do NOT create, ' +
  'modify, claim, or complete any tasks/nodes.\n\n';
// Lean (--consult=lean): mandatory consult, but call get_learnings with compact:true (the lean
// index, ~1k tokens vs ~25k) and expand a specific entry via get_task_detail only if needed.
const ON_PREAMBLE_LEAN =
  'You have the orchestrator-graph MCP. Before writing any code you MUST call get_learnings with ' +
  'compact:true (the lean index of prior verdicts / rejected approaches) and apply it; expand a ' +
  'specific entry via get_task_detail ONLY if you need its full detail. The graph is strictly ' +
  'READ-ONLY — do NOT create, modify, claim, or complete any tasks/nodes.\n\n';
// Search (--consult=search): grounded-KB retrieval. The agent MUST call search_knowledge with a
// query describing the task and apply any relevant retrieved note (a recorded decision/gotcha)
// before writing code. Tests whether a precise, retrievable KB note collapses task hardness.
const ON_PREAMBLE_SEARCH =
  'You have the orchestrator-graph MCP. Before writing code you MUST call search_knowledge with a ' +
  'query describing this task, and apply any relevant retrieved note (a recorded decision/gotcha). ' +
  'Graph is READ-ONLY — do NOT create, modify, claim, or complete any tasks/nodes.\n\n';
// DAG+RAG (--consult=dagrag): combine BOTH context channels before coding. (a) the task's DAG
// context — its dependency summaries via get_task_detail (the structured prior-work interface); AND
// (b) semantic recall — search_knowledge(query) over the grounded KB. Tests whether structured graph
// context AND retrieved free-text knowledge together beat either alone.
const ON_PREAMBLE_DAGRAG =
  'You have the orchestrator-graph MCP. Before writing any code you MUST consult BOTH: ' +
  '(a) this task\'s DAG context — call get_task_detail to read its dependency summaries (the ' +
  'structured interface of prior work it builds on); AND (b) the knowledge base — call ' +
  'search_knowledge with a query describing this task and apply any relevant retrieved note ' +
  '(a recorded decision/gotcha). Combine both before writing code. The graph is strictly ' +
  'READ-ONLY — do NOT create, modify, claim, or complete any tasks/nodes.\n\n';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

// Consult mode for the ON arm. Accepts `--consult=mandatory`, `--consult mandatory`, or env
// BENCH_CONSULT=mandatory. Unset/anything-else => 'permissive' (the prior 'may consult' behavior).
function consultMode() {
  const eq = process.argv.find((a) => a.startsWith('--consult='));
  let v = eq ? eq.split('=')[1] : arg('consult', process.env.BENCH_CONSULT || 'permissive');
  return v === 'mandatory' ? 'mandatory' : v === 'lean' ? 'lean' : v === 'search' ? 'search' : v === 'dagrag' ? 'dagrag' : 'permissive';
}

function main() {
  const specPath = arg('spec');
  const arm = arg('arm');
  const trial = parseInt(arg('trial', '0'), 10);
  const problem = arg('problem');
  if (!specPath || !['on', 'off'].includes(arm) || !problem) {
    console.error('usage: bench-arm.js --spec <path> --arm on|off --trial <int> --problem <name>');
    process.exit(2);
  }
  const specBody = fs.readFileSync(path.resolve(REPO, specPath), 'utf8');
  const graderArg = arg('grader');
  const accepts = graderArg
    ? [[process.execPath, path.resolve(REPO, graderArg)]]
    : ACCEPTANCE[problem];
  if (!accepts) { console.error('no acceptance test for problem: ' + problem + ' (pass --grader <path> or add to ACCEPTANCE)'); process.exit(2); }

  // (a) isolated worktree off HEAD
  const wtRel = `worktrees/bench/${problem}-${arm}-${trial}`;
  const wt = path.join(REPO, wtRel);
  if (fs.existsSync(wt)) {
    spawnSync('git', ['-C', REPO, 'worktree', 'remove', '--force', wtRel], { stdio: 'ignore' });
  }
  const branch = `orch/bench/${problem}-${arm}-${trial}`;
  spawnSync('git', ['-C', REPO, 'worktree', 'remove', '--force', wtRel], { stdio: 'ignore' });
  spawnSync('git', ['-C', REPO, 'branch', '-D', branch], { stdio: 'ignore' });
  const add = spawnSync('git', ['-C', REPO, 'worktree', 'add', '-b', branch, wtRel, 'HEAD'],
    { encoding: 'utf8' });
  if (add.status !== 0) { console.error('worktree add failed: ' + add.stderr); process.exit(1); }

  // (b) fresh session id + prompt.
  // Redirect the spec body's literal repo-root path to THIS worktree so the agent codes in
  // isolation (the spec names the absolute repo path; left as-is the arm would clobber the main
  // tree / other arms). Same substitution for both arms -> the A/B task stays identical.
  const sessionId = crypto.randomUUID();
  const body = specBody.split(REPO).join(wt);
  const cm = consultMode();
  const onPreamble = cm === 'mandatory' ? ON_PREAMBLE_MANDATORY : cm === 'lean' ? ON_PREAMBLE_LEAN : cm === 'search' ? ON_PREAMBLE_SEARCH : cm === 'dagrag' ? ON_PREAMBLE_DAGRAG : ON_PREAMBLE_PERMISSIVE;

  // Context injection: bench-context-inject.js may pass pre-fetched context via env vars.
  // BENCH_INJECT_GLOBAL_SUMMARY: JSON { done, in_progress, ready, blocked, recentTitles[] }
  // BENCH_INJECT_WINDOW: JSON Array<{ task_key, title, summary }>
  // Injected as a read-only context block prepended to the full prompt (works for any arm).
  let injectionPrefix = '';
  if (process.env.BENCH_INJECT_GLOBAL_SUMMARY) {
    try {
      const gs = JSON.parse(process.env.BENCH_INJECT_GLOBAL_SUMMARY);
      injectionPrefix +=
        '## Graph context (global summary)\n' +

        `Tasks: ${gs.done} done, ${gs.in_progress} in-progress, ${gs.ready} ready, ${gs.blocked} blocked.\n` +

        (gs.recentTitles && gs.recentTitles.length
          ? 'Recently completed: ' + gs.recentTitles.slice(0, 5).join('; ') + '.\n'

          : '') +
        '\n';

    } catch { /* malformed — skip */ }
  }
  if (process.env.BENCH_INJECT_WINDOW) {
    try {
      const win = JSON.parse(process.env.BENCH_INJECT_WINDOW);
      if (Array.isArray(win) && win.length) {
        injectionPrefix += '## Graph context (recent completed tasks)\n';

        for (const t of win) {
          injectionPrefix += `- ${t.task_key}: ${t.title}` +
            (t.summary ? ` — ${t.summary}` : '') + '\n';

        }
        injectionPrefix += '\n';

      }
    } catch { /* malformed — skip */ }
  }

  const prompt = injectionPrefix + (arm === 'on' ? onPreamble : '') + body;
  const mcpConfig = path.join(REPO, `bench/mcp-${arm}.json`);

  // (c) headless run, guarded by perl alarm (macOS has no `timeout`)
  const args = [
    '-e', `alarm ${TIMEOUT_S}; exec @ARGV`, '--',
    CLAUDE, '-p', prompt,
    '--mcp-config', mcpConfig,
    '--strict-mcp-config',                 // ONLY use these servers -> clean OFF arm (no project .mcp.json leak)
    '--session-id', sessionId,
    '--model', MODEL,
    '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions',      // throwaway worktree -> safe; non-interactive Edit/Write/Bash
    '--add-dir', wt,
  ];
  // ON arm: ORCH_WORKSPACE points the arm's orchestrator MCP at the REAL cloude graph (read-only
  // context) — verified NOT to hijack the daemon workspace. OFF arm: unchanged env.
  const env = arm === 'on' ? { ...process.env, ORCH_WORKSPACE } : process.env;
  const t0 = Date.now();
  const run = spawnSync('perl', args, { cwd: wt, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const wallMs = Date.now() - t0;
  const exitCode = run.status === null ? 124 : run.status;  // null => killed by alarm/signal

  // (d) locate transcript: slug(cwd) replaces non-alnum-ish path separators with '-'
  // (verified convention: /Users/.../.claude/... -> -Users-...--claude-...).
  const slug = wt.replace(/[^A-Za-z0-9]/g, '-');
  let transcriptPath = path.join(
    process.env.HOME, '.claude', 'projects', slug, `${sessionId}.jsonl`);
  if (!fs.existsSync(transcriptPath)) {
    // fall back: search every project dir for <uuid>.jsonl
    const projRoot = path.join(process.env.HOME, '.claude', 'projects');
    for (const d of fs.readdirSync(projRoot)) {
      const cand = path.join(projRoot, d, `${sessionId}.jsonl`);
      if (fs.existsSync(cand)) { transcriptPath = cand; break; }
    }
  }

  // run acceptance test(s) in the worktree
  let solved = true;
  for (const cmd of accepts) {
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd: wt, encoding: 'utf8' });
    if (r.status !== 0) { solved = false; break; }
  }

  // (e) capture W (real-work proxy = final solution size) BEFORE the driver removes the worktree.
  // The arm is told not to commit, so the solution = unstaged diff vs HEAD + new untracked files.
  // diffChars = chars of `git diff HEAD` + bytes of every untracked file (e.g. bench/sandbox/*).
  let diffChars = 0;
  try {
    const d = spawnSync('git', ['-C', wt, '--no-pager', 'diff', 'HEAD'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (d.status === 0 && typeof d.stdout === 'string') diffChars += d.stdout.length;
    const u = spawnSync('git', ['-C', wt, 'ls-files', '--others', '--exclude-standard'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (u.status === 0 && typeof u.stdout === 'string') {
      for (const rel of u.stdout.split('\n')) {
        if (!rel) continue;
        try { diffChars += fs.statSync(path.join(wt, rel)).size; } catch { /* gone/unreadable */ }
      }
    }
  } catch { /* leave diffChars as 0 on any failure */ }
  const diffTokens = Math.round(diffChars / 4);

  process.stdout.write(JSON.stringify({
    problem, arm, trial, sessionId, transcriptPath, worktree: wt, model: MODEL, exitCode, solved, wallMs,
    diffChars, diffTokens,
  }) + '\n');
}

main();
