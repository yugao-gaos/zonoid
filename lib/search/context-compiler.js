'use strict';

const { buildTaskContextPack } = require('./task-context');
const { memorySearch, createDupInvisible } = require('./memory-search');
const { enqueueSearchTelemetry } = require('./search-telemetry');
const { beliefStatusForNote } = require('../overlay');
const { applyReversibleContextCompression, fullNodeContent } = require('./context-compression');

function isTruthy(ctx, value) {
  if (ctx && typeof ctx.isTruthy === 'function') return ctx.isTruthy(value);
  return value != null && value !== '' && value !== '0' && value !== 'false' && value !== 'no';
}

function isTaskContextTier(tier) {
  return tier === 'dag' || tier === 'dag-note' || tier === 'surrounding';
}

function resultMemoryLane(result, byId) {
  if (!result) return 'evidence';
  if (result.memory_lane === 'guidance' || result.memory_lane === 'evidence') return result.memory_lane;
  const node = byId && byId.get(result.key);
  if (!node || (node.kind || 'task') !== 'note') return 'evidence';
  if (node.memory_lane === 'guidance' || node.memory_lane === 'evidence') return node.memory_lane;
  // Legacy preference/directive notes predate explicit lane provenance. Treating them as
  // guidance is the safe fallback; all other unlabeled nodes retain their historical evidence use.
  if (node.category === 'preference' || node.authority === 'directive') return 'guidance';
  return 'evidence';
}

function partitionMemoryResults(results, graph) {
  const byId = new Map(((graph && graph.tasks) || []).filter((node) => node && node.id).map((node) => [node.id, node]));
  const evidence = [];
  const guidance = [];
  for (const result of results || []) {
    const lane = resultMemoryLane(result, byId);
    const projected = lane === 'guidance'
      ? { ...result, memory_lane: 'guidance', use: 'internal_behavioral_guidance', factual: false }
      : { ...result, memory_lane: 'evidence', use: 'factual_evidence', factual: true };
    if (lane === 'guidance') guidance.push(projected);
    else evidence.push(projected);
  }
  return { evidence, guidance };
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
  result.memory_lane = node.memory_lane || null;
  result.source_role = node.source_role || 'unknown';
  result.authority = node.authority || null;
  result.confidence = typeof node.confidence === 'number' ? node.confidence : null;
  result.episode = node.episode || null;
  result.created_by = node.created_by || null;
  result.belief_status = node.belief_status || beliefStatusForNote(node);
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
    const result = {
      key: node.id,
      title: node.label,
      summary: String(node.summary || '').slice(0, 200),
      score: 1.0,
      kind: 'note',
      tier: 'system',
      inject: true,
      via: 'system',
      path: [],
    };
    addTemporalFields(result, node);
    notes.push(result);
  }
  return notes;
}

function plateauContinue(results, round) {
  return round < 3 && results.some((result) =>
    result.tier === 'rag' && (result.kind || 'note') === 'note' && result.score >= 0.5
  );
}

async function readSearchSnapshot(ctx, workspace) {
  if (ctx && typeof ctx.readGraphSnapshot === 'function') {
    const snapshot = await ctx.readGraphSnapshot(workspace);
    if (snapshot && snapshot.graph) {
      return {
        graph: snapshot.graph,
        overlay: snapshot.overlay || (ctx.overlayFor ? ctx.overlayFor(workspace) : {}),
      };
    }
    return {
      graph: snapshot,
      overlay: ctx.overlayFor ? ctx.overlayFor(workspace) : {},
    };
  }
  return {
    graph: ctx.buildGraph(workspace),
    overlay: ctx.overlayFor(workspace),
  };
}

function nodeFirstTokens(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9]{2,}/g) || [];
}

