'use strict';

// A "solo turn" is the assistant's own prose (text blocks) for one assistant message.
// We concatenate text blocks; thinking/tool blocks are ignored.
function turnsFromTranscriptText(text) {
  const lines = String(text || '').split('\n').filter(Boolean);
  const turns = [];
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'assistant') continue;
    const content = ev.message && ev.message.content;
    if (!Array.isArray(content)) continue;
    const turnText = textFromContentBlocks(content);
    if (turnText) turns.push({ text: turnText, idx: turns.length });
  }
  return turns;
}

function turnsFromRawTurns(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((t, i) => ({
    text: typeof t === 'string' ? t : t && t.text,
    idx: t && Number.isInteger(t.idx) ? t.idx : i,
  }));
}

function textFromContentBlocks(content) {
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// Cue phrases that flag a durable decision / finding / constraint, each with a weight.
// STRONG cues (>=1.5) clear the precision gate on their own. WEAK cues (1.0) need
// another cue or a reason connective to qualify.
const DECISION_CUES = [
  { re: /\bchose\b|\bchoosing\b|\bdecided to\b|\bdecision\b|\bwent with\b|\bopted (?:for|to)\b|\bsettled on\b/i, w: 1.5 },
  { re: /\bturns out\b|\bit turns out\b|\bthe (?:root )?cause (?:is|was)\b|\bthe key (?:insight|finding)\b/i, w: 1.5 },
  { re: /\bgotcha\b|\bcaveat\b|\bconstraint\b|\bmust (?:not|never|always)\b|\bcan(?:not|'t) be\b/i, w: 1.5 },
  { re: /\b(?:because|since|so that|in order to|the reason)\b.*\b(?:rather than|instead of|over|vs\.?)\b/i, w: 1.5 },
  { re: /\brather than\b|\binstead of\b|\bover (?:the )?alternative\b/i, w: 1.0 },
  { re: /\bthe trick is\b|\bthe fix is\b|\bthe approach is\b|\bwe (?:should|need to|must)\b/i, w: 1.0 },
];

const TRANSIENT = [
  /\b(?:let me|i'?ll|i will|now i'?ll|next,? i)\b/i,
  /\b(?:running|reading|looking at|checking|opening|let'?s see|first,? )\b/i,
  /\b(?:here'?s|here is) (?:the|a|what)\b/i,
  /\bdone\b\.?$|\ball set\b|\blooks good\b|\bgreat\b[.!]/i,
];

const REASON = /\b(because|since|so that|in order to|to avoid|to prevent|which means|so it|otherwise)\b/i;

const QUESTION_CUES = [
  /^(?:open )?question\s*:/i,
  /\?$/,
];

const TASK_CUES = [
  /^(?:todo|task|follow-?up|next step|remaining work)\s*:/i,
  /\b(?:need to|needs to|should|must)\s+(?:add|fix|update|write|verify|refactor|extract|preserve|remove|implement|document)\b/i,
];

const HYPOTHESIS_CUES = [
  /^(?:hypothesis|hunch|theory)\s*:/i,
  /\b(?:hypothesis|my hunch|my theory|i suspect|we suspect|likely caused by|might be caused by|may be due to)\b/i,
];

const OUTCOME_CUES = [
  /^(?:outcome|result)\s*:/i,
  /\b(?:outcome|result is|tests? passed|verified that|confirmed that|fixed by|resolved by)\b/i,
];

function splitSentences(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[-*\d.)\s]+/, '').trim())
    .filter((s) => s.length >= 25 && s.length <= 400);
}

function scoreSentence(s) {
  let score = 0;
  let cueHits = 0;
  for (const c of DECISION_CUES) if (c.re.test(s)) { score += c.w; cueHits += 1; }
  if (REASON.test(s)) score += 1;
  for (const re of TRANSIENT) if (re.test(s)) score -= 1.5;
  if (cueHits === 0 && !REASON.test(s)) score -= 2;
  return { score, cueHits };
}

function titleFromSentence(s) {
  let t = s
    .replace(/^(so|and|but|because|since|thus|therefore|we|i|the reason is that|note that)\b[,:\s]*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (t.length > 72) t = t.slice(0, 69).replace(/\s+\S*$/, '') + '…';
  return t;
}

function titleFromObservation(s) {
  return titleFromSentence(s)
    .replace(/^(Decision|Question|Task|Todo|Follow-?up|Next step|Hypothesis|Hunch|Theory|Outcome|Result):\s*/i, '')
    .trim();
}

function isTransient(s) {
  return TRANSIENT.some((re) => re.test(s));
}

function candidatesFromText(text, turnIdx) {
  const out = [];
  for (const s of splitSentences(text)) {
    const { score, cueHits } = scoreSentence(s);
    if (score < 1.5) continue;
    out.push({
      title: titleFromSentence(s),
      summary: s,
      knowledge: [
        'origin:auto-extract',
        `turn:${turnIdx}`,
        `signal:${cueHits ? 'decision-cue' : 'reason'}`,
      ],
      _score: roundScore(score),
      _turn: turnIdx,
    });
  }
  return out;
}

function observationsFromText(text, turnIdx) {
  const out = [];
  for (const s of splitSentences(text)) {
    const obs = observationFromSentence(s, turnIdx);
    if (obs) out.push(obs);
  }
  return out;
}

function observationsFromTurn(turn) {
  if (!turn || typeof turn.text !== 'string') return [];
  return observationsFromText(turn.text, Number.isInteger(turn.idx) ? turn.idx : 0);
}

function observationsFromTurns(turns) {
  const out = [];
  for (const turn of turns || []) out.push(...observationsFromTurn(turn));
  return out;
}

function observationsFromTranscriptText(text) {
  return observationsFromTurns(turnsFromTranscriptText(text));
}

function observationFromSentence(s, turnIdx) {
  const decision = decisionMatch(s);
  if (decision) return makeObservation('decision', s, turnIdx, decision.score, decision.signal);
  const question = cueMatch(s, QUESTION_CUES, 'question');
  if (question) return makeObservation('question', s, turnIdx, question.score, question.signal);
  const task = cueMatch(s, TASK_CUES, 'task');
  if (task) return makeObservation('task', s, turnIdx, task.score, task.signal);
  const hypothesis = cueMatch(s, HYPOTHESIS_CUES, 'hypothesis');
  if (hypothesis) return makeObservation('hypothesis', s, turnIdx, hypothesis.score, hypothesis.signal);
  const outcome = cueMatch(s, OUTCOME_CUES, 'outcome');
  if (outcome) return makeObservation('outcome', s, turnIdx, outcome.score, outcome.signal);
  return null;
}

function decisionMatch(s) {
  const { score, cueHits } = scoreSentence(s);
  if (score < 1.5) return null;
  return { score, signal: cueHits ? 'decision-cue' : 'reason' };
}

function cueMatch(s, cues, signal) {
  if (isTransient(s)) return null;
  if (!cues.some((re) => re.test(s))) return null;
  return { score: 1.5, signal };
}

function makeObservation(kind, sentence, turnIdx, score, signal) {
  return {
    kind,
    title: titleFromObservation(sentence),
    summary: sentence,
    knowledge: [
      'origin:auto-distill',
      `kind:${kind}`,
      `turn:${turnIdx}`,
      `signal:${signal}`,
    ],
    _score: roundScore(score),
    _turn: turnIdx,
  };
}

function roundScore(score) {
  return Math.round(score * 100) / 100;
}

function dedupSelf(cands) {
  const seen = new Set();
  const out = [];
  for (const c of cands.sort((a, b) => b._score - a._score)) {
    const key = c.summary.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

module.exports = {
  turnsFromTranscriptText,
  turnsFromRawTurns,
  observationsFromTranscriptText,
  observationsFromText,
  observationsFromTurn,
  observationsFromTurns,
  candidatesFromText,
  splitSentences,
  scoreSentence,
  titleFromSentence,
  dedupSelf,
};
