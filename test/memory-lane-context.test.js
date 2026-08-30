#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compileSearchContext } = require('../lib/search/context-compiler');
const graphTools = require('../lib/mcp/tools/graph');

function tokens(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function makeContext(graph, workspace, overlay = {}, gateTask) {
  return {
    buildGraph: () => graph,
    overlayFor: () => ({ knowledge: {}, edges: [], entity_nodes: {}, ...overlay }),
    isTruthy: (value) => value != null && value !== '' && value !== '0' && value !== 'false' && value !== 'no',
    embed: async () => null,
    suggestToks: tokens,
    scoreNodeAgainstTokens: (item, queryTokens) => {
      const itemTokens = tokens(`${item.label || ''} ${item.summary || ''}`);
      const shared = [...queryTokens].filter((token) => itemTokens.has(token));
      return { shared, score: queryTokens.size && itemTokens.size ? shared.length / Math.sqrt(queryTokens.size * itemTokens.size) : 0 };
    },
    knowledgeText: (item) => String((item && (item.value || item.text || item.summary)) || ''),
    noteCurrentAsOf: (item, asOf) => {
      if (!asOf || (item.kind || 'task') !== 'note') return true;
      const at = Date.parse(asOf);
      if (!Number.isFinite(at)) return true;
      if (item.validFrom && Date.parse(item.validFrom) > at) return false;
      return !(item.validTo && Date.parse(item.validTo) <= at);
    },
    gateTask: gateTask || (async () => ({ decision: 'abstain', reason: 'test', via: 'lexical', top1: 0, margin: 0, gap: 0, locality: 0, topType: null })),
    gatedSearchCounts: new Map(),
    checkGatedRateLimit: () => false,
    EMBED_MODEL: 'memory-lane-test',
    workspace,
  };
}

async function search(graph, params = {}, overlay = {}, gateTask) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-memory-lanes-')));
  fs.mkdirSync(path.join(workspace, '.graph'), { recursive: true });
  const url = new URL('http://127.0.0.1/search');
  url.searchParams.set('workspace', workspace);
  url.searchParams.set('q', params.q || 'database');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  try {
    const response = await compileSearchContext(makeContext(graph, workspace, overlay, gateTask), {
      req: { socket: { remoteAddress: '127.0.0.1' } },
      u: url,
    });
    assert.equal(response.status, 200);
    return response.body;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function note(id, label, summary, extra = {}) {
  return {
    id,
    label,
    summary,
    kind: 'note',
    status: 'done',
    deps: [],
    context_deps: [],
    context_weights: {},
    ...extra,
  };
}

(async () => {
  const mixedGraph = {
    tasks: [
      note('note:database-artifact', 'Current database artifact', 'The current database is SQLite.', {
        memory_lane: 'evidence', source_role: 'artifact', authority: 'observation', confidence: 0.98,
      }),
      note('note:database-guidance', 'Database preference', 'Prefer PostgreSQL for future database services.', {
        category: 'preference', memory_lane: 'guidance', source_role: 'user', authority: 'directive', confidence: 1,
      }),
    ],
  };

  const defaultOn = await search(mixedGraph, { q: 'current database', k: 1 });
  const explicitOn = await search(mixedGraph, { q: 'current database', k: 1, memory_lanes: 1 });
  assert.deepEqual(defaultOn, explicitOn, 'memory lanes must be enabled when the flag is omitted');

  const explicitOff = await search(mixedGraph, { q: 'current database', k: 5, memory_lanes: 0 });
  const camelCaseOff = await search(mixedGraph, { q: 'current database', k: 5, memoryLanes: false });
  assert.deepEqual(camelCaseOff, explicitOff, 'both supported flags must preserve the same legacy rollback payload');
  assert.equal(Object.prototype.hasOwnProperty.call(explicitOff, 'evidence_results'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(explicitOff, 'guidance_results'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(explicitOff, 'memory_lanes'), false);
  assert(explicitOff.results.some((result) => result.key === 'note:database-guidance'));

  const partitioned = await search(mixedGraph, { q: 'current database', k: 1, memory_lanes: 1 });
  assert.deepEqual(partitioned.results, partitioned.evidence_results);
  assert.deepEqual(partitioned.results.map((result) => result.key), ['note:database-artifact']);
  assert.deepEqual(partitioned.guidance_results.map((result) => result.key), ['note:database-guidance']);
  assert.equal(partitioned.results[0].use, 'factual_evidence');
  assert.equal(partitioned.results[0].factual, true);
  assert.equal(partitioned.results[0].source_role, 'artifact');
  assert.equal(partitioned.guidance_results[0].use, 'internal_behavioral_guidance');
  assert.equal(partitioned.guidance_results[0].factual, false);
  assert.match(partitioned.memory_lanes.guidance_contract, /never cite or assert as fact/);
  assert.equal(partitioned.memory_lanes.evidence_count, 1);
  assert.equal(partitioned.memory_lanes.guidance_count, 1);

  const legacyLabelGraph = {
    tasks: [
      note('note:legacy-preference', 'Legacy deployment preference', 'Prefer Toronto for deployment.', { category: 'preference' }),
      note('note:legacy-fact', 'Legacy deployment observation', 'The deployment currently runs in Toronto.'),
    ],
  };
  const legacyLabels = await search(legacyLabelGraph, { q: 'deployment Toronto', memory_lanes: 1 });
  assert(legacyLabels.guidance_results.some((result) => result.key === 'note:legacy-preference'));
  assert(legacyLabels.evidence_results.some((result) => result.key === 'note:legacy-fact'));

  const taskContextGraph = {
    tasks: [
      { id: 'task:target', label: 'Target task', summary: '', status: 'ready', deps: [], context_deps: ['note:task-evidence', 'note:task-guidance'], context_weights: {}, provisional: false },
      note('note:task-evidence', 'Task evidence', 'Observed task constraint.', { memory_lane: 'evidence', source_role: 'tool', authority: 'observation' }),
      note('note:task-guidance', 'Task guidance', 'Prefer the smaller task implementation.', { memory_lane: 'guidance', source_role: 'user', authority: 'directive' }),
    ],
  };
  const gated = await search(taskContextGraph, {
    q: 'task implementation', task_key: 'task:target', gated: 1, memory_lanes: 1,
  });
  assert.deepEqual(gated.results.map((result) => result.key), ['note:task-evidence']);
  assert.deepEqual(gated.guidance_results.map((result) => result.key), ['note:task-guidance']);
  assert.equal(gated.results[0].inject, true);
  assert.equal(gated.guidance_results[0].inject, true);
  const guidanceInjected = await search(taskContextGraph, {
    q: 'task implementation', task_key: 'task:target', gated: 1, memory_lanes: 1,
  }, {}, async () => ({
    decision: 'inject', reason: 'standing preference applies', topKey: 'note:task-guidance',
    via: 'lexical', top1: 0.9, margin: 0.8, gap: 0.7, locality: 2, topType: 'directive',
  }));
  assert.equal(guidanceInjected.decision, 'inject');
  assert.equal(guidanceInjected.injected_lane, 'guidance');
  assert.equal(guidanceInjected.guidance_results[0].inject, true);

  const temporalGraph = {
    tasks: [
      note('note:old-guidance', 'Old review preference', 'Use merge commits for review integration.', {
        memory_lane: 'guidance', authority: 'directive', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-04-01T00:00:00.000Z', supersededBy: 'note:new-guidance',
      }),
      note('note:new-guidance', 'Current review preference', 'Use squash commits for review integration.', {
        memory_lane: 'guidance', authority: 'directive', validFrom: '2026-04-01T00:00:00.000Z', supersedes: 'note:old-guidance',
      }),
      note('note:entity-evidence', 'Accounting evidence', 'Zonoid accounting amounts use cents.', {
        memory_lane: 'evidence', source_role: 'artifact', authority: 'observation',
      }),
    ],
  };
  const overlay = {
    entity_nodes: { zonoid: { name: 'Zonoid' } },
    edges: [{ kind: 'context', from: 'entity:zonoid', to: 'note:entity-evidence' }],
  };
  const current = await search(temporalGraph, { q: 'current review preference', memory_lanes: 1 }, overlay);
  assert(current.guidance_results.some((result) => result.key === 'note:new-guidance'));
  assert(!current.guidance_results.some((result) => result.key === 'note:old-guidance'));
  const entity = await search(temporalGraph, { q: 'what does Zonoid accounting use', memory_lanes: 1 }, overlay);
  const entityHit = entity.evidence_results.find((result) => result.key === 'note:entity-evidence');
  assert(entityHit && entityHit.via_entity === true, 'entity-expanded evidence must survive partitioning');

  const queryString = (params) => {
    const out = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value != null) out.set(key, String(value));
    }
    return out.toString();
  };
  const tool = graphTools({ q: queryString, UI_URI: '', PORT: 0, runSubconsciousAssignment: null })
    .find((candidate) => candidate.name === 'search_knowledge');
  assert.equal(tool.inputSchema.properties.memory_lanes.type, 'boolean');
  assert.equal(tool.inputSchema.properties.memory_lanes.default, true);
  let calledUrl = '';
  await tool.run({ query: 'database' }, async (_method, url) => {
    calledUrl = url;
    return {};
  });
  assert.doesNotMatch(calledUrl, /(?:\?|&)memory_lanes=/, 'omission should use the HTTP default-on behavior');
  await tool.run({ query: 'database', memory_lanes: false }, async (_method, url) => {
    calledUrl = url;
    return {};
  });
  assert.match(calledUrl, /(?:\?|&)memory_lanes=0(?:&|$)/, 'MCP false must explicitly request the legacy payload');
  await tool.run({ query: 'database', memory_lanes: true }, async (_method, url) => {
    calledUrl = url;
    return {};
  });
  assert.match(calledUrl, /(?:\?|&)memory_lanes=1(?:&|$)/);

  console.log('PASS memory lane context compiler');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
