#!/usr/bin/env node
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-long-note-base-')));
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-long-note-ws-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
process.env.ORCH_RERANK = '0';

try {
  const realModels = path.join(os.homedir(), '.claude', 'orchestrator', 'models');
  if (fs.existsSync(realModels)) fs.symlinkSync(realModels, path.join(SANDBOX, 'models'));
} catch { /* lexical fallback is fine */ }

const overlayStore = require('../lib/overlay');
const filedrop = require('../lib/filedrop-tasks');
const { expandStructuralContext } = require('../lib/search/memory-search');

const PORT = 19950 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;

async function post(p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body && body.workspace ? body : { workspace: WS, ...(body || {}) }),
  });
  return { status: res.status, body: await res.json() };
}

async function waitForPing(ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/ping`);
      const r = await res.json();
      if (r && r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function graphFromOverlay(ov) {
  const deps = {};
  const weights = {};
  for (const e of ov.edges || []) {
    if (e.kind !== 'context' || overlayStore.edgeWeight(e) === 0) continue;
    (deps[e.to] || (deps[e.to] = [])).push(e.from);
    (weights[e.to] || (weights[e.to] = {}))[e.from] = overlayStore.edgeWeight(e);
  }
  const tasks = [];
  for (const [id, n] of Object.entries(ov.note_nodes || {})) {
    const key = `note:${id}`;
    tasks.push({ id: key, label: n.title, kind: 'note', summary: n.summary, context_deps: deps[key] || [], context_weights: weights[key] || {} });
  }
  for (const [key, n] of Object.entries(ov.knowledge_nodes || {})) {
    tasks.push({ id: key, label: n.label, kind: n.type, summary: n.summary, context_deps: deps[key] || [], context_weights: weights[key] || {} });
  }
  return { tasks };
}

function dropStub(harness, id) {
  const dir = path.join(filedrop.dirFor(WS), harness);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, subject: `${harness} task ${id}`, status: 'pending' }, null, 2));
}

test('long note ingestion creates source cluster without changing short notes or explicit wires', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT), ORCH_RERANK: '0' },
    stdio: 'ignore',
  });
  try {
    assert.ok(await waitForPing(), 'sandboxed daemon came up');
    await post('/workspace', { path: WS });

    const shortSummary = 'A compact note should stay exactly as written.';
    const short = await post('/overlay/note', { title: 'short note unchanged', summary: shortSummary });
    assert.equal(short.status, 200);
    assert.equal(short.body.ok, true);
    let ov = overlayStore.load(WS);
    assert.equal(Object.keys(ov.knowledge_nodes || {}).length, 0, 'short note does not create source nodes');
    assert.equal(ov.note_nodes[short.body.id].summary, shortSummary, 'short note summary is unchanged');

    const longPayload = Array.from({ length: 12 }, (_, i) => `
## Section ${i + 1}

The retrieval hardening evidence chunk ${i + 1} says exact evidence must remain available.

\`\`\`js
function evidence${i + 1}() {
  const exactFact = "chunk ${i + 1} preserves source context";
  return exactFact;
}
\`\`\`
`).join('\n');
    const wiredTask = 'hardening/task';
    dropStub('hardening', 'task');
    await post('/sync', { workspace: WS });
    const long = await post('/overlay/note', {
      title: 'Distilled retrieval hardening fact',
      summary: longPayload,
      source_path: 'docs/retrieval-hardening.md',
      wires_to: [wiredTask],
    });
    assert.equal(long.status, 200);
    assert.equal(long.body.ok, true);
    assert.ok(long.body.source_cluster && long.body.source_cluster.chunks > 1, 'long note reports a source cluster');

    ov = overlayStore.load(WS);
    const noteKey = long.body.key;
    const longNote = ov.note_nodes[long.body.id];
    assert.ok(longNote.summary.length < longPayload.length, 'long note semantic handle is compacted');
    assert.match(longNote.summary, /structured source chunks/, 'compact note points at structured evidence');
    assert.ok((ov.edges || []).some((e) => e.from === noteKey && e.to === wiredTask && e.kind === 'context'), 'explicit note -> task wire survives');

    const nodes = Object.values(ov.knowledge_nodes || {});
    const doc = nodes.find((n) => n.type === 'source_doc');
    const section = nodes.find((n) => n.type === 'source_section');
    const chunks = nodes.filter((n) => n.type === 'source_chunk');
    assert.ok(doc && section && chunks.length > 1, 'source doc, section, and chunks are persisted');
    assert.ok(chunks.some((n) => /exact evidence must remain available/.test(n.summary)), 'raw evidence is preserved in chunk summaries');
    assert.ok((ov.edges || []).some((e) => e.from === doc.key && e.to === section.key && e.kind === 'context'), 'doc -> section edge exists');
    assert.ok((ov.edges || []).some((e) => e.from === section.key && e.to === chunks[0].key && e.kind === 'context'), 'section -> chunk edge exists');
    assert.ok((ov.edges || []).some((e) => e.from === chunks[0].key && e.to === noteKey && e.kind === 'context'), 'chunk -> note evidence edge exists');

    const sibling = await post('/overlay/note', {
      title: 'Sibling fact from same chunk',
      summary: 'The same source chunk also says sibling facts should expand with exact evidence.',
    });
    assert.equal(sibling.body.ok, true);
    await post('/overlay/edge', { from: chunks[0].key, to: sibling.body.key, kind: 'context', weight: 1.0 });

    ov = overlayStore.load(WS);
    const graph = graphFromOverlay(ov);
    const ragResults = [{ key: noteKey, title: longNote.title, summary: longNote.summary, score: 0.5, kind: 'note', tier: 'rag', via: 'test', path: [] }];
    expandStructuralContext({
      graph,
      ragResults,
      temporalOk: () => true,
      dupInvisible: () => false,
      excludedKeys: new Set(),
    });
    const keys = ragResults.map((r) => r.key);
    assert.ok(keys.includes(chunks[0].key), 'search expansion sees evidence chunk');
    assert.ok(keys.includes(section.key) && keys.includes(doc.key), 'search expansion sees parent section and doc');
    assert.ok(keys.includes(sibling.body.key), 'search expansion sees sibling fact sharing the same chunk');
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    fs.rmSync(WS, { recursive: true, force: true });
  }
});
