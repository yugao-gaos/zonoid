'use strict';

const fs = require('fs');
const path = require('path');
const recallJournal = require('../recall-outcome-journal');
const { buildTaskContextPack } = require('./task-context');
const { memorySearch, createDupInvisible } = require('./memory-search');

function isTruthy(ctx, value) {
  if (ctx && typeof ctx.isTruthy === 'function') return ctx.isTruthy(value);
  return value != null && value !== '' && value !== '0' && value !== 'false' && value !== 'no';
}

function isTaskContextTier(tier) {
  return tier === 'dag' || tier === 'dag-note' || tier === 'surrounding';
}

function resolveSupersedeHead(node, byId) {
  if (!node || (node.kind || 'task') !== 'note') return node;
  let cur = node;
  const seen = new Set([cur.id]);
  while (cur.supersededBy) {
    const next = byId.get(cur.supersededBy);
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    cur = next;
  }
  return cur;
}

function addTemporalFields(result, node) {
  if ((node.kind || 'task') !== 'note') return;
  if (!(node.validFrom || node.validTo || node.supersededBy || node.supersedes)) return;
  result.validFrom = node.validFrom || null;
  result.validTo = node.validTo || null;
  result.supersededBy = node.supersededBy || null;
  result.supersedes = node.supersedes || null;
  result.current = !node.validTo;
}

function entryScore(entry) {
  if (entry.tier === 'surrounding') {
    const n = Number(entry.weight == null ? 0.5 : entry.weight);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
  }
  return 1.0;
}

function taskContextSearch(graph, taskKey, options = {}) {
  const tasks = Array.isArray(graph && graph.tasks) ? graph.tasks : [];
  const byId = new Map(tasks.filter((node) => node && node.id).map((node) => [node.id, node]));
  const taskNode = taskKey ? byId.get(taskKey) : null;
  if (!taskKey || !taskNode) {
    return {
      taskNode: taskNode || null,
      dagOnly: false,
      pack: null,
      results: [],
      contextKeys: new Set(),
    };
  }

  const pack = buildTaskContextPack(graph, taskKey, options);
  const results = [];
  const seen = new Set();
  for (const entry of pack.results || []) {
    const rawNode = byId.get(entry.key);
    const node = resolveSupersedeHead(rawNode, byId) || rawNode;
    const key = node && node.id ? node.id : entry.key;
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const result = {
      key,
      title: (node && node.label) || entry.title || entry.label || key,
      summary: String((node && node.summary) || entry.summary || '').slice(0, 200),
      score: entryScore(entry),
      kind: (node && (node.kind || 'task')) || entry.kind || 'task',
      tier: entry.tier || 'dag',
      via: entry.via || 'dag',
      path: Array.isArray(entry.path) ? entry.path.slice() : [],
      pinned: entry.pinned !== false,
    };
    if (entry.weight != null) result.weight = entry.weight;
    if (entry.source) result.source = entry.source;
    if (entry.edge) result.edge = entry.edge;
    if (entry.status) result.status = entry.status;
    if (entry.structuralRank != null) result.structuralRank = entry.structuralRank;
    if (node && node.id !== entry.key) {
      result.supersededFrom = entry.key;
      result.path = result.path.length
        ? result.path.map((part, index) => index === 0 ? `${part} (via supersede)` : part)
        : [`supersede:${entry.key} (via supersede)`];
    }
    if (node) addTemporalFields(result, node);
    results.push(result);
  }

  return {
    taskNode,
    dagOnly: !taskNode.provisional,
    pack,
    results,
    contextKeys: new Set(results.map((result) => result.key)),
  };
}

function systemNotes(graph, dupInvisible) {
  const notes = [];
  for (const node of graph.tasks || []) {
    if ((node.kind || 'task') !== 'note') continue;
    if (node.validTo) continue;
    if (node.category !== 'system') continue;
    if (dupInvisible(node)) continue;
    notes.push({
      key: node.id,
      title: node.label,
      summary: String(node.summary || '').slice(0, 200),
      score: 1.0,
      kind: 'note',
      tier: 'system',
      inject: true,
      via: 'system',
      path: [],
    });
  }
  return notes;
}

function plateauContinue(results, round) {
  return round < 3 && results.some((result) =>
    result.tier === 'rag' && (result.kind || 'note') === 'note' && result.score >= 0.5
  );
}

function appendGateJournal(workspace, row) {
  fs.appendFileSync(path.join(workspace, '.graph', 'gate-journal.jsonl'), JSON.stringify(row) + '\n');
}

function journalGateVerdict({ workspace, query, taskKey, verdict, gateVia, embedModel, gated, round, kbMeta, taskMeta }) {
  appendGateJournal(workspace, {
    ts: new Date().toISOString(),
    workspace,
    query,
    task_key: taskKey || null,
    decision: verdict.decision,
    reason: verdict.reason,
    top1: verdict.top1,
    margin: verdict.margin,
    gap: verdict.gap,
    locality: verdict.locality,
    tagOverlap: verdict.tagOverlap,
    sharedTags: verdict.sharedTags,
    topType: verdict.topType,
    topKey: verdict.topKey || null,
    via: verdict.via || gateVia,
    embedModel,
    gated,
    round,
    ...kbMeta,
    ...taskMeta,
  });
}

function journalRecall(workspace, taskKey, results) {
  if (!taskKey) return;
  try {
    const noteKeys = results
      .filter((result) => (result.kind || 'task') === 'note' || (result.kind || 'task') === 'knowledge')
      .map((result) => result.key);
    const via = results.some((result) => isTaskContextTier(result.tier)) ? 'dag' : 'rag';
    recallJournal.appendRow(workspace, { task_key: taskKey, recalled_note_keys: noteKeys, outcome: 'pending', via });
  } catch {
    // Recall attribution must not break the search response.
  }
}

