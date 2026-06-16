#!/usr/bin/env node
// Product E2E bench — full orchestrator (DAG + RAG + gate) vs plain agent.
//
// Runs paired OFF/ON arms on multi-task scenarios where Task B requires context from Task A.
// v1 skeleton: hand-authored dag-chain scenario; --dry-run for CI without Claude.
//
// Usage:
//   node scripts/bench-e2e.js --scenario dag-chain [--trials 1] [--dry-run] [--model sonnet]
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const os = require('os');

const REPO = process.env.ZONOID_REPO || path.resolve(__dirname, '..');
const CLAUDE = process.env.CLAUDE_BIN || '/opt/homebrew/bin/claude';
const TIMEOUT_S = 600;
const snapDaemon = require('./bench-snapshot-daemon');
const { encodeWorkspace } = require('../lib/native-tasks');

const ON_PREAMBLE =
  'You have the orchestrator-graph MCP. Before writing any code you MUST call get_dependency_summaries ' +
  'for your task_key and apply any prior-task summaries. Graph is READ-ONLY for this bench — do NOT ' +
  'create, modify, claim, or complete any tasks/nodes.\n\n';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function loadScenario(name) {
  const dir = path.join(REPO, 'bench', 'e2e', 'scenarios', name);
  const jsonPath = path.join(dir, 'scenario.json');
  if (!fs.existsSync(jsonPath)) throw new Error('scenario not found: ' + name);
  const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  return { dir, name, ...cfg };
}

function renderTemplate(text, vars) {
  let out = text;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split('{{' + k + '}}').join(String(v));
  }
  return out;
}

function runGrader(scenarioDir, graderRel, artifactPath, secret) {
  const grader = path.join(scenarioDir, graderRel);
  const g = spawnSync(process.execPath, [grader, artifactPath, secret], { encoding: 'utf8', windowsHide: true });
  const line = (g.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
  try { return JSON.parse(line); }
  catch (e) { return { ok: false, error: 'grader parse fail: ' + e.message }; }
}

function httpJson(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
      timeout: 8000,
    }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: s ? JSON.parse(s) : {} }); }
        catch { resolve({ status: res.statusCode, body: { raw: s } }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('http timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function taskSummary(scenario) {
  return renderTemplate(scenario.taskA.summaryTemplate, { secret: scenario.secret });
}

/** Create native task fixtures under ~/.claude for the given workspace session. */
function writeNativeFixtures(workspace, session, scenario) {
  const projDir = path.join(os.homedir(), '.claude', 'projects', encodeWorkspace(workspace));
  const tasksDir = path.join(os.homedir(), '.claude', 'tasks', session);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, session + '.jsonl'), '');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, scenario.taskA.id + '.json'), JSON.stringify({
    id: String(scenario.taskA.id),
    subject: scenario.taskA.label,
    status: 'pending',
  }));
  fs.writeFileSync(path.join(tasksDir, scenario.taskB.id + '.json'), JSON.stringify({
    id: String(scenario.taskB.id),
    subject: scenario.taskB.label,
    status: 'pending',
  }));
  const keyA = session + '/' + scenario.taskA.id;
  const keyB = session + '/' + scenario.taskB.id;
  return { keyA, keyB, projDir, tasksDir };
}

function cleanupNativeFixtures({ projDir, tasksDir, session }) {
  try { fs.rmSync(tasksDir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(path.join(projDir, session + '.jsonl'), { force: true }); } catch { /* */ }
  try { if (fs.readdirSync(projDir).length === 0) fs.rmdirSync(projDir); } catch { /* */ }
}

/** Seed ON-arm graph: Task A done with secret summary, context edge A→B. */
async function seedGraphOnArm({ port, workspace, scenario, keyA, keyB }) {
  const summary = taskSummary(scenario);
  await httpJson(port, 'POST', '/workspace', { path: workspace });
  await httpJson(port, 'GET', '/state');
  const edge = await httpJson(port, 'POST', '/overlay/edge', { from: keyA, to: keyB, kind: 'context' });
  if (edge.status >= 400 || edge.body.error) throw new Error('edge seed failed: ' + JSON.stringify(edge.body));
  const done = await httpJson(port, 'POST', '/overlay/status', {
    key: keyA, status: 'done', summary, agent_id: 'bench-e2e-seed',
  });
  if (done.status >= 400 || done.body.error) throw new Error('task A seed failed: ' + JSON.stringify(done.body));
  const ctx = await httpJson(port, 'GET', '/task/context?key=' + encodeURIComponent(keyB));
  return { summary, ctx: ctx.body };
}

function buildTaskBPrompt(scenario, scenarioDir, taskBKey, arm) {
  const body = renderTemplate(
    fs.readFileSync(path.join(scenarioDir, scenario.taskB.promptFile), 'utf8'),
    { TASK_B_KEY: taskBKey, SECRET: scenario.secret }
  );
  return (arm === 'on' ? ON_PREAMBLE : '') + body.split(REPO).join('__WORKTREE__');
}

function extractTokens(tPath) {
  try {
    const lines = fs.readFileSync(tPath, 'utf8').trim().split('\n').filter(Boolean);
    let inputTokens = 0, outputTokens = 0;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const usage = obj?.message?.usage || obj?.usage;
        if (usage) {
          inputTokens += usage.input_tokens || 0;
          outputTokens += usage.output_tokens || 0;
        }
      } catch { /* skip */ }
    }
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  } catch { return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }; }
}

