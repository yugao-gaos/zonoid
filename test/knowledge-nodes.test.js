#!/usr/bin/env node
// Regression: typed knowledge nodes persist through graph-store, project into buildGraph/search,
// and remain non-executable graph nodes rather than ready/native tasks.
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

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-knowledge-nodes-')));
process.env.CLAUDE_PLUGIN_DATA = TMP;

const overlayStore = require('../lib/overlay');
const graphStore = require('../lib/graph-store');
const daemon = require('../daemon');
const newlyReady = require('../lib/newly-ready');

const WS = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'ws-')));
const docVec = [0.1, 0.2, 0.3];
const sectionVecs = [[1, 0, 0], [0, 1, 0]];

try {
  const ov = overlayStore.load(WS);
  const doc = overlayStore.upsertKnowledgeNode(ov, {
    type: 'source_doc',
    id: 'architecture-guide',
    label: 'Architecture Guide',
    summary: 'Canonical source document for cluster-preserving onboarding.',
    source_path: 'docs/architecture.md',
    metadata: { sha: 'abc123' },
    vec: docVec,
  });
  const section = overlayStore.upsertKnowledgeNode(ov, {
    type: 'source_section',
    id: 'architecture-guide#retrieval',
    label: 'Retrieval section',
    summary: 'Document progression links distilled clusters to evidence chunks.',
    source_path: 'docs/architecture.md',
    section_ref: 'retrieval',
    cluster_ref: 'cluster:retrieval',
    vecs: sectionVecs,
  });
  ok('upsert source_doc succeeds', doc.ok && doc.key === 'knowledge:source_doc:architecture-guide');
  ok('upsert source_section succeeds', section.ok && section.key === 'knowledge:source_section:architecture-guide#retrieval');

  overlayStore.addEdge(ov, doc.key, section.key, null, 'context', 1.0, { origin: 'test' });
  overlayStore.save(WS, ov);

  const rawGraph = graphStore.loadGraph(graphStore.forWorkspace(WS));
  const rawDoc = rawGraph.nodes[doc.key];
  ok('graph-store replays knowledge node event', rawDoc && rawDoc.kind === 'source_doc');
  ok('graph-store preserves metadata refs', rawDoc && rawDoc.knowledge_node && rawDoc.knowledge_node.source_path === 'docs/architecture.md');

  const reloaded = overlayStore.load(WS);
  ok('overlay.load rehydrates source_doc', reloaded.knowledge_nodes[doc.key] && reloaded.knowledge_nodes[doc.key].type === 'source_doc');
  ok('overlay.load rehydrates source_section refs', reloaded.knowledge_nodes[section.key] && reloaded.knowledge_nodes[section.key].section_ref === 'retrieval');
  ok('overlay.load rehydrates vectors', same(reloaded.knowledge_nodes[doc.key].vec, docVec) && same(reloaded.knowledge_nodes[section.key].vecs, sectionVecs));

  daemon.__clearOverlayCacheForTest();
  daemon.__setWorkspaceForTest(WS);
  const graph = daemon.buildGraph(WS);
  const docNode = graph.tasks.find((t) => t.id === doc.key);
  const sectionNode = graph.tasks.find((t) => t.id === section.key);
  ok('buildGraph projects source_doc node', docNode && docNode.kind === 'source_doc' && docNode.status === 'knowledge');
  ok('buildGraph projects source_section node', sectionNode && sectionNode.kind === 'source_section' && sectionNode.status === 'knowledge');
  ok('buildGraph projects context edge onto knowledge node', sectionNode && sectionNode.context_deps.includes(doc.key));
  ok('summary excludes knowledge nodes from tasks', graph.summary.tasks_total === 0 && graph.summary.knowledge_nodes === 2);
  ok('readyKeys excludes knowledge nodes', newlyReady.readyKeys(graph).size === 0);

  const scored = daemon.scoreNodeAgainstTokens(sectionNode, daemon.suggestToks('progression evidence chunks'));
  ok('search scorer sees typed knowledge node text', scored.score > 0);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
