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

// |intersection| / |taskTags| — 0 when task has no tags.
function tagOverlap(taskTags, noteTags) {
  const t = normalizeTags(taskTags);
  const n = new Set(normalizeTags(noteTags));
  if (!t.length) return 0;
  let shared = 0;
  for (const tag of t) if (n.has(tag)) shared++;
  return shared / t.length;
}

module.exports = { normalizeTags, normalizeCategory, noteEmbedText, tagOverlap };
