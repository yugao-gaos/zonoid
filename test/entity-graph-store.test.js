#!/usr/bin/env node
// Regression: entity nodes and relation-bearing entity edges persist through graph-store replay
// and project into buildGraph without becoming executable tasks.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-entity-graph-store-')));
process.env.CLAUDE_PLUGIN_DATA = TMP;
process.env.ORCH_RERANK = '0';

const overlayStore = require('../lib/overlay');
const graphStore = require('../lib/graph-store');
const daemon = require('../daemon');
const newlyReady = require('../lib/newly-ready');

const WS = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'ws-')));
const entityVec = [0.4, 0.5, 0.6];
const entityVecMeta = { provider: 'test', model: 'entity-test', dimensions: 3, identity: 'test:entity-test:3' };

async function main() {
try {
  const ov = overlayStore.load(WS);
  const entity = overlayStore.createEntity(ov, {
    name: 'Zonoid',
    type: 'org',
    aliases: ['orchestrator'],
    vec: entityVec,
    vecMeta: entityVecMeta,
  });
  const noteId = overlayStore.addNoteNode(ov, {
    title: 'Zonoid entity fact',
    summary: 'Zonoid stores entity memory in graph-store events.',
    created_by: 'test',
  });
  const entityKey = `entity:${entity.id}`;
  const noteKey = `note:${noteId}`;
  const linked = overlayStore.addEntityEdge(ov, entityKey, noteKey, 'subject_of');
  overlayStore.save(WS, ov);

  ok('createEntity returns org entity', entity && entity.kind === 'entity' && entity.type === 'org');
  ok('addEntityEdge stamps relation', linked && linked.relation === 'subject_of' && linked.origin === 'entity-link');

  const rawGraph = graphStore.loadGraph(graphStore.forWorkspace(WS));
  const rawEntity = rawGraph.nodes[entityKey];
  const rawEdge = rawGraph.edges.find((e) => e.from === entityKey && e.to === noteKey);
  ok('graph-store replays entity node event', rawEntity && rawEntity.kind === 'entity');
  ok('graph-store preserves entity fields', rawEntity && rawEntity.entity_node && rawEntity.entity_node.name === 'Zonoid' && rawEntity.entity_node.type === 'org');
  ok('graph-store preserves entity vector', rawEntity && same(rawEntity.vec, entityVec) && same(rawEntity.vecMeta, entityVecMeta));
  ok('graph-store replays relation-bearing entity edge', rawEdge && rawEdge.kind === 'context' && rawEdge.relation === 'subject_of' && rawEdge.origin === 'entity-link');

  // Prove replay from .graph, not the local overlay JSON compatibility copy.
  fs.rmSync(overlayStore.fileFor(WS), { force: true });
  const reloaded = overlayStore.load(WS);
  const reloadedEdge = reloaded.edges.find((e) => e.from === entityKey && e.to === noteKey);
  ok('overlay.load rehydrates entity node from graph-store', reloaded.entity_nodes[entity.id] && reloaded.entity_nodes[entity.id].name === 'Zonoid');
  ok('overlay.load rehydrates entity aliases/vector', same(reloaded.entity_nodes[entity.id].aliases, ['orchestrator']) && same(reloaded.entity_nodes[entity.id].vec, entityVec));
  ok('overlay.load rehydrates entity edge relation', reloadedEdge && reloadedEdge.relation === 'subject_of');

  daemon.__clearOverlayCacheForTest();
  daemon.__setWorkspaceForTest(WS);
  const graph = daemon.buildGraph(WS);
  const entityNode = graph.tasks.find((t) => t.id === entityKey);
  const noteNode = graph.tasks.find((t) => t.id === noteKey);
  ok('buildGraph projects entity node', entityNode && entityNode.kind === 'entity' && entityNode.status === 'entity');
  ok('buildGraph projects entity edge onto linked note', noteNode && noteNode.context_deps.includes(entityKey));
  ok('summary excludes entity nodes from tasks', graph.summary.tasks_total === 0 && graph.summary.notes === 1 && graph.summary.entity_nodes === 1);
  ok('readyKeys excludes entity nodes', newlyReady.readyKeys(graph).size === 0);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
