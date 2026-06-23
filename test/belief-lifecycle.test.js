#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-belief-lifecycle-')));
process.env.CLAUDE_PLUGIN_DATA = TMP;
process.env.ORCH_RERANK = '0';

const overlayStore = require('../lib/overlay');
const daemon = require('../daemon');
const { compileSearchContext } = require('../lib/search/context-compiler');

let pass = 0;
let fail = 0;
const tests = [];
const test = (label, fn) => tests.push({ label, fn });

function makeWorkspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'ws-')));
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  return ws;
}

function isTruthy(value) {
  return value != null && value !== '' && value !== '0' && value !== 'false' && value !== 'no';
}

function makeCtx(graph, workspace, overlay) {
  return {
    buildGraph: () => graph,
    overlayFor: () => overlay,
    isTruthy,
    embed: async () => null,
    suggestToks: daemon.suggestToks,
    scoreNodeAgainstTokens: daemon.scoreNodeAgainstTokens,
    knowledgeText: (item) => typeof item === 'string' ? item : String((item && (item.value || item.text || item.summary)) || ''),
    noteCurrentAsOf: daemon.noteCurrentAsOf,
    gateTask: async () => ({ decision: 'abstain', reason: 'test', via: 'lexical', top1: 0, margin: 0, gap: 0, locality: 0, topType: null }),
    gatedSearchCounts: new Map(),
    checkGatedRateLimit: () => false,
    EMBED_MODEL: 'test',
    workspace,
  };
}

async function runSearch(graph, workspace, overlay, params = {}) {
  const u = new URL('http://127.0.0.1/search');
  u.searchParams.set('workspace', workspace);
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
  const result = await compileSearchContext(makeCtx(graph, workspace, overlay), {
    req: { socket: { remoteAddress: '127.0.0.1' } },
    u,
  });
  assert.equal(result.status, 200);
  return result.body;
}

function addNote(overlay, title, summary) {
  return overlayStore.addNoteNode(overlay, {
    title,
    summary,
    valid_from: '2026-01-01T00:00:00.000Z',
  });
}

function buildFixture() {
  const overlay = overlayStore.EMPTY();
  const verified = addNote(overlay, 'Lifecycle verified sentinel', 'verified lifecycle search target');
  const pending = addNote(overlay, 'Lifecycle pending sentinel', 'pending lifecycle search target');
  const stale = addNote(overlay, 'Lifecycle stale sentinel', 'stale retired lifecycle search target');
  const superseded = addNote(overlay, 'Lifecycle superseded sentinel', 'superseded old lifecycle search target');
  const successor = addNote(overlay, 'Lifecycle successor sentinel', 'successor current lifecycle search target');
  const contradicted = addNote(overlay, 'Lifecycle contradicted sentinel', 'contradicted lifecycle search target');

  overlayStore.markPendingDup(overlay, `note:${pending}`, `note:${verified}`, 0.99);
  overlay.note_nodes[stale].validTo = '2026-02-01T00:00:00.000Z';
  overlayStore.supersedeNote(overlay, superseded, successor, '2026-03-01T00:00:00.000Z');
  overlay.note_nodes[contradicted].status = 'contradicted';

  return { overlay, ids: { verified, pending, stale, superseded, successor, contradicted } };
}

test('derived helper covers note lifecycle statuses', () => {
  const { overlay, ids } = buildFixture();
  assert.deepEqual(overlayStore.BELIEF_STATUSES, ['suggested', 'verified', 'stale', 'contradicted', 'superseded']);
  assert.equal(overlayStore.beliefStatusForNote(overlay.note_nodes[ids.verified]), 'verified');
  assert.equal(overlayStore.beliefStatusForNote(overlay.note_nodes[ids.pending], { pendingDup: true }), 'suggested');
  assert.equal(overlayStore.beliefStatusForNote(overlay.note_nodes[ids.stale]), 'stale');
  assert.equal(overlayStore.beliefStatusForNote(overlay.note_nodes[ids.superseded]), 'superseded');
  assert.equal(overlayStore.beliefStatusForNote(overlay.note_nodes[ids.contradicted]), 'contradicted');
});

