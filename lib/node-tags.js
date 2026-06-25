'use strict';

// Normalize author-supplied tags: lowercase, deduped, non-empty strings.
function normalizeTags(tags) {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(/[\s,]+/);
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const t = String(raw || '').trim().toLowerCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function normalizeCategory(category) {
  const c = String(category || '').trim().toLowerCase();
  return c || null;
}

// Text used for semantic embedding of a note (title + category + tags + summary). This stays the
// POOLED single-vector text — the gate/dedup vector (note.vec).
function noteEmbedText({ title, category, tags, summary }) {
  const parts = [title, normalizeCategory(category), ...normalizeTags(tags), summary].filter(Boolean);
  return parts.join(' ').trim();
}

// Text used for semantic embedding of a CODE node (the dedicated code-index layer). The pooled
// single-vector text for direct-RAG retrieval: `<name> — <signature> in <file>` (+ summary if any).
// MUST be the one place this is computed so the bulk-write embed, the /search scorer, and the ingest
// helper all embed/query against identical text.
function codeNodeEmbedText({ name, signature, file, summary }) {
  const head = [String(name || '').trim(), String(signature || '').trim()].filter(Boolean).join(' — ');
  const loc = String(file || '').trim() ? `in ${String(file).trim()}` : '';
  const parts = [head, loc, String(summary || '').trim()].filter(Boolean);
  return parts.join(' ').trim();
}

// FIELD-LEVEL embed texts for a note's MULTI-VECTOR set (note.vecs): one string per salient field —
// [title, summary, ...each knowledge[] entry] — so each knowledge item is embedded and retrievable on
// its own rather than diluted into the pooled vector. Knowledge items may be strings or objects (the
// same shape attach_knowledge stores); object items are flattened to a compact text. Empties are
// dropped, and each text is trimmed to a string. The POOLED noteEmbedText above is unchanged.
function noteFieldTexts({ title, summary, knowledge }) {
  const out = [];
  const push = (s) => { const t = String(s == null ? '' : s).trim(); if (t) out.push(t); };
  push(title);
  push(summary);
  for (const k of (Array.isArray(knowledge) ? knowledge : [])) {
    if (k && typeof k === 'object') push(knowledgeItemText(k));
    else push(k);
  }
  return out;
}

// Flatten a structured knowledge item ({ title?, summary?, content?, text?, ... }) to a single text
// for field-level embedding. Falls back to JSON for an unrecognized object shape so no signal is lost.
function knowledgeItemText(k) {
  if (k == null) return '';
  if (typeof k !== 'object') return String(k);
  const parts = [k.title, k.summary, k.content, k.text, k.note, k.body].filter((s) => s != null && String(s).trim());
  if (parts.length) return parts.map((s) => String(s).trim()).join(' ').trim();
  try { return JSON.stringify(k); } catch { return ''; }
}

// Text used for semantic embedding of a TASK node: title + summary ONLY. Category/tags are
// DELIBERATELY excluded (Step 0 — they are separate retrieval signals fused in later steps, not
// folded into the dense vector). The summary is bounded before embedding so it cannot silently
// overflow MiniLM's ~256-token window (≈1000 chars): an over-long summary would be truncated by the
// tokenizer with no signal to the caller, so we trim it deterministically here instead. The title
// is short and always kept whole.
const TASK_SUMMARY_EMBED_CHARS = 900; // leaves headroom under the ~256-token window for the title
function taskEmbedText({ title, summary }) {
  const t = String(title || '').trim();
  const s = String(summary || '').trim().slice(0, TASK_SUMMARY_EMBED_CHARS);
  return [t, s].filter(Boolean).join(' ').trim();
}

// |intersection| / |taskTags| — 0 when task has no tags.
function tagOverlap(taskTags, noteTags) {
  const t = normalizeTags(taskTags);
  const n = new Set(normalizeTags(noteTags));
  if (!t.length) return 0;
  let shared = 0;
  for (const tag of t) if (n.has(tag)) shared++;
  return shared / t.length;
}

module.exports = { normalizeTags, normalizeCategory, noteEmbedText, codeNodeEmbedText, noteFieldTexts, taskEmbedText, tagOverlap };
