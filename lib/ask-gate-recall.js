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
const { askGate, hardOverride } = require('./ask-gate');
const { maxCosine, nodeVecs } = require('./embed');

// recallNotes(g, qvec, { categories }) -> { cands, via }.
// Recall still-current note nodes whose category is in `categories` (a category of null/'' is a
// generic decision note — included when 'decision' is requested). Scored with the RAW cosine,
// exactly like the gated /search candidate pool.
function recallNotes(g, qvec, { categories, expectedMeta }) {
  const cands = [];
  let via = 'lexical';
  for (const n of g.tasks) {
    if ((n.kind || 'task') !== 'note' || n.validTo) continue;
    const cat = n.category ? String(n.category) : '';
    const member = cat ? categories.includes(cat) : categories.includes('decision');
    if (!member) continue;
    let rawScore = 0;
    if (qvec && nodeVecs(n, { expectedMeta }).length > 0) { rawScore = maxCosine(qvec, n, { expectedMeta }); via = 'semantic'; }
    cands.push({ key: n.id, title: n.label, summary: n.summary, score: rawScore, category: n.category || null, tags: n.tags || [] });
  }
  return { cands, via };
}

// journalVerdict(ws, { query, r, embedModel, candCount, seam }) — append a gate verdict to the T3
// training corpus. Journal failure must never break the gate response.
function journalVerdict(ws, { query, r, embedModel, candCount, seam }) {
  try {
    const journalRow = JSON.stringify({
      ts: new Date().toISOString(), workspace: ws, query,
      decision: r.decision, reason: r.reason,
      top1: r.top1, margin: r.margin, gap: r.gap, locality: r.locality, tagOverlap: r.tagOverlap, sharedTags: r.sharedTags,
      topType: r.topType, topKey: r.topKey || null, via: r.via,
      override: r.override, overrideCategory: r.overrideCategory,
      embedModel, gated: true, prefCands: candCount,
      seam,
    });
    fs.appendFileSync(path.join(ws, '.graph', 'ask-journal.jsonl'), journalRow + '\n');
  } catch { /* journal failure must not break the ask-gate response */ }
}

// runAskGate(ctx, ws, { decision, flags, tags, seam }) -> the full askGate result `r`
//   (includes decision, reason, appliedNote, topKey, override, overrideCategory, scores).
// ctx supplies embed/cosine/EMBED_MODEL/buildGraph. Null-safe on embed (null ⇒ lexical ⇒ ask).
// `seam` is a provenance label journaled with the verdict ('guidance' for the request_guidance seam).
async function runAskGate(ctx, ws, { decision, flags = {}, tags, seam = null } = {}) {
  const { embed, EMBED_MODEL, buildGraph } = ctx;
  const q = String(decision || '').trim();
  const g = buildGraph(ws);
  const overlay = ctx.overlayFor ? ctx.overlayFor(ws) : null;
  const expectedMeta = ctx.embeddingMeta && overlay ? ctx.embeddingMeta(overlay) : null;
  const qvec = await embed(q, { mode: 'query', overlay });   // null-safe: null ⇒ lexical fallback (all-zero ⇒ ask)
  // Recall candidates: still-current note nodes, grounded on category:"preference" plus general
  // decision notes (a note with no category is a generic decision note — kept).
  const { cands, via } = recallNotes(g, qvec, { categories: ['preference', 'decision'], expectedMeta });
  const r = await askGate(q, cands, { preScored: true, via, tags, ...flags });
  // Journal every verdict (ask AND predict) — training corpus for the learned ask-gate (T3).
  journalVerdict(ws, { query: q, r, embedModel: EMBED_MODEL, candCount: cands.length, seam });
  return r;
}

// Stricter bar for the answered-downstream pass. A wrong auto-resolve here SILENTLY DROPS a real
// question (the question never reaches the user), so this is calibrated well above runAskGate's
// preference defaults: higher cosine floor, and the margin "sharp" path is disabled (marginThreshold
// raised out of reach) so a match must clear the GAP-based on-task test AND project-locality — never
// a bare standalone hit. requireEmpirical stays on (an already-answered blocker reads as a decision).
const ANSWERED_DEFAULTS = {
  cosThreshold: 0.62,
  gapThreshold: 0.30,
  marginThreshold: 2,   // > any real cosine margin ⇒ the sharp-only predict path can never fire here.
  requireEmpirical: true,
  localityThreshold: 2,
};

// answeredDownstream(ctx, ws, { decision, flags, tags, seam }) -> { answer, provenance, reason } when
// a DECISION/CORRECTION note already answers this pending question with high confidence, else null.
//
// The SECOND recall pass behind the request_guidance seam (task EL-2/D, fix Mode-1 over-escalation):
// before a BLOCKING text escalation reaches the user, check whether the answer already lives in the
// graph as a decision/correction note (not just a category:preference note). On a CONFIDENT hit, the
// question is AUTO-RESOLVED from that note — returning the predicted answer + provenance, the same
// shape the preference-predict path returns — instead of pausing the loop.
//
// GUARDRAIL: hard-override categories (irreversible/outward/highImpact/scopeExpansion/repeatedFailure)
// must STILL escalate. A note match must NEVER auto-resolve an override question, so this short-circuits
// to null on any override (flag- or keyword-asserted) BEFORE recall — mirroring ask-gate.js precedence.
async function answeredDownstream(ctx, ws, { decision, flags = {}, tags, seam = null } = {}) {
  const { embed, EMBED_MODEL, buildGraph } = ctx;
  const q = String(decision || '').trim();
  // GUARDRAIL: override always escalates — never auto-resolve from a downstream note.
  if (hardOverride(q, flags).override) return null;
  if (!q) return null;
  const g = buildGraph(ws);
  const overlay = ctx.overlayFor ? ctx.overlayFor(ws) : null;
  const expectedMeta = ctx.embeddingMeta && overlay ? ctx.embeddingMeta(overlay) : null;
  const qvec = await embed(q, { mode: 'query', overlay });
  // The general note pool: decision (incl. uncategorized) + correction notes. Preference notes are
  // already covered by runAskGate's pass — this widens to the answered-blocker corpus.
  const { cands, via } = recallNotes(g, qvec, { categories: ['decision', 'correction'], expectedMeta });
  const r = await askGate(q, cands, { preScored: true, via, tags, ...flags, ...ANSWERED_DEFAULTS });
  // Distinct reason so the verdict is auditable as the answered-downstream pass, not the pref pass.
  const tagged = { ...r, reason: r.decision === 'predict' ? `answered-downstream:${r.reason}` : `answered-downstream-miss:${r.reason}` };
  journalVerdict(ws, { query: q, r: tagged, embedModel: EMBED_MODEL, candCount: cands.length, seam });
  if (r.decision !== 'predict' || !r.appliedNote) return null;
  const provenance = {
    key: r.topKey,
    title: (r.appliedNote.title || r.appliedNote.label) || null,
    summary: r.appliedNote.summary || null,
  };
  return { answer: provenance.summary || provenance.title || '', provenance, reason: tagged.reason };
}

module.exports = { runAskGate, answeredDownstream };
