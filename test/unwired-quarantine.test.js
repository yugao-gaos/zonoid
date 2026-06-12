#!/usr/bin/env node
// E2E test for the unwired-task quarantine (daemon.js buildGraph stamp + /overlay/status claim
// guard + /mark-root, lib/overlay.js addEdge clearing). Spawns the real daemon on a private port
// with a sandboxed CLAUDE_PLUGIN_DATA (style of test/workspace-write-target.test.js). Native task
// fixtures use a clearly-fake session under ~/.claude/tasks + ~/.claude/projects and are cleaned
// up (style of test/native-write.test.js). Run: node test/unwired-quarantine.test.js
//
// Covers:
//   - new task FIRST SEEN with no edges → start_task claim (in_progress) 409s with "unwired"
//   - add_dependency to the quarantined task → claim succeeds
//   - mark_root on a quarantined task → claim succeeds, reason lands in the note
//   - a task first seen WITH an inbound edge is never quarantined
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-unwired-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const PORT = 18990 + Math.floor(Math.random() * 200);
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-unwired-ws-')));

// Fake session wired to WS via the real ~/.claude/projects + ~/.claude/tasks layout
// (native-tasks.js hardcodes those paths). Hex-ish id to pass the listSessions regex; the
// "aaaaaaaa-feedface" prefix keeps it obviously fake. Cleaned up in finally.
const SESSION = 'aaaaaaaa-feedface-0000-4000-800000000001';
const { encodeWorkspace } = require('../lib/native-tasks');
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects', encodeWorkspace(WS));
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', SESSION);
const K = (id) => `${SESSION}/${id}`;
const writeTask = (id, extra = {}) =>
  fs.writeFileSync(path.join(TASKS_DIR, `${id}.json`), JSON.stringify({ id: String(id), subject: `task ${id}`, status: 'pending', ...extra }));

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch { resolve({ status: res.statusCode, body: {} }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForPing(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await req('GET', '/ping'); if (r.status === 200) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

(async () => {
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROJ_DIR, `${SESSION}.jsonl`), '');
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  // Distinct labels so the lexical autowire can't link the fixtures to each other.
  writeTask(1, { subject: 'zebra quarantine fixture alpha' });
  writeTask(2, { subject: 'walrus dependency fixture beta' });
  writeTask(3, { subject: 'pelican rootless fixture gamma' });
  writeTask(4, { subject: 'ocelot prewired fixture delta', blockedBy: ['1'] });

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    ok('daemon came up on the test port', await waitForPing());
    const pin = await req('POST', '/workspace', { path: WS });
    ok('workspace pinned to test WS', pin.status === 200);
    const st = await req('GET', '/state'); // triggers buildGraph → first-sighting quarantine stamps
    ok('graph built with fixture tasks', st.status === 200 && (st.body.tasks || []).some((t) => t.id === K(1)));

    // --- 1) new task with no edges → claim 409s with the unwired error -----------------------
    const claim1 = await req('POST', '/overlay/status', { key: K(1), status: 'in_progress', agent_id: 'test-agent' });
    ok('claim of unwired task refused with 409', claim1.status === 409);
    ok('409 error names the unwired quarantine', /unwired/.test(String(claim1.body.error)));

    // --- 2) add_dependency wires it → claim succeeds ------------------------------------------
    const edge = await req('POST', '/overlay/edge', { from: K(1), to: K(2), kind: 'context' });
    ok('edge add accepted', edge.status === 200 && edge.body.ok === true);
    const claim2 = await req('POST', '/overlay/status', { key: K(2), status: 'in_progress', agent_id: 'test-agent' });
    ok('claim succeeds after add_dependency (to-side cleared)', claim2.status === 200 && claim2.body.ok === true);
    const claim1b = await req('POST', '/overlay/status', { key: K(1), status: 'in_progress', agent_id: 'test-agent' });
    ok('claim succeeds for edge from-side too', claim1b.status === 200 && claim1b.body.ok === true);

    // --- 3) mark_root clears the quarantine → claim succeeds ----------------------------------
    const mrMissing = await req('POST', '/mark-root', {});
    ok('mark-root without task_key 400s', mrMissing.status === 400);
    const mr = await req('POST', '/mark-root', { task_key: K(3), reason: 'genuinely standalone test root' });
    ok('mark-root accepted and reports prior quarantine', mr.status === 200 && mr.body.ok === true && mr.body.was_unwired === true);
    const claim3 = await req('POST', '/overlay/status', { key: K(3), status: 'in_progress', agent_id: 'test-agent' });
    ok('claim succeeds after mark_root', claim3.status === 200 && claim3.body.ok === true);
    const st2 = await req('GET', '/state');
    const t3 = (st2.body.tasks || []).find((t) => t.id === K(3));
    ok('mark-root reason recorded in the task note', t3 && /genuinely standalone test root/.test(t3.note));

    // --- 4) task first seen WITH an edge (native blockedBy) is never quarantined --------------
    // K(4) is blocked by K(1) (now in_progress) → not claimable for readiness reasons aside,
    // the unwired guard itself must not fire. Complete K(1) first so the claim is clean.
    await req('POST', '/overlay/status', { key: K(1), status: 'done', summary: 'done' });
    const claim4 = await req('POST', '/overlay/status', { key: K(4), status: 'in_progress', agent_id: 'test-agent' });
    ok('pre-wired task (native blockedBy) never quarantined', claim4.status === 200 && claim4.body.ok === true);
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    fs.rmSync(TASKS_DIR, { recursive: true, force: true });
    fs.rmSync(PROJ_DIR, { recursive: true, force: true });
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    fs.rmSync(WS, { recursive: true, force: true });
  }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
