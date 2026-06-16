#!/usr/bin/env node
// Integration test: per-workspace SSE event tagging from routes/overlay.js producers.
//
// Verifies that POST mutations that resolve a target workspace via targetOverlay (T.ws)
// emit `data: changed:<ws>\n\n` on the /events SSE stream, not the bare `data: changed\n\n`.
//
// Test routes exercised:
//   /overlay/note   (record_decision / attach_knowledge flow)
//   /overlay/edge   (add_dependency flow)
//   /overlay/status (set_status flow)
//
// Run: node test/notifychange-ws-tag.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const http = require('http');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-nc-tag-')));
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-nc-tag-ws-')));

// Port range 19800-19899 (distinct from other test files)
const PORT = 19800 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;

// ── helpers ──────────────────────────────────────────────────────────────────

async function post(p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function waitForPing(ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/ping`);
      const j = await res.json();
      if (j && j.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Subscribe to /events SSE stream and collect raw `data:` lines until either
 *   (a) the predicate fn(line) returns true, or
 *   (b) the timeout elapses.
 * Returns { matched: string|null, all: string[] }.
 */
function waitForEvent(fn, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const all = [];
    let matched = null;
    let settled = false;
    const settle = (m) => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({ matched: m, all });
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/events', method: 'GET',
      headers: { Accept: 'text/event-stream' } }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        // SSE events are terminated by \n\n; process complete lines.
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const event = buf.slice(0, idx + 2); // includes the trailing \n\n
          buf = buf.slice(idx + 2);
          const dataLine = event.split('\n').find((l) => l.startsWith('data:'));
          if (dataLine) {
            all.push(dataLine);
            if (!matched && fn(dataLine)) {
              matched = dataLine;
              clearTimeout(timer);
              settle(matched);
            }
          }
        }
      });
      res.on('error', () => settle(null));
    });
    req.on('error', () => settle(null));
    req.end();
  });
}

// ── test ─────────────────────────────────────────────────────────────────────

test('notifyChange(T.ws): targeted mutations emit workspace-tagged SSE events', async () => {
  // The WS dir must be a git repo so branch_task / worktree operations work.
  execSync('git init -q', { cwd: WS });
  execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: WS });

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: SANDBOX,
      ORCH_PORT: String(PORT),
      ORCH_TOKEN: '',
      ORCH_GATE_OFF: '1',
    },
    stdio: 'ignore',
  });

  try {
    assert.ok(await waitForPing(), 'sandboxed daemon came up');
    // Register the workspace so targetOverlay resolves T.ws to WS (not a default fallback).
    const wsResp = await post('/workspace', { path: WS });
    assert.equal(wsResp.body.ok, true, 'workspace registered');

    const TASK_KEY = `nc-tag-test-${crypto.randomUUID().slice(0, 8)}/1`;
    // Mark the task as a root so it is not quarantined (unwired guard).
    const mrResp = await post('/mark-root', { task_key: TASK_KEY, reason: 'nc-tag test', workspace: WS });
    assert.equal(mrResp.body.ok, true, 'task marked root');

    // ── (1) /overlay/note mutation emits changed:<WS> ─────────────────────────
    {
      const eventP = waitForEvent((line) => line.startsWith(`data: changed:${WS}`));
      const noteResp = await post('/overlay/note', {
        title: 'nc-tag test note',
        summary: 'verifying notifyChange(T.ws) on /overlay/note',
        workspace: WS,
      });
      assert.equal(noteResp.status, 200, '/overlay/note 200');
      assert.equal(noteResp.body.ok, true, '/overlay/note ok:true');
      const { matched, all } = await eventP;
      assert.ok(matched, `/overlay/note SSE event tagged with WS (got: ${JSON.stringify(all.slice(-3))})`);
      assert.equal(matched, `data: changed:${WS}`, '/overlay/note event exact line');
    }

    // ── (2) /overlay/edge mutation emits changed:<WS> ─────────────────────────
    {
      const TASK_B = `nc-tag-test-${crypto.randomUUID().slice(0, 8)}/2`;
      await post('/mark-root', { task_key: TASK_B, reason: 'nc-tag edge target', workspace: WS });
      const eventP = waitForEvent((line) => line.startsWith(`data: changed:${WS}`));
      const edgeResp = await post('/overlay/edge', {
        from: TASK_KEY,
        to: TASK_B,
        kind: 'context',
        workspace: WS,
      });
      assert.equal(edgeResp.status, 200, '/overlay/edge 200');
      assert.equal(edgeResp.body.ok, true, '/overlay/edge ok:true');
      const { matched, all } = await eventP;
      assert.ok(matched, `/overlay/edge SSE event tagged with WS (got: ${JSON.stringify(all.slice(-3))})`);
      assert.equal(matched, `data: changed:${WS}`, '/overlay/edge event exact line');
    }

    // ── (3) /overlay/status mutation emits changed:<WS> ──────────────────────
    {
      // Need a worktree so the in_progress claim is accepted.
      const wtResp = await post('/git/worktree', { key: TASK_KEY, repo_path: WS, workspace: WS });
      assert.equal(wtResp.status, 200, 'worktree registered');
      const SID = crypto.randomUUID();
      const eventP = waitForEvent((line) => line.startsWith(`data: changed:${WS}`));
      const statusResp = await post('/overlay/status', {
        key: TASK_KEY,
        status: 'in_progress',
        agent_id: 'nc-tag-agent',
        session_id: SID,
        workspace: WS,
      });
      assert.equal(statusResp.status, 200, '/overlay/status 200');
      assert.equal(statusResp.body.ok, true, '/overlay/status ok:true');
      const { matched, all } = await eventP;
      assert.ok(matched, `/overlay/status SSE event tagged with WS (got: ${JSON.stringify(all.slice(-3))})`);
      assert.equal(matched, `data: changed:${WS}`, '/overlay/status event exact line');
    }

    // ── (4) bare notifyChange() (backfill-embeddings) emits bare changed ──────
    //   Confirms that genuinely global routes still emit the legacy payload.
    {
      const eventP = waitForEvent((line) => line === 'data: changed');
      await post('/overlay/backfill-embeddings', {});
      const { matched } = await eventP;
      assert.ok(matched, 'backfill-embeddings still emits bare `data: changed`');
    }

  } finally {
    child.kill('SIGKILL');
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(WS, { recursive: true, force: true }); } catch {}
  }
});
