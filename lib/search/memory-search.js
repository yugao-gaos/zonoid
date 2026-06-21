'use strict';

const judge = require('../judge');
const { contentTokens, classifyNoteType, noteText } = require('../context-gate');
const { maxCosine, nodeVecs } = require('../embed');
const { rerank } = require('../rerank');
const recallJournal = require('../recall-outcome-journal');
const { activateGraph } = require('./activation');
const retrievalWeights = require('./retrieval-weights');

const STOP = new Set(['a','an','the','is','in','on','at','of','to','and','or','for','with',
  'by','as','be','it','that','this','was','are','were','has','have','had',
  'not','but','from','into','if','up','out','about','after','before']);

function roundScore(value) {
  return Math.round(value * 1000) / 1000;
}

function tokenize(s) {
  return String(s || '').toLowerCase().split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));
}

function contextWeight(node, dep, fallback = 0.5) {
  const weights = node && node.context_weights;
  const raw = weights && weights[dep];
  const n = Number(raw == null ? fallback : raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function createDupInvisible(overlay) {
  const timeout = judge.judgingTimeoutMs(overlay);
  const now = Date.now();
  return (node) => {
    if ((node.kind || 'task') !== 'note' || !node.pending_dup) return false;
    return !judge.pendingDupState(overlay, node.id, now, timeout).visible;
  };
}

function buildSearchAdjacency(nodes, options = {}) {
  const retrievalWeightMap = options.retrievalWeightMap instanceof Map
    ? options.retrievalWeightMap
    : retrievalWeights.latestWeightMap(options.workspace);
  const learnedWeight = (from, to, relation) => retrievalWeights.weightFromMap(retrievalWeightMap, from, to, relation);
  const adjacency = new Map();
  const add = (from, edge) => {
    if (!from || !edge || !edge.to) return;
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push(edge);
  };

  for (const node of nodes || []) {
    if (!node || !node.id) continue;
    if (!adjacency.has(node.id)) adjacency.set(node.id, []);
    for (const dep of (node.context_deps || [])) {
      if (!dep || String(dep).startsWith('ghost:')) continue;
      const weight = contextWeight(node, dep);
      if (weight <= 0) continue;
      const retrievalWeight = learnedWeight(node.id, dep, 'context');
      const edge = { relation: 'context', weight, retrievalWeight, judged: true };
      add(node.id, { ...edge, to: dep, source: node.id });
      add(dep, { ...edge, to: node.id, source: dep });
    }
    for (const dep of (node.deps || [])) {
      if (!dep || String(dep).startsWith('ghost:')) continue;
      const retrievalWeight = learnedWeight(node.id, dep, 'blocking');
      const edge = { relation: 'blocking', weight: 1, retrievalWeight, judged: true };
      add(node.id, { ...edge, to: dep, source: node.id });
      add(dep, { ...edge, to: node.id, source: dep });
    }
  }
  return adjacency;
}

function buildPathFinder(nodes) {
  const adjMap = new Map();
  const ensureAdj = (k) => { if (!adjMap.has(k)) adjMap.set(k, []); };
  for (const node of nodes || []) {
    if (!node || !node.id) continue;
    ensureAdj(node.id);
    for (const dep of (node.deps || [])) {
      ensureAdj(dep);
      adjMap.get(node.id).push({ neighborKey: dep, edgeType: 'dep' });
      adjMap.get(dep).push({ neighborKey: node.id, edgeType: 'dep' });
    }
    for (const dep of (node.context_deps || [])) {
      ensureAdj(dep);
      adjMap.get(node.id).push({ neighborKey: dep, edgeType: 'context_dep' });
      adjMap.get(dep).push({ neighborKey: node.id, edgeType: 'context_dep' });
    }
  }

  return (startKey, targetSet) => {
    if (targetSet.has(startKey)) return [];
    const visited = new Set([startKey]);
    const queue = [{ key: startKey, path: [] }];
    let visits = 0;
    while (queue.length > 0 && visits < 50) {
      const { key: cur, path } = queue.shift();
      if (path.length >= 2) continue;
      visits++;
      for (const { neighborKey, edgeType } of (adjMap.get(cur) || [])) {
        if (visited.has(neighborKey)) continue;
        visited.add(neighborKey);
        const newPath = [...path, `${edgeType}:${neighborKey}`];
        if (targetSet.has(neighborKey)) return newPath;
        queue.push({ key: neighborKey, path: newPath });
      }
    }
    return null;
  };
}

function prepareRRF({ candidates, q, qvec, expectedMeta }) {
  const qToks = tokenize(q);
  const corpus = [];
  const idxMap = new Map();
  let avgdl = 1;
  let idf = new Map();

  if (qToks.length) {
    let totalLen = 0;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const docText = String(c.label || c.title || '') + ' ' + String(c.summary || '').slice(0, 200);
      const toks = tokenize(docText);
      corpus.push({ toks });
      idxMap.set(c._bm25Key, i);
      totalLen += toks.length;
    }
    avgdl = candidates.length ? totalLen / candidates.length : 1;
    idf = new Map();
    for (const qt of qToks) {
      if (idf.has(qt)) continue;
      let df = 0;
      for (const { toks } of corpus) if (toks.includes(qt)) df++;
      idf.set(qt, Math.log(1 + (candidates.length - df + 0.5) / (df + 0.5)));
    }
  }

  const bm25Score = (key) => {
    const idx = idxMap.get(key);
    if (idx === undefined || !idf) return 0;
    const { toks } = corpus[idx] || { toks: [] };
    const dl = toks.length;
    const k1 = 1.2;
    const b = 0.75;
    let score = 0;
    for (const qt of qToks) {
      const tf = toks.filter((t) => t === qt).length;
      if (!tf) continue;
      const idfVal = idf.get(qt) || 0;
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl));
      score += idfVal * tfNorm;
    }
    return score;
  };

  const cosineRank = new Map();
  const bm25Rank = new Map();
  const withCosine = candidates.map((c) => ({
    key: c._bm25Key,
    cos: (qvec && nodeVecs(c, { expectedMeta }).length > 0) ? maxCosine(qvec, c, { expectedMeta }) : 0,
  }));
  withCosine.sort((a, b) => b.cos - a.cos);
  for (let i = 0; i < withCosine.length; i++) cosineRank.set(withCosine[i].key, i + 1);

  const withBm25 = candidates.map((c) => ({ key: c._bm25Key, bm25: bm25Score(c._bm25Key) }));
  withBm25.sort((a, b) => b.bm25 - a.bm25);
  for (let i = 0; i < withBm25.length; i++) bm25Rank.set(withBm25[i].key, i + 1);

  const rrfK = 60;
  return (key) => {
    const rankC = cosineRank.get(key) ?? (cosineRank.size + 1);
    const rankB = bm25Rank.get(key) ?? (bm25Rank.size + 1);
    const via = (rankC <= rankB) ? (qvec ? 'rrf-semantic' : 'rrf-bm25') : 'rrf-bm25';
    return { score: 1 / (rrfK + rankC) + 1 / (rrfK + rankB), via };
  };
}

