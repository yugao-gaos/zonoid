#!/usr/bin/env node
// Integration test for POST /sweep endpoint.
// Verifies response shape and idempotency (safe to call multiple times).
// Run: node --test test/sweep.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sweep-test-')));
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sweep-ws-')));
const PORT = 19900 + Math.floor(Math.random() * 100);
process.env.CLAUDE_PLUGIN_DATA = SANDBOX; // before filedrop reads env — test + daemon must agree on the stub dir
const filedropTasks = require('../lib/filedrop-tasks');

// Drop a file-drop task stub (a real adapter would), so the task is backed by a file and
// survives release — exactly how a stale claim lands on a real native/file-drop task.
function dropStub(harness, id, extra = {}) {
  const dir = path.join(filedropTasks.dirFor(WS), harness);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ id, subject: `stub ${id}`, ...extra }, null, 2));
  fs.renameSync(tmp, file);
}

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
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

async function waitForDaemon(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await req('GET', '/ping'); if (r.status === 200) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

let child;

test('POST /sweep', { timeout: 15000 }, async (t) => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });

  // WS doubles as the workspace AND the task repo — the claim path requires a registered worktree.
  execSync('git init -q', { cwd: WS });
  execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: WS });

  try {
    assert.ok(await waitForDaemon(), 'daemon came up');
    await req('POST', '/workspace', { path: WS });

    await t.test('returns ok:true and released count (no stale claims)', async () => {
      const r = await req('POST', '/sweep', { workspace: WS });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(typeof r.body.released, 'number');
      assert.equal(r.body.released, 0); // nothing to sweep on a fresh workspace
    });

    await t.test('is idempotent — second call returns same shape', async () => {
      const r = await req('POST', '/sweep', { workspace: WS });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(typeof r.body.released, 'number');
    });

    await t.test('releases a stale in_progress claim with force:true', async () => {
      // A file-drop stub task backed by a real file — survives release (unlike a synthetic
      // overlay-only key, which vanishes from buildGraph). Wired via blockedBy so it clears the
      // unwired quarantine and the in_progress claim lands.
      dropStub('cursor', 'blocker');
      dropStub('cursor', 'swp', { blockedBy: ['blocker'] });
      // First peek adopts the stubs into the overlay (mints snapshots + dependency edge).
      await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`);
      // Register the (soon-dead) worker so the claim's session_id is inferable from the registry.
      await req('POST', '/agent/start', {
        agent_id: 'dead-agent-sweep', session: 'dead-session', agent_tool_spawn: true,
      });
      await req('POST', '/git/worktree', { workspace: WS, key: 'cursor/swp', repo_path: WS });
      const claim = await req('POST', '/overlay/status', {
        workspace: WS, key: 'cursor/swp', status: 'in_progress',
        agent_id: 'dead-agent-sweep', session_id: 'dead-session',
      });
      assert.equal(claim.status, 200, 'claim placed (in_progress)');

      // stale_minutes:0 forces any claim to be immediately stale, force:true bypasses vouchedLive.
      const r = await req('POST', '/sweep', { workspace: WS, force: true, stale_minutes: 0 });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.released, 1);

      // (a) No durable "Continuity: stale claim reset" note node is created — continuity now
      // rides on the task's note, not a separate note node.
      const g = (await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`)).body;
      const continuityNotes = (g.tasks || []).filter(
        (t) => t.kind === 'note' && /Continuity: stale claim reset/.test(t.label || ''));
      assert.equal(continuityNotes.length, 0, 'no stale-claim continuity note node in graph');

      // (b) The released task still carries the continuity reason via get_task_detail → task.note.
      const d = (await req('GET', `/task/detail?key=${encodeURIComponent('cursor/swp')}&workspace=${encodeURIComponent(WS)}`)).body;
      assert.ok(d.task, 'task detail returned');
      assert.match(d.task.note, /sweep:.*idle/i, 'released task note carries the continuity reason');
    });

    await t.test('a force /sweep release reaps the owning agent out of the running count, keeps a live agent', async () => {
      // 3d: the POST /sweep route must reap the owning agent in lockstep with the released claim
      // (shared reapAgent helper), not leave it 'running' until the independent sweepStaleAgents
      // 60s pass. summary.agents.running is the count /graph exposes (daemon summaryFor).
      const graph = async () => (await req('GET', `/state?workspace=${encodeURIComponent(WS)}`)).body;
      const agentState = async (id) => (await graph()).agents.find((a) => a.agent_id === id);

      // One backed task whose claim we will force-sweep, owned by its own agent.
      dropStub('cursor', 'reap-blocker');
      dropStub('cursor', 'reap-swept', { blockedBy: ['reap-blocker'] });
      await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`);
      await req('POST', '/agent/start', { agent_id: 'reap-swept-agent', session: 'reap-swept-sess', agent_tool_spawn: true });
      await req('POST', '/git/worktree', { workspace: WS, key: 'cursor/reap-swept', repo_path: WS });
      await req('POST', '/overlay/status', { workspace: WS, key: 'cursor/reap-swept', status: 'in_progress', agent_id: 'reap-swept-agent', session_id: 'reap-swept-sess' });

      // A second agent that holds NO swept claim — the control. It must stay running across the sweep.
      await req('POST', '/agent/start', { agent_id: 'reap-live-agent', session: 'reap-live-sess', agent_tool_spawn: true });

      assert.equal((await agentState('reap-swept-agent')).state, 'running', 'claim owner running before sweep');
      assert.equal((await agentState('reap-live-agent')).state, 'running', 'control agent running before sweep');
      const before = (await graph()).summary.agents.running;

      // force:true + stale_minutes:0 releases the idle claim; the route must reap its owning agent.
      const swept = await req('POST', '/sweep', { workspace: WS, force: true, stale_minutes: 0 });
      assert.equal(swept.status, 200);
      assert.ok(swept.body.released >= 1, 'force sweep released the stale claim');

      // The agent that owned the swept claim is reaped out of the running count, terminal-stamped.
      const sweptAgent = await agentState('reap-swept-agent');
      assert.notEqual(sweptAgent.state, 'running', 'swept agent reaped out of running');
      assert.equal(sweptAgent.state, 'stale', 'swept agent moved to terminal stale state');
      assert.equal(typeof sweptAgent.endedAt, 'string', 'swept agent stamped endedAt');

      // The control agent (no swept claim) is untouched, and the running count dropped by exactly one.
      assert.equal((await agentState('reap-live-agent')).state, 'running', 'control agent still running');
      assert.equal((await graph()).summary.agents.running, before - 1, 'running count dropped by one');
    });
  } finally {
    child.kill();
    try { fs.rmSync(SANDBOX, { recursive: true }); } catch { /* */ }
    try { fs.rmSync(WS, { recursive: true }); } catch { /* */ }
  }
});
