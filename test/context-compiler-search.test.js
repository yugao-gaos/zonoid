#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compileSearchContext } = require('../lib/search/context-compiler');
const { buildContextRetrievalHandle, compressNaturalLanguage, resolveContextHandle } = require('../lib/search/context-compression');
const recallJournal = require('../lib/recall-outcome-journal');

let pass = 0;
let fail = 0;
const tests = [];
const test = (label, fn) => tests.push({ label, fn });

function node(id, label, extra = {}) {
  return {
    id,
    label,
    status: extra.status || 'done',
    deps: extra.deps || [],
    context_deps: extra.context_deps || [],
    context_weights: extra.context_weights || {},
    summary: extra.summary || `${label} summary`,
    kind: extra.kind,
    category: extra.category,
    provisional: extra.provisional,
  };
}

function suggestToks(s) {
  return new Set((String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []));
}

function scoreNodeAgainstTokens(item, qt) {
  const xt = suggestToks(`${item.label || ''} ${item.summary || ''}`);
  const shared = [...qt].filter((token) => xt.has(token));
  const score = qt.size && xt.size ? shared.length / Math.sqrt(qt.size * xt.size) : 0;
  return { shared, score };
}

function noteCurrentAsOf(item, asOf) {
  if (!asOf || (item.kind || 'task') !== 'note') return true;
  if (!item.validFrom) return true;
  const t = Date.parse(asOf);
  if (Number.isNaN(t)) return true;
  if (Date.parse(item.validFrom) > t) return false;
  if (item.validTo && Date.parse(item.validTo) <= t) return false;
  return true;
}

function makeWorkspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-context-compiler-')));
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  return ws;
}

function makeCtx(graph, workspace, overlay = {}, overrides = {}) {
  const ov = { knowledge: {}, edges: [], entity_nodes: {}, ...overlay };
  return {
    buildGraph: () => graph,
    overlayFor: () => ov,
    isTruthy: (value) => value != null && value !== '' && value !== '0' && value !== 'false' && value !== 'no',
    embed: async () => null,
    suggestToks,
    scoreNodeAgainstTokens,
    knowledgeText: (item) => typeof item === 'string' ? item : String((item && (item.value || item.text || item.summary)) || ''),
    noteCurrentAsOf,
    gateTask: async () => ({ decision: 'abstain', reason: 'test', via: 'lexical', top1: 0, margin: 0, gap: 0, locality: 0, topType: null }),
    gatedSearchCounts: new Map(),
    checkGatedRateLimit: () => false,
    EMBED_MODEL: 'test',
    workspace,
    ...overrides,
  };
}

async function runSearchWithWorkspace(graph, params, overlay, overrides) {
  const workspace = makeWorkspace();
  const u = new URL('http://127.0.0.1/search');
  u.searchParams.set('workspace', workspace);
  for (const [key, value] of Object.entries(params || {})) u.searchParams.set(key, value);
  const result = await compileSearchContext(makeCtx(graph, workspace, overlay, overrides), {
    req: { socket: { remoteAddress: '127.0.0.1' } },
    u,
  });
  assert.equal(result.status, 200);
  return { body: result.body, workspace };
}

async function runSearch(graph, params, overlay) {
  return (await runSearchWithWorkspace(graph, params, overlay)).body;
}

test('settled task_key search returns only system and structural task context', async () => {
  const graph = {
    tasks: [
      node('task/target', 'Target task', {
        status: 'ready',
        deps: ['task/blocker'],
        context_deps: ['note:direct'],
        context_weights: { 'note:direct': 0.9 },
        provisional: false,
      }),
      node('task/blocker', 'Blocking prerequisite'),
      node('note:direct', 'Direct task context', {
        kind: 'note',
        context_deps: ['note:support'],
        context_weights: { 'note:support': 0.7 },
      }),
      node('note:support', 'Support note', { kind: 'note' }),
      node('note:system', 'System constraint', {
        kind: 'note',
        category: 'system',
        summary: 'System context must always be present.',
      }),
      node('note:semantic-rag', 'Semantic RAG-only match', {
        kind: 'note',
        summary: 'needle query exact semantic match that must not leak into a settled task.',
      }),
      node('task/sibling', 'Sibling wired task', {
        context_deps: ['note:direct'],
        context_weights: { 'note:direct': 0.8 },
      }),
    ],
  };

  const body = await runSearch(graph, {
    q: 'needle query exact semantic match',
    task_key: 'task/target',
    k: '3',
  });
  const byKey = new Map(body.results.map((item) => [item.key, item]));

  assert(byKey.has('note:system'));
  assert.equal(byKey.get('note:system').tier, 'system');
  assert(byKey.has('task/blocker'));
  assert.equal(byKey.get('task/blocker').tier, 'dag');
  assert.equal(byKey.get('task/blocker').via, 'blocking');
  assert.equal(byKey.get('note:direct').tier, 'dag');
  assert.equal(byKey.get('note:direct').weight, 0.9);
  assert.equal(byKey.get('note:support').tier, 'dag-note');
  assert.equal(byKey.get('task/sibling').tier, 'surrounding');
  assert.equal(byKey.has('note:semantic-rag'), false);
  assert.equal(body.results.some((item) => item.tier === 'rag'), false);
  assert.equal(body.continue, false);
});