function temporalFilter({ noteCurrentAsOf, asOf, history, knownAsOf }) {
  const knownT = knownAsOf ? Date.parse(knownAsOf) : NaN;
  return (node) => {
    let ok;
    if (asOf) ok = noteCurrentAsOf(node, asOf);
    else if (history) ok = true;
    else if ((node.kind || 'task') !== 'note') ok = true;
    else ok = !node.validTo;
    if (!ok) return false;
    if (knownAsOf && (node.kind || 'task') === 'note' && !Number.isNaN(knownT)) {
      const c = Date.parse(node.created_at);
      if (!Number.isNaN(c) && c > knownT) return false;
    }
    return true;
  };
}

function expandEntities({ overlay, q, qvec, expectedMeta }) {
  const expanded = new Set();
  const entityNodes = overlay.entity_nodes || {};
  const entityIds = Object.keys(entityNodes);
  if (!entityIds.length) return expanded;

  const qLower = q.toLowerCase();
  const matched = new Set();
  for (const eid of entityIds) {
    const ent = entityNodes[eid];
    if (!ent || ent.validTo) continue;
    const entName = String(ent.name || '').toLowerCase();
    if (entName && qLower.includes(entName)) {
      matched.add('entity:' + eid);
      continue;
    }
    if (Array.isArray(ent.aliases)) {
      for (const alias of ent.aliases) {
        if (alias && qLower.includes(String(alias).toLowerCase())) {
          matched.add('entity:' + eid);
          break;
        }
      }
    }
    if (qvec && Array.isArray(ent.vec) && ent.vec.length > 0 && maxCosine(qvec, ent, { expectedMeta }) > 0.5) {
      matched.add('entity:' + eid);
    }
  }
  if (!matched.size) return expanded;

  const edgeList = overlay.edges || [];
  const hop1 = new Set();
  for (const e of edgeList) {
    if (e.kind !== 'context') continue;
    if (matched.has(e.from) && e.to && e.to.startsWith('note:')) hop1.add(e.to);
    if (matched.has(e.to) && e.from && e.from.startsWith('note:')) hop1.add(e.from);
  }
  const hop2 = new Set();
  for (const e of edgeList) {
    if (e.kind !== 'context') continue;
    if (hop1.has(e.from) && e.to && e.to.startsWith('note:')) hop2.add(e.to);
    if (hop1.has(e.to) && e.from && e.from.startsWith('note:')) hop2.add(e.from);
  }
  for (const key of hop1) expanded.add(key);
  for (const key of hop2) expanded.add(key);
  return expanded;
}

