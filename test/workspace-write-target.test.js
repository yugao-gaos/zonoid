#!/usr/bin/env node
// Regression test for the daemon workspace gremlin: graph-MUTATING routes must honor a
// per-request `workspace` (request body) instead of always writing into the daemon-global
// state.workspace — a write from session A targeting workspace A must land in A's overlay
// file even while the daemon's pinned workspace is B (flipped by another session's hook).
// Also asserts the BACK-COMPAT fallback: no workspace in the body ⇒ the write still lands
// in state.workspace, and same-workspace targeting stays coherent with the in-memory state
// (visible via GET /state without a daemon reload).
//
// End-to-end over HTTP: spawns the real daemon on a private port with a sandboxed
// CLAUDE_PLUGIN_DATA. No framework; matches the style of test/test-cmd.test.js.
// Run: node test/workspace-write-target.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// Sandbox BASE so overlays/workspace-file land in a temp dir (BASE is read at require-time).
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wstarget-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const overlayStore = require('../lib/overlay');

// Reuse the already-downloaded embedding weights if present, so /overlay/note doesn't try a
// network download from the sandboxed (empty) model cache. Absent ⇒ embed() degrades to null.
try {
  const realModels = path.join(os.homedir(), '.claude', 'orchestrator', 'models');
  if (fs.existsSync(realModels)) fs.symlinkSync(realModels, path.join(SANDBOX, 'models'));
} catch { /* lexical fallback is fine */ }

const PORT = 18790 + Math.floor(Math.random() * 200);
const WS_A = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wstarget-A-')));
const WS_B = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wstarget-B-')));

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

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    ok('daemon came up on the test port', await waitForPing());

    // Pin the DAEMON-GLOBAL workspace to B (the "other session flipped it" precondition).
    const pin = await req('POST', '/workspace', { path: WS_B });
    ok('workspace pinned to B', pin.status === 200 && pin.body.workspace === WS_B);

    // --- cross-workspace WRITES: body.workspace = A while state.workspace = B ----------------
    // note (record_decision)
    const note = await req('POST', '/overlay/note', { workspace: WS_A, title: 'decision for A', summary: 'must land in workspace A overlay' });
    ok('note write accepted', note.status === 200 && note.body.ok === true);
    // knowledge (attach_knowledge)
    const kn = await req('POST', '/overlay/knowledge', { workspace: WS_A, key: 'sessA/1', item: { type: 'note', value: 'A-knowledge' } });
    ok('knowledge write accepted', kn.status === 200 && kn.body.ok === true);
    // dependency edge (add_dependency)
    const edge = await req('POST', '/overlay/edge', { workspace: WS_A, from: 'sessA/1', to: 'sessA/2', kind: 'context' });
    ok('edge write accepted', edge.status === 200 && edge.body.ok === true);
    ok('edge count reflects TARGET overlay, not B', edge.body.edges === 1);
    // status + summary (complete_task path)
    const st = await req('POST', '/overlay/status', { workspace: WS_A, key: 'sessA/2', status: 'done', summary: 'done in A' });
    ok('status write accepted', st.status === 200 && st.body.ok === true);

    const ovA = overlayStore.load(WS_A);
    const ovB = overlayStore.load(WS_B);
    ok('note landed in A overlay file', Object.values(ovA.note_nodes).some((n) => n.title === 'decision for A'));
    ok('note NOT in B overlay file', !Object.values(ovB.note_nodes).some((n) => n.title === 'decision for A'));
    ok('knowledge landed in A', (ovA.knowledge['sessA/1'] || []).some((i) => i.value === 'A-knowledge'));
    ok('knowledge NOT in B', !(ovB.knowledge['sessA/1'] || []).length);
    ok('edge landed in A', ovA.edges.some((e) => e.from === 'sessA/1' && e.to === 'sessA/2'));
    ok('edge NOT in B', !ovB.edges.some((e) => e.from === 'sessA/1' && e.to === 'sessA/2'));
    ok('status landed in A', ovA.status['sessA/2'] === 'done');
    ok('summary landed in A', ovA.summaries['sessA/2'] === 'done in A');
    ok('status NOT in B', ovB.status['sessA/2'] === undefined);

    // --- supersede_note targeting A (both notes live in A) -----------------------------------
    const note2 = await req('POST', '/overlay/note', { workspace: WS_A, title: 'newer decision for A', summary: 'replaces the older one' });
    const sup = await req('POST', '/overlay/note/supersede', { workspace: WS_A, old_key: note.body.key, new_key: note2.body.key });
    ok('cross-workspace supersede_note works', sup.status === 200 && sup.body.ok === true);
    const ovA2 = overlayStore.load(WS_A);
    ok('old note stamped validTo in A', !!ovA2.note_nodes[String(note.body.key).replace(/^note:/, '')].validTo);

    // --- fallback: NO workspace in body ⇒ write lands in state.workspace (B) -----------------
    const fb = await req('POST', '/overlay/edge', { from: 'sessB/1', to: 'sessB/2' });
    ok('fallback edge write accepted', fb.status === 200 && fb.body.ok === true);
    const ovB2 = overlayStore.load(WS_B);
    ok('fallback edge landed in B (state.workspace)', ovB2.edges.some((e) => e.from === 'sessB/1' && e.to === 'sessB/2'));
    ok('fallback edge NOT in A', !overlayStore.load(WS_A).edges.some((e) => e.from === 'sessB/1'));

    // --- same-workspace targeting (workspace explicitly = B) keeps IN-MEMORY state coherent ---
    const same = await req('POST', '/overlay/edge', { workspace: WS_B, from: 'sessB/3', to: 'sessB/4' });
    ok('same-workspace write accepted', same.status === 200 && same.body.ok === true);
    const stt = await req('GET', '/state');
    ok('same-workspace edge visible in live /state (mutated state.overlay, not a detached copy)',
      stt.body.edges.some((e) => e.from === 'sessB/3' && e.to === 'sessB/4'));
    ok('fallback edge also visible in live /state', stt.body.edges.some((e) => e.from === 'sessB/1'));

    // --- cross-workspace write must NOT clobber/poison the in-memory current overlay ----------
    ok('live /state holds only B edges (A writes never leaked into memory)',
      !stt.body.edges.some((e) => String(e.from).startsWith('sessA/')));
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
