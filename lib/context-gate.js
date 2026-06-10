// Context-need gate — abstain-by-default retrieval-confidence classifier.
//
// THE PROBLEM (from bench/report-v2..v7): on self-solvable tasks, every ON arm did MORE hardness
// than OFF — the over-deliberation tax. Injecting context the model didn't need is not free: it
// pays a consult-overhead `C` (cache cost to hold the graph) AND nudges the model into extra
// deliberation. So the orchestrator must DECIDE, per task, whether to RETRIEVE/INJECT context or
// ABSTAIN. Default = ABSTAIN. Inject ONLY on a high-confidence, specific, EMPIRICAL match.
//
// SIGNAL (all from the existing semantic KB — no new model, no new infra):
//   top1   = best cosine of (task label+summary[+spec]) against note vectors. A SHARP specific
//            match scores high; diffuse topical noise scores low.
//   margin = top1 - top2. A genuinely specific hit stands ALONE above the field; a vague topical
//            match drags up a cluster of near-ties (small margin). Margin separates "this exact
//            scar applies" from "we have lots of vaguely-related notes".
//   type   = note-TYPE of the top hit. Only EMPIRICAL scar-tissue qualifies — a gotcha, a decision
//            with a reason, a root-cause. General PRINCIPLES ("always prefer X", "best practice")
//            do NOT: the base model already knows those, so injecting them is pure overhead.
//
// DECISION (recalibrated against the FIRST real positive — see below). INJECT iff:
//     (top1 >= cosThreshold) AND (top is EMPIRICAL) AND (externalGap >= gapThreshold)
//           [OR a sharp standalone hit: (top1 >= cosThreshold) AND empirical AND margin >= marginThreshold]
//           Otherwise ABSTAIN. Conservative by construction — when in doubt, abstain.
//
// WHY THE THRESHOLDS MOVED (held-out task→transcript win, the first positive label):
//   On the held-out resolveOwner task the load-bearing note (note-mq7kyiir6sx — "exact-session
//   resolution silently drops ~40% of tasks; add window-overlap correlation") scored top1 cosine
//   = 0.548, top2 = 0.531, so MARGIN = 0.017. The old gate (cos>=0.55 AND margin>=0.12) ABSTAINED
//   and would have MISSED the win twice over. The cause is structural, not a tuning miss: MiniLM
//   pulls a whole cluster of topically-adjacent orchestrator notes into a tight 0.50–0.55 band, so
//   neither a raw cosine cut at ~0.51 NOR a margin cut separates the true positive from useless-but-
//   topical matches. Lowering cosine alone re-admits the cluster (regret would climb); margin can
//   never fire inside a near-tie cluster.
//   The signal that DOES separate them is the EXTERNAL-GAP: the fraction of the note's own content
//   tokens that also appear in the task text. A note genuinely ABOUT this task shares concrete
//   vocabulary with it (assignee/transcript/session/window/resolve…); a note that merely embeds
//   nearby does not. Empirically over the live KB: positive externalGap = 0.34 vs every topical
//   negative <= 0.17 — a wide, clean margin where cosine and margin both collapse.
//
// This module is PURE + offline-friendly: it takes already-embedded notes (or falls back to a
// lexical scorer) so it can be unit-tested and run over bench transcripts without standing up the
// daemon. The daemon can wire it to live search_knowledge by passing embedded note nodes + an
// embed() for the query.
'use strict';

// PROVISIONAL thresholds — calibrated on n=1 positive (the held-out task→transcript win) plus the
// v1–v7 + topical-cluster negatives. n=1 is too few to fix these confidently; treat them as a
// starting point to be firmed up by task #9's second positive label. The OLD conservative defaults
// (0.55 / 0.12 / empirical) abstained on the only real win we have — see header.
const DEFAULTS = {
  cosThreshold: 0.50,    // top-1 cosine floor — lowered from 0.55 (positive sat at 0.548); the gap
                         // signal, not cosine, now does the discrimination work.
  gapThreshold: 0.25,    // EXTERNAL-GAP: fraction of the top note's content tokens that recur in the
                         // task. Separates the on-task scar (0.34) from the topical cluster (<=0.17).
  marginThreshold: 0.12, // alt path only: a SHARP standalone hit can inject without the gap test.
  requireEmpirical: true, // only scar-tissue (gotcha/decision/root-cause) qualifies; principles don't
};

