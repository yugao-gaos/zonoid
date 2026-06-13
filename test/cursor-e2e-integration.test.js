#!/usr/bin/env node
// Cursor adapter stack — end-to-end integration (CI-safe, no live Cursor IDE).
// Proves H1 hook relays, H2 post-todo-adopt minting, and D2 transcript reader work together.
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
const HOOKS_SAMPLE = path.join(ADAPTERS, 'hooks.json.sample');
const cursorTx = require('../lib/cursor-transcripts');
const filedrop = require('../lib/filedrop-tasks');

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

function runHook(script, input, env) {
  const r = spawnSync('bash', [script], { input, encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ── 1) H1 hooks wired (sample + project hooks reference adapter scripts) ─────
{
  const sample = JSON.parse(fs.readFileSync(HOOKS_SAMPLE, 'utf8'));
  const cmds = JSON.stringify(sample).replace(/__INSTALL_DIR__\//g, '');
  ok('H1: sessionStart → session-start.sh', cmds.includes('adapters/cursor/session-start.sh'));
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

    const health = await req(PORT, 'GET', '/health');
    ok('sessionStart: workspace registered', health.body.workspace === WS);
    ok('sessionStart: mainTranscript set', health.body.mainTranscript === true);
  } finally {
    child.kill('SIGTERM');
  }

  // ── 3) gate denies unclaimed Write (cursor orch-gate → shared orch-gate.sh) ─
  {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-gate-stub-'));
    fs.writeFileSync(path.join(stubDir, 'curl'), `#!/bin/bash
U="\${@: -1}"
if [[ "\$U" == *"/active-claim"* ]]; then echo '{"claimed":false}'
elif [[ "\$U" == *"/session-info"* ]]; then echo '{"is_subagent":"true"}'
fi
exit 0
`, { mode: 0o755 });

    const gateIn = JSON.stringify({
      conversation_id: 'conv-gate-sub',
      tool_name: 'Write',
      tool_input: { file_path: '/Users/x/proj/src.js', new_string: 'x' },
    });
    const gr = runHook(ORCH_GATE, gateIn, {
      ORCH_ROOT: REPO,
      ORCH_PORT: '8787',
      PATH: `${stubDir}:${process.env.PATH}`,
    });
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

  // ── 5) costflow includes cursor harness when transcript fixture present ────
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
