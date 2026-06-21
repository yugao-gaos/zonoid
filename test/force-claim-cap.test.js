#!/usr/bin/env node
// Tests for the force-claim hard cap (3 per task) and dashboard-only approval reset.
//
// Covers:
//   (a) force claims 1-3 succeed with decreasing force_claims_remaining
//   (b) 4th force claim refused (409, approval_required:true) and a guidance item filed
//   (c) no duplicate guidance on repeated over-cap attempts
//   (d) counter reset via /guidance/resolve re-allows force claims
//   (e) normal (non-force) claims are NOT capped and do not regress
//
// Spawns a sandboxed daemon on a private port. Run: node test/force-claim-cap.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fc-cap-')));
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fc-cap-ws-')));
// DG1/DG2 claim gate: every in_progress claim needs a session_id + a registered worktree, so WS is
// a git repo (with a base commit so `git worktree add` works) and each claimed key gets a worktree.
const SID = crypto.randomUUID();

// Port range 19700-19799 (unused by other test files)
const PORT = 19700 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;

async function post(p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(p) {
  const res = await fetch(`${BASE}${p}`);
  return { status: res.status, body: await res.json() };
}

async function waitForPing(ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await get('/ping'); if (r.body && r.body.ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Claim a task normally (no force), returns ok:true on success.
async function normalClaim(key) {
  return post('/overlay/status', { key, status: 'in_progress', agent_id: 'test-agent', session_id: SID, workspace: WS });
}

// Force-claim a task, returns the raw response.
async function forceClaim(key, agentId = 'test-agent') {
  return post('/overlay/status', { key, status: 'in_progress', agent_id: agentId, session_id: SID, force: true, workspace: WS });
}

// Release a task back to ready.
async function releaseTask(key) {
  return post('/overlay/status', { key, status: 'done', agent_id: 'test-agent', summary: 'done', workspace: WS });
}

test('force-claim cap', async () => {
  execSync('git init -q', { cwd: WS });
  execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: WS });
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT), ORCH_TOKEN: '', ORCH_GATE_OFF: '1' },
    stdio: 'ignore',
  });
  try {
    assert.ok(await waitForPing(), 'sandboxed daemon came up');
    assert.equal((await post('/workspace', { path: WS })).body.ok, true, 'workspace pinned');

    // Set up two task keys — one for force-cap tests, one for normal-claim regression.
    const TASK_FORCE = `fc-cap-test-${crypto.randomUUID().slice(0, 8)}/1`;
    const TASK_NORMAL = `fc-cap-test-${crypto.randomUUID().slice(0, 8)}/1`;

    // Wire both tasks as roots so the unwired quarantine doesn't block claims.
    assert.equal((await post('/mark-root', { task_key: TASK_FORCE, reason: 'force-cap test', workspace: WS })).body.ok, true, 'TASK_FORCE marked root');
    assert.equal((await post('/mark-root', { task_key: TASK_NORMAL, reason: 'normal-cap test', workspace: WS })).body.ok, true, 'TASK_NORMAL marked root');

    // Register a worktree per task — the DG1/DG2 claim precondition. (A worktree-backed claim with
    // a session_id self-registers as a hook-less worker, so force claims by agent-alpha/beta/... ride
    // the same precondition; the force CAP is enforced AFTER this gate.)
    assert.equal((await post('/git/worktree', { key: TASK_FORCE, repo_path: WS, workspace: WS })).status, 200, 'TASK_FORCE worktree');
    assert.equal((await post('/git/worktree', { key: TASK_NORMAL, repo_path: WS, workspace: WS })).status, 200, 'TASK_NORMAL worktree');

    // ── (e) normal claim is NOT capped ──────────────────────────────────────
    let r = await normalClaim(TASK_NORMAL);
    assert.equal(r.status, 200, 'normal claim 1: 200');
    assert.equal(r.body.ok, true, 'normal claim 1: ok');
    // release and re-claim many times — should never be refused
    for (let i = 0; i < 5; i++) {
      const released = await releaseTask(TASK_NORMAL);
      assert.equal(released.body.ok, true, `normal release ${i + 1}: ok ${JSON.stringify(released.body)}`);
      r = await normalClaim(TASK_NORMAL);
      assert.equal(r.body.ok, true, `normal claim ${i + 2}: ok ${JSON.stringify(r.body)}`);
    }

    // ── (a) force claims 1-3 succeed with decreasing force_claims_remaining ─
    // Start with a normal claim so we have something to force-over.
    r = await normalClaim(TASK_FORCE);
    assert.equal(r.body.ok, true, 'initial normal claim for TASK_FORCE');

    r = await forceClaim(TASK_FORCE, 'agent-alpha');
    assert.equal(r.status, 200, 'force claim 1: 200');
    assert.equal(r.body.ok, true, 'force claim 1: ok');
    assert.equal(r.body.force_claims_remaining, 2, 'force claim 1: 2 remaining');

    r = await forceClaim(TASK_FORCE, 'agent-beta');
    assert.equal(r.status, 200, 'force claim 2: 200');
    assert.equal(r.body.ok, true, 'force claim 2: ok');
    assert.equal(r.body.force_claims_remaining, 1, 'force claim 2: 1 remaining');

    r = await forceClaim(TASK_FORCE, 'agent-gamma');
    assert.equal(r.status, 200, 'force claim 3: 200');
    assert.equal(r.body.ok, true, 'force claim 3: ok');
    assert.equal(r.body.force_claims_remaining, 0, 'force claim 3: 0 remaining');

    // ── (b) 4th force claim refused with approval_required:true + guidance filed ─
    r = await forceClaim(TASK_FORCE, 'agent-delta');
    assert.equal(r.status, 409, '4th force claim: 409');
    assert.equal(r.body.ok, false, '4th force claim: not ok');
    assert.equal(r.body.approval_required, true, '4th force claim: approval_required:true');

    // Guidance item must have been filed.
    const gResp = await get(`/guidance?workspace=${encodeURIComponent(WS)}`);
    assert.equal(gResp.status, 200, 'guidance GET: 200');
    const pending = gResp.body.pending || [];
    const capItem = pending.find((g) => g.trigger === 'force_claim_cap' && g.action && g.action.taskKey === TASK_FORCE);
    assert.ok(capItem, 'force_claim_cap guidance item filed');
    assert.equal(capItem.action.kind, 'force_claim_cap', 'guidance action kind correct');

    // ── (c) no duplicate guidance on repeated over-cap attempts ─────────────
    r = await forceClaim(TASK_FORCE, 'agent-epsilon');
    assert.equal(r.status, 409, '5th force claim: 409');
    r = await forceClaim(TASK_FORCE, 'agent-zeta');
    assert.equal(r.status, 409, '6th force claim: 409');
    const gResp2 = await get(`/guidance?workspace=${encodeURIComponent(WS)}`);
    const capItems2 = (gResp2.body.pending || []).filter((g) => g.trigger === 'force_claim_cap' && g.action && g.action.taskKey === TASK_FORCE);
    assert.equal(capItems2.length, 1, 'no duplicate guidance items filed');

    // ── (d) counter reset via dashboard answer route re-allows force claims ─
    const resolveR = await post('/guidance/resolve', { id: capItem.id, decision: 'approved', workspace: WS });
    assert.equal(resolveR.status, 200, 'guidance resolve: 200');
    assert.equal(resolveR.body.ok, true, 'guidance resolve: ok');
    assert.equal(resolveR.body.reset_task_key, TASK_FORCE, 'resolve echoes reset_task_key');

    // Guidance item should now be resolved (not pending).
    const gResp3 = await get(`/guidance?workspace=${encodeURIComponent(WS)}`);
    const capStillPending = (gResp3.body.pending || []).some((g) => g.id === capItem.id);
    assert.equal(capStillPending, false, 'guidance item resolved after approve');

    // Force claims should work again (counter reset to 0).
    r = await forceClaim(TASK_FORCE, 'agent-eta');
    assert.equal(r.status, 200, 'force claim after reset: 200');
    assert.equal(r.body.ok, true, 'force claim after reset: ok');
    assert.equal(r.body.force_claims_remaining, 2, 'force claim after reset: 2 remaining');

  } finally {
    child.kill('SIGKILL');
  }
});