// --- note-TYPE classifier -------------------------------------------------------------------------
// Notes carry no explicit type field (see lib/overlay.js addNoteNode), so we INFER it from text.
// EMPIRICAL scar-tissue = a concrete, learned-the-hard-way fact: a gotcha, a root cause, or a
// decision-with-a-reason. These are the notes whose absence actually costs a re-run. GENERAL
// principles are advice the base model already holds; injecting them is the over-deliberation tax.
const EMPIRICAL_MARKERS = [
  /\bgotcha\b/i, /\bfails?\s+(on|when|because|if)\b/i, /\bbroke[sn]?\b/i, /\bregress(ion|ed)?\b/i,
  /\broot[\s-]?cause\b/i, /\bbecause\b/i, /\bturns?\s+out\b/i, /\bactually\b/i,
  /\buse\s+\S+\s+not\s+\S+/i, /\bdon'?t\s+use\b/i, /\bmust\s+(not\s+)?\b/i, /\bonly\s+works?\b/i,
  /\bchose\s+\S+\s+over\b/i, /\bdecided\b/i, /\bworkaround\b/i, /\bpin(?:ned)?\b.*\bversion\b/i,
  /\bv?\d+\.\d+(?:\.\d+)?\b/, /\berror[:\s]/i, /\bexit\s*code\b/i, /\bself-signed\b/i,
  /\bissuer[\s-]trust\b/i, /\bhijack\b/i, /\bidempotenc/i,
  // added when recalibrating against the first positive (note-mq7kyiir6sx): an empirically-observed
  // silent failure / a stated wrong-approach / a measured hit-rate are scar-tissue, not principle.
  /\bsilently\b/i, /\bis\s+wrong\b/i, /\brecover(?:ed|s|y)?\s+only\b/i, /~?\d+\s?%/,
];
// Markers of GENERAL advice the base model already knows — these DISQUALIFY a note from EMPIRICAL
// (unless an empirical marker also fires AND the note is specific). Pure-principle phrasing only.
const PRINCIPLE_MARKERS = [
  /\balways\b/i, /\bnever\b/i, /\bin\s+general\b/i, /\bbest\s+practice\b/i, /\bprefer\b/i,
  /\bgenerally\b/i, /\bas\s+a\s+rule\b/i, /\bshould\s+(?:try\s+to\s+)?(?:keep|aim|consider)\b/i,
  /\bremember\s+to\b/i, /\bmake\s+sure\s+to\b/i,
];

// Classify a note's text as 'empirical' | 'principle' | 'neutral'.
//   empirical: has a concrete failure/decision/root-cause signature.
//   principle: reads as general advice (and lacks a concrete signature).
//   neutral:   neither — a bare statement; treated as NON-empirical (does not qualify for inject).
function classifyNoteType(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return 'neutral';
  const empirical = EMPIRICAL_MARKERS.some((re) => re.test(s));
  const principle = PRINCIPLE_MARKERS.some((re) => re.test(s));
  // Empirical signature wins even if a principle word also appears (a real scar often says "always
  // X because <concrete failure>"). A note with ONLY principle phrasing is a principle. Bare → neutral.
  if (empirical) return 'empirical';
  if (principle) return 'principle';
  return 'neutral';
}

function noteText(n) {
  if (!n) return '';
  return `${n.title || n.label || ''} ${n.summary || ''}`.trim();
}

// --- external-gap signal --------------------------------------------------------------------------
// The discriminator that cosine+margin miss inside a tight topical cluster (see header). It measures
// how much of the NOTE is actually ABOUT this task: the fraction of the note's own content tokens
// that recur in the task text. A scar that genuinely applies shares concrete vocabulary with the
// task (the entities/operations it's about); a note that merely embeds nearby — general orchestrator
// chatter — does not. Pure lexical, so it runs identically in the offline eval and the live daemon.
const STOPWORDS = new Set(('the a an of to and or is are be on in for with that this it as by at from '
  + 'into your you our we their its than not no off but if then else when where which who what how do '
  + 'does done make made take return returns given via').split(' '));
function contentTokens(s) {
  return (String(s == null ? '' : s).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [])
    .filter((t) => !STOPWORDS.has(t));
}
// externalGap(noteText, taskTokenSet) -> fraction of note content tokens present in the task. 0 when
// the note is empty.
function externalGap(text, taskTokens) {
  const nt = contentTokens(text);
  if (!nt.length) return 0;
  let shared = 0;
  for (const t of nt) if (taskTokens.has(t)) shared++;
  return shared / nt.length;
}