test('task_key search journals direct context edge metadata after injection flags are set', async () => {
  const graph = {
    tasks: [
      node('task/target', 'Target task', {
        status: 'ready',
        context_deps: ['note:direct', 'task/context'],
        context_weights: { 'note:direct': 0.9, 'task/context': 0.8 },
        provisional: false,
      }),
      node('note:direct', 'Direct note', { kind: 'note' }),
      node('task/context', 'Direct task context'),
    ],
  };

  const { workspace } = await runSearchWithWorkspace(graph, {
    q: 'direct context',
    task_key: 'task/target',
    gated: '1',
  });
  const row = recallJournal.readRows(workspace).filter((r) => r.task_key === 'task/target').pop();

  assert(row, 'expected pending recall row');
  assert(row.recalled_note_keys.includes('note:direct'));
  const noteEdge = row.recalled_context_edges.find((edge) => edge.from === 'task/target' && edge.to === 'note:direct');
  const taskEdge = row.recalled_context_edges.find((edge) => edge.from === 'task/target' && edge.to === 'task/context');
  assert(noteEdge, 'expected note context edge metadata');
  assert(taskEdge, 'expected task context edge metadata');
  assert.equal(noteEdge.relation, 'context');
  assert.equal(noteEdge.result_kind, 'note');
  assert.equal(noteEdge.injected, true);
  assert.equal(noteEdge.structural, true);
  assert.equal(noteEdge.direct, true);
  assert.equal(noteEdge.weight, 0.9);
  assert.equal(taskEdge.result_kind, 'task');
});

test('conversational query promotes a wired neighbor through activation', async () => {
  const graph = {
    tasks: [
      node('note:anchor', 'Alpha anchor retrieval', {
        kind: 'note',
        summary: 'alpha anchor retrieval seed',
        context_deps: ['note:neighbor'],
        context_weights: { 'note:neighbor': 1 },
      }),
      node('note:neighbor', 'Wired neighbor', {
        kind: 'note',
        summary: 'graph-only context with no alpha token',
      }),
      node('note:loose', 'Alpha loose match', {
        kind: 'note',
        summary: 'alpha standalone hit',
      }),
    ],
  };

  const body = await runSearch(graph, { q: 'alpha anchor', k: '5' });
  const neighbor = body.results.find((item) => item.key === 'note:neighbor');

  assert(neighbor, 'expected wired neighbor in conversational results');
  assert(neighbor.graphActivation > 0, 'expected activation metadata on wired neighbor');
  assert((neighbor.path || []).some((part) => part.startsWith('activation:')));
});

test('default query promotes exact node label before chunk evidence', async () => {
  const graph = {
    tasks: [
      node('task/subconscious-mcp', 'Subconscious MCP tool implementation', {
        summary: 'plumbing task',
      }),
      node('task/research', 'Memory competitor research', {
        summary: 'research parent',
      }),
    ],
  };
  const overlay = {
    knowledge: {
      'task/research': [
        { value: 'subconscious memory self learning agent recall competitor evidence with rich context' },
      ],
    },
  };

  const body = await runSearch(graph, { q: 'subconscious', k: '5' }, overlay);

  assert.equal(body.results[0].key, 'task/subconscious-mcp');
  assert.equal(body.results[0].nodeFirst, true);
  assert(body.results.some((item) => item.key === 'task/research#k0'), 'expected chunk evidence to remain present');
});

test('disjoint query does not return arbitrary zero-evidence RRF candidates', async () => {
  const graph = {
    tasks: [
      node('note:refund', 'Stripe refund idempotency', { kind: 'note', summary: 'payment gateway retry details' }),
      node('task/rotate', 'Rotate database credentials', { summary: 'vault credential cron job' }),
    ],
  };

  const body = await runSearch(graph, { q: 'airline mileage kiosk redemption', k: '5' });

  assert.deepEqual(body.results, []);
  assert.equal(body.continue, false);
});

