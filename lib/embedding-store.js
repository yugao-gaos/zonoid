'use strict';

const embedProviders = require('./embed-providers');

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function expectedMeta(opts = {}) {
  return opts.expectedMeta || (opts.overlay ? embedProviders.embeddingMeta(opts.overlay) : null);
}

function keepVector(vec, meta, expected) {
  if (!Array.isArray(vec)) return false;
  if (!expected) return vec.length > 0;
  return embedProviders.vectorMatchesMeta(vec, meta || null, expected);
}

function vectorFreshness(vec, meta, expected) {
  if (!Array.isArray(vec) || vec.length === 0) return 'missing';
  return keepVector(vec, meta, expected) ? 'fresh' : 'stale';
}

function vectorSetPresent(vecs) {
  return Array.isArray(vecs) && vecs.length > 0;
}

function vectorSetFresh(vecs, metas, opts = {}) {
  if (!vectorSetPresent(vecs)) return false;
  const expected = expectedMeta(opts);
  if (!expected) return true;
  const match = typeof opts.vectorMatchesMeta === 'function' ? opts.vectorMatchesMeta : embedProviders.vectorMatchesMeta;
  const metaList = Array.isArray(metas) ? metas : [];
  return vecs.every((v, i) => match(v, metaList[i] || null, expected));
}

function nodeVecs(node, opts = {}) {
  const expected = expectedMeta(opts);
  if (node && Array.isArray(node.vecs) && node.vecs.length) {
    const metas = Array.isArray(node.vecsMeta) ? node.vecsMeta : [];
    return node.vecs.filter((v, i) => keepVector(v, metas[i] || node.vecMeta || null, expected));
  }
  if (node && keepVector(node.vec, node.vecMeta || null, expected)) return [node.vec];
  return [];
}

function maxCosine(qvec, node, opts = {}) {
  if (!Array.isArray(qvec) || qvec.length === 0) return 0;
  const vecs = nodeVecs(node, opts);
  if (vecs.length === 0) return 0;
  let best = -Infinity;
  for (const v of vecs) {
    const s = cosine(qvec, v);
    if (s > best) best = s;
  }
  return best;
}

function pushVectorReport(out, layer, key, vec, meta, expected) {
  if (!Array.isArray(vec) || vec.length === 0) return;
  out.total++;
  out.byLayer[layer] = (out.byLayer[layer] || 0) + 1;
  if (vectorFreshness(vec, meta, expected) === 'fresh') {
    out.fresh++;
    return;
  }
  out.stale++;
  out.staleByLayer[layer] = (out.staleByLayer[layer] || 0) + 1;
  out.staleRefs.push({ layer, key });
}

function planVectorInvalidation(overlay, opts = {}) {
  const expected = expectedMeta({ ...opts, overlay });
  const out = {
    activeIdentity: expected || null,
    denseVectors: {
      total: 0,
      fresh: 0,
      stale: 0,
      byLayer: {},
      staleByLayer: {},
      staleRefs: [],
    },
    semanticDerivedArtifacts: {
      stale: 0,
      byLayer: {},
      refs: [],
    },
    unaffected: ['status', 'assignee', 'summaries', 'dependencies', 'git', 'reviews', 'metrics'],
  };

  if (!overlay || typeof overlay !== 'object') return out;

  for (const [id, n] of Object.entries(overlay.note_nodes || {})) {
    pushVectorReport(out.denseVectors, 'note.vec', `note:${id}`, n && n.vec, n && n.vecMeta, expected);
    const vecs = Array.isArray(n && n.vecs) ? n.vecs : [];
    const metas = Array.isArray(n && n.vecsMeta) ? n.vecsMeta : [];
    vecs.forEach((v, i) => pushVectorReport(out.denseVectors, 'note.vecs', `note:${id}#${i}`, v, metas[i] || null, expected));
  }

  for (const [taskKey, vecs] of Object.entries(overlay.taskVecs || {})) {
    const metas = overlay.taskVecMeta && Array.isArray(overlay.taskVecMeta[taskKey]) ? overlay.taskVecMeta[taskKey] : [];
    (Array.isArray(vecs) ? vecs : []).forEach((v, i) => pushVectorReport(out.denseVectors, 'taskVecs', `${taskKey}#${i}`, v, metas[i] || null, expected));
  }

  for (const [taskKey, items] of Object.entries(overlay.knowledge || {})) {
    (items || []).forEach((it, i) => pushVectorReport(out.denseVectors, 'knowledge._vec', `${taskKey}#k${i}`, it && it._vec, it && it._vecMeta, expected));
  }

  for (const [key, n] of Object.entries(overlay.code_nodes || {})) {
    pushVectorReport(out.denseVectors, 'code_nodes.vec', key, n && n.vec, n && n.vecMeta, expected);
    const vecs = Array.isArray(n && n.vecs) ? n.vecs : [];
    const metas = Array.isArray(n && n.vecsMeta) ? n.vecsMeta : [];
    vecs.forEach((v, i) => pushVectorReport(out.denseVectors, 'code_nodes.vecs', `${key}#${i}`, v, metas[i] || null, expected));
  }

  for (const [id, n] of Object.entries(overlay.entity_nodes || {})) {
    pushVectorReport(out.denseVectors, 'entity_nodes.vec', `entity:${id}`, n && n.vec, n && n.vecMeta, expected);
  }

  for (const e of overlay.edges || []) {
    if (!e || e.origin !== 'autowire-semantic') continue;
    out.semanticDerivedArtifacts.stale++;
    out.semanticDerivedArtifacts.byLayer['edges.autowire-semantic'] = (out.semanticDerivedArtifacts.byLayer['edges.autowire-semantic'] || 0) + 1;
    out.semanticDerivedArtifacts.refs.push({ layer: 'edges.autowire-semantic', from: e.from, to: e.to });
  }

  return out;
}

