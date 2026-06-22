'use strict';

const LONG_NOTE_CHARS = 2400;
const SOURCE_LIKE_CHARS = 1000;
const CHUNK_CHARS = 1200;

function cleanText(s) {
  return String(s || '').replace(/\r\n/g, '\n').trim();
}

function sourceSignal(text) {
  const t = cleanText(text);
  if (!t) return false;
  const lines = t.split('\n');
  const codeish = lines.filter((line) => /^\s*(const|let|var|function|class|import|export|module\.exports|#include|def |async function|if \(|for \(|while \(|[{}]|\/\/|\*)/.test(line)).length;
  return /```|\/\*\*?|=>|;\s*$|^\s*#{1,6}\s+/m.test(t) || codeish >= 4;
}

function evidenceTextForNote({ summary, knowledge, source_text, raw, evidence }) {
  const parts = [source_text, raw, evidence, summary];
  if (Array.isArray(knowledge)) {
    for (const item of knowledge) {
      if (typeof item === 'string' && item.length >= 400) parts.push(item);
      else if (item && typeof item === 'object') parts.push(JSON.stringify(item));
    }
  }
  return cleanText(parts.filter(Boolean).join('\n\n'));
}

function shouldClusterNote(input) {
  const text = evidenceTextForNote(input);
  if (text.length >= LONG_NOTE_CHARS) return true;
  return text.length >= SOURCE_LIKE_CHARS && sourceSignal(text);
}

function compactNoteSummary(summary) {
  const raw = cleanText(summary);
  if (raw.length <= 2000 && !shouldClusterNote({ summary: raw })) return raw;
  const paragraphs = raw.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const nonCode = paragraphs.filter((p) => !sourceSignal(p) && p.length <= 800);
  const seed = (nonCode[0] || paragraphs[0] || raw).replace(/\s+/g, ' ').trim();
  const clipped = seed.slice(0, 1000).trim();
  return clipped
    ? `${clipped}\n\n[Long raw evidence preserved as structured source chunks.]`
    : 'Long raw evidence preserved as structured source chunks.';
}

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9._#:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'note-source';
}

function chunkText(text, maxChars = CHUNK_CHARS) {
  const paragraphs = cleanText(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = '';
  };
  for (const p of paragraphs.length ? paragraphs : [cleanText(text)]) {
    if (p.length > maxChars) {
      push();
      for (let i = 0; i < p.length; i += maxChars) chunks.push(p.slice(i, i + maxChars).trim());
      continue;
    }
    if (cur && cur.length + p.length + 2 > maxChars) push();
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  push();
  return chunks;
}

function buildSourceClusterForNote(noteKey, input = {}) {
  const evidence = evidenceTextForNote(input);
  if (!noteKey || !shouldClusterNote(input)) return null;
  const bare = String(noteKey).replace(/^note:/, '');
  const sourcePath = cleanText(input.source_path || input.sourcePath || input.path) || null;
  const docId = slug(sourcePath ? `${sourcePath}-${bare}` : bare);
  const sectionId = `${docId}#note-evidence`;
  const chunks = chunkText(evidence);
  const title = cleanText(input.title) || noteKey;
  const nodes = [
    {
      type: 'source_doc',
      id: docId,
      label: sourcePath || `${title} evidence`,
      summary: `Raw evidence captured from long note ${noteKey}.`,
      source_path: sourcePath,
      metadata: { note_key: noteKey, origin: 'overlay/note' },
    },
    {
      type: 'source_section',
      id: sectionId,
      label: `${title} evidence`,
      summary: chunks[0] || evidence.slice(0, 500),
      source_path: sourcePath,
      section_ref: 'note-evidence',
      metadata: { note_key: noteKey, origin: 'overlay/note' },
    },
  ];
  chunks.forEach((chunk, i) => {
    nodes.push({
      type: 'source_chunk',
      id: `${sectionId}:chunk-${i + 1}`,
      label: `${title} evidence chunk ${i + 1}`,
      summary: chunk,
      source_path: sourcePath,
      section_ref: 'note-evidence',
      chunk_ref: `chunk-${i + 1}`,
      metadata: { note_key: noteKey, origin: 'overlay/note' },
    });
  });
  const docKey = `knowledge:source_doc:${docId}`;
  const sectionKey = `knowledge:source_section:${sectionId}`;
  const edges = [{ from: docKey, to: sectionKey }];
  chunks.forEach((_, i) => {
    const chunkKey = `knowledge:source_chunk:${sectionId}:chunk-${i + 1}`;
    edges.push({ from: sectionKey, to: chunkKey });
    edges.push({ from: chunkKey, to: noteKey });
  });
  if (chunks.length > 1) edges.push({ from: sectionKey, to: noteKey });
  return { nodes, edges, chunkCount: chunks.length, noteSummary: compactNoteSummary(input.summary) };
}

module.exports = {
  shouldClusterNote,
  compactNoteSummary,
  buildSourceClusterForNote,
};