async function compileSearchContext(ctx, { req, u }) {
  const q = u.searchParams.get('q') || '';
  const k = Math.max(1, Math.min(parseInt(u.searchParams.get('k') || '5', 10) || 5, 50));
  const asOf = u.searchParams.get('asOf') || '';
  const knownAsOf = u.searchParams.get('knownAsOf') || '';
  const history = isTruthy(ctx, u.searchParams.get('history'));
  const workspace = u.searchParams.get('workspace');
  if (!workspace) return { status: 400, body: { ok: false, error: 'workspace required' } };

  const taskKey = u.searchParams.get('task_key') || '';
  const round = Math.max(1, parseInt(u.searchParams.get('round') || '1', 10) || 1);
  const excludeKeys = new Set((u.searchParams.get('exclude_keys') || '').split(',').map((s) => s.trim()).filter(Boolean));
  const gated = isTruthy(ctx, u.searchParams.get('gated'));
  if (gated && !taskKey) {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'gated:true requires task_key — pass the task you are working on',
        code: 'missing_task_key',
      },
    };
  }

  const graph = ctx.buildGraph(workspace);
  const overlay = ctx.overlayFor(workspace);
  const dupInvisible = createDupInvisible(overlay);
  const taskContext = taskContextSearch(graph, taskKey, { workspace });
  const contextResults = taskContext.results;
  const contextKeys = taskContext.contextKeys;
  const sysNotes = systemNotes(graph, dupInvisible);
  const sysKeys = new Set(sysNotes.map((note) => note.key));
  const pathAnchors = new Set([...contextKeys]);
  if (taskKey) pathAnchors.add(taskKey);

  const memory = await memorySearch(ctx, {
    graph,
    overlay,
    workspace,
    q,
    asOf,
    knownAsOf,
    history,
    excludeKeys,
    taskKey,
    contextKeys,
    systemKeys: sysKeys,
    pathAnchors,
    taskNode: taskContext.taskNode,
    rerankParam: u.searchParams.get('rerank'),
    complexity: u.searchParams.get('complexity') || '',
    dupInvisible,
  });

  const results = taskContext.dagOnly
    ? [...sysNotes, ...contextResults]
    : [...sysNotes, ...contextResults, ...memory.ragResults].slice(0, k + contextResults.length + sysNotes.length);

  const payload = {
    query: q,
    k,
    asOf: asOf || null,
    knownAsOf: knownAsOf || null,
    history,
    round,
    continue: plateauContinue(results, round),
    results,
  };

  journalRecall(workspace, taskKey, results);

  const gateTaskInput = {
    label: q,
    tags: (taskContext.taskNode && taskContext.taskNode.tags) ? taskContext.taskNode.tags : [],
  };
  const clientIp = (req && req.socket && req.socket.remoteAddress) || 'unknown';
  const counts = ctx.gatedSearchCounts || new Map();
  const rlEntry = counts.get(clientIp);
  const shadowRateLimited = rlEntry && (Date.now() - rlEntry.windowStart < 60_000) && rlEntry.count > 20;

  if (!gated) {
    if (!shadowRateLimited && typeof ctx.gateTask === 'function') {
      try {
        const verdict = await ctx.gateTask(gateTaskInput, memory.gateCands, { preScored: true, via: memory.gateVia });
        try {
          journalGateVerdict({
            workspace,
            query: q,
            taskKey,
            verdict,
            gateVia: memory.gateVia,
            embedModel: ctx.EMBED_MODEL,
            gated: false,
            round,
            kbMeta: memory.kbMeta,
            taskMeta: memory.taskMeta,
          });
        } catch {
          // Journal failure must not break the search response.
        }
      } catch {
        // Shadow gate failure must not break the search response.
      }
    }
    return { status: 200, body: payload };
  }

  for (const result of results) {
    if (isTaskContextTier(result.tier)) result.inject = true;
  }

  const checkRate = typeof ctx.checkGatedRateLimit === 'function' ? ctx.checkGatedRateLimit : () => false;
  if (checkRate(clientIp)) {
    return { status: 200, body: { ...payload, gated: true, decision: 'abstain', reason: 'rate-limited' } };
  }

  const verdict = await ctx.gateTask(gateTaskInput, memory.gateCands, { preScored: true, via: memory.gateVia });
  try {
    journalGateVerdict({
      workspace,
      query: q,
      taskKey,
      verdict,
      gateVia: memory.gateVia,
      embedModel: ctx.EMBED_MODEL,
      gated: true,
      round,
      kbMeta: memory.kbMeta,
      taskMeta: memory.taskMeta,
    });
  } catch {
    // Journal failure must not break the search response.
  }

  const meta = {
    gated: true,
    decision: verdict.decision,
    reason: verdict.reason,
    top1: verdict.top1,
    margin: verdict.margin,
    gap: verdict.gap,
    locality: verdict.locality,
    topType: verdict.topType,
    via: verdict.via,
  };

  if (verdict.decision === 'inject' && verdict.topKey) {
    let hit = results.find((result) => result.key === verdict.topKey);
    if (!hit) {
      hit = memory.ragResults.find((result) => result.key === verdict.topKey);
      if (hit) results.push(hit);
    }
    if (hit) hit.inject = true;
  }

  return { status: 200, body: { ...payload, ...meta } };
}

module.exports = {
  compileSearchContext,
  isTaskContextTier,
  taskContextSearch,
};
