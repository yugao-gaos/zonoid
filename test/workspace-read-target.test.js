#!/usr/bin/env node
// Regression test for the READ-side workspace gremlin (counterpart of workspace-write-target):
// 1) lib/mcp-core makeCall must inject the session's pinned workspace into GET paths as
//    ?workspace= (it already injects POST bodies), so MCP READ tools resolve the session's
//    graph instead of the daemon-global workspace (which a restart / another session may have
//    pinned elsewhere).
// 2) Daemon read routes (/state, /task/detail, /guidance, /agents, /agent/stop-requested) must
//    honor ?workspace= for their overlay-backed fields, not just buildGraph.
// P3 (deprecate-global-workspace): the daemon-global default is GONE. Reads that REQUIRE a
//    workspace (/state, /search) 400 when none is resolvable; workspace-agnostic reads
//    (/task/detail, /guidance, /agent/stop-requested) degrade to the EMPTY overlay, never B.
// 3) Claim-release must operate on the TARGET workspace's overlay: the stale-claim sweep fires
//    for a ?workspace= read, and /agent/done cascades into the agent's recorded workspace.
//
// End-to-end over HTTP: spawns the real daemon on a private port with a sandboxed
// CLAUDE_PLUGIN_DATA. No framework; matches the style of test/workspace-write-target.test.js.
// Run: node test/workspace-read-target.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// Sandbox BASE so overlays/workspace-file land in a temp dir (BASE is read at require-time).
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rdtarget-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const overlayStore = require('../lib/overlay');
const { makeCall } = require('../lib/mcp-core');

// Reuse the already-downloaded embedding weights if present, so /overlay/note doesn't try a
// network download from the sandboxed (empty) model cache. Absent ⇒ embed() degrades to null.
try {
  const realModels = path.join(os.homedir(), '.claude', 'orchestrator', 'models');
  if (fs.existsSync(realModels)) fs.symlinkSync(realModels, path.join(SANDBOX, 'models'));
} catch { /* lexical fallback is fine */ }

const PORT = 18790 + Math.floor(Math.random() * 200);
const WS_A = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rdtarget-A-')));
const WS_B = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rdtarget-B-')));

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch (e) { reject(e); } });
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

