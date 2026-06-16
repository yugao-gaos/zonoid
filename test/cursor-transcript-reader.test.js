#!/usr/bin/env node
// Cursor transcript reader — path discovery, human-input parsing, adapter contract.
// Run: node test/cursor-transcript-reader.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cursorTx = require('../lib/cursor-transcripts');
const cursor = require('../lib/adapters/cursor');
const { CHARS_PER_TOKEN } = require('../lib/human-input');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

{
  const ws = '/Users/x/Desktop/zonoid';
  ok('encodeWorkspace strips leading slash', cursorTx.encodeWorkspace(ws) === 'Users-x-Desktop-zonoid');
  ok('projectDir under ~/.cursor/projects', cursorTx.projectDir(ws).includes(path.join('.cursor', 'projects', 'Users-x-Desktop-zonoid')));
  ok('transcriptsDir is agent-transcripts child', cursorTx.transcriptsDir(cursorTx.projectDir(ws)).endsWith('agent-transcripts'));
}

{
  ok('stripCursorEnvelope removes timestamp', cursorTx.stripCursorEnvelope('<timestamp>now</timestamp>hello') === 'hello');
  ok('stripCursorEnvelope removes user_query tags', cursorTx.stripCursorEnvelope('<user_query>\nfix bug\n</user_query>') === 'fix bug');
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-tx-'));
  try {
    const conv = 'conv-abc-123';
    const convDir = path.join(tmp, 'agent-transcripts', conv);
    fs.mkdirSync(path.join(convDir, 'subagents'), { recursive: true });
    const L = (o) => JSON.stringify(o);
    const main = [
      L({ role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Fri</timestamp>\n<user_query>\nhello cursor\n</user_query>' }] } }),
      L({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nsecond msg\n</user_query>' }] } }),
      L({ role: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
      L({ role: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(100) }] } }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(convDir, `${conv}.jsonl`), main);
    fs.writeFileSync(path.join(convDir, 'subagents', 'sub1.jsonl'), L({ role: 'user', message: { content: 'subagent only' } }) + '\n');

    const listed = cursorTx.listSessionTranscripts(tmp);
    ok('lists one main session', listed.length === 1 && listed[0].id === conv);
    ok('skips subagents dir', listed[0].path.endsWith(`${conv}.jsonl`));

    const human = cursorTx.humanInputTokens(tmp);
    const expectedChars = 'hello cursor'.length + 'second msg'.length;
    ok(`human chars counted (${expectedChars})`, human.chars === expectedChars);
    ok('human messages', human.messages === 2);
    ok('token estimate', human.tokens === Math.round(expectedChars / CHARS_PER_TOKEN));

    const missing = cursorTx.humanInputTokens(path.join(tmp, 'nope'));
    ok('missing dir returns zeros', missing.tokens === 0 && missing.files === 0);

    const mainTp = listed[0].path;
    ok('sessionTranscriptPath returns main', cursorTx.sessionTranscriptPath(mainTp, conv) === mainTp);
    ok('sessionTranscriptPath finds subagent', cursorTx.sessionTranscriptPath(mainTp, 'sub1').replace(/\\/g, '/').endsWith('subagents/sub1.jsonl'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  ok('adapter name cursor', cursor.name === 'cursor');
  ok('adapter source transcripts', cursor.transcripts.source === 'transcripts');
  ok('adapter projectDir', typeof cursor.transcripts.projectDir('/tmp/ws') === 'string');
  ok('adapter missing transcripts empty human', cursor.transcripts.humanInputTokens('/no/such/project', {}).tokens === 0);
  ok('adapter selfReported fallback', cursor.transcripts.selfReportedUsage({ w: { reported_usage: { output_tokens: 42 } } }).output_tokens === 42);
  ok('harness registers cursor', (() => {
    const h = require('../lib/harness');
    return h.get('cursor').name === 'cursor';
  })());
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