function addTemporalFields(result, node) {
  if ((node.kind || 'task') === 'note' && (node.validFrom || node.validTo || node.supersededBy || node.supersedes)) {
    result.validFrom = node.validFrom || null;
    result.validTo = node.validTo || null;
    result.supersededBy = node.supersededBy || null;
    result.supersedes = node.supersedes || null;
    result.current = !node.validTo;
  }
}

const STRUCTURAL_KINDS = new Set(['source_doc', 'source_section', 'source_chunk', 'knowledge_cluster']);
const STRUCTURAL_EXPANSION = {
  seedLimit: 3,
  directSourceLimit: 4,
  sourceDepth: 2,
  sourceFanout: 3,
  siblingLimit: 4,
  totalLimit: 12,
};

function isStructuralNode(node) {
  return !!(node && STRUCTURAL_KINDS.has(String(node.kind || '').toLowerCase()));
}

function appendExpandedResult({ ragResults, seen, node, seed, viaSource, relation, temporalOk, dupInvisible }) {
  if (!node || !node.id) return false;
  if (dupInvisible && dupInvisible(node)) return false;
  if (temporalOk && !temporalOk(node)) return false;
  const expansionPath = [`expanded_from:${seed.id}`, `context:${viaSource}`];
  const existing = ragResults.find((result) => result.key === node.id);
  if (existing) {
    if (existing.expanded) return false;
    existing.expanded = true;
    existing.expanded_from = seed.id;
    existing.expansion_relation = relation;
    existing.expansion_source = viaSource;
    existing.expansion_via = 'structural-context';
    existing.expansion_score = 0.001;
    existing.expansion_path = expansionPath;
    seen.add(node.id);
    return true;
  }
  if (seen.has(node.id)) return false;
  const result = {
    key: node.id,
    title: node.label,
    summary: String(node.summary || '').slice(0, 200),
    score: 0.001,
    kind: node.kind || 'task',
    tier: 'graph_expanded',
    via: 'structural-context',
    path: expansionPath,
    expanded: true,
    expanded_from: seed.id,
    expansion_relation: relation,
    expansion_source: viaSource,
  };
  addTemporalFields(result, node);
  ragResults.push(result);
  seen.add(node.id);
  return true;
}

