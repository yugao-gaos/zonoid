'use strict';

const AGENTIC_CONTENT_BUDGET = 1200;
const REVERSIBLE_CONTEXT_MIN_CHARS = 360;
const REVERSIBLE_CONTEXT_HEAD_CHARS = 220;
const REVERSIBLE_CONTEXT_TAIL_CHARS = 80;
const CAVEMAN_CONTEXT_MIN_CHARS = 40;

const CAVEMAN_DROP_WORDS = new Set([
  'a', 'an', 'the',
  'just', 'really', 'basically', 'actually', 'simply', 'essentially', 'generally',
  'certainly', 'sure',
]);

const CAVEMAN_PHRASES = [
  [/\bin order to\b/gi, 'to'],
  [/\bmake sure to\b/gi, 'ensure'],
  [/\bit is important to\b/gi, ''],
  [/\bit is worth noting that\b/gi, ''],
  [/\byou should\b/gi, ''],
  [/\byou could\b/gi, ''],
  [/\bwe should\b/gi, ''],
  [/\bwe need to\b/gi, 'need to'],
  [/\bthis means that\b/gi, ''],
  [/\bthe reason is because\b/gi, 'because'],
  [/\bhowever,\s*/gi, ''],
  [/\bfurthermore,\s*/gi, ''],
  [/\badditionally,\s*/gi, ''],
  [/\bin addition,\s*/gi, ''],
];

function approxTokens(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.ceil(value / 4);
  return Math.ceil(String(value || '').length / 4);
}

function fullNodeContent(node, budget = AGENTIC_CONTENT_BUDGET) {
  if (!node) return '';
  const kn = node.knowledge_node || null;
  const raw = String(
    node.summary
    || (kn && kn.summary)
    || node.label
    || (kn && kn.title)
    || ''
  ).trim();
  return raw.length > budget ? raw.slice(0, budget) : raw;
}

function retrievalToolForResult(result) {
  if (!result) return 'search';
  if ((result.kind || 'task') === 'task') return 'get_task_detail';
  if ((result.kind || 'task') === 'note') return 'search_knowledge';
  if (String(result.key || '').includes('#')) return 'source_chunk';
  return 'search';
}

function compressTextReversibly(text) {
  const raw = String(text || '').trim();
  if (raw.length <= REVERSIBLE_CONTEXT_MIN_CHARS) return null;
  const head = raw.slice(0, REVERSIBLE_CONTEXT_HEAD_CHARS).trimEnd();
  const tail = raw.slice(-REVERSIBLE_CONTEXT_TAIL_CHARS).trimStart();
  return `${head}\n[CCR omitted ${raw.length - head.length - tail.length} chars; retrieve with ccr.handle]\n${tail}`;
}

function splitProtectedInline(text) {
  return String(text || '').split(/(`[^`]*`|https?:\/\/\S+|\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+|\.{1,2}\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+)/g);
}

function compressProseSegment(segment) {
  let out = String(segment || '');
  for (const [pattern, replacement] of CAVEMAN_PHRASES) out = out.replace(pattern, replacement);
  out = out
    .replace(/\b(implement a solution for|create an implementation for)\b/gi, 'fix')
    .replace(/\butilize\b/gi, 'use')
    .replace(/\bapproximately\b/gi, 'about')
    .replace(/\bprior to\b/gi, 'before')
    .replace(/\bsubsequent to\b/gi, 'after')
    .replace(/\bdue to the fact that\b/gi, 'because')
    .replace(/\s+/g, ' ');
  out = out.replace(/\b[A-Za-z]+\b/g, (word) => {
    return CAVEMAN_DROP_WORDS.has(word.toLowerCase()) ? '' : word;
  });
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1');
}

function compressNaturalLanguage(text) {
  const raw = String(text || '');
  if (raw.length < CAVEMAN_CONTEXT_MIN_CHARS) return raw;
  const parts = splitProtectedInline(raw).map((part) => {
    if (!part) return part;
    if (part.startsWith('`') || /^https?:\/\//.test(part) || /^(\/|\.{1,2}\/)/.test(part)) return part;
    return compressProseSegment(part);
  });
  return parts.join('').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function buildContextRetrievalHandle(result, field, originalChars, compressedChars) {
  const key = String((result && result.key) || '');
  return {
    kind: 'context_compaction_retrieval_handle',
    version: 1,
    key,
    field,
    tool: retrievalToolForResult(result),
    source: result && result.source ? result.source : null,
    tier: result && result.tier ? result.tier : null,
    via: result && result.via ? result.via : null,
    ccr_id: `ccr:${Buffer.from(`${key}:${field}`).toString('base64url')}`,
    original_chars: originalChars,
    compressed_chars: compressedChars,
  };
}