// --- the gate -------------------------------------------------------------------------------------
// Decide INJECT vs ABSTAIN for one task.
//
//   task  : { label, summary, spec? }  — what we're about to run.
//   notes : array of candidate notes, each { title|label, summary, vec? } (vec = 384-float embedding).
//   opts  :
//     embedQuery(text) -> Promise<number[]|null>   // semantic path; null ⇒ lexical fallback.
//     cosine(a,b) -> number                          // required when embedQuery yields vectors.
//     lexScore(queryText, note) -> number            // fallback scorer (e.g. scoreNodeAgainstTokens).
//     ...threshold overrides (cosThreshold/marginThreshold/requireEmpirical).
//
// Returns { decision:'inject'|'abstain', top1, margin, topType, topKey, via, reason }.
async function gateTask(task, notes, opts = {}) {
  const cfg = {
    cosThreshold: opts.cosThreshold != null ? opts.cosThreshold : DEFAULTS.cosThreshold,
    gapThreshold: opts.gapThreshold != null ? opts.gapThreshold : DEFAULTS.gapThreshold,
    marginThreshold: opts.marginThreshold != null ? opts.marginThreshold : DEFAULTS.marginThreshold,
    requireEmpirical: opts.requireEmpirical != null ? opts.requireEmpirical : DEFAULTS.requireEmpirical,
  };
  const queryText = [task && task.label, task && task.summary, task && task.spec]
    .filter(Boolean).join(' ').trim();

  const abstain = (reason, extra) => ({
    decision: 'abstain', top1: 0, margin: 0, gap: 0, topType: null, topKey: null, via: null, reason, ...extra,
  });

  if (!queryText) return abstain('empty-query');
  const cands = Array.isArray(notes) ? notes : [];
  if (cands.length === 0) return abstain('no-notes');

  // Score every candidate. SEMANTIC when the query embeds AND the note has a vector; else LEXICAL.
  let via = 'lexical';
  let qvec = null;
  if (typeof opts.embedQuery === 'function' && typeof opts.cosine === 'function') {
    qvec = await opts.embedQuery(queryText);
  }
  const scored = cands.map((n) => {
    let score;
    if (qvec && Array.isArray(n.vec) && typeof opts.cosine === 'function') {
      score = opts.cosine(qvec, n.vec); via = 'semantic';
    } else if (typeof opts.lexScore === 'function') {
      score = opts.lexScore(queryText, n);
    } else {
      score = 0;
    }
    return { note: n, score, key: n.key || n.id || n.title || n.label || '' };
  }).sort((a, b) => b.score - a.score);

  const top1 = scored[0] ? scored[0].score : 0;
  const top2 = scored[1] ? scored[1].score : 0;
  const margin = top1 - top2;
  const topNote = scored[0] ? scored[0].note : null;
  const topType = classifyNoteType(noteText(topNote));
  const topKey = scored[0] ? scored[0].key : null;
  const taskTokens = new Set(contentTokens(queryText));
  const gap = externalGap(noteText(topNote), taskTokens);

  const base = { top1: round(top1), margin: round(margin), gap: round(gap), topType, topKey, via };

  // DEFAULT = ABSTAIN. Each guard must pass to flip to INJECT.
  // 1. confidence floor (lowered to 0.50 — the real positive sat at 0.548, inside a topical cluster).
  if (!(top1 >= cfg.cosThreshold)) return abstain('low-confidence', base);
  // 2. only empirical scar-tissue qualifies; principles the base model already knows do not.
  if (cfg.requireEmpirical && topType !== 'empirical') return abstain('non-empirical', base);
  // 3. specificity — the note must be ABOUT this task. Inside a tight cosine cluster (margin tiny),
  //    cosine/margin can't tell the scar from topical noise; the EXTERNAL-GAP can. Accept EITHER a
  //    sharp standalone hit (large margin) OR a strong external-gap (note shares the task's concrete
  //    vocabulary). This is the provisional recalibration off the first positive.
  const sharp = margin >= cfg.marginThreshold;
  const onTask = gap >= cfg.gapThreshold;
  if (!sharp && !onTask) return abstain('diffuse-match', base);

  return { decision: 'inject', reason: sharp ? 'sharp-specific-empirical' : 'gap-specific-empirical', ...base };
}

function round(x) { return Math.round((x || 0) * 1000) / 1000; }

module.exports = { gateTask, classifyNoteType, noteText, externalGap, contentTokens, DEFAULTS };