function expandStructuralContext({ graph, ragResults, temporalOk, dupInvisible, excludedKeys }) {
  if (!graph || !Array.isArray(graph.tasks) || !Array.isArray(ragResults) || !ragResults.length) return [];
  const byId = new Map(graph.tasks.filter((node) => node && node.id).map((node) => [node.id, node]));
  const seen = new Set([...(excludedKeys || []), ...ragResults.map((result) => result.key)]);
  const noteSeeds = ragResults
    .filter((result) => (result.kind || 'task') === 'note' && !result.expanded && byId.has(result.key))
    .slice(0, STRUCTURAL_EXPANSION.seedLimit)
    .map((result) => byId.get(result.key));
  if (!noteSeeds.length) return [];

  const notesBySource = new Map();
  for (const node of graph.tasks) {
    if (!node || (node.kind || 'task') !== 'note') continue;
    if (dupInvisible && dupInvisible(node)) continue;
    if (temporalOk && !temporalOk(node)) continue;
    for (const dep of (node.context_deps || [])) {
      const source = byId.get(dep);
      if (!isStructuralNode(source)) continue;
      if (!notesBySource.has(dep)) notesBySource.set(dep, []);
      notesBySource.get(dep).push(node);
    }
  }

  const added = [];
  const add = (node, seed, viaSource, relation) => {
    if (added.length >= STRUCTURAL_EXPANSION.totalLimit) return false;
    const ok = appendExpandedResult({ ragResults, seen, node, seed, viaSource, relation, temporalOk, dupInvisible });
    if (ok) added.push(node.id);
    return ok;
  };

  for (const seed of noteSeeds) {
    if (added.length >= STRUCTURAL_EXPANSION.totalLimit) break;
    const directSources = (seed.context_deps || [])
      .map((dep) => byId.get(dep))
      .filter(isStructuralNode)
      .slice(0, STRUCTURAL_EXPANSION.directSourceLimit);
    if (!directSources.length) continue;

    const sourceQueue = directSources.map((node) => ({ node, depth: 0, via: node.id }));
    const sourceSeen = new Set(sourceQueue.map((row) => row.node.id));
    let sourceVisits = 0;
    while (sourceQueue.length && added.length < STRUCTURAL_EXPANSION.totalLimit) {
      const { node: source, depth, via } = sourceQueue.shift();
      sourceVisits++;
      if (sourceVisits > STRUCTURAL_EXPANSION.directSourceLimit + STRUCTURAL_EXPANSION.sourceFanout * STRUCTURAL_EXPANSION.sourceDepth) break;

      add(source, seed, via, depth === 0 ? 'evidence_source' : 'source_parent');

      if (depth < STRUCTURAL_EXPANSION.sourceDepth) {
        const parents = (source.context_deps || [])
          .map((dep) => byId.get(dep))
          .filter(isStructuralNode)
          .slice(0, STRUCTURAL_EXPANSION.sourceFanout);
        for (const parent of parents) {
          if (sourceSeen.has(parent.id)) continue;
          sourceSeen.add(parent.id);
          sourceQueue.push({ node: parent, depth: depth + 1, via });
        }
      }
    }

    let siblings = 0;
    for (const source of directSources) {
      if (added.length >= STRUCTURAL_EXPANSION.totalLimit || siblings >= STRUCTURAL_EXPANSION.siblingLimit) break;
      for (const sibling of (notesBySource.get(source.id) || [])) {
        if (sibling.id === seed.id) continue;
        if (add(sibling, seed, source.id, 'sibling_fact')) siblings++;
        if (added.length >= STRUCTURAL_EXPANSION.totalLimit || siblings >= STRUCTURAL_EXPANSION.siblingLimit) break;
      }
    }
  }

  return added;
}

