#!/usr/bin/env node
// Cursor adapter stack — end-to-end integration (CI-safe, no live Cursor IDE).
// Proves H1 hook relays, H4 classify injection, H2 post-todo-adopt minting, and D2 transcript reader work together.
//
// Run: node test/cursor-e2e-integration.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const ADAPTERS = path.join(REPO, 'adapters', 'cursor');
const SESSION_START = path.join(ADAPTERS, 'session-start.sh');
const ORCH_GATE = path.join(ADAPTERS, 'orch-gate.sh');
const POST_TODO = path.join(ADAPTERS, 'post-todo-adopt.sh');
const CLASSIFY = path.join(ADAPTERS, 'classify.sh');
const HOOKS_SAMPLE = path.join(ADAPTERS, 'hooks.json.sample');
const cursorTx = require('../lib/cursor-transcripts');
const filedrop = require('../lib/filedrop-tasks');
const { writeCurlStub, hookEnv } = require('./helpers/curl-stub');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForPing(port, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await req(port, 'GET', '/ping'); if (r.status === 200) return true; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function spawnDaemon(port, sandbox, extra = {}) {
  return spawn(process.execPath, [path.join(REPO, 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: sandbox, ORCH_PORT: String(port), ...extra },
    stdio: 'ignore',
  });
}

function runHook(script, input, env = {}) {
  // Split any caller-supplied `${stubDir}:${process.env.PATH}` PATH back into a stub dir + rebuild
  // through hookEnv so `jq` stays resolvable in the spawned bash on Windows (see
  // test/helpers/curl-stub.js). Hooks here depend on jq under `set -euo pipefail`.
  const { PATH: rawPath, ...rest } = env;
  let stubDirs = [];
  let overrides = rest;
  if (rawPath) {
    const tail = `:${process.env.PATH}`;
    stubDirs = rawPath.endsWith(tail) ? [rawPath.slice(0, -tail.length)] : [rawPath];
  } else {
    overrides = { ...rest, PATH: process.env.PATH };
  }
  const r = spawnSync('bash', [script], { input, encoding: 'utf8', env: hookEnv(stubDirs, overrides) });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ── 1) H1 hooks wired (sample + project hooks reference adapter scripts) ─────
{
  const sample = JSON.parse(fs.readFileSync(HOOKS_SAMPLE, 'utf8'));
  const cmds = JSON.stringify(sample).replace(/__INSTALL_DIR__\//g, '');
  ok('H1: sessionStart → session-start.sh', cmds.includes('adapters/cursor/session-start.sh'));
  ok('H1: beforeSubmitPrompt → classify.sh', cmds.includes('adapters/cursor/classify.sh'));
  ok('H1: preToolUse Write → orch-gate.sh', cmds.includes('adapters/cursor/orch-gate.sh'));
  ok('H1: preToolUse Shell → shell-gate.sh', cmds.includes('adapters/cursor/shell-gate.sh'));
  ok('H1: beforeShellExecution → before-shell-gate.sh', cmds.includes('adapters/cursor/before-shell-gate.sh'));
  ok('H1: subagentStart → subagent-start.sh', cmds.includes('adapters/cursor/subagent-start.sh'));
  ok('H1: subagentStop → subagent-stop.sh', cmds.includes('adapters/cursor/subagent-stop.sh'));
  const projHooks = path.join(REPO, '.cursor', 'hooks.json');
  if (fs.existsSync(projHooks)) {
    const pj = JSON.parse(fs.readFileSync(projHooks, 'utf8'));
    const pjStr = JSON.stringify(pj);
    ok('H2: project postToolUse → post-todo-adopt.sh', pjStr.includes('post-todo-adopt.sh'));
    ok('H2: TodoWrite matcher present', /TodoWrite|todo_write/.test(pjStr));
  } else {
    ok('H2: project hooks (skipped — no .cursor/hooks.json)', true);
  }
}

// ── 2) sessionStart → POST /workspace (sandbox daemon) ─────────────────────
(async () => {
  const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-e2e-d-')));
  const PORT = 18920 + Math.floor(Math.random() * 80);
  const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-e2e-ws-')));
  // Mark WS as a real workspace so repoRoot() resolves it (repo-rooted model: a bare
  // mkdtemp dir has repoRoot()===null, so start-daemon.js would skip registration). The
  // .graph marker is exactly what repoRoot looks for, and avoids a git dependency in the test.
  fs.mkdirSync(path.join(WS, '.graph'), { recursive: true });
  const TX = path.join(WS, 'fixture-transcript.jsonl');
  fs.writeFileSync(TX, '');

  const child = spawnDaemon(PORT, SANDBOX);
  try {
    ok('sessionStart: daemon up', await waitForPing(PORT));

    const payload = JSON.stringify({
      conversation_id: 'conv-e2e-001',
      workspace_roots: [WS],
      transcript_path: TX,
    });
    const r = runHook(SESSION_START, payload, {
      ORCH_ROOT: REPO,
      ORCH_PORT: String(PORT),
      CLAUDE_PLUGIN_DATA: SANDBOX,
      ZONOID_ROOT: REPO,
    });
    ok('sessionStart: hook exits 0', r.status === 0);

    // P3 daemon model: /health is workspace-agnostic — its `workspace` field only echoes the
    // OPTIONAL ?workspace= query param (routes/meta.js), it does NOT report a registered workspace.
    // Genuine proof of registration lives in /workspaces, which enumerates the repos the daemon knows
    // from session bindings (the cursor hook just bound one for WS). So assert WS shows up there.
    const wss = await req(PORT, 'GET', '/workspaces');
    const registeredRepos = (wss.body.workspaces || []).flatMap((w) => (w.repos || []).map((r2) => r2.path));
    ok('sessionStart: workspace registered', registeredRepos.includes(WS));
    const health = await req(PORT, 'GET', '/health');
    ok('sessionStart: session binding registered', health.body.sessions >= 1);
  } finally {
    child.kill('SIGTERM');
  }

  // ── 3) gate denies unclaimed Write (cursor orch-gate → shared orch-gate.js via Node HTTP) ─
  // The gate now uses Node's http module (not curl), so we spawn a real stub daemon process
  // (not a curl shim — spawnSync blocks the Node event loop, so the in-process server can't
  // serve requests while the gate subprocess runs synchronously). The stub responds with
  // {claimed:false} for /active-claim and {is_subagent:true} for /session-info so the gate
  // correctly denies the unclaimed subagent write.
  {
    const gatePort = 18800 + Math.floor(Math.random() * 100);
    const stubServerCode = `
'use strict';
const http = require('http');
const srv = http.createServer((req, res) => {
  res.writeHead(200, {'content-type': 'application/json'});
  if (req.url && req.url.includes('/active-claim')) res.end(JSON.stringify({claimed:false,claims:[]}));
  else if (req.url && req.url.includes('/session-info')) res.end(JSON.stringify({is_subagent:true}));
  else res.end('{}');
});
srv.listen(${gatePort}, '127.0.0.1', () => { process.stdout.write('ready\\n'); });
`;
    const stubFile = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-stub-'));
    const stubPath = path.join(stubFile, 'stub.js');
    fs.writeFileSync(stubPath, stubServerCode);
    const stubProc = spawn(process.execPath, [stubPath], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((r) => { stubProc.stdout.once('data', r); });

    const gateIn = JSON.stringify({
      conversation_id: 'conv-gate-sub',
      tool_name: 'Write',
      tool_input: { file_path: '/Users/x/proj/src.js', new_string: 'x' },
    });
    const gr = runHook(ORCH_GATE, gateIn, {
      // lib.sh resolves the shared gate from ZONOID_ROOT (not ORCH_ROOT, which it overwrites);
      // without it the path falls back to ~/.claude/orchestrator, which isn't present in CI.
      ZONOID_ROOT: REPO,
      ORCH_ROOT: REPO,
      ORCH_PORT: String(gatePort),
    });
    stubProc.kill('SIGKILL');
    try { fs.rmSync(stubFile, { recursive: true, force: true }); } catch { /* best effort */ }
    ok('gate: unclaimed subagent Write → exit 2', gr.status === 2);
    ok('gate: denial message mentions claim', /no task claimed|start_task/i.test(gr.stderr));
  }

  // ── 4) post-todo-adopt mints cursor/<id>.json stubs from fixture stdin ─────
  {
    const mintSandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-mint-')));
    const mintWs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-mint-ws-')));
    const todoPayload = JSON.stringify({
      conversation_id: 'conv-mint-99',
      tool_name: 'TodoWrite',
      workspace_roots: [mintWs],
      agent_id: 'agent-mint-1',
      tool_input: {
        todos: [
          { id: 'e2e-todo-a', content: 'First minted todo', status: 'pending' },
          { id: 'e2e-todo-b', content: 'Second minted todo', status: 'in_progress' },
        ],
      },
    });
    const mr = runHook(POST_TODO, todoPayload, {
      ORCH_PORT: '1',
      CLAUDE_PLUGIN_DATA: mintSandbox,
    });
    ok('mint: hook exits 0', mr.status === 0);
    ok('mint: additional_context in stdout', /additional_context/.test(mr.stdout));
    ok('mint: quarantine nudge present', /QUARANTINED|suggest_links/i.test(mr.stdout));

    const stubDir = path.join(mintSandbox, 'tasks', filedrop.workspaceKey(mintWs), 'cursor');
    const stubA = path.join(stubDir, 'e2e-todo-a.json');
    const stubB = path.join(stubDir, 'e2e-todo-b.json');
    ok('mint: stub e2e-todo-a.json exists', fs.existsSync(stubA));
    ok('mint: stub e2e-todo-b.json exists', fs.existsSync(stubB));
    if (fs.existsSync(stubA)) {
      const j = JSON.parse(fs.readFileSync(stubA, 'utf8'));
      ok('mint: stub subject from content', j.subject === 'First minted todo');
      ok('mint: created_by.harness cursor', j.created_by && j.created_by.harness === 'cursor');
    }
    fs.rmSync(mintSandbox, { recursive: true, force: true });
    fs.rmSync(mintWs, { recursive: true, force: true });
  }

  // ── 5) beforeSubmitPrompt → classify.sh (sandbox daemon POST /classify) ────
  {
    const clSandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-cl-d-')));
    const clPort = 19020 + Math.floor(Math.random() * 40);
    const clWs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-cl-ws-')));
    const conv = 'conv-classify-e2e';
    fs.mkdirSync(path.join(clWs, '.graph'), { recursive: true });
    fs.writeFileSync(path.join(clWs, '.graph', 'checkpoint.json'), JSON.stringify({ nodes: {}, edges: [] }));

    const clChild = spawnDaemon(clPort, clSandbox, { ZONOID_SKIP_LIVE: '1' });
    try {
      ok('classify: daemon up', await waitForPing(clPort));
      await req(clPort, 'POST', '/workspace', { path: clWs, force: true });

      const payload = JSON.stringify({
        conversation_id: conv,
        prompt: 'fix the login button color',
        workspace_roots: [clWs],
      });
      const cr = runHook(CLASSIFY, payload, {
        ORCH_ROOT: REPO,
        ORCH_PORT: String(clPort),
        CLAUDE_PLUGIN_DATA: clSandbox,
        ZONOID_ROOT: REPO,
      });
      ok('classify: hook exits 0', cr.status === 0);
      ok('classify: additionalContext in stdout', /additionalContext/.test(cr.stdout));

      let out;
      try { out = JSON.parse(cr.stdout); } catch { /* */ }
      const ctx = (out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
      ok('classify: hookEventName beforeSubmitPrompt', out && out.hookSpecificOutput.hookEventName === 'beforeSubmitPrompt');
      ok('classify: model routing from daemon', ctx.includes('[Model routing]'));
      ok('classify: gate reminder from daemon', ctx.includes('[Orch gate]'));
      ok('classify: heartbeat from daemon', ctx.includes('[Orchestrator heartbeat]'));
    } finally {
      clChild.kill('SIGTERM');
      fs.rmSync(clSandbox, { recursive: true, force: true });
      fs.rmSync(clWs, { recursive: true, force: true });
    }
  }

  // ── 6) costflow includes cursor harness when transcript fixture present ────
  {
    const cfSandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-cf-d-')));
    const cfPort = 18980 + Math.floor(Math.random() * 40);
    const cfWs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-cf-ws-')));
    const conv = 'conv-costflow-e2e';
    const projDir = cursorTx.projectDir(cfWs);
    const convDir = path.join(projDir, 'agent-transcripts', conv);
    fs.mkdirSync(convDir, { recursive: true });
    const txPath = path.join(convDir, `${conv}.jsonl`);
    const L = (o) => JSON.stringify(o);
    fs.writeFileSync(txPath, [
      L({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nplan the feature\n</user_query>' }] } }),
      L({ role: 'assistant', message: { content: 'ok' }, usage: { input_tokens: 100, output_tokens: 400 } }),
    ].join('\n') + '\n');

    const cfChild = spawnDaemon(cfPort, cfSandbox, { ZONOID_HARNESS: 'cursor' });
    try {
      ok('costflow: daemon up', await waitForPing(cfPort));
      await req(cfPort, 'POST', '/workspace', { path: cfWs, transcript: txPath, force: true });

      const cf = await req(cfPort, 'GET', `/costflow?workspace=${encodeURIComponent(cfWs)}`);
      ok('costflow: 200 response', cf.status === 200);
      ok('costflow: human input from cursor transcript', cf.body.human && cf.body.human.tokens > 0);
      ok('costflow: session catchalls present', cf.body.sessions && cf.body.sessions.count >= 1);
      ok('costflow: totals include transcript output', cf.body.totals && cf.body.totals.output_tokens >= 400);
    } finally {
      cfChild.kill('SIGTERM');
      fs.rmSync(path.dirname(projDir), { recursive: true, force: true });
      fs.rmSync(cfWs, { recursive: true, force: true });
      fs.rmSync(cfSandbox, { recursive: true, force: true });
    }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
