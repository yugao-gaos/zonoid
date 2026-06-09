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

const REPO = '__INSTALL_DIR__';
const CLAUDE = '/opt/homebrew/bin/claude';
const MODEL = (function () {       // PINNED for ALL runs (A/B parity); default opus per user choice.
  const i = process.argv.indexOf('--model');
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : 'opus';
})();
const TIMEOUT_S = 600;

// Per-problem acceptance test commands, run with cwd = worktree root (relative paths resolve there).
const ACCEPTANCE = {
  greenfield:    [['node', 'bench/sandbox/parse-duration.test.js']],
  'context-rich':[['node', 'test/summarize-rejected.test.js'], ['node', 'test/rejected-digest.test.js']],
};

// ON arm joins the REAL cloude graph (read context) without hijacking the daemon workspace.
const ORCH_WORKSPACE = '__WORKSPACE__';
const ON_PREAMBLE =
  'You have the orchestrator-graph MCP. You MAY consult get_learnings / get_task_detail / ' +
  'get_full_graph for relevant prior context, but treat the graph as READ-ONLY — do NOT create, ' +
  'modify, claim, or complete any tasks/nodes.\n\n';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
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
  const accepts = ACCEPTANCE[problem];
  if (!accepts) { console.error('no acceptance test for problem: ' + problem); process.exit(2); }

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
  const prompt = (arm === 'on' ? ON_PREAMBLE : '') + body;
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

  process.stdout.write(JSON.stringify({
    problem, arm, trial, sessionId, transcriptPath, worktree: wt, model: MODEL, exitCode, solved, wallMs,
  }) + '\n');
}

main();