function applyActivation({ graph, ragResults, excludedKeys, temporalOk, dupInvisible, pathAnchors, retrievalWeightMap }) {
  if (!ragResults.length) return;
  const topScore = Math.max(...ragResults.map((r) => r.score), 0);
  if (!(topScore > 0)) return;

  const seeds = ragResults.slice(0, 20).map((r) => ({
    key: r.key,
    activation: Math.min(1, r.score / topScore),
    source: r.via,
  }));
  const activated = activateGraph({
    seeds,
    includeSeeds: false,
    maxDepth: 2,
    decay: 0.75,
    relationWeights: { context: 1, blocking: 0.25 },
    adjacency: buildSearchAdjacency(graph.tasks, { retrievalWeightMap }),
  });
  if (!activated.length) return;

  const byId = new Map((graph.tasks || []).filter((n) => n && n.id).map((n) => [n.id, n]));
  const byResult = new Map(ragResults.map((r) => [r.key, r]));
  for (const row of activated) {
    if (excludedKeys.has(row.key)) continue;
    const node = byId.get(row.key);
    if (!node || dupInvisible(node) || !temporalOk(node)) continue;
    const boost = roundScore(row.activation * 0.05);
    if (!(boost > 0)) continue;
    const existing = byResult.get(row.key);
    if (existing) {
      existing.graphActivation = roundScore(Math.max(existing.graphActivation || 0, row.activation));
      existing.score = roundScore(existing.score + boost);
      if (!existing.path || !existing.path.length) existing.path = row.path ? [`activation:${row.path.join('>')}`] : [];
      continue;
    }
    const foundPath = pathAnchors && pathAnchors.size ? [] : [];
    const result = {
      key: node.id,
      title: node.label,
      summary: String(node.summary || '').slice(0, 200),
      score: boost,
      kind: node.kind || 'task',
      tier: 'rag',
      via: 'activation',
      path: row.path ? [`activation:${row.path.join('>')}`] : foundPath,
      graphActivation: roundScore(row.activation),
    };
    addTemporalFields(result, node);
    ragResults.push(result);
    byResult.set(row.key, result);
  }
  ragResults.sort((a, b) => b.score - a.score);
}