test('entity expansion still returns linked notes when the query names the entity', async () => {
  const graph = {
    tasks: [
      node('note:entity-context', 'Budget normalization decision', {
        kind: 'note',
        summary: 'use cents internally for accounting',
      }),
    ],
  };
  const overlay = {
    entity_nodes: {
      zonoid: { name: 'Zonoid' },
    },
    edges: [
      { kind: 'context', from: 'entity:zonoid', to: 'note:entity-context' },
    ],
  };

  const body = await runSearch(graph, { q: 'zonoid', k: '5' }, overlay);
  const hit = body.results.find((item) => item.key === 'note:entity-context');

  assert(hit, 'expected entity-linked note to remain visible');
  assert.equal(hit.via_entity, true);
});

test('task_key RAG results exclude the current task itself', async () => {
  const graph = {
    tasks: [
      node('task/target', 'Alpha target task', {
        summary: 'alpha target implementation',
        provisional: true,
      }),
      node('task/other', 'Alpha supporting task', {
        summary: 'alpha target supporting context',
      }),
    ],
  };

  const body = await runSearch(graph, { q: 'alpha target', task_key: 'task/target', k: '5' });
  const keys = new Set(body.results.map((item) => item.key));

  assert.equal(keys.has('task/target'), false);
  assert.equal(keys.has('task/other'), true);
});

test('gated search does not inject a gate topKey pruned from selected results', async () => {
  const graph = {
    tasks: [
      node('task/target', 'Target task', {
        provisional: true,
      }),
      node('note:visible', 'Alpha alpha visible note', {
        kind: 'note',
        summary: 'alpha alpha selected context',
      }),
      node('note:hidden', 'Beta hidden note', {
        kind: 'note',
        summary: 'beta pruned context',
      }),
    ],
  };

  const { body } = await runSearchWithWorkspace(graph, {
    q: 'alpha beta',
    task_key: 'task/target',
    gated: '1',
    k: '1',
  }, {}, {
    gateTask: async () => ({
      decision: 'inject',
      reason: 'test hidden topKey',
      topKey: 'note:hidden',
      top1: 0.9,
      margin: 0.8,
      gap: 0.7,
      locality: 3,
      topType: 'empirical',
      via: 'lexical',
    }),
  });

  assert.equal(body.decision, 'abstain');
  assert.equal(body.results.some((item) => item.key === 'note:hidden'), false);
  assert.equal(body.results.some((item) => item.inject === true), false);
});

test('node_first can be disabled for raw rank diagnostics', async () => {
  const graph = {
    tasks: [
      node('task/subconscious-mcp', 'Subconscious MCP tool implementation', {
        summary: 'plumbing task',
      }),
      node('task/research', 'Memory competitor research', {
        summary: 'research parent',
      }),
    ],
  };
  const overlay = {
    knowledge: {
      'task/research': [
        { value: 'subconscious memory self learning agent recall competitor evidence with rich context' },
      ],
    },
  };

  const body = await runSearch(graph, { q: 'subconscious', k: '5', node_first: '0' }, overlay);

  assert.equal(body.results.some((item) => item.nodeFirst), false);
});

test('default query promotes quoted node search term inside verbose prompt', async () => {
  const graph = {
    tasks: [
      node('task/subconscious-mcp', 'Subconscious MCP tool implementation', {
        summary: 'plumbing task',
      }),
      node('task/research', 'Memory competitor research', {
        summary: 'research parent',
      }),
    ],
  };
  const overlay = {
    knowledge: {
      'task/research': [
        { value: 'subconscious memory self learning agent recall competitor evidence with rich context' },
      ],
    },
  };

  const body = await runSearch(graph, { q: "For query 'subconscious', report top graph context", k: '5' }, overlay);

  assert.equal(body.results[0].key, 'task/subconscious-mcp');
  assert.equal(body.results[0].nodeFirst, true);
});

