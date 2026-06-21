#!/usr/bin/env node
'use strict';

const { expandStructuralContext } = require('../lib/search/memory-search');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const graph = {
  tasks: [
    {
      id: 'note:seed',
      label: 'Cache hydration retry finding',
      kind: 'note',
      summary: 'Hydration retries must preserve source order.',
      context_deps: ['knowledge:source_chunk:guide#chunk-1'],
    },
    {
      id: 'note:sibling',
      label: 'Neighbor fact',
      kind: 'note',
      summary: 'The same chunk also says stale reads should keep their checkpoint.',
      context_deps: ['knowledge:source_chunk:guide#chunk-1'],
    },
    {
      id: 'note:broad-doc-neighbor',
      label: 'Broad same document fact',
      kind: 'note',
      summary: 'This shares only the parent document and should not ride the chunk hit.',
      context_deps: ['knowledge:source_doc:guide'],
    },
    {
      id: 'note:unrelated',
      label: 'Unrelated fact',
      kind: 'note',
      summary: 'Different source material.',
      context_deps: ['knowledge:source_chunk:other#chunk-9'],
    },
    {
      id: 'knowledge:source_chunk:guide#chunk-1',
      label: 'Guide chunk 1',
      kind: 'source_chunk',
      summary: 'Evidence chunk for cache hydration.',
      context_deps: ['knowledge:source_section:guide#retrieval'],
    },
    {
      id: 'knowledge:source_section:guide#retrieval',
      label: 'Guide retrieval section',
      kind: 'source_section',
      summary: 'Parent retrieval section.',
      context_deps: ['knowledge:source_doc:guide'],
    },
    {
      id: 'knowledge:source_doc:guide',
      label: 'Guide document',
      kind: 'source_doc',
      summary: 'Parent source document.',
      context_deps: [],
    },
    {
      id: 'knowledge:source_chunk:other#chunk-9',
      label: 'Other chunk',
      kind: 'source_chunk',
      summary: 'Unrelated source chunk.',
      context_deps: ['knowledge:source_doc:other'],
    },
    {
      id: 'knowledge:source_doc:other',
      label: 'Other document',
      kind: 'source_doc',
      summary: 'Unrelated source document.',
      context_deps: [],
    },
  ],
};

const ragResults = [
  {
    key: 'note:seed',
    title: 'Cache hydration retry finding',
    summary: 'Hydration retries must preserve source order.',
    score: 0.42,
    kind: 'note',
    tier: 'rag',
    via: 'rrf-bm25',
    path: [],
  },
];

const added = expandStructuralContext({
  graph,
  ragResults,
  temporalOk: () => true,
  dupInvisible: () => false,
  excludedKeys: new Set(),
});

const keys = ragResults.map((r) => r.key);
const expanded = ragResults.filter((r) => r.expanded);

ok('direct note remains first', keys[0] === 'note:seed' && !ragResults[0].expanded);
ok('evidence chunk is expanded', keys.includes('knowledge:source_chunk:guide#chunk-1'));
ok('source parents are expanded', keys.includes('knowledge:source_section:guide#retrieval') && keys.includes('knowledge:source_doc:guide'));
ok('sibling fact sharing exact evidence chunk is expanded', keys.includes('note:sibling'));
ok('broad same-document sibling is not expanded', !keys.includes('note:broad-doc-neighbor'));
ok('unrelated source nodes are not expanded', !keys.includes('knowledge:source_chunk:other#chunk-9') && !keys.includes('knowledge:source_doc:other') && !keys.includes('note:unrelated'));
ok('expanded rows are distinct from direct RAG hits', expanded.length === added.length && expanded.every((r) => r.tier === 'graph_expanded' && r.via === 'structural-context' && r.expanded_from === 'note:seed'));

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