async function memorySearch(ctx, options) {
  const {
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
    systemKeys,
    pathAnchors,
    taskNode,
    rerankParam,
  } = options;
  const { embed, suggestToks, scoreNodeAgainstTokens, knowledgeText, noteCurrentAsOf } = ctx;
  const expectedMeta = ctx.embeddingMeta ? ctx.embeddingMeta(overlay) : null;
  const dupInvisible = options.dupInvisible || createDupInvisible(overlay);
  const qt = suggestToks(q);
  const qvec = await embed(q, { mode: 'query', overlay });
  const temporalOk = temporalFilter({ noteCurrentAsOf, asOf, history, knownAsOf });
  const excluded = new Set([...(excludeKeys || []), ...(contextKeys || []), ...(systemKeys || [])]);
  const retrievalWeightMap = options.retrievalWeightMap instanceof Map
    ? options.retrievalWeightMap
    : retrievalWeights.latestWeightMap(workspace);
  const findPath = buildPathFinder(graph.tasks);

  const gateCands = [];
  let gateVia = 'lexical';
  for (const n of graph.tasks || []) {
    if ((n.kind || 'task') !== 'note' || n.validTo || excluded.has(n.id)) continue;
    if (dupInvisible(n)) continue;
    let rawScore = 0;
    if (qvec && nodeVecs(n, { expectedMeta }).length > 0) {
      rawScore = maxCosine(qvec, n, { expectedMeta });
      gateVia = 'semantic';
    }
    gateCands.push({ key: n.id, title: n.label, summary: n.summary, score: rawScore, category: n.category || null, tags: n.tags || [] });
  }

  const kbTop1 = gateCands.length ? Math.max(...gateCands.map((c) => c.score)) : 0;
  const kbMeta = {
    kbCands: gateCands.length,
    cluster: gateCands.filter((c) => c.score >= kbTop1 - 0.05).length,
    near45: gateCands.filter((c) => c.score >= 0.45).length,
    qTokens: contentTokens(q).length,
    empTop10: (() => {
      if (!gateCands.length) return 0;
      const top10 = [...gateCands].sort((a, b) => b.score - a.score).slice(0, 10);
      const empCount = top10.filter((c) => classifyNoteType(noteText(c)) === 'empirical').length;
      return Math.round((empCount / top10.length) * 1000) / 1000;
    })(),
  };
  const passedComplexity = parseFloat(options.complexity || '');
  const qWords = q.split(/\s+/).filter(Boolean).length;
  const taskLabel = taskNode ? (taskNode.label || '') : '';
  const taskMeta = {
    qWords,
    taskWords: taskLabel.split(/\s+/).filter(Boolean).length,
    hasSpec: /\b(implement|add|build|fix|refactor|create|write|migrate|update|extend)\b/i.test(taskLabel || q),
    complexity: Number.isFinite(passedComplexity) ? passedComplexity
      : Math.min(1.0, (qWords < 15 ? 0.2 : qWords <= 40 ? 0.5 : 0.8)
        + (/\b(audit|migrate|refactor|all\s+files|entire|sweep)\b/i.test(q) ? 0.2 : 0)),
  };

  const entityExpandedKeys = expandEntities({ overlay, q, qvec, expectedMeta });
  const rrfCandidates = [];
  const rrfNodeMap = new Map();
  for (const node of graph.tasks || []) {
    if (excluded.has(node.id)) continue;
    if (dupInvisible(node)) continue;
    if (!temporalOk(node)) continue;
    node._bm25Key = node.id;
    rrfCandidates.push(node);
    rrfNodeMap.set(node.id, node);
  }
  for (const expandedKey of entityExpandedKeys) {
    if (rrfNodeMap.has(expandedKey) || excluded.has(expandedKey)) continue;
    const node = (graph.tasks || []).find((n) => n.id === expandedKey);
    if (!node || dupInvisible(node) || !temporalOk(node)) continue;
    node._bm25Key = expandedKey;
    rrfCandidates.push(node);
    rrfNodeMap.set(expandedKey, node);
  }

  const scoreRRF = prepareRRF({ candidates: rrfCandidates, q, qvec, expectedMeta });
  const ragResults = [];
  for (const node of rrfCandidates) {
    const bk = node._bm25Key;
    delete node._bm25Key;
    const isEntityExpanded = entityExpandedKeys.has(node.id);
    const { score, via } = scoreRRF(bk);
    if (!isEntityExpanded && !(score > 0)) continue;
    const foundPath = findPath(node.id, pathAnchors || new Set());
    const result = {
      key: node.id,
      title: node.label,
      summary: String(node.summary || '').slice(0, 200),
      score: roundScore(score),
      kind: node.kind || 'task',
      tier: 'rag',
      via,
      path: foundPath || [],
    };
    if (isEntityExpanded) result.via_entity = true;
    addTemporalFields(result, node);
    ragResults.push(result);
  }

  const scoreHybrid = (vecNode, lexNode) => {
    if (qvec && nodeVecs(vecNode, { expectedMeta }).length > 0) return { score: maxCosine(qvec, vecNode, { expectedMeta }), via: 'semantic' };
    return { score: scoreNodeAgainstTokens(lexNode, qt).score, via: 'lexical' };
  };
  for (const [tkey, items] of Object.entries(overlay.knowledge || {})) {
    (items || []).forEach((it, i) => {
      const text = knowledgeText(it);
      if (!text) return;
      const key = `${tkey}#k${i}`;
      if (excluded.has(key)) return;
      const lexNode = { label: text, summary: '' };
      const { score, via } = scoreHybrid({ vec: it && it._vec, vecMeta: it && it._vecMeta }, lexNode);
      if (!(score > 0)) return;
      let kPath;
      if (pathAnchors && pathAnchors.has(tkey)) kPath = [`dep:${tkey}`];
      else kPath = findPath(tkey, pathAnchors || new Set()) || [];
      ragResults.push({ key, title: text.slice(0, 80), summary: text.slice(0, 200), score: roundScore(score), kind: 'knowledge', tier: 'rag', via, path: kPath });
    });
  }

  const confMap = recallJournal.noteConfidenceMap(workspace);
  const floor = recallJournal.CONFIDENCE_FLOOR;
  for (let i = ragResults.length - 1; i >= 0; i--) {
    const r = ragResults[i];
    if ((r.kind || 'task') !== 'note') continue;
    const conf = confMap.has(r.key) ? confMap.get(r.key) : 1.0;
    if (conf < floor) ragResults.splice(i, 1);
  }
  ragResults.sort((a, b) => b.score - a.score);

  expandStructuralContext({
    graph,
    ragResults,
    temporalOk,
    dupInvisible,
    excludedKeys: excluded,
  });

  applyActivation({ graph, ragResults, excludedKeys: excluded, temporalOk, dupInvisible, pathAnchors: pathAnchors || new Set(), retrievalWeightMap });

  const rrEnv = String(process.env.ORCH_RERANK ?? '').trim().toLowerCase();
  const rrParam = String(rerankParam ?? '').trim().toLowerCase();
  const off = (v) => v === '0' || v === 'false' || v === 'off';
  const rerankOn = rrParam ? !off(rrParam) : !off(rrEnv);
  if (rerankOn && ragResults.length > 1) {
    const K = Math.max(1, parseInt(process.env.ORCH_RERANK_K || '50', 10) || 50);
    const aRaw = parseFloat(process.env.ORCH_RERANK_ALPHA || '0.5');
    const ALPHA = Number.isFinite(aRaw) ? Math.min(1, Math.max(0, aRaw)) : 0.5;
    const shortlist = ragResults.slice(0, K);
    const ceScores = await rerank(q, shortlist.map((r) => `${r.title || ''}\n${r.summary || ''}`.trim()));
    if (Array.isArray(ceScores) && ceScores.length === shortlist.length) {
      for (let i = 0; i < shortlist.length; i++) {
        const cos = shortlist[i].score;
        shortlist[i].ceScore = roundScore(ceScores[i]);
        shortlist[i].reranked = true;
        shortlist[i].score = roundScore((ALPHA * cos + (1 - ALPHA) * ceScores[i]));
      }
      ragResults.sort((a, b) => b.score - a.score);
    }
  }

  const ragScoreMap = new Map();
  for (const r of ragResults) ragScoreMap.set(r.key, r.score);
  const adj = buildSearchAdjacency(graph.tasks, { retrievalWeightMap });
  for (const r of ragResults) {
    let maxNeighborScore = 0;
    for (const edge of (adj.get(r.key) || [])) {
      const ns = ragScoreMap.get(edge.to);
      const weighted = ns === undefined ? undefined : ns * (edge.retrievalWeight || 1);
      if (weighted !== undefined && weighted > maxNeighborScore) maxNeighborScore = weighted;
    }
    const boost = roundScore(0.1 * maxNeighborScore);
    r.structBoost = boost;
    r.score = roundScore(r.score + boost);
  }
  ragResults.sort((a, b) => b.score - a.score);

  if (taskKey) {
    const stats = recallJournal.computeNoteStats(workspace);
    for (let i = ragResults.length - 1; i >= 0; i--) {
      const r = ragResults[i];
      if ((r.kind || 'task') !== 'note') continue;
      if (!recallJournal.isCorroborated(r.key, stats)) ragResults.splice(i, 1);
    }
  }

  return { ragResults, gateCands, gateVia, kbMeta, taskMeta };
}

module.exports = {
  memorySearch,
  buildSearchAdjacency,
  createDupInvisible,
  expandStructuralContext,
};
