'use strict';

// The default remains the legacy "solo turn" view: assistant prose only. Callers that need
// lossless source attribution can pass { include_all_sources:true, session_id, transcript_ref }.
// Public user/system text, tool results, and artifact observations then become distinct turns;
// thinking blocks remain private and are never distilled.
function turnsFromTranscriptText(text, options = {}) {
  const lines = String(text || '').split('\n').filter(Boolean);
  const turns = [];
  const includeAll = options.include_all_sources === true || options.includeSources === true;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const content = ev.message && ev.message.content;
    if (!Array.isArray(content)) continue;
    for (const record of transcriptRecords(ev, content, includeAll)) {
      turns.push(normalizeTurn({
        ...record,
        idx: turns.length,
        confidence: ev.confidence,
        episode: {
          session_id: options.session_id,
          transcript_ref: options.transcript_ref,
          turn: lineIdx,
          span: { start: 0, end: record.text.length },
        },
      }, turns.length));
    }
  }
  return turns;
}

function turnsFromRawTurns(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((t, i) => normalizeTurn(
    typeof t === 'string' ? { text: t, idx: i } : t,
    i,
  ));
}

function transcriptRecords(ev, content, includeAll) {
  const eventRole = normalizeSourceRole(ev.type || (ev.message && ev.message.role));
  if (!includeAll && eventRole !== 'assistant') return [];
  if (!includeAll) {
    const assistantText = textFromContentBlocks(content);
    return assistantText ? [{ text: assistantText, source_role: 'assistant' }] : [];
  }

  const records = [];
  const publicText = content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (publicText) records.push({ text: publicText, source_role: eventRole });

  for (const block of content) {
    if (!block || block.type === 'thinking' || block.type === 'text') continue;
    if (block.type === 'tool_result' || block.type === 'tool') {
      const toolText = textFromNestedContent(block.content ?? block.text);
      if (toolText) records.push({ text: toolText, source_role: 'tool' });
    } else if (block.type === 'artifact' || block.type === 'document') {
      const artifactText = textFromNestedContent(block.content ?? block.text);
      if (artifactText) records.push({ text: artifactText, source_role: 'artifact' });
    }
  }
  return records;
}

function textFromNestedContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => typeof item === 'string' ? item : (item && typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function normalizeSourceRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'tool_result') return 'tool';
  return ['user', 'assistant', 'tool', 'artifact', 'system'].includes(role) ? role : 'unknown';
}

function normalizeTurn(turn, fallbackIdx) {
  const t = turn && typeof turn === 'object' ? turn : {};
  const normalized = {
    text: t.text,
    idx: Number.isInteger(t.idx) ? t.idx : fallbackIdx,
    source_role: normalizeSourceRole(t.source_role || t.role),
  };
  if (t.memory_lane === 'evidence' || t.memory_lane === 'guidance') normalized.memory_lane = t.memory_lane;
  if (['directive', 'observation', 'inference'].includes(t.authority)) normalized.authority = t.authority;
  if (typeof t.confidence === 'number' && Number.isFinite(t.confidence)) {
    normalized.confidence = Math.max(0, Math.min(1, t.confidence));
  }
  const episode = normalizeEpisode(t.episode);
  if (episode) normalized.episode = episode;
  return normalized;
}

function normalizeEpisode(value) {
  if (!value || typeof value !== 'object') return null;
  const episode = {};
  const sessionId = value.session_id ?? value.session;
  const transcriptRef = value.transcript_ref ?? value.transcript;
  const turn = value.turn ?? value.turn_index;
  if (sessionId != null && String(sessionId).trim()) episode.session_id = String(sessionId).slice(0, 500);
  if (transcriptRef != null && String(transcriptRef).trim()) episode.transcript_ref = String(transcriptRef).slice(0, 2000);
  if (Number.isInteger(turn) && turn >= 0) episode.turn = turn;
  if (value.span && typeof value.span === 'object') {
    const start = Number(value.span.start);
    const end = Number(value.span.end);
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start) {
      episode.span = { start, end };
    }
  }
  return Object.keys(episode).length ? episode : null;
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

function candidatesFromText(text, turnIdx, provenance) {
  const out = [];
  for (const s of splitSentences(text)) {
    const { score, cueHits } = scoreSentence(s);
    if (score < 1.5) continue;
    out.push(withProvenance({
      title: titleFromSentence(s),
      summary: s,
      knowledge: [
        'origin:auto-extract',
        `turn:${turnIdx}`,
        `signal:${cueHits ? 'decision-cue' : 'reason'}`,
      ],
      _score: roundScore(score),
      _turn: turnIdx,
    }, provenance, 'decision', s));
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
  return observationsFromText(turn.text, Number.isInteger(turn.idx) ? turn.idx : 0)
    .map((observation) => withProvenance(observation, turn, observation.kind, observation.summary));
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

function withProvenance(item, provenance, kind, sentence) {
  if (!provenance || typeof provenance !== 'object') return item;
  const role = normalizeSourceRole(provenance.source_role || provenance.role);
  const directive = role === 'system' || (role === 'user' && (
    kind === 'task'
    || /\b(?:prefer|please|must|always|never|should|need to|decided to|chose|went with|opted|settled on)\b/i.test(sentence)
  ));
  const explicitAuthority = ['directive', 'observation', 'inference'].includes(provenance.authority)
    ? provenance.authority : null;
  const explicitLane = ['evidence', 'guidance'].includes(provenance.memory_lane)
    ? provenance.memory_lane : null;
  item.source_role = role;
  item.authority = explicitAuthority || (directive ? 'directive'
    : (role === 'assistant' ? 'inference' : 'observation'));
  item.memory_lane = explicitLane || (directive ? 'guidance' : 'evidence');
  if (typeof provenance.confidence === 'number' && Number.isFinite(provenance.confidence)) {
    item.confidence = Math.max(0, Math.min(1, provenance.confidence));
  }
  const episode = normalizeEpisode(provenance.episode);
  if (episode) item.episode = episode;
  return item;
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
  normalizeSourceRole,
  normalizeEpisode,
  splitSentences,
  scoreSentence,
  titleFromSentence,
  dedupSelf,
};