function nodeFirstQueries(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return [];
  const queries = [raw];
  for (const match of raw.matchAll(/["'`]([^"'`]{2,80})["'`]/g)) {
    const quoted = String(match[1] || '').trim().toLowerCase();
    if (quoted && !queries.includes(quoted)) queries.push(quoted);
  }
  return queries;
}

function nodeFirstPriority(result, query, options = {}) {
  if (!result || String(result.key || '').includes('#')) return 0;
  const haystack = `${result.key || ''} ${result.title || ''}`.toLowerCase().replace(/[_/-]+/g, ' ');
  let priority = 0;
  for (const q of nodeFirstQueries(query)) {
    const tokens = [...new Set(nodeFirstTokens(q))];
    if (!tokens.length) continue;
    const normalizedQuery = q.replace(/[_/-]+/g, ' ');
    if (haystack.includes(normalizedQuery)) priority = Math.max(priority, 3);
    const hits = tokens.filter((token) => haystack.includes(token)).length;
    if (hits === tokens.length) priority = Math.max(priority, 2);
    else if (options.allowPartial && hits > 0) priority = Math.max(priority, hits / tokens.length);
  }
  return priority;
}

function selectMemoryResults(ragResults, k, options = {}) {
  const nodeFirst = !!options.nodeFirst;
  const allowPartialNodeFirst = !!options.allowPartialNodeFirst;
  const query = options.query || '';
  const ranked = nodeFirst
    ? (ragResults || []).map((result, index) => ({
        result,
        index,
        nodePriority: nodeFirstPriority(result, query, { allowPartial: allowPartialNodeFirst }),
      }))
      .sort((a, b) => {
        if (b.nodePriority !== a.nodePriority) return b.nodePriority - a.nodePriority;
        return a.index - b.index;
      })
      .map(({ result, nodePriority }) => {
        if (!(nodePriority > 0)) return result;
        return {
          ...result,
          originalScore: result.score,
          score: Math.max(Number(result.score) || 0, Math.round((1 + nodePriority / 10) * 1000) / 1000),
          nodeFirst: true,
          nodePriority: Math.round(nodePriority * 1000) / 1000,
          via: result.via ? `${result.via}+node-first` : 'node-first',
        };
      })
    : (ragResults || []);
  const direct = [];
  const visibleSeeds = new Set();
  const selected = new Set();
  for (const result of ranked) {
    if (result.tier === 'graph_expanded') continue;
    if (direct.length >= k) continue;
    direct.push(result);
    visibleSeeds.add(result.key);
    selected.add(result.key);
  }

  // ADDITIVE EXPANSION TIERS are emitted BEYOND the top-k direct cut, each gated on its seed having
  // made the visible cut. TWO families feed this pass and both must be matched here: graph structural
  // context (`expanded` / `expanded_from`, tier 'graph_expanded') and code-edge traversal
  // (`code_expanded` / `code_expanded_from`, tier 'code'). Matching only the graph family made every
  // code-structural row fall through this loop, and because those rows carry a deliberately sub-cosine
  // floor score they also sort past the direct cut — so whenever cosine retrieval returned k or more
  // hits (the normal case) expandCodeStructure's output was silently discarded and the code-edge
  // traversal tier was inert end to end.
  const expanded = [];
  for (const result of ranked) {
    if (selected.has(result.key)) continue;
    const graphExpanded = result.tier === 'graph_expanded' || !!result.expanded;
    const codeExpanded = !graphExpanded && !!result.code_expanded;
    if (!graphExpanded && !codeExpanded) continue;
    const seedKey = graphExpanded ? result.expanded_from : result.code_expanded_from;
    if (seedKey && !visibleSeeds.has(seedKey)) continue;
    if (codeExpanded) {
      // Code-structural rows already carry their final tier/via/path and score, so pass them through
      // untouched — expandCodeStructure's ADDITIVE contract (never reorder or rescore a cosine hit)
      // has to hold all the way out to the caller, including for an existing cosine hit that was only
      // annotated as a structural neighbor.
      expanded.push(result);
      continue;
    }
    if (result.tier === 'graph_expanded') {
      expanded.push(result);
      continue;
    }
    expanded.push({
      ...result,
      score: result.expansion_score == null ? result.score : result.expansion_score,
      tier: 'graph_expanded',
      via: result.expansion_via || 'structural-context',
      path: Array.isArray(result.expansion_path) ? result.expansion_path.slice() : (Array.isArray(result.path) ? result.path.slice() : []),
    });
  }

  return [...direct, ...expanded];
}

function recalledContextEdges(taskKey, results) {
  const edges = [];
  for (const result of results || []) {
    const kind = result.kind || 'task';
    if (kind !== 'note' && kind !== 'task') continue;
    let from = null;
    let to = null;
    if (result.tier === 'dag' && result.via === 'context') {
      from = taskKey;
      to = result.key;
    } else if (result.tier === 'dag-note' && result.source) {
      from = result.source;
      to = result.key;
    } else if (result.tier === 'surrounding' && result.edge === 'context' && result.source) {
      from = result.source;
      to = result.key;
    }
    if (!from || !to) continue;
    const edge = {
      from,
      to,
      relation: 'context',
      result_key: result.key,
      result_kind: kind,
      tier: result.tier,
      via: result.via,
      injected: result.inject === true,
      structural: isTaskContextTier(result.tier),
      direct: true,
    };
    if (result.source) edge.source = result.source;
    if (typeof result.weight === 'number' && Number.isFinite(result.weight)) edge.weight = result.weight;
    edges.push(edge);
  }
  return edges;
}

async function compileSearchContext(ctx, { req, u }) {
  const q = u.searchParams.get('q') || '';
  const k = Math.max(1, Math.min(parseInt(u.searchParams.get('k') || '5', 10) || 5, 50));
  const asOf = u.searchParams.get('asOf') || '';
  const knownAsOf = u.searchParams.get('knownAsOf') || '';
  const history = isTruthy(ctx, u.searchParams.get('history'));
  const memoryLanesParam = u.searchParams.has('memory_lanes')
    ? u.searchParams.get('memory_lanes')
    : u.searchParams.get('memoryLanes');
  const memoryLanes = memoryLanesParam != null && isTruthy(ctx, memoryLanesParam);
  const nodeFirstParam = u.searchParams.has('node_first') ? u.searchParams.get('node_first') : u.searchParams.get('nodeFirst');
  const nodeFirst = nodeFirstParam == null ? true : isTruthy(ctx, nodeFirstParam);
  const allowPartialNodeFirst = nodeFirstParam != null && nodeFirst;
  // AGENTIC DELIVERY opt-in (see searchUrlForPlan): when set, attach a bounded fuller `content` field to
  // each result so the subconscious search-context path can deliver enough of the matched chunk to answer
  // from. OFF by default — the one-shot GET /search keeps the lean 200-char display `summary`.
  const fullContent = isTruthy(ctx, u.searchParams.get('full_content'));
  const reversibleContext = isTruthy(ctx, u.searchParams.get('reversible_context'))
    || isTruthy(ctx, u.searchParams.get('compact_context'));
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

  const { graph, overlay } = await readSearchSnapshot(ctx, workspace);
  const dupInvisible = createDupInvisible(overlay);
  const taskContext = taskContextSearch(graph, taskKey, { workspace, reversibleContext });
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

  let results;
  let evidenceResults;
  let guidanceResults = [];
  if (memoryLanes) {
    const contextLanes = partitionMemoryResults([...sysNotes, ...contextResults], graph);
    const memoryLanesPartition = partitionMemoryResults(memory.ragResults, graph);
    const selectOptions = { nodeFirst, allowPartialNodeFirst, query: q };
    const evidenceMemory = selectMemoryResults(memoryLanesPartition.evidence, k, selectOptions);
    const guidanceMemory = selectMemoryResults(memoryLanesPartition.guidance, k, selectOptions);
    evidenceResults = taskContext.dagOnly
      ? contextLanes.evidence
      : [...contextLanes.evidence, ...evidenceMemory];
    guidanceResults = taskContext.dagOnly
      ? contextLanes.guidance
      : [...contextLanes.guidance, ...guidanceMemory];
    // Keep the established `results` consumer surface factual when the feature is explicitly on.
    // Guidance remains available only through its named internal-only channel.
    results = evidenceResults;
  } else {
    const memoryResults = selectMemoryResults(memory.ragResults, k, { nodeFirst, allowPartialNodeFirst, query: q });
    results = taskContext.dagOnly
      ? [...sysNotes, ...contextResults]
      : [...sysNotes, ...contextResults, ...memoryResults];
    evidenceResults = results;
  }
  const allResults = memoryLanes ? [...evidenceResults, ...guidanceResults] : results;

  // AGENTIC DELIVERY enrichment: on the full_content path, attach a bounded fuller `content` to each
  // result from its live node's full text. This is the ONLY clip-bypass — the existing 200-char display
  // `summary` on every result is left untouched, so general /search consumers are unaffected; only the
  // subconscious search-context path (which sets full_content and reads `content` in
  // contextDependencyFromResult) sees the larger budget.
  if (fullContent) {
    const byId = new Map((graph.tasks || []).filter((node) => node && node.id).map((node) => [node.id, node]));
    for (const result of allResults) {
      const node = byId.get(result.key);
      const content = fullNodeContent(node);
      // Only set `content` when it adds beyond the lean summary the result already carries; never shrink.
      if (content && content.length > String(result.summary || '').length) result.content = content;
    }
  }

  let contextCompression = null;
  if (reversibleContext) {
    try {
      contextCompression = applyReversibleContextCompression(allResults);
    } catch (err) {
      contextCompression = {
        enabled: true,
        mode: 'reversible_context',
        fail_open: true,
        error: err && err.message ? err.message : String(err),
      };
    }
  }

  const payload = {
    query: q,
    k,
    asOf: asOf || null,
    knownAsOf: knownAsOf || null,
    history,
    round,
    continue: plateauContinue(allResults, round),
    results,
  };
  if (memoryLanes) {
    payload.evidence_results = evidenceResults;
    payload.guidance_results = guidanceResults;
    payload.memory_lanes = {
      enabled: true,
      version: 1,
      evidence_count: evidenceResults.length,
      guidance_count: guidanceResults.length,
      evidence_contract: 'may_support factual answers when source authority is appropriate',
      guidance_contract: 'internal behavioral guidance only; never cite or assert as fact',
      legacy_fallback: 'unlabeled preference and directive notes are guidance; other unlabeled results are evidence',
    };
  }
  if (contextCompression) payload.context_compression = contextCompression;
  if (taskContext.pack && taskContext.pack.contextCompression) {
    payload.task_context_compression = taskContext.pack.contextCompression;
  }

  const gateTaskInput = {
    label: q,
    tags: (taskContext.taskNode && taskContext.taskNode.tags) ? taskContext.taskNode.tags : [],
  };
  const clientIp = (req && req.socket && req.socket.remoteAddress) || 'unknown';
  const counts = ctx.gatedSearchCounts || new Map();
  const rlEntry = counts.get(clientIp);
  const shadowRateLimited = rlEntry && (Date.now() - rlEntry.windowStart < 60_000) && rlEntry.count > 20;

  const makeTelemetryEvent = (gate) => ({
    workspace,
    query: q,
    taskKey,
    round,
    results: allResults,
    recalledContextEdges: recalledContextEdges(taskKey, allResults),
    embedModel: ctx.EMBED_MODEL,
    gate,
  });

  if (!gated) {
    const gate = (!shadowRateLimited && typeof ctx.gateTask === 'function')
      ? {
        gated: false,
        runGate: true,
        input: gateTaskInput,
        candidates: memory.gateCands,
        gateVia: memory.gateVia,
        kbMeta: memory.kbMeta,
        taskMeta: memory.taskMeta,
      }
      : null;
    enqueueSearchTelemetry(ctx, makeTelemetryEvent(gate));
    return { status: 200, body: payload };
  }

  for (const result of allResults) {
    if (isTaskContextTier(result.tier)) result.inject = true;
  }

  const checkRate = typeof ctx.checkGatedRateLimit === 'function' ? ctx.checkGatedRateLimit : () => false;
  if (checkRate(clientIp)) {
    enqueueSearchTelemetry(ctx, makeTelemetryEvent(null));
    return { status: 200, body: { ...payload, gated: true, decision: 'abstain', reason: 'rate-limited' } };
  }

  const verdict = await ctx.gateTask(gateTaskInput, memory.gateCands, { preScored: true, via: memory.gateVia });
  const gateTelemetry = {
    gated: true,
    verdict,
    input: gateTaskInput,
    candidates: memory.gateCands,
    gateVia: memory.gateVia,
    kbMeta: memory.kbMeta,
    taskMeta: memory.taskMeta,
  };

  let gateDecision = verdict.decision;
  let gateReason = verdict.reason;
  const meta = {
    gated: true,
    decision: gateDecision,
    reason: gateReason,
    top1: verdict.top1,
    margin: verdict.margin,
    gap: verdict.gap,
    locality: verdict.locality,
    topType: verdict.topType,
    topKey: verdict.topKey || null,
    via: verdict.via,
  };

  if (verdict.decision === 'inject') {
    const hit = verdict.topKey ? allResults.find((result) => result.key === verdict.topKey) : null;
    if (hit) {
      hit.inject = true;
      if (memoryLanes) meta.injected_lane = hit.memory_lane;
    } else {
      gateDecision = 'abstain';
      gateReason = verdict.topKey
        ? `topKey pruned from selected results: ${verdict.reason || ''}`.trim()
        : `inject verdict missing topKey: ${verdict.reason || ''}`.trim();
      meta.decision = gateDecision;
      meta.reason = gateReason;
    }
  }

  enqueueSearchTelemetry(ctx, makeTelemetryEvent(gateTelemetry));
  return { status: 200, body: { ...payload, ...meta } };
}

module.exports = {
  compileSearchContext,
  applyReversibleContextCompression,
  isTaskContextTier,
  taskContextSearch,
  readSearchSnapshot,
  selectMemoryResults,
  recalledContextEdges,
  resultMemoryLane,
  partitionMemoryResults,
};