test('conversational query keeps structural graph expansion beyond direct k', async () => {
  const sourceKey = 'knowledge:source_chunk:guide#chunk-1';
  const graph = {
    tasks: [
      node('note:seed', 'Alpha omega visibility seed', {
        kind: 'note',
        summary: 'alpha omega visibility distilled fact',
        context_deps: [sourceKey],
        context_weights: { [sourceKey]: 0.001 },
      }),
      node('note:distractor-a', 'Alpha omega direct match A', {
        kind: 'note',
        summary: 'alpha omega visibility distractor',
      }),
      node('note:distractor-b', 'Alpha omega direct match B', {
        kind: 'note',
        summary: 'alpha omega visibility distractor',
      }),
      node('note:distractor-c', 'Alpha omega direct match C', {
        kind: 'note',
        summary: 'alpha omega visibility distractor',
      }),
      node('note:sibling', 'Sibling source fact', {
        kind: 'note',
        summary: 'same evidence chunk contains a second fact',
        context_deps: [sourceKey],
        context_weights: { [sourceKey]: 0.001 },
      }),
      node(sourceKey, 'Evidence chunk', {
        kind: 'source_chunk',
        summary: 'supporting evidence text',
        context_deps: ['knowledge:source_section:guide#section-1'],
        context_weights: { 'knowledge:source_section:guide#section-1': 0.001 },
      }),
      node('knowledge:source_section:guide#section-1', 'Evidence section', {
        kind: 'source_section',
        summary: 'parent evidence section',
        context_deps: ['knowledge:source_doc:guide'],
        context_weights: { 'knowledge:source_doc:guide': 0.001 },
      }),
      node('knowledge:source_doc:guide', 'Evidence document', {
        kind: 'source_doc',
        summary: 'parent evidence document',
      }),
    ],
  };

  const body = await runSearch(graph, { q: 'alpha omega visibility', k: '1' });
  const direct = body.results.filter((item) => item.tier === 'rag');
  const expanded = body.results.filter((item) => item.tier === 'graph_expanded');
  const expandedKeys = new Set(expanded.map((item) => item.key));

  assert.equal(direct.length, 1);
  assert(body.results.length > 1, 'expected supplemental expanded rows beyond direct k');
  assert(expandedKeys.has(sourceKey), 'expected exact evidence chunk to survive slicing');
  assert(expandedKeys.has('knowledge:source_section:guide#section-1'), 'expected source parent to survive slicing');
  assert(expandedKeys.has('note:sibling'), 'expected exact-source sibling fact to survive slicing');
  assert(expanded.every((item) => item.expanded_from === 'note:seed'));
});

test('reversible context compression is default-off for full content search results', async () => {
  const longSummary = `alpha reversible context ${'detail '.repeat(100)}final provenance sentence`;
  const graph = {
    tasks: [
      node('note:long', 'Long reversible context note', {
        kind: 'note',
        summary: longSummary,
      }),
    ],
  };

  const body = await runSearch(graph, { q: 'alpha reversible context', k: '1', full_content: '1' });
  const hit = body.results.find((item) => item.key === 'note:long');

  assert(hit, 'expected long note result');
  assert.equal(body.context_compression, undefined);
  assert.equal(hit.ccr, undefined);
  assert.equal(hit.content, longSummary.slice(0, 1200));
});

test('reversible context compression preserves keys provenance and retrieval handles', async () => {
  const longSummary = `alpha reversible context ${'retrievable provenance detail '.repeat(35)}tail marker`;
  const graph = {
    tasks: [
      node('task/target', 'Compression target', {
        status: 'ready',
        context_deps: ['note:long'],
        context_weights: { 'note:long': 0.9 },
        provisional: false,
      }),
      node('note:long', 'Long reversible context note', {
        kind: 'note',
        summary: longSummary,
      }),
    ],
  };

  const body = await runSearch(graph, {
    q: 'alpha reversible context',
    task_key: 'task/target',
    k: '1',
    full_content: '1',
    reversible_context: '1',
  });
  const hit = body.results.find((item) => item.key === 'note:long');

  assert(hit, 'expected direct context result');
  assert.equal(hit.key, 'note:long');
  assert.equal(hit.kind, 'note');
  assert.equal(hit.tier, 'dag');
  assert.equal(hit.via, 'context');
  assert.deepEqual(hit.path, ['context_dep of task/task/target']);
  assert(hit.content.includes('[CCR omitted '), 'expected reversible compression marker');
  assert(hit.content.includes('tail marker'), 'expected tail context to survive compression');
  assert.equal(hit.ccr.reversible, true);
  assert.equal(hit.ccr.handle.key, 'note:long');
  assert.equal(hit.ccr.handle.tool, 'search_knowledge');
  assert.equal(hit.ccr.handle.field, 'content');
  assert.equal(hit.ccr.handle.tier, 'dag');
  assert.equal(hit.ccr.handle.via, 'context');
  assert.match(hit.ccr.handle.ccr_id, /^ccr:/);
  assert.equal(hit.ccr.handle.original_chars, longSummary.length);
  assert(hit.ccr.handle.compressed_chars < hit.ccr.handle.original_chars);
  assert.equal(body.context_compression.enabled, true);
  assert.equal(body.context_compression.mode, 'reversible_context');
  assert.equal(body.context_compression.compressed_entries, 1);
  assert(body.context_compression.before_tokens > body.context_compression.after_tokens);
  assert.equal(body.context_compression.saved_tokens, body.context_compression.before_tokens - body.context_compression.after_tokens);
  assert.deepEqual(body.context_compression.handles.map((handle) => handle.key), ['note:long']);

  const resolved = resolveContextHandle(hit.ccr.handle, graph, {});
  assert.equal(resolved.ok, true);
  assert.equal(resolved.key, 'note:long');
  assert.equal(resolved.field, 'content');
  assert.equal(resolved.kind, 'note');
  assert.equal(resolved.content, longSummary);
});

