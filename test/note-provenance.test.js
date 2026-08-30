#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-note-provenance-')));
process.env.CLAUDE_PLUGIN_DATA = TMP;
process.env.ORCH_RERANK = '0';

const overlayStore = require('../lib/overlay');
const daemon = require('../daemon');
const { compileSearchContext } = require('../lib/search/context-compiler');

const WS = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'ws-')));

function suggestToks(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function scoreNodeAgainstTokens(item, queryTokens) {
  const itemTokens = suggestToks(`${item.label || ''} ${item.summary || ''}`);
  const shared = [...queryTokens].filter((token) => itemTokens.has(token));
  return {
    shared,
    score: queryTokens.size && itemTokens.size
      ? shared.length / Math.sqrt(queryTokens.size * itemTokens.size)
      : 0,
  };
}

async function search(graph, overlay, query) {
  const ctx = {
    buildGraph: () => graph,
    overlayFor: () => overlay,
    isTruthy: (value) => value != null && value !== '' && value !== '0' && value !== 'false' && value !== 'no',
    embed: async () => null,
    suggestToks,
    scoreNodeAgainstTokens,
    knowledgeText: (item) => String((item && (item.value || item.text || item.summary)) || ''),
    noteCurrentAsOf: () => true,
    gatedSearchCounts: new Map(),
    checkGatedRateLimit: () => false,
    enqueueSearchTelemetry: () => {},
    EMBED_MODEL: 'note-provenance-test',
  };
  const u = new URL('http://127.0.0.1/search');
  u.searchParams.set('workspace', WS);
  u.searchParams.set('q', query);
  u.searchParams.set('k', '5');
  u.searchParams.set('rerank', '0');
  u.searchParams.set('node_first', '0');
  const result = await compileSearchContext(ctx, { req: { socket: { remoteAddress: '127.0.0.1' } }, u });
  assert.equal(result.status, 200);
  return result.body.results;
}

(async () => {
  try {
    const ov = overlayStore.load(WS);
    const episode = {
      session_id: 'session-provenance',
      transcript_ref: '/transcripts/session-provenance.jsonl',
      turn: 7,
      span: { start: 12, end: 84 },
    };
    const noteId = overlayStore.addNoteNode(ov, {
      title: 'Immutable artifact provenance contract',
      summary: 'The release artifact records the immutable provenance contract evidence.',
      created_by: 'test-worker',
      memory_lane: 'evidence',
      source_role: 'artifact',
      authority: 'observation',
      confidence: 0.91,
      episode,
    });
    const oldId = overlayStore.addNoteNode(ov, {
      title: 'Old review preference',
      summary: 'Always write long review summaries because detail was previously preferred.',
      memory_lane: 'guidance',
      source_role: 'user',
      authority: 'directive',
      confidence: 0.75,
      episode: { ...episode, turn: 8 },
    });
    const newId = overlayStore.addNoteNode(ov, {
      title: 'Current review preference',
      summary: 'Always write concise review summaries because the verdict should stay visible.',
      memory_lane: 'guidance',
      source_role: 'user',
      authority: 'directive',
      confidence: 1,
      episode: { ...episode, turn: 9 },
    });
    const supersede = overlayStore.supersedeNote(ov, oldId, newId, '2026-08-30T16:00:00.000Z', WS);
    assert.equal(supersede.ok, true);

    const entity = overlayStore.createEntity(ov, { name: 'VoiceMem', type: 'product' });
    overlayStore.addEntityEdge(ov, `entity:${entity.id}`, `note:${noteId}`, 'subject_of');
    overlayStore.save(WS, ov);

    fs.rmSync(overlayStore.fileFor(WS), { force: true });
    const reloaded = overlayStore.load(WS);
    const loaded = reloaded.note_nodes[noteId];
    assert.equal(loaded.memory_lane, 'evidence');
    assert.equal(loaded.source_role, 'artifact');
    assert.equal(loaded.authority, 'observation');
    assert.equal(loaded.confidence, 0.91);
    assert.deepEqual(loaded.episode, episode);

    assert.equal(reloaded.note_nodes[oldId].source_role, 'user');
    assert.equal(reloaded.note_nodes[oldId].validTo, '2026-08-30T16:00:00.000Z');
    assert.equal(reloaded.note_nodes[newId].memory_lane, 'guidance');
    assert.equal(reloaded.note_nodes[newId].supersedes, oldId);
    const entityEdge = reloaded.edges.find((edge) => edge.from === `entity:${entity.id}` && edge.to === `note:${noteId}`);
    assert(entityEdge && entityEdge.relation === 'subject_of');

    daemon.__clearOverlayCacheForTest();
    daemon.__setWorkspaceForTest(WS);
    const graph = daemon.buildGraph(WS);
    const projected = graph.tasks.find((node) => node.id === `note:${noteId}`);
    assert.equal(projected.memory_lane, 'evidence');
    assert.equal(projected.source_role, 'artifact');
    assert.equal(projected.authority, 'observation');
    assert.equal(projected.confidence, 0.91);
    assert.deepEqual(projected.episode, episode);
    assert(projected.context_deps.includes(`entity:${entity.id}`));

    const results = await search(graph, reloaded, 'immutable artifact provenance contract evidence');
    const recalled = results.find((item) => item.key === `note:${noteId}`);
    assert(recalled, 'provenance note should remain retrievable');
    assert.equal(recalled.memory_lane, 'evidence');
    assert.equal(recalled.source_role, 'artifact');
    assert.equal(recalled.authority, 'observation');
    assert.equal(recalled.confidence, 0.91);
    assert.deepEqual(recalled.episode, episode);

    console.log('PASS note provenance persistence, replay, projection, supersession, entity link, and search');
  } finally {
    try {
      const pid = parseInt(fs.readFileSync(path.join(TMP, 'embed.pid'), 'utf8'), 10);
      if (pid) process.kill(pid, 'SIGTERM');
    } catch { /* sidecar may not have spawned */ }
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().then(() => process.exit(0)).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