test('buildGraph projects belief_status for notes', () => {
  const workspace = makeWorkspace();
  const { overlay, ids } = buildFixture();
  daemon.__clearOverlayCacheForTest();
  daemon.__setWorkspaceForTest(workspace);
  daemon.__setOverlayForTest(overlay);

  const graph = daemon.buildGraph(workspace);
  const byId = new Map(graph.tasks.map((node) => [node.id, node]));
  assert.equal(byId.get(`note:${ids.verified}`).belief_status, 'verified');
  assert.equal(byId.get(`note:${ids.pending}`).belief_status, 'suggested');
  assert.equal(byId.get(`note:${ids.stale}`).belief_status, 'stale');
  assert.equal(byId.get(`note:${ids.superseded}`).belief_status, 'superseded');
  assert.equal(byId.get(`note:${ids.contradicted}`).belief_status, 'contradicted');
});

test('search preserves filters and surfaces lifecycle metadata', async () => {
  const workspace = makeWorkspace();
  const { overlay, ids } = buildFixture();
  daemon.__clearOverlayCacheForTest();
  daemon.__setWorkspaceForTest(workspace);
  daemon.__setOverlayForTest(overlay);
  const graph = daemon.buildGraph(workspace);

  const current = await runSearch(graph, workspace, overlay, { q: 'verified lifecycle search target', k: '10' });
  const verified = current.results.find((row) => row.key === `note:${ids.verified}`);
  assert(verified, 'expected current verified note in search results');
  assert.equal(verified.belief_status, 'verified');

  const pending = await runSearch(graph, workspace, overlay, { q: 'pending lifecycle search target', k: '10' });
  assert(!pending.results.some((row) => row.key === `note:${ids.pending}`), 'pending duplicate remains hidden');

  const staleDefault = await runSearch(graph, workspace, overlay, { q: 'stale retired lifecycle search target', k: '10' });
  assert(!staleDefault.results.some((row) => row.key === `note:${ids.stale}`), 'stale note remains hidden by default');

  const staleHistory = await runSearch(graph, workspace, overlay, { q: 'stale retired lifecycle search target', history: 'true', k: '10' });
  const stale = staleHistory.results.find((row) => row.key === `note:${ids.stale}`);
  assert(stale, 'expected stale note when history=true');
  assert.equal(stale.belief_status, 'stale');

  const supersededHistory = await runSearch(graph, workspace, overlay, { q: 'superseded old lifecycle search target', history: 'true', k: '10' });
  const superseded = supersededHistory.results.find((row) => row.key === `note:${ids.superseded}`);
  assert(superseded, 'expected superseded note when history=true');
  assert.equal(superseded.belief_status, 'superseded');
});

test('context compiler task context includes belief_status on note metadata', async () => {
  const workspace = makeWorkspace();
  const { overlay, ids } = buildFixture();
  daemon.__clearOverlayCacheForTest();
  daemon.__setWorkspaceForTest(workspace);
  daemon.__setOverlayForTest(overlay);
  const graph = daemon.buildGraph(workspace);
  graph.tasks.push({
    id: 'task/context-consumer',
    label: 'Consumer task',
    status: 'ready',
    deps: [],
    context_deps: [`note:${ids.verified}`],
    context_weights: { [`note:${ids.verified}`]: 0.9 },
    summary: '',
    provisional: false,
  });

  const body = await runSearch(graph, workspace, overlay, { task_key: 'task/context-consumer', q: 'anything', k: '10' });
  const row = body.results.find((result) => result.key === `note:${ids.verified}`);
  assert(row, 'expected direct context note');
  assert.equal(row.belief_status, 'verified');
  assert.equal(row.validFrom, '2026-01-01T00:00:00.000Z');
});

(async () => {
  try {
    for (const { label, fn } of tests) {
      try {
        await fn();
        console.log(`PASS  ${label}`);
        pass++;
      } catch (err) {
        console.log(`FAIL  ${label}`);
        console.log(err && err.stack ? err.stack : err);
        fail++;
      }
    }
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
