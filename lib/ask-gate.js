// Ask-vs-predict preference gate — predict-only-on-confidence, ask-by-default.
//
// THE PROBLEM (mirror of lib/context-gate.js, but for the OTHER axis): when the orchestrator hits a
// decision the user might care about, it can either ESCALATE (request_guidance — pause, ask the
// user) or PREDICT the answer from a stored user-preference note. Asking is never wrong but is
// expensive (it stalls the loop and taxes the user's attention); predicting is cheap but wrong-
// predicting silently does the thing the user didn't want. So the gate must DECIDE, per pending
// decision, whether a stored preference is confident+specific enough to PREDICT, vs ASK.
// Default = ASK. Predict ONLY on a high-confidence, specific, project-local, EMPIRICAL preference
// match — the exact same four-guard shape as the context-need gate.
//
// This is the heuristic that ships LIVE; a learned classifier (separate task T3) trains on the
// .graph/ask-journal.jsonl this gate's caller writes — so the journal schema must be stable.
//
// HARD OVERRIDE: some decisions ALWAYS ask, no matter how confident the match. These mirror
// request_guidance's documented trigger list (irreversible / outward-facing / high-impact /
// scope-expansion / repeated-failure). The override is checkable from caller-supplied flags
// (opts.irreversible etc.) AND conservative keyword heuristics over the decision query. When in
// doubt, ASK.
//
// PURE + offline-friendly like context-gate: it takes already-embedded preference notes (or falls
// back to a lexical/pre-scored scorer) so it unit-tests and runs over journals without the daemon.
'use strict';

const {
  classifyNoteType, noteText, externalGap, contentTokens, projectLocality, tagOverlap,
} = require('./context-gate');
const { normalizeTags } = require('./node-tags');
const { maxCosine, nodeVecs } = require('./embed');

// --- learned-source switch (T3) -------------------------------------------------------------------
// The heuristic above is the DEFAULT live decider. A separately-trained logistic classifier
// (scripts/ask-clf-*.js) runs ALONGSIDE it in SHADOW — every recall-scored verdict carries the
// learned model's shadow_decision/shadow_conf for the journal (training signal), WITHOUT deciding.
// The live source flips heuristic→learned automatically once the comparator (lib/ask-promote.js)
// proves the learned model beats the heuristic over a stable window — see .graph/ask-clf/mode.json.
// Both deps are loaded best-effort: a missing model / missing mode file ⇒ pure heuristic (the
// shadow-before-enforce default). lib/ask-gate.js stays usable offline with neither present.
let _clf = null;
try { _clf = require('../scripts/ask-clf-predict'); } catch { _clf = null; }
let _promote = null;
try { _promote = require('./ask-promote'); } catch { _promote = null; }

// Thresholds mirror context-gate's DEFAULTS — same signal, same calibration starting point. They
// govern when a stored preference is confident+specific enough to PREDICT instead of ASK.
const DEFAULTS = {
  cosThreshold: 0.50,     // top-1 cosine floor on the matched preference note.
  gapThreshold: 0.25,     // external-gap: fraction of the note's content tokens that recur in the query.
  marginThreshold: 0.08,  // alt path: a sharp standalone hit can predict without the gap test.
  requireEmpirical: true, // only a concrete stated preference qualifies; a bare topical note does not.
  localityThreshold: 2,   // project-locality: the note must read as a local observation (>= 2 of 4 cats).
};

// --- hard-override triggers -----------------------------------------------------------------------
// request_guidance (lib/mcp-core.js) documents the escalation triggers: "ambiguous intent,
// irreversible/outward action, low-confidence high-impact, repeated failure, scope expansion". A
// decision matching any of these ALWAYS asks — a confident preference match cannot license the
// orchestrator to e.g. force-push or email a customer on its own. Keyword set is deliberately
// conservative+broad: a false override (asking when we could have predicted) is cheap; a missed
// override (predicting an irreversible action) is the expensive failure.
const OVERRIDE_MARKERS = {
  // irreversible / destructive: cannot be undone.
  irreversible: [/\birreversible\b/i, /\bdelete\b/i, /\bdrop\b/i, /\bdestroy\b/i, /\bpurge\b/i,
    /\bforce[\s-]?push\b/i, /\boverwrit/i, /\bwipe\b/i, /\breset\s+--hard\b/i, /\brm\s+-rf\b/i,
    /\btruncate\b/i, /\brevoke\b/i],
  // outward-facing: visible to or affecting someone outside the loop.
  outward: [/\bpublish\b/i, /\bdeploy\b/i, /\brelease\b/i, /\bemail\b/i, /\bsend\b.*\b(message|email|notification)\b/i,
    /\bpost\b.*\b(public|comment|pr|issue)\b/i, /\bmerge\b.*\b(main|master|production)\b/i,
    /\bcustomer\b/i, /\bproduction\b/i, /\bprod\b/i, /\bopen\s+a?\s*pr\b/i, /\btweet\b/i],
  // high-impact: payments, credentials, infra, security.
  highImpact: [/\bpayment\b/i, /\bcharge\b/i, /\brefund\b/i, /\bmoney\b/i, /\btransfer\s+funds?\b/i,
    /\bcredential\b/i, /\bsecret\b/i, /\bapi[\s-]?key\b/i, /\btoken\b/i, /\bpassword\b/i,
    /\bsecurity\b/i, /\bpermission\b/i, /\bgrant\s+access\b/i, /\bbilling\b/i],
  // scope-expansion: the decision broadens the task beyond what was asked.
  scopeExpansion: [/\bscope\s+(expansion|creep|change)\b/i, /\bout\s+of\s+scope\b/i,
    /\bbeyond\s+(the\s+)?(scope|ask|request)\b/i, /\brefactor\s+(everything|the\s+whole)\b/i,
    /\brewrite\s+(everything|the\s+whole)\b/i, /\badd(itional)?\s+feature\b/i],
  // repeated-failure: we've tried and failed before — stop guessing, ask.
  repeatedFailure: [/\brepeated\s+failure\b/i, /\bkeeps?\s+failing\b/i, /\btried\s+\d+\s+times?\b/i,
    /\bstill\s+(failing|broken|fails)\b/i, /\bfailed\s+again\b/i, /\bretr(y|ied|ies)\b.*\bfail/i],
};
// Map of caller-supplied boolean flags → the override category they assert directly.
const FLAG_CATEGORIES = {
  irreversible: 'irreversible',
  outward: 'outward',
  outwardFacing: 'outward',
  highImpact: 'highImpact',
  scopeExpansion: 'scopeExpansion',
  repeatedFailure: 'repeatedFailure',
};

