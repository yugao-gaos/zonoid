#!/usr/bin/env node
// Plain Node test for lib/human-input.js — the autonomy-score denominator (genuinely human-TYPED
// tokens). Run: node test/human-input.test.js — exits non-zero on any failure.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { humanInputTokens, countFile, stripInjected, CHARS_PER_TOKEN } = require('../lib/human-input');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// --- stripInjected ------------------------------------------------------------------------------
ok('strip: system-reminder removed', stripInjected('<system-reminder>noise</system-reminder>hello') === 'hello');
ok('strip: command tags removed', stripInjected('<command-name>/x</command-name><command-args>a</command-args>hi') === 'hi');
ok('strip: local-command-stdout removed', stripInjected('ok<local-command-stdout>dump</local-command-stdout>') === 'ok');
ok('strip: trailing router verdict removed', stripInjected('do the thing\n[Orchestrator router] decision: solo because...') === 'do the thing');

// --- transcript fixtures ------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'human-input-'));
try {
  const L = (o) => JSON.stringify(o);
  const main = [
    // counted: plain typed string (5 chars)
    L({ type: 'user', timestamp: '2026-06-10T12:00:00.000Z', message: { content: 'hello' } }),
    // counted: list content with a text part (7 chars)
    L({ type: 'user', timestamp: '2026-06-10T12:01:00.000Z', message: { content: [{ type: 'text', text: 'do this' }] } }),
    // counted after stripping the injected block (2 chars: "yo")
    L({ type: 'user', timestamp: '2026-06-10T12:02:00.000Z', message: { content: '<system-reminder>big injected blob</system-reminder>yo' } }),
    // NOT typing: tool_result payloads
    L({ type: 'user', timestamp: '2026-06-10T12:03:00.000Z', message: { content: [{ type: 'tool_result', content: 'x'.repeat(500) }] } }),
    // NOT typing: sidechain / meta / assistant lines
    L({ type: 'user', isSidechain: true, timestamp: '2026-06-10T12:04:00.000Z', message: { content: 'subagent prompt' } }),
    L({ type: 'user', isMeta: true, timestamp: '2026-06-10T12:05:00.000Z', message: { content: 'meta line' } }),
    L({ type: 'assistant', timestamp: '2026-06-10T12:06:00.000Z', message: { content: 'reply', usage: { output_tokens: 9 } } }),
    // dropped automation prompts (counted in .dropped, not .chars)
    L({ type: 'user', timestamp: '2026-06-10T12:07:00.000Z', message: { content: '<task-notification>task done</task-notification> go' } }),
    L({ type: 'user', timestamp: '2026-06-10T12:08:00.000Z', message: { content: '=== CANDIDATES ===\n1. foo' } }),
    // before the since-cutoff used below (4 chars when unbounded)
    L({ type: 'user', timestamp: '2026-06-09T09:00:00.000Z', message: { content: 'old!' } }),
    'not json at all',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(tmp, 'sess-main.jsonl'), main);
  // a subagent transcript in a SUBDIR — must be ignored (only top-level *.jsonl are main sessions)
  fs.mkdirSync(path.join(tmp, 'subagents'));
  fs.writeFileSync(path.join(tmp, 'subagents', 'agent.jsonl'), L({ type: 'user', timestamp: '2026-06-10T12:00:00.000Z', message: { content: 'agent-side prompt that is long' } }) + '\n');
  // a non-jsonl top-level file — ignored
  fs.writeFileSync(path.join(tmp, 'notes.txt'), 'user typed nothing here');

  const all = humanInputTokens(tmp);
  // counted chars: 5 ("hello") + 7 ("do this") + 2 ("yo") + 4 ("old!") = 18
  ok(`all-time: chars counted from typed text only (18, got ${all.chars})`, all.chars === 18);
  ok('all-time: 4 human messages', all.messages === 4);
  ok('all-time: 2 automation prompts dropped', all.dropped === 2);
  ok('all-time: token estimate = round(chars/3.8)', all.tokens === Math.round(18 / CHARS_PER_TOKEN));
  ok('all-time: subagents/ and non-jsonl ignored (1 file)', all.files === 1);

  const sliced = humanInputTokens(tmp, { since: '2026-06-10T00:00:00' });
  ok('since: pre-cutoff typing excluded (14 chars)', sliced.chars === 14 && sliced.messages === 3);

  const missing = humanInputTokens(path.join(tmp, 'nope'));
  ok('missing project dir: zeros, no throw', missing.tokens === 0 && missing.files === 0);

  const single = countFile(path.join(tmp, 'sess-main.jsonl'), null);
  ok('countFile matches the aggregate', single.chars === 18 && single.messages === 4 && single.dropped === 2);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
