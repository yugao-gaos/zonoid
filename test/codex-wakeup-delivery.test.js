#!/usr/bin/env node
'use strict';
const {
  parseScheduledTaskLine,
  handleWakeLine,
} = require('../lib/codex-wakeup-delivery');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const unrelated = parseScheduledTaskLine('hello world');
ok('unrelated line ignored', unrelated.ok === true && unrelated.ignored === true);

const similarPrefix = parseScheduledTaskLine('ORCH_SCHEDULED_TASKX {"prompt":"no"}');
ok('similar prefix ignored', similarPrefix.ok === true && similarPrefix.ignored === true);

const invalid = parseScheduledTaskLine('ORCH_SCHEDULED_TASK {not-json');
ok('invalid payload does not throw', invalid.ok === false && invalid.ignored === true && /invalid/.test(invalid.error || ''));

const parsed = parseScheduledTaskLine('ORCH_SCHEDULED_TASK {"delaySeconds":1,"reason":"idle","prompt":"wake now"}');
ok('scheduled task payload parsed', parsed.ok === true && parsed.payload.prompt === 'wake now');

const calls = [];
const fired = handleWakeLine(
  'ORCH_SCHEDULED_TASK {"delaySeconds":1,"reason":"idle","prompt":"continue work"}',
  {
    sessionId: 'codex-real-session',
    command: 'codex-test',
    spawnResume(command, args, opts) {
      calls.push({ command, args, opts });
    },
  },
);
ok('fired line invokes injected resume command', fired.ok === true && calls.length === 1);
ok('resume args include session and prompt', calls[0].command === 'codex-test' && calls[0].args.join('|') === 'resume|codex-real-session|continue work');

const fallbackCalls = [];
const fallback = handleWakeLine(
  'ORCH_SCHEDULED_TASK {"prompt":"wake"}',
  {
    sessionId: 'codex-mcp-123-0123456789abcdef0123456789abcdef',
    spawnResume(command, args) { fallbackCalls.push({ command, args }); },
  },
);
ok('process-local fallback is not resumable', fallback.ok === false && /fallback/.test(fallback.error || '') && fallbackCalls.length === 0);

const missingPromptCalls = [];
const missingPrompt = handleWakeLine(
  'ORCH_SCHEDULED_TASK {"reason":"idle"}',
  {
    sessionId: 'codex-real-session',
    spawnResume(command, args) { missingPromptCalls.push({ command, args }); },
  },
);
ok('missing prompt resumes with empty prompt', missingPrompt.ok === true && missingPromptCalls[0].args[2] === '');

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
