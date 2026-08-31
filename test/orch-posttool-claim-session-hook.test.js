#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NODE_HOOK = path.join(ROOT, 'hooks', 'orch-posttool-starttask.js');
const CODEX_SHELL_HOOK = path.join(ROOT, 'adapters', 'codex', 'hooks', 'post-start-task.sh');
const TRANSCRIPTS = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-hook-session-'));

function run(command, args, payload, env) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    delete childEnv.CODEX_THREAD_ID;
    Object.assign(childEnv, env);
    const child = spawn(command, args, {
      cwd: ROOT,
      env: childEnv,
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
  const executionPermit = {
    workspace: '/graph/default',
    session_id: 'mcp-fallback-session',
    task_key: 'codex/claim-hook-probe',
    agent_id: 'worker-probe',
  };
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
      content: [{ type: 'text', text: JSON.stringify({ ok: true, execution_permit: executionPermit }) }],
    },
    ...overrides,
  };
}

function lastRequest(server) {
  return server.requests[server.requests.length - 1];
}

function transcript(name, firstRecord, laterRecords = []) {
  const file = path.join(TRANSCRIPTS, `${name}.jsonl`);
  fs.writeFileSync(file, [firstRecord, ...laterRecords].map((record) => (
    typeof record === 'string' ? record : JSON.stringify(record)
  )).join('\n') + '\n');
  return file;
}