/** Dry-run: mock OFF fail + ON pass via grader only (no Claude, no daemon). */
async function runDryRun(scenario, scenarioDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-e2e-dry-'));
  const offPath = path.join(tmp, 'off.txt');
  const onPath = path.join(tmp, 'on.txt');
  fs.writeFileSync(offPath, 'UNKNOWN\n');
  fs.writeFileSync(onPath, scenario.secret + '\n');
  const offGrade = runGrader(scenarioDir, scenario.grader, offPath, scenario.secret);
  const onGrade = runGrader(scenarioDir, scenario.grader, onPath, scenario.secret);
  return {
    mode: 'dry-run',
    off: { passed: !!offGrade.ok, grade: offGrade },
    on: { passed: !!onGrade.ok, grade: onGrade },
    dagRequired: !offGrade.ok && onGrade.ok,
  };
}

function prepareWorktree(scenarioName, trial) {
  const wtRel = 'worktrees/bench/e2e-' + scenarioName + '-' + trial;
  const wt = path.join(REPO, wtRel);
  const branch = 'orch/bench/e2e-' + scenarioName + '-' + trial;
  spawnSync('git', ['-C', REPO, 'worktree', 'remove', '--force', wtRel], { stdio: 'ignore', windowsHide: true });
  spawnSync('git', ['-C', REPO, 'branch', '-D', branch], { stdio: 'ignore', windowsHide: true });
  const add = spawnSync('git', ['-C', REPO, 'worktree', 'add', '-b', branch, wtRel, 'HEAD'], { encoding: 'utf8', windowsHide: true });
  if (add.status !== 0) throw new Error('worktree add failed: ' + add.stderr);
  return wt;
}