function applyReversibleContextCompression(results, options = {}) {
  const fieldForResult = typeof options.fieldForResult === 'function' ? options.fieldForResult : null;
  const compactNaturalLanguage = options.compactNaturalLanguage !== false;
  const metrics = {
    enabled: true,
    mode: 'reversible_context',
    before_chars: 0,
    after_chars: 0,
    before_tokens: 0,
    after_tokens: 0,
    compressed_entries: 0,
    prose_compacted_entries: 0,
    handles: [],
  };
  for (const result of results || []) {
    if (!result || typeof result !== 'object') continue;
    const field = fieldForResult ? fieldForResult(result) : (result.content != null ? 'content' : 'summary');
    if (!field) continue;
    const original = String(result[field] || '');
    metrics.before_chars += original.length;
    const compacted = compactNaturalLanguage ? compressNaturalLanguage(original) : original;
    if (compacted.length < original.length) metrics.prose_compacted_entries += 1;
    const compressed = compressTextReversibly(compacted);
    if (!compressed) {
      if (compacted !== original) result[field] = compacted;
      metrics.after_chars += compacted.length;
      continue;
    }
    result[field] = compressed;
    const handle = buildContextRetrievalHandle(result, field, original.length, compressed.length);
    result.ccr = {
      marker: '[CCR]',
      reversible: true,
      handle,
    };
    metrics.after_chars += compressed.length;
    metrics.compressed_entries += 1;
    metrics.handles.push(handle);
  }
  metrics.before_tokens = approxTokens(metrics.before_chars);
  metrics.after_tokens = approxTokens(metrics.after_chars);
  metrics.saved_tokens = Math.max(0, metrics.before_tokens - metrics.after_tokens);
  return metrics;
}

function compressStructuredContextValue(value, metrics, options = {}) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) compressStructuredContextValue(item, metrics, options);
    return;
  }

  const key = value.key || value.id || value.noteId;
  const field = typeof value.summary === 'string'
    ? 'summary'
    : (typeof value.content === 'string' && options.includeContent === true ? 'content' : null);
  if (key && field) {
    const original = String(value[field] || '');
    metrics.before_chars += original.length;
    const compacted = options.compactNaturalLanguage === false ? original : compressNaturalLanguage(original);
    if (compacted.length < original.length) metrics.prose_compacted_entries += 1;
    const compressed = compressTextReversibly(compacted);
    if (compressed) {
      value[field] = compressed;
      const handleSource = value.kind ? value : { ...value, kind: String(key).startsWith('note:') ? 'note' : 'task' };
      const handle = buildContextRetrievalHandle(handleSource, field, original.length, compressed.length);
      value.ccr = { marker: '[CCR]', reversible: true, handle };
      metrics.after_chars += compressed.length;
      metrics.compressed_entries += 1;
      metrics.handles.push(handle);
    } else {
      if (compacted !== original) value[field] = compacted;
      metrics.after_chars += compacted.length;
    }
  }

  for (const [childKey, child] of Object.entries(value)) {
    if (childKey === 'ccr') continue;
    compressStructuredContextValue(child, metrics, options);
  }
}

function applyStructuredContextCompression(payload, options = {}) {
  const metrics = {
    enabled: true,
    mode: 'reversible_structured_context',
    before_chars: 0,
    after_chars: 0,
    before_tokens: 0,
    after_tokens: 0,
    compressed_entries: 0,
    prose_compacted_entries: 0,
    handles: [],
  };
  compressStructuredContextValue(payload, metrics, options);
  metrics.before_tokens = approxTokens(metrics.before_chars);
  metrics.after_tokens = approxTokens(metrics.after_chars);
  metrics.saved_tokens = Math.max(0, metrics.before_tokens - metrics.after_tokens);
  return metrics;
}

function parseHandle(input) {
  if (input && typeof input === 'object') return input;
  const raw = String(input || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function overlayKnowledgeText(item) {
  if (typeof item === 'string') return item;
  return String((item && (item.value || item.text || item.summary)) || '');
}

function resolveSourceChunk(key, overlay) {
  const match = String(key || '').match(/^(.*)#k(\d+)$/);
  if (!match) return null;
  const sourceKey = match[1];
  const index = Number(match[2]);
  const items = overlay && overlay.knowledge && overlay.knowledge[sourceKey];
  if (!Array.isArray(items) || !Number.isInteger(index) || index < 0 || index >= items.length) return null;
  return {
    key,
    source: sourceKey,
    kind: 'knowledge',
    field: 'content',
    content: overlayKnowledgeText(items[index]),
  };
}

function resolveContextHandle(input, graph, overlay = {}) {
  const handle = parseHandle(input);
  if (!handle || handle.kind !== 'context_compaction_retrieval_handle') {
    return { ok: false, error: 'invalid CCR handle' };
  }
  const key = String(handle.key || '');
  const field = String(handle.field || 'content');
  if (!key) return { ok: false, error: 'CCR handle missing key' };

  const chunk = key.includes('#') ? resolveSourceChunk(key, overlay) : null;
  if (chunk) {
    return {
      ok: true,
      handle,
      key,
      field,
      kind: chunk.kind,
      source: chunk.source,
      content: chunk.content,
    };
  }

  const tasks = Array.isArray(graph && graph.tasks) ? graph.tasks : [];
  const node = tasks.find((item) => item && item.id === key);
  if (!node) return { ok: false, error: 'CCR key not found', key };

  let content;
  if (field === 'content') content = fullNodeContent(node, Infinity);
  else content = String(node[field] || '');
  return {
    ok: true,
    handle,
    key,
    field,
    kind: node.kind || 'task',
    title: node.label || key,
    content,
  };
}

module.exports = {
  AGENTIC_CONTENT_BUDGET,
  applyReversibleContextCompression,
  applyStructuredContextCompression,
  buildContextRetrievalHandle,
  compressNaturalLanguage,
  compressTextReversibly,
  fullNodeContent,
  resolveContextHandle,
};