function desktopSessionMeta(parentSession, childSession, windowId = null) {
  return {
    type: 'session_meta',
    payload: {
      session_id: parentSession,
      id: childSession,
      parent_thread_id: parentSession,
      context_window: windowId ? { window_id: windowId } : undefined,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: parentSession,
            depth: 1,
            agent_path: '/root/worker',
          },
        },
      },
    },
  };
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
      { ok: true, execution_permit: { workspace: '/graph/workspace-0', session_id: 'fallback-0', task_key: 'codex/claim-hook-probe', agent_id: 'worker-probe' } },
      { isError: false, structuredContent: { ok: true, execution_permit: { workspace: '/graph/workspace-1', session_id: 'fallback-1', task_key: 'codex/claim-hook-probe', agent_id: 'worker-probe' } } },
      { content: [{ type: 'text', text: '{"ok":true,"execution_permit":{"id":"permit-test","workspace":"/graph/workspace-2","session_id":"fallback-2","task_key":"codex/claim-hook-probe","agent_id":"worker-probe"}}' }] },
    ];
    for (let i = 0; i < assignmentAliases.length; i++) {
      const before = stub.requests.length;
      const result = await run(process.execPath, [NODE_HOOK], assignmentPayload(assignmentAliases[i], {
        session_id: `real-codex-thread-${i}`,
        tool_response: successResponses[i],
        tool_input: {
          action: 'accept',
          task_key: 'codex/claim-hook-probe',
          agent_id: 'worker-probe',
          graph_repo: '/untrusted/client-workspace',
        },
      }), env);
      assert.equal(result.code, 0);
      assert.equal(stub.requests.length, before + 1, `${assignmentAliases[i]} should register a successful accept`);
      assert.deepEqual(lastRequest(stub).body, {
        task_key: 'codex/claim-hook-probe',
        session_id: `real-codex-thread-${i}`,
        agent_id: 'worker-probe',
        workspace: `/graph/workspace-${i}`,
        expected_session_id: `fallback-${i}`,
      });
    }

    {
      const before = stub.requests.length;
      const result = await run(process.execPath, [NODE_HOOK], assignmentPayload('subconscious_assignment', {
        session_id: 'parent-payload-session',
      }), { ...env, CODEX_THREAD_ID: 'child-thread-session', CODEX_SESSION_ID: 'parent-runtime-session' });
      assert.equal(result.code, 0);
      assert.equal(stub.requests.length, before + 1, 'trusted child thread env should override the parent hook payload');
      assert.deepEqual(lastRequest(stub).body, {
        task_key: 'codex/claim-hook-probe',
        session_id: 'child-thread-session',
        agent_id: 'worker-probe',
        workspace: '/graph/default',
        expected_session_id: 'mcp-fallback-session',
      });
    }

    {
      const before = stub.requests.length;
      const parentSession = 'desktop-parent-session';
      const childSession = 'desktop-child-session';
      const windowId = 'desktop-window-session';
      const childTranscript = transcript('desktop-child', desktopSessionMeta(parentSession, childSession, windowId));
      const permit = {
        workspace: '/graph/desktop-child',
        session_id: childSession,
        task_key: 'codex/claim-hook-probe',
        agent_id: 'worker-probe',
      };
      const result = await run(process.execPath, [NODE_HOOK], assignmentPayload('subconscious_assignment', {
        session_id: windowId,
        agent_id: childSession,
        agent_transcript_path: transcript('desktop-invalid-agent-path', '{not-json'),
        transcript_path: childTranscript,
        tool_input: {
          action: 'accept',
          task_key: 'codex/claim-hook-probe',
          agent_id: 'worker-probe',
          session_id: childSession,
        },
        tool_response: { ok: true, execution_permit: permit },
      }), { ...env, CODEX_THREAD_ID: parentSession, CODEX_SESSION_ID: parentSession });
      assert.equal(result.code, 0);
      assert.equal(stub.requests.length, before + 1, 'Desktop child transcript and matching transport agent should override the parent thread');
      assert.deepEqual(lastRequest(stub).body, {
        task_key: 'codex/claim-hook-probe',
        session_id: childSession,
        agent_id: 'worker-probe',
        workspace: '/graph/desktop-child',
        expected_session_id: childSession,
      });
    }

    {
      const parentSession = 'unproven-parent-session';
      const childSession = 'explicit-child-session';
      const permit = {
        workspace: '/graph/explicit-child',
        session_id: childSession,
        task_key: 'codex/claim-hook-probe',
        agent_id: 'worker-probe',
      };
      const inconsistent = desktopSessionMeta(parentSession, childSession);
      inconsistent.payload.parent_thread_id = 'different-parent';
      const provenWindow = 'explicit-child-window';
      const provenTranscript = transcript('explicit-child-proven', desktopSessionMeta(parentSession, childSession, provenWindow));
      const maliciousWindow = 'malicious-child-window';
      const cases = [
        ['missing transcript', {}],
        ['relative transcript path', { transcript_path: 'untrusted-relative.jsonl' }],
        ['malformed transcript', { transcript_path: transcript('malformed', '{not-json') }],
        ['mismatched parent metadata', {
          transcript_path: transcript('mismatched-parent', desktopSessionMeta('different-parent', childSession)),
        }],
        ['inconsistent parent metadata', {
          transcript_path: transcript('inconsistent-parent', inconsistent),
        }],
        ['metadata after the first record', {
          transcript_path: transcript(
            'metadata-not-first',
            { type: 'turn_context', payload: { session_id: parentSession } },
            [desktopSessionMeta(parentSession, childSession)],
          ),
        }],
        ['oversized first record', {
          transcript_path: transcript('oversized-first-record', JSON.stringify({
            ...desktopSessionMeta(parentSession, childSession),
            padding: 'x'.repeat(70 * 1024),
          })),
        }],
        ['matching transcript without top-level transport agent', {
          session_id: provenWindow,
          agent_id: undefined,
          transcript_path: provenTranscript,
        }],
        ['matching transcript with different top-level transport agent', {
          session_id: provenWindow,
          agent_id: 'different-child-session',
          transcript_path: provenTranscript,
        }],
        ['matching child/window metadata bound to a different parent', {
          session_id: maliciousWindow,
          transcript_path: transcript(
            'malicious-window-parent',
            desktopSessionMeta('different-parent', childSession, maliciousWindow),
          ),
        }],
      ];
      for (const [label, transcriptFields] of cases) {
        const before = stub.requests.length;
        const result = await run(process.execPath, [NODE_HOOK], assignmentPayload('subconscious_assignment', {
          session_id: parentSession,
          agent_id: childSession,
          ...transcriptFields,
          tool_input: {
            action: 'accept',
            task_key: 'codex/claim-hook-probe',
            agent_id: 'worker-probe',
            session_id: childSession,
          },
          tool_response: { ok: true, execution_permit: permit },
        }), { ...env, CODEX_THREAD_ID: parentSession, CODEX_SESSION_ID: parentSession });
        assert.equal(result.code, 0, label);
        assert.equal(stub.requests.length, before, `${label} must not rebind an explicit child permit to the parent`);
      }
    }

    {
      const before = stub.requests.length;
      const permit = {
        workspace: '/graph/advisory',
        session_id: 'advisory-fallback',
        task_key: 'codex/claim-hook-probe',
        agent_id: 'worker-probe',
      };
      const result = await run(process.execPath, [NODE_HOOK], assignmentPayload('subconscious_assignment', {
        session_id: 'advisory-child',
        tool_response: {
          structuredContent: { ok: true, execution_permit: permit },
          result: { git_claim: { ok: false, already_claimed: false, pushed: false, conflict: false, advisory: true, error: 'git claim acquire failed' } },
        },
      }), env);
      assert.equal(result.code, 0);
      assert.equal(stub.requests.length, before + 1, 'advisory git-claim failure must not hide a successful accept');
      assert.equal(lastRequest(stub).body.expected_session_id, 'advisory-fallback');

      const failedBefore = stub.requests.length;
      const failed = await run(process.execPath, [NODE_HOOK], assignmentPayload('subconscious_assignment', {
        tool_response: {
          structuredContent: { ok: true, execution_permit: permit },
          result: { git_claim: { ok: false, already_claimed: false, pushed: false, conflict: false, advisory: false, error: 'strict git claim failed' } },
        },
      }), env);
      assert.equal(failed.code, 0);
      assert.equal(stub.requests.length, failedBefore, 'non-advisory accept failure must not bind a session');
    }

    {
      const before = stub.requests.length;
      const result = await run(process.execPath, [NODE_HOOK], assignmentPayload('subconscious_assignment', {
        tool_response: { ok: true },
      }), env);
      assert.equal(result.code, 0);
      assert.equal(stub.requests.length, before, 'accept without a permit workspace must not use the client workspace fallback');
    }

    for (const field of ['task_key', 'agent_id']) {
      const before = stub.requests.length;
      const permit = {
        workspace: '/graph/mismatched-permit',
        session_id: 'mismatched-fallback',
        task_key: 'codex/claim-hook-probe',
        agent_id: 'worker-probe',
        [field]: `wrong-${field}`,
      };
      const result = await run(process.execPath, [NODE_HOOK], assignmentPayload('subconscious_assignment', {
        tool_response: { ok: true, execution_permit: permit },
      }), env);
      assert.equal(result.code, 0);
      assert.equal(stub.requests.length, before, `permit ${field} must match the accepted assignment`);
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
      const fallbackSession = `legacy-fallback-${before}`;
      const result = await run(process.execPath, [NODE_HOOK], {
        session_id: 'legacy-start-session',
        tool_name: toolName,
        tool_input: {
          task_key: 'codex/legacy-start',
          agent_id: 'legacy-worker',
          graph_repo: '/untrusted/legacy-workspace',
          session_id: 'untrusted-input-session',
        },
        tool_response: {
          ok: true,
          execution_permit: {
            workspace: '/graph/legacy-start',
            session_id: fallbackSession,
            task_key: 'codex/legacy-start',
            agent_id: 'legacy-worker',
          },
        },
      }, env);
      assert.equal(result.code, 0);
      assert.equal(stub.requests.length, before + 1, `${toolName} compatibility should remain active`);
      assert.deepEqual(lastRequest(stub).body, {
        task_key: 'codex/legacy-start',
        session_id: 'legacy-start-session',
        agent_id: 'legacy-worker',
        workspace: '/graph/legacy-start',
        expected_session_id: fallbackSession,
      });
    }

    {
      const before = stub.requests.length;
      const result = await run(process.execPath, [NODE_HOOK], {
        session_id: 'legacy-no-permit-session',
        tool_name: 'start_task',
        tool_input: {
          task_key: 'codex/legacy-start',
          agent_id: 'legacy-worker',
          graph_repo: '/workspace/legacy-start',
          session_id: 'legacy-no-permit-session',
        },
        tool_response: { ok: true },
      }, env);
      assert.equal(result.code, 0);
      assert.equal(stub.requests.length, before, 'legacy start without an authoritative response permit must not bind');
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
            workspace: '/untrusted/shell-client-workspace',
          },
          tool_response: {
            isError: false,
            content: [{ type: 'text', text: '{"ok":true,"execution_permit":{"workspace":"/graph/shell-workspace","session_id":"shell-fallback-session","task_key":"codex/claim-hook-probe","agent_id":"worker-probe"}}' }],
          },
        }
      ), { ...env, CODEX_THREAD_ID: 'shell-child-session', CODEX_SESSION_ID: 'shell-parent-runtime' });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(stub.requests.length, before + 1, 'Codex shell adapter should register successful accept');
      assert.deepEqual(lastRequest(stub).body, {
        task_key: 'codex/claim-hook-probe',
        session_id: 'shell-child-session',
        agent_id: 'worker-probe',
        workspace: '/graph/shell-workspace',
        expected_session_id: 'shell-fallback-session',
      });

      const transcriptBefore = stub.requests.length;
      const shellParent = 'shell-desktop-parent';
      const shellChild = 'shell-desktop-child';
      const shellWindow = 'shell-desktop-window';
      const shellTranscript = transcript('shell-desktop-child', desktopSessionMeta(shellParent, shellChild, shellWindow));
      const shellTranscriptPermit = {
        workspace: '/graph/shell-desktop-child',
        session_id: shellChild,
        task_key: 'codex/claim-hook-probe',
        agent_id: 'worker-probe',
      };
      const transcriptPayload = assignmentPayload('subconscious_assignment', {
        session_id: shellWindow,
        agent_id: shellChild,
        transcript_path: shellTranscript,
        tool_input: {
          action: 'accept',
          task_key: 'codex/claim-hook-probe',
          agent_id: 'worker-probe',
          session_id: shellChild,
        },
        tool_response: { ok: true, execution_permit: shellTranscriptPermit },
      });
      const shellDesktopEnv = {
        ...env,
        CODEX_THREAD_ID: shellParent,
        CODEX_SESSION_ID: shellParent,
      };
      assert.equal((await run('bash', [CODEX_SHELL_HOOK], transcriptPayload, shellDesktopEnv)).code, 0);
      assert.equal(stub.requests.length, transcriptBefore + 1, 'shell adapter should override the parent from proven Desktop child metadata');
      assert.deepEqual(lastRequest(stub).body, {
        task_key: 'codex/claim-hook-probe',
        session_id: shellChild,
        agent_id: 'worker-probe',
        workspace: '/graph/shell-desktop-child',
        expected_session_id: shellChild,
      });

      const missingAgentBefore = stub.requests.length;
      const missingAgentPayload = { ...transcriptPayload };
      delete missingAgentPayload.agent_id;
      assert.equal((await run('bash', [CODEX_SHELL_HOOK], missingAgentPayload, shellDesktopEnv)).code, 0);
      assert.equal(stub.requests.length, missingAgentBefore, 'shell adapter must not rebind an explicit child permit without the top-level transport agent');

      const mismatchedBefore = stub.requests.length;
      transcriptPayload.transcript_path = transcript(
        'shell-mismatched-parent',
        desktopSessionMeta('different-shell-parent', shellChild),
      );
      assert.equal((await run('bash', [CODEX_SHELL_HOOK], transcriptPayload, shellDesktopEnv)).code, 0);
      assert.equal(stub.requests.length, mismatchedBefore, 'shell adapter must not rebind an explicit child permit from mismatched metadata');

      const failedBefore = stub.requests.length;
      const failed = assignmentPayload('mcp__orchestrator-graph__subconscious_assignment', {
        tool_response: { isError: true, content: [{ type: 'text', text: '{"ok":true}' }] },
      });
      assert.equal((await run('bash', [CODEX_SHELL_HOOK], failed, env)).code, 0);
      assert.equal(stub.requests.length, failedBefore, 'Codex shell adapter must ignore failed accepts');

      const advisoryBefore = stub.requests.length;
      const shellPermit = {
        workspace: '/graph/shell-advisory',
        session_id: 'shell-advisory-fallback',
        task_key: 'codex/claim-hook-probe',
        agent_id: 'worker-probe',
      };
      const advisory = assignmentPayload('mcp__orchestrator_graph__subconscious_assignment', {
        session_id: 'shell-parent-session',
        tool_response: {
          structuredContent: { ok: true, execution_permit: shellPermit },
          result: { git_claim: { ok: false, already_claimed: false, pushed: false, conflict: false, advisory: true, error: 'git claim acquire failed' } },
        },
      });
      assert.equal((await run('bash', [CODEX_SHELL_HOOK], advisory, {
        ...env,
        CODEX_THREAD_ID: 'shell-child-session',
        CODEX_SESSION_ID: 'shell-parent-runtime',
      })).code, 0);
      assert.equal(stub.requests.length, advisoryBefore + 1, 'shell adapter should ignore advisory git-claim failure');
      assert.deepEqual(lastRequest(stub).body, {
        task_key: 'codex/claim-hook-probe',
        session_id: 'shell-child-session',
        agent_id: 'worker-probe',
        workspace: '/graph/shell-advisory',
        expected_session_id: 'shell-advisory-fallback',
      });

      const strictBefore = stub.requests.length;
      advisory.tool_response.result.git_claim.advisory = false;
      advisory.tool_response.result.git_claim.error = 'strict git claim failed';
      assert.equal((await run('bash', [CODEX_SHELL_HOOK], advisory, env)).code, 0);
      assert.equal(stub.requests.length, strictBefore, 'shell adapter must reject non-advisory accept failures');

      const legacyBefore = stub.requests.length;
      const legacy = {
        session_id: 'shell-legacy-real-session',
        tool_name: 'start_task',
        tool_input: {
          task_key: 'codex/shell-legacy',
          agent_id: 'shell-legacy-worker',
          graph_repo: '/untrusted/shell-legacy-workspace',
          session_id: 'untrusted-shell-input-session',
        },
        tool_response: {
          ok: true,
          execution_permit: {
            workspace: '/graph/shell-legacy',
            session_id: 'shell-legacy-fallback',
            task_key: 'codex/shell-legacy',
            agent_id: 'shell-legacy-worker',
          },
        },
      };
      assert.equal((await run('bash', [CODEX_SHELL_HOOK], legacy, env)).code, 0);
      assert.equal(stub.requests.length, legacyBefore + 1, 'shell legacy start should bind from its authoritative response permit');
      assert.deepEqual(lastRequest(stub).body, {
        task_key: 'codex/shell-legacy',
        session_id: 'shell-legacy-real-session',
        agent_id: 'shell-legacy-worker',
        workspace: '/graph/shell-legacy',
        expected_session_id: 'shell-legacy-fallback',
      });

      const noPermitBefore = stub.requests.length;
      delete legacy.tool_response.execution_permit;
      legacy.tool_input.session_id = legacy.session_id;
      assert.equal((await run('bash', [CODEX_SHELL_HOOK], legacy, env)).code, 0);
      assert.equal(stub.requests.length, noPermitBefore, 'shell legacy start without an authoritative response permit must not bind');
    }

    console.log('orch post-tool claim-session hook tests passed');
  } finally {
    await stub.close();
    fs.rmSync(TRANSCRIPTS, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