async function runLiveArm({ arm, scenario, scenarioDir, trial, worktree, orchPort, session, keyB, fixtures }) {
  const prompt = buildTaskBPrompt(scenario, scenarioDir, keyB, arm)
    .split('__WORKTREE__').join(worktree);
  const mcpConfig = path.join(REPO, 'bench/mcp-' + arm + '.json');
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(worktree, scenario.artifact);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });

  if (arm === 'on') {
    await seedGraphOnArm({
      port: orchPort,
      workspace: worktree,
      scenario,
      keyA: fixtures.keyA,
      keyB: fixtures.keyB,
    });
  }

  const args = [
    '-e', 'alarm ' + TIMEOUT_S + '; exec @ARGV', '--',
    CLAUDE, '-p', prompt,
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--session-id', sessionId,
    '--model', arg('model', 'sonnet'),
    '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions',
    '--add-dir', worktree,
  ];
  const env = arm === 'on'
    ? { ...process.env, ORCH_WORKSPACE: worktree, ORCH_GATE_OFF: '1', ORCH_PORT: String(orchPort) }
    : { ...process.env, ORCH_GATE_OFF: '1' };

  const t0 = Date.now();
  const run = spawnSync('perl', args, { cwd: worktree, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const wallMs = Date.now() - t0;

  let transcriptPath = path.join(process.env.HOME, '.claude', 'projects',
    worktree.replace(/[^A-Za-z0-9]/g, '-'), sessionId + '.jsonl');
  if (!fs.existsSync(transcriptPath)) {
    try {
      for (const d of fs.readdirSync(path.join(process.env.HOME, '.claude', 'projects'))) {
        const cand = path.join(process.env.HOME, '.claude', 'projects', d, sessionId + '.jsonl');
        if (fs.existsSync(cand)) { transcriptPath = cand; break; }
      }
    } catch { /* ignore */ }
  }
  const tokens = extractTokens(transcriptPath);
  const grade = runGrader(scenarioDir, scenario.grader, artifactPath, scenario.secret);

  return {
    arm, trial, sessionId, passed: !!grade.ok, grade, wallMs, tokens,
    exitCode: run.status === null ? 124 : run.status,
    artifactPresent: fs.existsSync(artifactPath),
  };
}

async function main() {
  const scenarioName = arg('scenario');
  const trials = parseInt(arg('trials', '1'), 10);
  const dryRun = process.argv.includes('--dry-run');
  if (!scenarioName) {
    console.error('usage: bench-e2e.js --scenario <name> [--trials N] [--dry-run] [--model sonnet]');
    process.exit(2);
  }

  const scenario = loadScenario(scenarioName);
  const scenarioDir = scenario.dir;
  const results = [];

  if (dryRun) {
    const cmp = await runDryRun(scenario, scenarioDir);
    const row = { scenario: scenarioName, trial: 0, ...cmp, ts: new Date().toISOString() };
    process.stdout.write(JSON.stringify(row) + '\n');
    process.exit(cmp.dagRequired ? 0 : 1);
  }

  let isolatedPort = null;
  let sandboxData = null;
  let daemonChild = null;
  const useIsolated = process.env.ZONOID_BENCH_ISOLATED === '1';

  try {
    if (useIsolated) {
      isolatedPort = await snapDaemon.ensureRunning();
    } else {
      // Private daemon for graph seeding (never touch live :8787)
      isolatedPort = 8820 + Math.floor(Math.random() * 70);
      sandboxData = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-e2e-orch-'));
      daemonChild = require('child_process').spawn(process.execPath, [path.join(REPO, 'daemon.js')], {
        env: { ...process.env, ORCH_PORT: String(isolatedPort), CLAUDE_PLUGIN_DATA: sandboxData },
        stdio: 'ignore',
        windowsHide: true,
      });
      for (let i = 0; i < 80; i++) {
        try {
          const p = await httpJson(isolatedPort, 'GET', '/ping');
          if (p.status === 200) break;
        } catch { /* wait */ }
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    for (let trial = 0; trial < trials; trial++) {
      const wt = prepareWorktree(scenarioName, trial);
      const session = 'bench-e2e-' + scenarioName + '-' + trial + '-' + crypto.randomBytes(4).toString('hex');
      const fixtures = writeNativeFixtures(wt, session, scenario);

      try {
        const off = await runLiveArm({
          arm: 'off', scenario, scenarioDir, trial, worktree: wt,
          orchPort: isolatedPort, session, keyB: fixtures.keyB, fixtures,
        });
        results.push(off);

        const on = await runLiveArm({
          arm: 'on', scenario, scenarioDir, trial, worktree: wt,
          orchPort: isolatedPort, session, keyB: fixtures.keyB, fixtures,
        });
        results.push(on);

        const summary = {
          scenario: scenarioName, trial,
          offPassed: off.passed, onPassed: on.passed,
          dagRequired: !off.passed && on.passed,
          tokenDelta: (on.tokens?.totalTokens || 0) - (off.tokens?.totalTokens || 0),
        };
        process.stdout.write(JSON.stringify(summary) + '\n');
        fs.appendFileSync(path.join(REPO, 'bench', 'e2e', 'results.jsonl'), JSON.stringify({ ...summary, ts: new Date().toISOString() }) + '\n');
      } finally {
        cleanupNativeFixtures({ ...fixtures, session });
      }
    }
  } finally {
    if (useIsolated) snapDaemon.teardown();
    else if (daemonChild) { try { daemonChild.kill('SIGKILL'); } catch { /* */ } }
    if (sandboxData) { try { fs.rmSync(sandboxData, { recursive: true, force: true }); } catch { /* */ } }
  }

  const anyDagWin = results.some((_, i) => i % 2 === 1 && results[i].passed && !results[i - 1].passed);
  process.exit(anyDagWin || results.length === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}

module.exports = {
  loadScenario, renderTemplate, runGrader, runDryRun, seedGraphOnArm,
  writeNativeFixtures, cleanupNativeFixtures, taskSummary, buildTaskBPrompt, ON_PREAMBLE,
};