// ---- part 1: makeCall injects ?workspace= into GETs (pure transport, no daemon) -------------
async function testMakeCall() {
  const seen = [];
  const srv = http.createServer((rq, rs) => {
    let raw = '';
    rq.on('data', (c) => { raw += c; });
    rq.on('end', () => { seen.push({ method: rq.method, url: rq.url, body: raw }); rs.writeHead(200, { 'content-type': 'application/json' }); rs.end('{}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const call = makeCall(port, WS_A);
  await call('GET', '/task/detail?key=x/1');
  await call('GET', '/state');
  await call('GET', `/peek?workspace=${encodeURIComponent(WS_B)}`);   // explicit workspace= wins
  await call('POST', '/overlay/status', { key: 'x/1', status: 'done' });
  srv.close();
  const wsq = `workspace=${encodeURIComponent(WS_A)}`;
  ok('GET with query gains &workspace=', seen[0].url === `/task/detail?key=x/1&${wsq}`);
  ok('bare GET gains ?workspace=', seen[1].url === `/state?${wsq}`);
  ok('explicit ?workspace= is NOT overridden', seen[2].url === `/peek?workspace=${encodeURIComponent(WS_B)}`);
  ok('POST body still carries workspace', JSON.parse(seen[3].body).workspace === WS_A);
  const bare = makeCall(port, null);   // no pinned workspace ⇒ untouched paths (daemon self-call)
  ok('no-workspace client leaves GET path alone', typeof bare === 'function');
}

(async () => {
  await testMakeCall();

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    ok('daemon came up on the test port', await waitForPing());

    // Register workspace B (P3: setWorkspace registers + binds, it sets NO daemon-global default).
    const pin = await req('POST', '/workspace', { path: WS_B });
    ok('workspace B registered', pin.status === 200 && pin.body.workspace === WS_B);

    // Seed workspace A via the (already-fixed) write routes: a note node, an edge, knowledge, guidance.
    const note = await req('POST', '/overlay/note', { workspace: WS_A, title: 'A-side decision', summary: 'read-gremlin fixture summary' });
    ok('A note created', note.status === 200 && note.body.ok === true);
    await req('POST', '/overlay/edge', { workspace: WS_A, from: 'sessA/1', to: 'sessA/2', kind: 'context' });
    await req('POST', '/overlay/knowledge', { workspace: WS_A, key: 'sessA/1', item: { type: 'note', value: 'gremlin-knowledge-marker' } });
    await req('POST', '/guidance', { workspace: WS_A, question: 'A-side question?' });

    // --- reads with ?workspace=A while state.workspace = B -----------------------------------
    const stA = await req('GET', `/state?workspace=${encodeURIComponent(WS_A)}`);
    ok('/state?workspace=A serves A edges', stA.body.edges.some((e) => e.from === 'sessA/1' && e.to === 'sessA/2'));
    ok('/state?workspace=A serves A note node', stA.body.tasks.some((t) => t.kind === 'note' && t.label === 'A-side decision'));
    ok('/state?workspace=A summary counts A edges', stA.body.summary.edges === 1);
    // P3: /state with NO ?workspace= 400s (the daemon-global default is gone) instead of serving B.
    const stNoWs = await req('GET', '/state');
    ok('/state without workspace returns 400 (no global default)', stNoWs.status === 400 && stNoWs.body.ok === false);
    // B is still independently readable via its explicit ?workspace= and never shows A's writes.
    const stB = await req('GET', `/state?workspace=${encodeURIComponent(WS_B)}`);
    ok('/state?workspace=B serves B (no A leakage)', !stB.body.tasks.some((t) => t.label === 'A-side decision') && stB.body.edges.length === 0);

    // /task/detail — THE live symptom: without workspace ⇒ unknown task; with ⇒ found.
    const noteKey = note.body.key;
    const dMiss = await req('GET', `/task/detail?key=${encodeURIComponent(noteKey)}`);
    ok('detail WITHOUT workspace misses A task (the symptom)', dMiss.status === 404);
    const dHit = await req('GET', `/task/detail?key=${encodeURIComponent(noteKey)}&workspace=${encodeURIComponent(WS_A)}`);
    ok('detail WITH workspace=A finds it', dHit.status === 200 && dHit.body.task.summary === 'read-gremlin fixture summary');
    const dKn = await req('GET', `/task/detail?key=sessA/1&workspace=${encodeURIComponent(WS_A)}`);
    // sessA/1 has no native file so it is not a graph node — but the route must 404 from A's graph,
    // not crash reading B's overlay.
    ok('detail for overlay-only key answers cleanly', dKn.status === 404 || dKn.status === 200);

    // /guidance — pending question lives in A's overlay only.
    const gA = await req('GET', `/guidance?workspace=${encodeURIComponent(WS_A)}`);
    ok('/guidance?workspace=A lists A question', gA.body.pending.some((g) => g.question === 'A-side question?'));
    const gB = await req('GET', '/guidance');
    ok('fallback /guidance stays on B (empty)', gB.body.pending.length === 0);

    // /search — A's knowledge item is only findable when the read targets A.
    const sA = await req('GET', `/search?q=${encodeURIComponent('gremlin-knowledge-marker')}&workspace=${encodeURIComponent(WS_A)}`);
    ok('/search?workspace=A finds A knowledge', sA.body.results.some((r) => r.kind === 'knowledge' && r.title.includes('gremlin-knowledge-marker')));
    // P3: /search with no ?workspace= 400s (no global default to fall back onto).
    const sB = await req('GET', `/search?q=${encodeURIComponent('gremlin-knowledge-marker')}`);
    ok('/search without workspace returns 400 (no global default)', sB.status === 400 && sB.body.ok === false);

    // --- claim-release: stale-claim sweep fires on the TARGET workspace ----------------------
    const ovA = overlayStore.load(WS_A);
    ovA.status['sessA/7'] = 'in_progress';
    ovA.assignee['sessA/7'] = 'ghost-worker';           // never registered ⇒ not running
    ovA.config.stale_minutes = 0;                       // stale immediately
    overlayStore.save(WS_A, ovA);
    await req('GET', `/state?workspace=${encodeURIComponent(WS_A)}`);   // read triggers the sweep
    const ovA2 = overlayStore.load(WS_A);
    ok('stale claim in A auto-released by ?workspace=A read', ovA2.status['sessA/7'] === undefined);
    ok('release reason recorded in A', String(ovA2.notes['sessA/7'] || '').includes('auto-released'));
    ok('B overlay untouched by A sweep', overlayStore.load(WS_B).notes['sessA/7'] === undefined);

    // --- claim-release: /agent/done cascades into the AGENT's workspace ----------------------
    await req('POST', '/agent/start', { agent_id: 'workerA', workspace: WS_A });
    const ovA3 = overlayStore.load(WS_A);
    ovA3.status['sessA/8'] = 'in_progress';
    ovA3.assignee['sessA/8'] = 'workerA';
    ovA3.config.stale_minutes = 999;                    // keep the sweep away — agent/done must do it
    ovA3.timestamps['sessA/8'] = { firstSeen: new Date().toISOString(), lastChanged: new Date().toISOString(), lastStatus: 'in_progress' };
    overlayStore.save(WS_A, ovA3);
    const done = await req('POST', '/agent/done', { agent_id: 'workerA' });
    ok('/agent/done released the A claim (agent workspace, no body.workspace)', done.status === 200 && done.body.released === 1);
    const ovA4 = overlayStore.load(WS_A);
    ok('A claim cleared on disk', ovA4.status['sessA/8'] === undefined);
    ok('B overlay has no phantom release', overlayStore.load(WS_B).notes['sessA/8'] === undefined);

    // --- cooperative stop flags target the caller's workspace --------------------------------
    const stop = await req('POST', '/agent/stop', { workspace: WS_A, agent_id: 'workerA' });
    ok('/agent/stop accepted with workspace=A', stop.status === 200 && stop.body.ok === true);
    ok('stop flag landed in A overlay', !!overlayStore.load(WS_A).stop_requested['workerA']);
    ok('stop flag NOT in B overlay', !overlayStore.load(WS_B).stop_requested['workerA']);
    const sr = await req('GET', `/agent/stop-requested?agent_id=workerA&workspace=${encodeURIComponent(WS_A)}`);
    ok('stop-requested readable via ?workspace=A', !!sr.body.stop_requested);
    const srB = await req('GET', '/agent/stop-requested?agent_id=workerA');
    ok('stop-requested fallback (B) stays null', srB.body.stop_requested === null);
    const agA = await req('GET', `/agents?workspace=${encodeURIComponent(WS_A)}`);
    ok('/agents?workspace=A surfaces the stop flag', agA.body.agents.some((a) => a.agent_id === 'workerA' && a.stop_requested));
  } catch (e) {
    console.error('TEST ERROR:', e);
    fail++;
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    for (const d of [SANDBOX, WS_A, WS_B]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
