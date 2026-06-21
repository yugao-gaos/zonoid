#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseScheduledTaskLine,
  handleWakeLine,
  CodexWakeDeliverySupervisor,
} = require('../lib/codex-wakeup-delivery');
const sw = require('../lib/schedule-wakeup');
const codexSessionBridge = require('../lib/codex-session-bridge');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

function waitFor(label, predicate, ms = 3000) {
  return new Promise((resolve) => {
    const until = Date.now() + ms;
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() >= until) return resolve(false);
      setTimeout(tick, 25);
    };
    tick();
  }).then((hit) => ok(label, hit));
}

(async () => {
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

const prevOrchData = process.env.ORCH_DATA;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-wake-delivery-'));
process.env.ORCH_DATA = tmp;
try {
  const supervisedCalls = [];
  const supervisor = new CodexWakeDeliverySupervisor({
    command: 'codex-test',
    restartDelayMs: 10,
    spawnResume(command, args, opts) { supervisedCalls.push({ command, args, opts }); },
  });
  const session = 'codex-real-supervised-session';
  const supervised = supervisor.supervise(session);
  ok('real Codex session is supervised', supervised.ok === true && supervised.supervised === true && supervised.reused === false);
  ok('supervisor creates missing fire file before watching', fs.existsSync(sw.fireFile(session)));
  const reused = supervisor.supervise(session);
  ok('supervisor reuses existing session monitor', reused.ok === true && reused.reused === true && supervisor.activeSessions().filter((s) => s === session).length === 1);
  const armed = sw.armWakeup({ session, delaySeconds: 0, reason: 'test', prompt: 'daemon-owned wake' });
  ok('ScheduleWakeup arm succeeds without manual monitor process', armed.ok === true);
  await waitFor('supervised ScheduleWakeup delivery invokes codex resume', () => supervisedCalls.length === 1);
  ok('supervised delivery uses resume args', supervisedCalls[0] && supervisedCalls[0].args.join('|') === 'resume|codex-real-supervised-session|daemon-owned wake');
  sw.cancelWakeup(session);
  supervisor.stopAll();

  const preCalls = [];
  const preSupervisor = new CodexWakeDeliverySupervisor({
    command: 'codex-test',
    spawnResume(command, args) { preCalls.push({ command, args }); },
  });
  const preSession = 'codex-real-precreated-session';
  fs.mkdirSync(sw.resolveWakeDir(), { recursive: true });
  fs.writeFileSync(sw.fireFile(preSession), 'ORCH_SCHEDULED_TASK {"prompt":"old"}\n');
  const pre = preSupervisor.supervise(preSession);
  ok('pre-created fire file is supervised', pre.ok === true);
  await new Promise((r) => setTimeout(r, 75));
  ok('pre-created stale lines are not replayed', preCalls.length === 0);
  fs.appendFileSync(sw.fireFile(preSession), 'ORCH_SCHEDULED_TASK {"prompt":"new"}\n');
  await waitFor('pre-created fire file appended line is delivered', () => preCalls.length === 1);
  ok('pre-created delivery uses appended prompt', preCalls[0] && preCalls[0].args[2] === 'new');
  preSupervisor.stopAll();

  const fallbackSupervisor = new CodexWakeDeliverySupervisor({
    spawnResume() { throw new Error('fallback should not resume'); },
  });
  const fallbackSupervise = fallbackSupervisor.supervise('codex-mcp-123-0123456789abcdef0123456789abcdef');
  ok('supervisor refuses process-local fallback sessions', fallbackSupervise.ok === false && /fallback/.test(fallbackSupervise.error || '') && fallbackSupervisor.activeSessions().length === 0);

  const bridgeWs = fs.mkdtempSync(path.join(tmp, 'bridge-ws-'));
  codexSessionBridge.writeLatestSession({ workspace: bridgeWs, session_id: 'codex-real-bridged-session', transcript: '/tmp/bridged.jsonl' });
  const bridgeSupervisor = new CodexWakeDeliverySupervisor({ spawnResume() {} });
  const bridgeResult = bridgeSupervisor.superviseBridgeWorkspaces([bridgeWs]);
  ok('bridge workspace sweep supervises real Codex sessions', bridgeResult.ok === true && bridgeResult.supervised.length === 1 && bridgeSupervisor.activeSessions()[0] === 'codex-real-bridged-session');
  ok('bridge workspace sweep creates bridged fire file', fs.existsSync(sw.fireFile('codex-real-bridged-session')));
  bridgeSupervisor.stopAll();
} finally {
  if (prevOrchData === undefined) delete process.env.ORCH_DATA;
  else process.env.ORCH_DATA = prevOrchData;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