class OverlayEmbeddingStore {
  constructor(overlay) {
    this.overlay = overlay || {};
  }

  taskNode(key) {
    const vecs = this.overlay.taskVecs && this.overlay.taskVecs[key];
    const vecsMeta = this.overlay.taskVecMeta && this.overlay.taskVecMeta[key];
    return {
      vecs: Array.isArray(vecs) ? vecs : null,
      vecsMeta: Array.isArray(vecsMeta) ? vecsMeta : null,
    };
  }

  taskVecs(key, opts = {}) {
    return nodeVecs(this.taskNode(key), opts);
  }

  hasTaskVec(key) {
    return vectorSetPresent(this.taskNode(key).vecs);
  }

  taskVecFresh(key, opts = {}) {
    const node = this.taskNode(key);
    return vectorSetFresh(node.vecs, node.vecsMeta, opts);
  }

  setTaskVec(key, vec, meta) {
    if (!this.overlay.taskVecs) this.overlay.taskVecs = {};
    if (!this.overlay.taskVecMeta) this.overlay.taskVecMeta = {};
    if (Array.isArray(vec) && vec.length) {
      this.overlay.taskVecs[key] = [vec];
      if (meta) this.overlay.taskVecMeta[key] = [meta];
      else delete this.overlay.taskVecMeta[key];
    } else {
      delete this.overlay.taskVecs[key];
      delete this.overlay.taskVecMeta[key];
    }
    return this.overlay;
  }

  knowledgeItemNode(item) {
    return {
      vec: item && item._vec,
      vecMeta: item && item._vecMeta,
    };
  }

  knowledgeItemVecs(item, opts = {}) {
    return nodeVecs(this.knowledgeItemNode(item), opts);
  }

  setKnowledgeItemVec(item, vec, meta) {
    if (!item || typeof item !== 'object') return item;
    if (Array.isArray(vec) && vec.length) {
      item._vec = vec;
      if (meta) item._vecMeta = meta;
      else delete item._vecMeta;
    } else {
      delete item._vec;
      delete item._vecMeta;
    }
    return item;
  }
}

function createEmbeddingStore(overlay) {
  return new OverlayEmbeddingStore(overlay);
}

function setTaskVec(overlay, key, vec, meta) {
  return createEmbeddingStore(overlay).setTaskVec(key, vec, meta);
}

function taskNode(overlay, key) {
  return createEmbeddingStore(overlay).taskNode(key);
}

function hasTaskVec(overlay, key) {
  return createEmbeddingStore(overlay).hasTaskVec(key);
}

function taskVecFresh(overlay, key, opts = {}) {
  return createEmbeddingStore(overlay).taskVecFresh(key, opts);
}

function knowledgeItemNode(item) {
  return createEmbeddingStore(null).knowledgeItemNode(item);
}

function setKnowledgeItemVec(item, vec, meta) {
  return createEmbeddingStore(null).setKnowledgeItemVec(item, vec, meta);
}

module.exports = {
  OverlayEmbeddingStore,
  createEmbeddingStore,
  setTaskVec,
  taskNode,
  hasTaskVec,
  taskVecFresh,
  vectorSetFresh,
  planVectorInvalidation,
  knowledgeItemNode,
  setKnowledgeItemVec,
  nodeVecs,
  maxCosine,
};
