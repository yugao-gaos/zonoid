#!/usr/bin/env node
'use strict';

const {
  createEmbeddingStore,
  hasTaskVec,
  knowledgeItemNode,
  maxCosine,
  nodeVecs,
  setKnowledgeItemVec,
  setTaskVec,
  taskNode,
  taskVecFresh,
  vectorSetFresh,
} = require('../lib/embedding-store');
const { DIMS, embeddingMeta } = require('../lib/embed');
const overlayStore = require('../lib/overlay');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const minilmVec = Array.from({ length: DIMS }, (_, i) => i / DIMS);
const voyageMeta = { provider: 'voyage', model: 'voyage-4-lite', dimensions: 1024, identity: 'voyage:voyage-4-lite:1024' };
const voyageVec = Array.from({ length: 1024 }, (_, i) => i / 1024);
const cohereMeta = { provider: 'cohere', model: 'embed-v4.0', dimensions: 1536, identity: 'cohere:embed-v4.0:1536' };

{
  const ov = overlayStore.EMPTY();
  const store = createEmbeddingStore(ov);
  store.setTaskVec('sess/1', voyageVec, voyageMeta);
  ok('store writes task vector into overlay.taskVecs', Array.isArray(ov.taskVecs['sess/1']) && ov.taskVecs['sess/1'][0] === voyageVec);
  ok('store writes task metadata into overlay.taskVecMeta', ov.taskVecMeta['sess/1'][0] === voyageMeta);
  ok('store projects task vector as node vecs', nodeVecs(store.taskNode('sess/1'), { expectedMeta: voyageMeta }).length === 1);
  ok('taskNode helper projects task vector as node vecs', nodeVecs(taskNode(ov, 'sess/1'), { expectedMeta: voyageMeta }).length === 1);
  ok('hasTaskVec reports raw task vector presence', store.hasTaskVec('sess/1') && hasTaskVec(ov, 'sess/1'));
  ok('taskVecFresh accepts matching task vector metadata', store.taskVecFresh('sess/1', { expectedMeta: voyageMeta }) && taskVecFresh(ov, 'sess/1', { expectedMeta: voyageMeta }));
  ok('taskVecFresh rejects stale task vector metadata', !store.taskVecFresh('sess/1', { expectedMeta: cohereMeta }));
  store.setTaskVec('sess/1', null);
  ok('store clears task vector and metadata', !ov.taskVecs['sess/1'] && !ov.taskVecMeta['sess/1']);
  ok('hasTaskVec reports cleared task vector absence', !hasTaskVec(ov, 'sess/1'));
}

{
  const ov = overlayStore.EMPTY();
  setTaskVec(ov, 'sess/2', minilmVec, embeddingMeta(ov));
  ok('setTaskVec helper preserves existing overlay shape', Array.isArray(ov.taskVecs['sess/2']) && Array.isArray(ov.taskVecMeta['sess/2']));
}

{
  ok('nodeVecs accepts matching hosted metadata', nodeVecs({ vec: voyageVec, vecMeta: voyageMeta }, { expectedMeta: voyageMeta }).length === 1);
  ok('nodeVecs rejects missing hosted metadata', nodeVecs({ vec: voyageVec }, { expectedMeta: voyageMeta }).length === 0);
  ok('nodeVecs rejects stale hosted metadata', nodeVecs({ vec: voyageVec, vecMeta: cohereMeta }, { expectedMeta: voyageMeta }).length === 0);
  ok('nodeVecs keeps legacy MiniLM vector under MiniLM default', nodeVecs({ vec: minilmVec }, { expectedMeta: embeddingMeta(overlayStore.EMPTY()) }).length === 1);
  ok('vectorSetFresh preserves no-expected-meta presence semantics', vectorSetFresh([{}], null));
  ok('vectorSetFresh rejects missing hosted metadata', !vectorSetFresh([voyageVec], null, { expectedMeta: voyageMeta }));
  ok('vectorSetFresh accepts matching hosted metadata', vectorSetFresh([voyageVec], [voyageMeta], { expectedMeta: voyageMeta }));
}

{
  const item = {};
  setKnowledgeItemVec(item, voyageVec, voyageMeta);
  ok('knowledge helper writes _vec sidecar', item._vec === voyageVec && item._vecMeta === voyageMeta);
  ok('knowledge helper projects _vec sidecar as node vec', nodeVecs(knowledgeItemNode(item), { expectedMeta: voyageMeta }).length === 1);
  setKnowledgeItemVec(item, null);
  ok('knowledge helper clears _vec sidecar', !item._vec && !item._vecMeta);
}

{
  const q = [0.6, 0.8, 0];
  const v1 = [1, 0, 0];
  const v2 = [0, 1, 0];
  ok('maxCosine scores max over filtered node vectors', maxCosine(q, { vecs: [v1, v2] }) === 0.8);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
