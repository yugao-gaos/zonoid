#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const sessionBindings = require('../lib/session-bindings');
const { taskTranscript } = require('../daemon.js');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

(async () => {
// ── unit: session-bindings helpers ───────────────────────────────────────────
{
  ok('inferHarness: cursor path', sessionBindings.inferHarness('/Users/x/.cursor/projects/foo/agent-transcripts/c1/c1.jsonl') === 'cursor');
  ok('inferHarness: claude path', sessionBindings.inferHarness('/Users/x/.claude/projects/foo/bar.jsonl') === 'claude');
  ok('resolveSessionId: explicit session_id', sessionBindings.resolveSessionId({ session_id: 'abc' }, null) === 'abc');
  ok('resolveSessionId: from transcript basename', sessionBindings.resolveSessionId({}, '/tmp/conv-99.jsonl') === 'conv-99');

  let sessions = {};
  sessions = sessionBindings.bindSession(sessions, 's1', { transcript: '/tmp/s1.jsonl', workspace: '/ws', harness: 'cursor' });
  sessions = sessionBindings.bindSession(sessions, 's2', { transcript: '/tmp/s2.jsonl', workspace: '/ws', harness: 'claude' });
  ok('bindSession: two concurrent sessions retained', Object.keys(sessions).length === 2);
  ok('bindSession: updates lastSeen', !!sessions.s1.lastSeen);
  sessions = sessionBindings.bindSession(sessions, 's1', { workspace: '/ws2' });
  ok('bindSession: partial update keeps transcript', sessions.s1.transcript === '/tmp/s1.jsonl' && sessions.s1.workspace === '/ws2');
}

// ── integration: daemon taskTranscript via sessions map ──────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-bind-'));
  const mainA = path.join(tmp, 'sessA.jsonl');
  const mainB = path.join(tmp, 'sessB.jsonl');
  const subTp = path.join(tmp, 'sub.jsonl');
  fs.writeFileSync(mainA, JSON.stringify({ message: { usage: { input_tokens: 10, output_tokens: 2 } } }) + '\n');
  fs.writeFileSync(mainB, JSON.stringify({ message: { usage: { input_tokens: 99, output_tokens: 1 } } }) + '\n');
  fs.writeFileSync(subTp, JSON.stringify({ message: { usage: { input_tokens: 50, output_tokens: 5 } } }) + '\n');

  const st = {
    sessions: {
      sessA: { harness: 'claude', transcript: mainA, workspace: tmp, lastSeen: new Date().toISOString() },
      sessB: { harness: 'claude', transcript: mainB, workspace: tmp, lastSeen: new Date().toISOString() },
    },
    overlay: { assignee: {} },
    agents: {},
  };
  ok('taskTranscript resolves sessA binding', taskTranscript('sessA/1', 'sessA', true, st) === mainA);
  ok('taskTranscript resolves sessB binding (not last-wins)', taskTranscript('sessB/2', 'sessB', true, st) === mainB);
  ok('agent transcript_path still wins', taskTranscript('x/1', 'sessA', true, {
    ...st,
    overlay: { assignee: { 'x/1': 'w' } },
    agents: { w: { transcript_path: subTp } },
  }) === subTp);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── e2e: sandbox daemon POST /workspace binds per session ────────────────────
  const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sess-bind-d-')));
  const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sess-bind-ws-')));
  const PORT = 19650 + Math.floor(Math.random() * 40);
  const txA = path.join(WS, 'conv-a.jsonl');
  const txB = path.join(WS, 'conv-b.jsonl');
  fs.writeFileSync(txA, '');
  fs.writeFileSync(txB, '');

  const child = spawn('node', [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, ORCH_PORT: String(PORT), CLAUDE_PLUGIN_DATA: SANDBOX },
    stdio: 'ignore',
  });

  // Raw http.request (not global fetch/undici): undici keeps background async resources that race
  // with the child-process kill during Windows teardown, tripping a libuv async-handle assertion.
  function req(method, p, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({
        host: '127.0.0.1', port: PORT, path: p, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
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

  try {
    for (let i = 0; i < 80; i++) {
      try { const r = await req('GET', '/ping'); if (r.body.ok) break; } catch { /* */ }
      await new Promise((r) => setTimeout(r, 50));
    }

    await req('POST', '/workspace', { path: WS, transcript: txA, session_id: 'conv-a', force: true });
    let health = await req('GET', '/health');
    ok('health: sessions count after first bind', health.body.sessions === 1);
    ok('health: no mainTranscript field', health.body.mainTranscript === undefined);

    await req('POST', '/workspace', { path: WS, transcript: txB, session_id: 'conv-b', force: true });
    health = await req('GET', '/health');
    ok('health: two concurrent session bindings', health.body.sessions === 2);

    await req('POST', '/agent/start', { agent_id: 'sub-1', session: 'conv-a', transcript_path: txA, workspace: WS });
    const ping = await req('GET', '/ping');
    ok('ping: exposes session count', ping.body.sessions === 2);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    fs.rmSync(WS, { recursive: true, force: true });
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  // Windows-safe exit: the SIGTERM above followed by an immediate process.exit() in the same tick
  // trips a libuv async-handle assertion on Windows (UV_HANDLE_CLOSING, win/async.c) — the
  // child-exit watcher fires while the event loop is already closing. Defer the exit until the
  // child's 'close' has drained that watcher (unref'd timer as a safety net).
  const exitCode = fail === 0 ? 0 : 1;
  if (child.exitCode !== null || child.signalCode !== null) {
    process.exit(exitCode);
  } else {
    child.once('close', () => process.exit(exitCode));
    setTimeout(() => process.exit(exitCode), 3000).unref();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