test('reversible context compression compacts prose before CCR while resolver preserves original', async () => {
  const longSummary = [
    'alpha caveman context',
    'You should make sure to utilize the existing helper in order to implement a solution for the assignment.',
    'It is important to keep `/src/exact/path.js`, `exactSymbolName`, and https://example.test/docs unchanged.',
    'Additionally, the reason is because the worker really only needs the shortest useful briefing.',
    'tail marker',
  ].join(' ');
  const graph = {
    tasks: [
      node('note:compact', 'Compact prose note', {
        kind: 'note',
        summary: longSummary + ' '.repeat(10) + 'detail '.repeat(80),
      }),
    ],
  };

  const body = await runSearch(graph, {
    q: 'alpha caveman context',
    k: '1',
    full_content: '1',
    reversible_context: '1',
  });
  const hit = body.results.find((item) => item.key === 'note:compact');

  assert(hit, 'expected compacted note result');
  assert(body.context_compression.prose_compacted_entries >= 1);
  assert(!hit.content.includes('You should make sure to utilize'), 'expected filler prose to be compacted before CCR');
  assert(hit.content.includes('/src/exact/path.js'), 'expected paths to survive compaction');
  assert(hit.content.includes('`exactSymbolName`'), 'expected inline code to survive compaction');
  assert(hit.content.includes('https://example.test/docs'), 'expected URLs to survive compaction');
  assert(compressNaturalLanguage('You should utilize the helper in order to fix it.').includes('use helper to fix it.'));

  const resolved = resolveContextHandle(hit.ccr.handle, graph, {});
  assert.equal(resolved.ok, true);
  assert(resolved.content.includes('You should make sure to utilize'), 'resolver returns original uncompressed prose');
});

test('CCR resolver returns original task fields by key and field', async () => {
  const taskSummary = `task reversible context ${'implementation detail '.repeat(30)}task tail marker`;
  const graph = {
    tasks: [
      node('task/long', 'Long resolver task', {
        summary: taskSummary,
      }),
    ],
  };
  const handle = buildContextRetrievalHandle({ key: 'task/long', kind: 'task' }, 'summary', taskSummary.length, 10);

  const resolved = resolveContextHandle(handle, graph, {});

  assert.equal(resolved.ok, true);
  assert.equal(resolved.key, 'task/long');
  assert.equal(resolved.field, 'summary');
  assert.equal(resolved.kind, 'task');
  assert.equal(resolved.title, 'Long resolver task');
  assert.equal(resolved.content, taskSummary);
});

test('CCR resolver returns original overlay source chunk content by key and field', async () => {
  const chunk = `source reversible context ${'chunk evidence '.repeat(40)}source tail marker`;
  const graph = { tasks: [node('note:source', 'Source note', { kind: 'note' })] };
  const overlay = {
    knowledge: {
      'note:source': [{ value: chunk }],
    },
  };
  const handle = buildContextRetrievalHandle({ key: 'note:source#k0', kind: 'knowledge' }, 'content', chunk.length, 10);

  const resolved = resolveContextHandle(handle, graph, overlay);

  assert.equal(resolved.ok, true);
  assert.equal(resolved.key, 'note:source#k0');
  assert.equal(resolved.field, 'content');
  assert.equal(resolved.kind, 'knowledge');
  assert.equal(resolved.source, 'note:source');
  assert.equal(resolved.content, chunk);
});

(async () => {
  const oldRerank = process.env.ORCH_RERANK;
  process.env.ORCH_RERANK = '0';
  for (const { label, fn } of tests) {
    try {
      await fn();
      console.log(`PASS  ${label}`);
      pass++;
    } catch (err) {
      console.log(`FAIL  ${label}`);
      console.error(err && err.stack ? err.stack : err);
      fail++;
    }
  }
  if (oldRerank == null) delete process.env.ORCH_RERANK;
  else process.env.ORCH_RERANK = oldRerank;
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
