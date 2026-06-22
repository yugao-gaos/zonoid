#!/usr/bin/env node
// Tests for newly_ready on terminal /overlay/status (complete_task / set_status path).
// Replicates the post-agent.sh nudge in-band for hookless harnesses.
//
// Run: node test/newly-ready.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const git = require('../lib/git');
const newlyReady = require('../lib/newly-ready');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-newly-ready-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const filedrop = require('../lib/filedrop-tasks');

const PORT = 18860 + Math.floor(Math.random() * 100);
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-newly-ready-ws-')));

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

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

async function waitForPing(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await req('GET', '/ping'); if (r.status === 200) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function waitForNotJudging(key, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const g = (await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`)).body;
    const t = g.tasks.find((x) => x.id === key);
    if (t && !t.judging) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function dropStub(harness, id, extra = {}) {
  const dir = path.join(filedrop.dirFor(WS), harness);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, subject: `stub ${id}`, ...extra }, null, 2));
}

// ── Pure unit tests ───────────────────────────────────────────────────────────
{
  const before = new Set(['a', 'b']);
  const after = new Set(['b', 'c', 'd']);
  ok('unit: diffNewlyReady finds new keys', JSON.stringify(newlyReady.diffNewlyReady(before, after)) === '["c","d"]');
  ok('unit: isTerminalStatus(done)', newlyReady.isTerminalStatus('done'));
  ok('unit: isTerminalStatus(in_progress) false', !newlyReady.isTerminalStatus('in_progress'));
  const g = { tasks: [{ id: 'x', status: 'ready' }, { id: 'note:1', kind: 'note', status: 'note' }, { id: 'y', status: 'not_ready' }] };
  ok('unit: readyKeys excludes notes', newlyReady.readyKeys(g).size === 1 && newlyReady.readyKeys(g).has('x'));
}

(async () => {
  git.initRepo(WS); // claim gate needs a registered worktree, which needs a git repo
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT), ZONOID_EMBED_PROVIDER: 'voyage', VOYAGE_API_KEY: '', JUDGE_TIMEOUT_MS: '1', JUDGE_HARD_CEILING_MS: '1' },
    stdio: 'ignore',
  });
  try {
    ok('daemon came up', await waitForPing());
    await req('POST', '/workspace', { path: WS });

    dropStub('h', 'blocker', { created_by: { harness: 'h', agent_id: 'w1' } });
    dropStub('h', 'blocked', { blockedBy: ['blocker'] });
    dropStub('h', 'bystander', { blockedBy: ['blocker'] });
    await req('POST', '/sync', { workspace: WS });

    await req('POST', '/mark-root', { workspace: WS, task_key: 'h/blocker', reason: 'test root' });
    await req('POST', '/overlay/edge', { workspace: WS, from: 'h/blocker', to: 'h/blocked', kind: 'blocking' });
    await req('POST', '/overlay/edge', { workspace: WS, from: 'h/blocker', to: 'h/bystander', kind: 'blocking' });
    await waitForNotJudging('h/blocker');
    await waitForNotJudging('h/blocked');
    await waitForNotJudging('h/bystander');
    // DG1/DG2 claim gate: register a worktree + supply session_id on the in_progress claim.
    await req('POST', '/git/worktree', { workspace: WS, key: 'h/blocker', repo_path: WS });
    const claim = await req('POST', '/overlay/status', { workspace: WS, key: 'h/blocker', status: 'in_progress', agent_id: 'w1', session_id: 'nr-worker-sid' });
    ok('blocker claim accepted', claim.status === 200 && claim.body.ok === true);
    ok('in_progress has no newly_ready', claim.body.newly_ready === undefined);

    const done = await req('POST', '/overlay/status', {
      workspace: WS, key: 'h/blocker', status: 'done', agent_id: 'w1', session_id: 'nr-worker-sid', summary: 'blocker finished.',
    });
    ok('terminal done accepted', done.status === 200 && done.body.ok === true);
    ok('newly_ready is an array', Array.isArray(done.body.newly_ready));
    ok('newly_ready excludes completed task', !done.body.newly_ready.includes('h/blocker'));

    const failed = await req('POST', '/overlay/status', {
      workspace: WS, key: 'h/bystander', status: 'failed', note: 'failed attempt',
    });
    ok('failed status also carries newly_ready key', Array.isArray(failed.body.newly_ready));
  } finally {
    child.kill();
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
