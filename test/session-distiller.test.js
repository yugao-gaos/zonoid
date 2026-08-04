#!/usr/bin/env node
'use strict';

const {
  turnsFromTranscriptText,
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

const samples = [
  ['decision', 'I chose the existing extractor path because it reuses the review gate rather than adding a parser.'],
  ['question', 'Should the distiller keep transcript parsing offline for repeatable test fixtures?'],
  ['task', 'Task: add focused tests for each structured observation kind before wiring the CLI.'],
  ['hypothesis', 'Hypothesis: duplicate notes happen because session turns are distilled twice.'],
  ['outcome', 'Outcome: node test/session-distiller.test.js passed after the module split.'],
];

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
