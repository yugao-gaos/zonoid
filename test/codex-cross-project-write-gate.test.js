#!/usr/bin/env node
'use strict';

// Codex Desktop can accept through an MCP fallback session while PostToolUse observes the
// real worker session. Exercise that split with the graph and target in different repositories.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-codex-cross-data-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;

const git = require('../lib/git');
const { encodeWorkspace } = require('../lib/native-tasks');

const ROOT = path.join(__dirname, '..');
const PORT = 19400 + Math.floor(Math.random() * 200);
const GRAPH_REPO = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-codex-graph-')));
const TARGET_REPO = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-codex-target-')));
const NATIVE_SESSION = crypto.randomUUID();
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects', encodeWorkspace(GRAPH_REPO));
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', NATIVE_SESSION);
const AGENT = 'codex-cross-project-worker';
const taskKey = (id) => `${NATIVE_SESSION}/${id}`;
const worktrees = [];

function request(method, route, body, scoped = true) {
  let requestRoute = route;
  let requestBody = body;
  if (scoped && route !== '/workspace' && route !== '/ping' && !route.includes('workspace=')) {
    if (requestBody && typeof requestBody === 'object') {
      requestBody = { ...requestBody, workspace: GRAPH_REPO };
    } else {
      requestRoute += `${route.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(GRAPH_REPO)}`;
    }
  }
  return new Promise((resolve, reject) => {
    const data = requestBody ? JSON.stringify(requestBody) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: requestRoute,
      method,
      headers: data ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        try { parsed = JSON.parse(text || '{}'); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForDaemon(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await request('GET', '/ping', null, false)).status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('test daemon did not start');
}

function runHook(file, payload) {
  return spawnSync(process.execPath, [path.join(ROOT, 'hooks', file)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ORCH_PORT: String(PORT), CLAUDE_PLUGIN_DATA: SANDBOX },
  });
}

function writeGate(toolName, filePath, sessionId, agentId = AGENT) {
  return runHook('orch-gate.js', {
    session_id: sessionId,
    agent_id: agentId,
    tool_name: toolName,
    tool_input: { file_path: filePath, new_string: 'first write\n' },
  });
}

function bashGate(command, worktree, sessionId, agentId = AGENT) {
  return runHook('orch-gate-bash.js', {
    session_id: sessionId,
    agent_id: agentId,
    tool_name: 'Bash',
    cwd: worktree,
    tool_input: { command },
  });
}

async function prepareAndAccept(key, fallbackSession) {
  assert.equal((await request('POST', '/mark-root', { task_key: key })).status, 200);
  const prepared = await request('POST', '/git/worktree', { key, target_repo: TARGET_REPO });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.notEqual(prepared.body.graph_repo, prepared.body.target_repo);
  assert.equal(fs.realpathSync(prepared.body.target_repo), TARGET_REPO);
  worktrees.push({ key, path: prepared.body.worktree });

  // subconscious_assignment action:"accept" delegates to this status route.
  const accepted = await request('POST', '/overlay/status', {
    key,
    status: 'in_progress',
    agent_id: AGENT,
    session_id: fallbackSession,
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.execution_permit.session_id, fallbackSession);
  assert.equal(accepted.body.execution_permit.worktree, prepared.body.worktree);
  return { prepared: prepared.body, accepted: accepted.body };
}

async function exerciseAlias({ id, alias, toolName }) {
  const key = taskKey(id);
  const fallbackSession = `codex-mcp-fallback-${id}`;
  const realSession = `codex-real-worker-${id}`;
  const { prepared, accepted } = await prepareAndAccept(key, fallbackSession);
  const fallbackActive = await request(
    'GET',
    `/active-claim?session=${encodeURIComponent(fallbackSession)}`,
    null,
    false,
  );
  assert.equal(fallbackActive.body.claimed, true, JSON.stringify(fallbackActive.body));

  const postTool = runHook('orch-posttool-starttask.js', {
    session_id: realSession,
    tool_name: alias,
    tool_input: {
      action: 'accept',
      task_key: key,
      agent_id: AGENT,
      graph_repo: GRAPH_REPO,
      target_repo: TARGET_REPO,
    },
    tool_response: {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(accepted) }],
    },
  });
  assert.equal(postTool.status, 0, postTool.stderr);

  // Deliberately omit workspace: the hook-bound claim must resolve from the graph repo even
  // though its registered Git worktree belongs to TARGET_REPO.
  const active = await request(
    'GET',
    `/active-claim?session=${encodeURIComponent(realSession)}`,
    null,
    false,
  );
  assert.equal(active.status, 200);
  assert.equal(active.body.claimed, true, JSON.stringify(active.body));
  const claim = active.body.claims.find((item) => item.key === key);
  assert(claim, JSON.stringify(active.body));
  assert.equal(fs.realpathSync(claim.workspace), GRAPH_REPO);

  const permit = await request(
    'GET',
    `/subconscious/permit?session_id=${encodeURIComponent(realSession)}&agent_id=${encodeURIComponent(AGENT)}&task_key=${encodeURIComponent(key)}`,
  );
  assert.equal(permit.status, 200);
  assert.equal(permit.body.valid, true);
  assert.equal(permit.body.execution_permit.session_id, realSession);
  assert.equal(permit.body.execution_permit.task_key, key);
  assert.equal(permit.body.execution_permit.agent_id, AGENT);
  assert.equal(permit.body.execution_permit.branch, prepared.branch);
  assert.equal(permit.body.execution_permit.worktree, prepared.worktree);
  assert.deepEqual(permit.body.execution_permit.allowed_paths, [prepared.worktree]);

  const firstWrite = path.join(prepared.worktree, `first-${toolName.toLowerCase()}.txt`);
  const writeResult = writeGate(toolName, firstWrite, realSession);
  assert.equal(writeResult.status, 0, writeResult.stderr);
  fs.writeFileSync(firstWrite, 'first write\n');

  const bashTarget = path.join(prepared.worktree, `bash-${id}.txt`);
  const shellTarget = bashTarget.replace(/\\/g, '/');
  const shellWorktree = prepared.worktree.replace(/\\/g, '/');
  const command = `printf codex > "${shellTarget}" && git -C "${shellWorktree}" add "${path.basename(bashTarget)}"`;
  const bashResult = bashGate(command, prepared.worktree, realSession);
  assert.equal(bashResult.status, 0, bashResult.stderr);
  fs.writeFileSync(bashTarget, 'codex');
  const mutation = spawnSync('git', ['-C', prepared.worktree, 'add', path.basename(bashTarget)], { encoding: 'utf8' });
  assert.equal(mutation.status, 0, mutation.stderr);
  const status = spawnSync('git', ['-C', prepared.worktree, 'status', '--short'], { encoding: 'utf8' }).stdout;
  assert.match(status, new RegExp(`A  bash-${id}\\.txt`));

  assert.equal(writeGate('Write', path.join(prepared.worktree, 'fallback-denied.txt'), fallbackSession).status, 2);
  assert.equal(writeGate('Write', path.join(prepared.worktree, 'wrong-agent.txt'), realSession, 'other-worker').status, 2);
  assert.equal(writeGate('Write', path.join(GRAPH_REPO, 'outside-worktree.txt'), realSession).status, 2);
  assert.equal(bashGate(`printf denied > ${path.join(GRAPH_REPO, 'outside-bash.txt')}`, prepared.worktree, realSession).status, 2);

  const wrongTaskPermit = await request(
    'GET',
    `/subconscious/permit?session_id=${encodeURIComponent(realSession)}&agent_id=${encodeURIComponent(AGENT)}&task_key=${encodeURIComponent(taskKey('unprepared'))}`,
  );
  assert.notEqual(wrongTaskPermit.body.valid, true);

  const failedSession = `codex-failed-accept-${id}`;
  const failedPostTool = runHook('orch-posttool-starttask.js', {
    session_id: failedSession,
    tool_name: alias,
    tool_input: { action: 'accept', task_key: key, agent_id: AGENT },
    tool_response: { isError: true, content: [{ type: 'text', text: '{"ok":true}' }] },
  });
  assert.equal(failedPostTool.status, 0);
  const failedActive = await request(
    'GET',
    `/active-claim?session=${encodeURIComponent(failedSession)}`,
    null,
    false,
  );
  assert.equal(failedActive.body.claimed, false);
}

(async () => {
  git.initRepo(GRAPH_REPO);
  git.initRepo(TARGET_REPO);
  assert.notEqual(git.commonDir(GRAPH_REPO), git.commonDir(TARGET_REPO));

  fs.mkdirSync(PROJ_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROJ_DIR, `${NATIVE_SESSION}.jsonl`), '');
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  for (const id of ['hyphen', 'underscore', 'unprepared', 'terminal']) {
    fs.writeFileSync(path.join(TASKS_DIR, `${id}.json`), JSON.stringify({
      id,
      subject: `Codex cross-project gate ${id}`,
      status: 'pending',
    }));
  }

  const daemon = spawn(process.execPath, [path.join(ROOT, 'daemon.js')], {
    cwd: GRAPH_REPO,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });

  try {
    await waitForDaemon();
    assert.equal((await request('POST', '/workspace', { path: GRAPH_REPO }, false)).status, 200);
    await request('GET', '/state');

    await exerciseAlias({
      id: 'hyphen',
      alias: 'mcp__orchestrator-graph__subconscious_assignment',
      toolName: 'Write',
    });
    await exerciseAlias({
      id: 'underscore',
      alias: 'mcp__orchestrator_graph__subconscious_assignment',
      toolName: 'Edit',
    });

    const unpreparedKey = taskKey('unprepared');
    assert.equal((await request('POST', '/mark-root', { task_key: unpreparedKey })).status, 200);
    const unprepared = await request('POST', '/overlay/claim-session', {
      task_key: unpreparedKey,
      session_id: 'unprepared-real-session',
      agent_id: AGENT,
    });
    assert.equal(unprepared.status, 409);
    assert.match(String(unprepared.body.error), /active claimed task/);

    const terminalKey = taskKey('terminal');
    await prepareAndAccept(terminalKey, 'terminal-fallback-session');
    const terminal = await request('POST', '/overlay/status', {
      key: terminalKey,
      status: 'canceled',
      agent_id: AGENT,
      session_id: 'terminal-fallback-session',
      summary: 'terminal fixture',
    });
    assert.equal(terminal.status, 200, JSON.stringify(terminal.body));
    const terminalRebind = await request('POST', '/overlay/claim-session', {
      task_key: terminalKey,
      session_id: 'terminal-real-session',
      agent_id: AGENT,
    });
    assert.equal(terminalRebind.status, 409);
    assert.match(String(terminalRebind.body.error), /active claimed task/);

    console.log('Codex cross-project write-gate E2E passed');
  } finally {
    daemon.kill();
    await new Promise((resolve) => daemon.once('exit', resolve));
    for (const item of worktrees) git.removeWorktree(TARGET_REPO, item.key);
    fs.rmSync(TASKS_DIR, { recursive: true, force: true });
    fs.rmSync(PROJ_DIR, { recursive: true, force: true });
    fs.rmSync(GRAPH_REPO, { recursive: true, force: true });
    fs.rmSync(TARGET_REPO, { recursive: true, force: true });
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
