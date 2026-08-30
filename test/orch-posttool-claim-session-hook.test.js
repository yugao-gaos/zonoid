#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NODE_HOOK = path.join(ROOT, 'hooks', 'orch-posttool-starttask.js');
const CODEX_SHELL_HOOK = path.join(ROOT, 'adapters', 'codex', 'hooks', 'post-start-task.sh');

function run(command, args, payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function startServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      requests.push({ method: req.method, path: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      requests,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

function assignmentPayload(toolName, overrides = {}) {
  return {
    session_id: 'real-codex-thread',
    tool_name: toolName,
    tool_input: {
      action: 'accept',
      task_key: 'codex/claim-hook-probe',
      agent_id: 'worker-probe',
      graph_repo: '/workspace/codex-claim-hook-probe',
    },
    tool_response: {
      isError: false,
      content: [{ type: 'text', text: '{"ok":true}' }],
    },
    ...overrides,
  };
}

function lastRequest(server) {
  return server.requests[server.requests.length - 1];
}

(async () => {
  const stub = await startServer();
  const env = { ORCH_PORT: String(stub.port) };
  try {
    const assignmentAliases = [
      'mcp__orchestrator-graph__subconscious_assignment',
      'mcp__orchestrator_graph__subconscious_assignment',
      'subconscious_assignment',
    ];
    const successResponses = [
      { ok: true },
      { isError: false, structuredContent: { ok: true } },
      { content: [{ type: 'text', text: '{"ok":true,"execution_permit":{"id":"permit-test"}}' }] },
    ];
    for (let i = 0; i < assignmentAliases.length; i++) {
      const before = stub.requests.length;
      const workspaceField = i === 1 ? { workspace: '/workspace/codex-claim-hook-probe' } : { graph_repo: '/workspace/codex-claim-hook-probe' };
      const result = await run(process.execPath, [NODE_HOOK], assignmentPayload(assignmentAliases[i], {
        session_id: `real-codex-thread-${i}`,
        tool_response: successResponses[i],
        tool_input: {
          action: 'accept',
          task_key: 'codex/claim-hook-probe',
          agent_id: 'worker-probe',
          ...workspaceField,
        },
      }), env);
      assert.equal(result.code, 0);
      assert.equal(stub.requests.length, before + 1, `${assignmentAliases[i]} should register a successful accept`);
      assert.deepEqual(lastRequest(stub).body, {
        task_key: 'codex/claim-hook-probe',
        session_id: `real-codex-thread-${i}`,
        agent_id: 'worker-probe',
        graph_repo: '/workspace/codex-claim-hook-probe',
        workspace: '/workspace/codex-claim-hook-probe',
      });
    }

    for (const action of ['prepare', 'read', 'complete', 'submit_verdict']) {
      const before = stub.requests.length;
      const result = await run(process.execPath, [NODE_HOOK], assignmentPayload('subconscious_assignment', {
        tool_input: { action, task_key: 'codex/claim-hook-probe', agent_id: 'worker-probe' },
      }), env);
      assert.equal(result.code, 0);
      assert.equal(stub.requests.length, before, `${action} must not register a claim session`);
    }

    const failedResponses = [
      undefined,
      { isError: true, content: [{ type: 'text', text: '{"ok":true}' }] },
      { structuredContent: { ok: false, error: 'claim refused' } },
      { error: { message: 'transport failed' } },
      { content: [{ type: 'text', text: 'not JSON success evidence' }] },
    ];
    for (const toolResponse of failedResponses) {
      const before = stub.requests.length;
      const payload = assignmentPayload('subconscious_assignment');
      payload.tool_response = toolResponse;
      const result = await run(process.execPath, [NODE_HOOK], payload, env);
      assert.equal(result.code, 0);
      assert.equal(stub.requests.length, before, 'failed or ambiguous accept must not register a claim session');
    }

    for (const toolName of [
      'mcp__orchestrator-graph__start_task',
      'mcp__orchestrator_graph__start_task',
      'start_task',
    ]) {
      const before = stub.requests.length;
      const result = await run(process.execPath, [NODE_HOOK], {
        session_id: 'legacy-start-session',
        tool_name: toolName,
        tool_input: { task_key: 'codex/legacy-start', agent_id: 'legacy-worker' },
      }, env);
      assert.equal(result.code, 0);
      assert.equal(stub.requests.length, before + 1, `${toolName} compatibility should remain active`);
      assert.equal(lastRequest(stub).body.agent_id, 'legacy-worker');
    }

    for (const missing of ['session_id', 'task_key', 'agent_id']) {
      const before = stub.requests.length;
      const payload = assignmentPayload('subconscious_assignment');
      if (missing === 'session_id') delete payload.session_id;
      else delete payload.tool_input[missing];
      const result = await run(process.execPath, [NODE_HOOK], payload, env);
      assert.equal(result.code, 0);
      assert.equal(stub.requests.length, before, `missing ${missing} must not call claim-session`);
    }

    const hasBash = spawnSync('bash', ['-lc', 'command -v jq >/dev/null && command -v curl >/dev/null']).status === 0;
    if (hasBash) {
      const before = stub.requests.length;
      const result = await run('bash', [CODEX_SHELL_HOOK], assignmentPayload(
        'mcp__orchestrator_graph__subconscious_assignment',
        {
          session_id: 'shell-real-session',
          tool_input: {
            action: 'accept',
            task_key: 'codex/claim-hook-probe',
            agent_id: 'worker-probe',
            workspace: '/workspace/codex-claim-hook-probe',
          },
        }
      ), env);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(stub.requests.length, before + 1, 'Codex shell adapter should register successful accept');
      assert.deepEqual(lastRequest(stub).body, {
        task_key: 'codex/claim-hook-probe',
        session_id: 'shell-real-session',
        agent_id: 'worker-probe',
        graph_repo: '/workspace/codex-claim-hook-probe',
        workspace: '/workspace/codex-claim-hook-probe',
      });

      const failedBefore = stub.requests.length;
      const failed = assignmentPayload('mcp__orchestrator-graph__subconscious_assignment', {
        tool_response: { isError: true, content: [{ type: 'text', text: '{"ok":true}' }] },
      });
      assert.equal((await run('bash', [CODEX_SHELL_HOOK], failed, env)).code, 0);
      assert.equal(stub.requests.length, failedBefore, 'Codex shell adapter must ignore failed accepts');
    }

    console.log('orch post-tool claim-session hook tests passed');
  } finally {
    await stub.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
