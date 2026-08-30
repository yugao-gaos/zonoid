#!/usr/bin/env node
'use strict';

const {
  turnsFromTranscriptText,
  turnsFromRawTurns,
  observationsFromText,
  observationsFromTurns,
  candidatesFromText,
} = require('../lib/session-distiller');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

function kinds(text) {
  return observationsFromText(text, 0).map((o) => o.kind);
}

const transcript = [
  JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'ignored user turn' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'thinking', text: 'private reasoning should not leak' },
    { type: 'text', text: 'I chose the existing extractor path because it reuses the review gate rather than adding a parser.' },
  ] } }),
  'not-json',
  JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'text', text: 'Outcome: node test/session-distiller.test.js passed after the module split.' },
  ] } }),
].join('\n');

const turns = turnsFromTranscriptText(transcript);
ok('transcript extraction keeps assistant text turns only', turns.length === 2);
ok('transcript extraction indexes kept turns densely', turns[0].idx === 0 && turns[1].idx === 1);
ok('transcript extraction ignores thinking blocks', !turns[0].text.includes('private reasoning'));
ok('legacy transcript extraction attributes assistant source', turns.every((turn) => turn.source_role === 'assistant'));

const attributedTranscript = [
  JSON.stringify({ type: 'system', message: { content: [{ type: 'text', text: 'Always keep behavioral guidance private from factual answers.' }] } }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'I decided to keep reviews concise because long summaries hide the verdict.' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hypothesis: source confusion happens because roles are discarded.' }] } }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Outcome: the provenance regression test passed successfully.' }] } }),
  JSON.stringify({ type: 'artifact', message: { content: [{ type: 'document', content: 'Result: the artifact records a stable release identifier.' }] } }),
].join('\n');

const attributedTurns = turnsFromTranscriptText(attributedTranscript, {
  include_all_sources: true,
  session_id: 'session-42',
  transcript_ref: '/tmp/session-42.jsonl',
});
ok('attributed extraction keeps each public source distinct',
  ['system', 'user', 'assistant', 'tool', 'artifact'].every((role) => attributedTurns.some((turn) => turn.source_role === role)));
ok('attributed extraction preserves episode turn and span', attributedTurns.every((turn) =>
  turn.episode && turn.episode.session_id === 'session-42' && turn.episode.transcript_ref === '/tmp/session-42.jsonl'
  && Number.isInteger(turn.episode.turn) && turn.episode.span.end === turn.text.length));

const attributedObservations = observationsFromTurns(attributedTurns);
const userDirective = attributedObservations.find((item) => item.source_role === 'user');
const assistantInference = attributedObservations.find((item) => item.source_role === 'assistant');
const toolObservation = attributedObservations.find((item) => item.source_role === 'tool');
const artifactObservation = attributedObservations.find((item) => item.source_role === 'artifact');
ok('user directive becomes guidance without losing role', userDirective && userDirective.memory_lane === 'guidance' && userDirective.authority === 'directive');
ok('assistant conclusion remains attributed inference evidence', assistantInference && assistantInference.memory_lane === 'evidence' && assistantInference.authority === 'inference');
ok('tool result remains attributed observation evidence', toolObservation && toolObservation.memory_lane === 'evidence' && toolObservation.authority === 'observation');
ok('artifact result remains attributed observation evidence', artifactObservation && artifactObservation.memory_lane === 'evidence' && artifactObservation.authority === 'observation');

const rawTurns = turnsFromRawTurns([{ text: samplesText(), role: 'tool', confidence: 0.82, episode: { turn_index: 4, span: { start: 1, end: 8 } } }]);
ok('raw turn normalization preserves supplied confidence and episode', rawTurns[0].source_role === 'tool'
  && rawTurns[0].confidence === 0.82 && rawTurns[0].episode.turn === 4 && rawTurns[0].episode.span.start === 1);

const samples = [
  ['decision', 'I chose the existing extractor path because it reuses the review gate rather than adding a parser.'],
  ['question', 'Should the distiller keep transcript parsing offline for repeatable test fixtures?'],
  ['task', 'Task: add focused tests for each structured observation kind before wiring the CLI.'],
  ['hypothesis', 'Hypothesis: duplicate notes happen because session turns are distilled twice.'],
  ['outcome', 'Outcome: node test/session-distiller.test.js passed after the module split.'],
];

function samplesText() {
  return 'Outcome: a raw tool observation was verified by the focused test.';
}

for (const [kind, text] of samples) {
  ok(`${kind} sample emits ${kind}`, kinds(text).includes(kind));
}

const chatter = [
  'Let me read the relevant files first so I can match the surrounding style.',
  "I'll run the smoke test now and check the output.",
  "Here's the diff. Looks good. Done.",
];
for (const text of chatter) {
  ok(`chatter emits no observations: ${text.slice(0, 24)}`, observationsFromText(text, 0).length === 0);
}

const all = observationsFromTurns(turns);
ok('observationsFromTurns extracts structured observations', all.some((o) => o.kind === 'decision') && all.some((o) => o.kind === 'outcome'));
ok('observation shape includes kind/title/summary/knowledge', all.every((o) => o.kind && o.title && o.summary && Array.isArray(o.knowledge)));

const decisionCandidate = candidatesFromText(samples[0][1], 3)[0];
ok('decision candidate API remains record_decision-compatible', decisionCandidate && decisionCandidate.title && decisionCandidate.summary && Array.isArray(decisionCandidate.knowledge));
ok('decision candidate keeps auto-extract origin', decisionCandidate.knowledge.includes('origin:auto-extract'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
