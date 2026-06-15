// Shared recall+gate+journal path for the ask-vs-predict preference gate (lib/ask-gate.js).
//
// Both the explicit POST /ask-gate route (routes/graph.js) AND the request_guidance SEAM
// (routes/session.js POST /guidance) run this: recall still-current preference-pool note nodes,
// score them with the SAME raw cosine the gated /search path uses, run the four-guard gate, and
// append every verdict to .graph/ask-journal.jsonl (the T3 training corpus). Extracted so the
// guidance seam enforces the gate IN FRONT of every escalation — making request_guidance a genuine
// last resort — without duplicating the recall/journal machinery.
'use strict';

const path = require('path');
const fs = require('fs');
const { askGate } = require('./ask-gate');
const { maxCosine, nodeVecs } = require('./embed');

// runAskGate(ctx, ws, { decision, flags, tags, seam }) -> the full askGate result `r`
//   (includes decision, reason, appliedNote, topKey, override, overrideCategory, scores).
// ctx supplies embed/cosine/EMBED_MODEL/buildGraph. Null-safe on embed (null ⇒ lexical ⇒ ask).
// `seam` is a provenance label journaled with the verdict ('guidance' for the request_guidance seam).
async function runAskGate(ctx, ws, { decision, flags = {}, tags, seam = null } = {}) {
  const { embed, EMBED_MODEL, buildGraph } = ctx;
  const q = String(decision || '').trim();
  const g = buildGraph(ws);
  const qvec = await embed(q);   // null-safe: null ⇒ lexical fallback (all-zero ⇒ ask)
  // Recall candidates: still-current note nodes, grounded on category:"preference" plus general
  // decision notes (a note with no category is a generic decision note — kept). Excludes notes
  // explicitly categorized as something else to keep the pool a preference pool. Scored with the
  // RAW cosine, exactly like the gated /search candidate pool.
  const prefCands = [];
  let via = 'lexical';
  for (const n of g.tasks) {
    if ((n.kind || 'task') !== 'note' || n.validTo) continue;
    const cat = n.category ? String(n.category) : '';
    if (cat && cat !== 'preference' && cat !== 'decision') continue;   // preference-pool grounding
    let rawScore = 0;
    if (qvec && nodeVecs(n).length > 0) { rawScore = maxCosine(qvec, n); via = 'semantic'; }
    prefCands.push({ key: n.id, title: n.label, summary: n.summary, score: rawScore, category: n.category || null, tags: n.tags || [] });
  }
  const r = await askGate(q, prefCands, { preScored: true, via, tags, ...flags });
  // Journal every verdict (ask AND predict) — training corpus for the learned ask-gate (T3).
  try {
    const journalRow = JSON.stringify({
      ts: new Date().toISOString(), workspace: ws, query: q,
      decision: r.decision, reason: r.reason,
      top1: r.top1, margin: r.margin, gap: r.gap, locality: r.locality, tagOverlap: r.tagOverlap, sharedTags: r.sharedTags,
      topType: r.topType, topKey: r.topKey || null, via: r.via,
      override: r.override, overrideCategory: r.overrideCategory,
      embedModel: EMBED_MODEL, gated: true, prefCands: prefCands.length,
      seam,
    });
    fs.appendFileSync(path.join(ws, '.graph', 'ask-journal.jsonl'), journalRow + '\n');
  } catch { /* journal failure must not break the ask-gate response */ }
  return r;
}

module.exports = { runAskGate };