// hardOverride(query, opts) -> { override:boolean, category:string|null }.
// A caller flag asserts its category outright; otherwise the query is scanned for trigger keywords.
// Returns the FIRST category that fires (flags first, then keyword categories in declaration order).
function hardOverride(query, opts = {}) {
  for (const flag of Object.keys(FLAG_CATEGORIES)) {
    if (opts[flag] === true) return { override: true, category: FLAG_CATEGORIES[flag] };
  }
  const s = String(query == null ? '' : query);
  for (const cat of Object.keys(OVERRIDE_MARKERS)) {
    if (OVERRIDE_MARKERS[cat].some((re) => re.test(s))) return { override: true, category: cat };
  }
  return { override: false, category: null };
}

function round(x) { return Math.round((x || 0) * 1000) / 1000; }

// --- the gate -------------------------------------------------------------------------------------
// Decide ASK vs PREDICT for one pending decision.
//
//   decisionQuery : string — the pending decision/question we'd otherwise ask the user.
//   prefNotes     : array of candidate preference notes, each { title|label, summary, vec?, tags?,
//                   category? } (vec = 384-float embedding).
//   opts :
//     embedQuery(text) -> Promise<number[]|null>   // semantic path; null ⇒ lexical fallback.
//     cosine(a,b) -> number                          // required when embedQuery yields vectors.
//     lexScore(queryText, note) -> number            // fallback scorer.
//     preScored: bool                                // candidates carry `score` already (live path).
//     via: string                                    // scoring provenance label when preScored.
//     irreversible/outward/highImpact/scopeExpansion/repeatedFailure: bool  // hard-override flags.
//     ...threshold overrides (cosThreshold/gapThreshold/marginThreshold/requireEmpirical/localityThreshold).
//
// Returns { decision:'ask'|'predict', appliedNote?, reason, top1, margin, gap, locality, topType,
//           topKey, via, tagOverlap, sharedTags, override, overrideCategory }.
async function askGate(decisionQuery, prefNotes, opts = {}) {
  const cfg = {
    cosThreshold: opts.cosThreshold != null ? opts.cosThreshold : DEFAULTS.cosThreshold,
    gapThreshold: opts.gapThreshold != null ? opts.gapThreshold : DEFAULTS.gapThreshold,
    marginThreshold: opts.marginThreshold != null ? opts.marginThreshold : DEFAULTS.marginThreshold,
    requireEmpirical: opts.requireEmpirical != null ? opts.requireEmpirical : DEFAULTS.requireEmpirical,
    localityThreshold: opts.localityThreshold != null ? opts.localityThreshold : DEFAULTS.localityThreshold,
  };
  const queryText = String(decisionQuery == null ? '' : decisionQuery).trim();

  const ask = (reason, extra) => ({
    decision: 'ask', reason, top1: 0, margin: 0, gap: 0, locality: 0, topType: null, topKey: null,
    via: null, tagOverlap: 0, sharedTags: 0, override: false, overrideCategory: null, ...extra,
  });

  // HARD OVERRIDE first — short-circuits regardless of confidence. Checked before recall so an
  // irreversible/outward decision always asks even when a perfect preference match exists.
  const ov = hardOverride(queryText, opts);
  if (ov.override) {
    return ask('hard-override', { override: true, overrideCategory: ov.category });
  }

  if (!queryText) return ask('empty-query');
  const cands = Array.isArray(prefNotes) ? prefNotes : [];
  if (cands.length === 0) return ask('no-preference');

  // Score every candidate (semantic / lexical / pre-scored) — identical machinery to context-gate.
  let via = 'lexical';
  let scored;
  if (opts.preScored) {
    via = opts.via || 'lexical';
    scored = cands.map((n) => ({
      note: n, score: Number(n.score) || 0, key: n.key || n.id || n.title || n.label || '',
    })).sort((a, b) => b.score - a.score);
  } else {
    let qvec = null;
    if (typeof opts.embedQuery === 'function' && typeof opts.cosine === 'function') {
      qvec = await opts.embedQuery(queryText);
    }
    scored = cands.map((n) => {
      let score;
      if (qvec && typeof opts.cosine === 'function' && opts.expectedMeta && nodeVecs(n, { expectedMeta: opts.expectedMeta }).length > 0) {
        score = maxCosine(qvec, n, { expectedMeta: opts.expectedMeta }); via = 'semantic';
      } else if (qvec && !opts.expectedMeta && Array.isArray(n.vec) && typeof opts.cosine === 'function') {
        score = opts.cosine(qvec, n.vec); via = 'semantic';
      } else if (typeof opts.lexScore === 'function') {
        score = opts.lexScore(queryText, n);
      } else {
        score = 0;
      }
      return { note: n, score, key: n.key || n.id || n.title || n.label || '' };
    }).sort((a, b) => b.score - a.score);
  }

  const top1 = scored[0] ? scored[0].score : 0;
  const top2 = scored[1] ? scored[1].score : 0;
  const margin = top1 - top2;
  const topNote = scored[0] ? scored[0].note : null;
  const topType = classifyNoteType(noteText(topNote));
  const topKey = scored[0] ? scored[0].key : null;
  const taskTokens = new Set(contentTokens(queryText));
  const gap = externalGap(noteText(topNote), taskTokens);
  const locality = projectLocality(noteText(topNote));
  const queryTagList = normalizeTags(opts.tags);
  const noteTagList = normalizeTags(topNote && topNote.tags);
  let sharedTagCount = 0;
  if (queryTagList.length && noteTagList.length) {
    const noteTagSet = new Set(noteTagList);
    for (const t of queryTagList) if (noteTagSet.has(t)) sharedTagCount++;
  }
  const tagOv = tagOverlap(queryTagList, noteTagList);

  const base = {
    top1: round(top1), margin: round(margin), gap: round(gap), locality, topType, topKey, via,
    tagOverlap: round(tagOv), sharedTags: sharedTagCount, override: false, overrideCategory: null,
  };

  // finish() wraps every RECALL-BASED verdict (the ones below; hard-override/empty/no-preference
  // above are structural and never shadowed). It (1) attaches the learned model's shadow_decision/
  // shadow_conf for the journal, and (2) when the promotion mode is 'learned', swaps the LIVE decision
  // to the learned model's — recording heuristic_decision so the journal still has the heuristic call.
  // Hard-overrides never reach here, so the learned source can never license an irreversible action.
  const finish = (result) => {
    let shadow = null;
    if (_clf) { try { shadow = _clf.predict(base, opts.modelPath); } catch { shadow = null; } }
    const out = { ...result };
    if (shadow) { out.shadow_decision = shadow.decision; out.shadow_conf = round(shadow.conf); }
    const mode = opts.source || (_promote ? _promote.readMode(opts.modeDir) : 'heuristic');
    out.source = 'heuristic';
    if (mode === 'learned' && shadow) {
      out.heuristic_decision = result.decision;
      out.source = 'learned';
      if (shadow.decision !== result.decision) {
        out.decision = shadow.decision;
        out.reason = `learned:${shadow.decision}`;
        if (shadow.decision === 'predict') out.appliedNote = topNote; else delete out.appliedNote;
      }
    }
    return out;
  };

  // DEFAULT = ASK. Each guard must pass to flip to PREDICT.
  // 1. confidence floor — the preference must actually match the pending decision.
  if (!(top1 >= cfg.cosThreshold)) return finish(ask('low-confidence', base));
  // 2. only a concrete stated preference qualifies; a vague topical note does not (mirror of
  //    context-gate's empirical guard — a real preference reads as a decision/constraint, not advice).
  if (cfg.requireEmpirical && topType !== 'empirical') return finish(ask('non-empirical', base));
  // 3. specificity — the preference must be ABOUT this decision. Sharp standalone hit OR strong gap.
  const sharp = margin >= cfg.marginThreshold;
  const tagOnTask = queryTagList.length > 0 && (tagOv >= 0.5 || sharedTagCount >= 1);
  const onTask = gap >= cfg.gapThreshold || tagOnTask;
  if (!sharp && !onTask) return finish(ask('diffuse-match', base));
  // 4. project-locality — a preference phrased as general advice (in the model's prior) is not a
  //    user-specific signal worth predicting from. Require it to read as a local observation.
  if (cfg.localityThreshold > 0 && locality < cfg.localityThreshold) return finish(ask('non-local', base));

  const reason = sharp ? 'sharp-specific-preference'
    : tagOnTask ? 'tag-overlap-preference'
    : 'gap-specific-preference';
  return finish({ decision: 'predict', reason, appliedNote: topNote, ...base });
}

module.exports = { askGate, hardOverride, DEFAULTS, OVERRIDE_MARKERS };
