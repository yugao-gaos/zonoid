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

// Text used for semantic embedding of a note (title + category + tags + summary).
function noteEmbedText({ title, category, tags, summary }) {
  const parts = [title, normalizeCategory(category), ...normalizeTags(tags), summary].filter(Boolean);
  return parts.join(' ').trim();
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

module.exports = { normalizeTags, normalizeCategory, noteEmbedText, taskEmbedText, tagOverlap };
