#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-dsh-harness-'));
const previous = {
  ORCH_DATA: process.env.ORCH_DATA,
  DSH_HOME: process.env.DSH_HOME,
  DSH_SESSION_ROOT: process.env.DSH_SESSION_ROOT,
};
process.env.ORCH_DATA = path.join(tmp, 'zonoid-data');
process.env.DSH_HOME = path.join(tmp, 'dsh-home');
process.env.DSH_SESSION_ROOT = path.join(tmp, 'dsh-sessions');

const filedrop = require('../lib/filedrop-tasks');
const dsh = require('../lib/harnesses/dsh');

let pass = 0;
let fail = 0;
function ok(label, condition) {
  if (condition) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

try {
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  writeJson(filedrop.stubFile(workspace, 'dsh/c1'), {
    id: 'c1',
    subject: 'Live DSH task',
    description: 'live description',
    status: 'pending',
    blockedBy: ['c0'],
    metadata: { keep: true },
  });
  writeJson(filedrop.stubFile(workspace, 'codex/foreign'), {
    id: 'foreign', subject: 'Foreign task', status: 'pending', blockedBy: [],
  });

  const aggregate = dsh.tasks.aggregateWorkspace(workspace, {
    'dsh/c1': {
      subject: 'Adopted DSH task', description: 'adopted description', status: 'pending', blockedBy: ['legacy'],
    },
    'dsh/legacy': {
      subject: 'Retained DSH task', description: 'snapshot only', status: 'completed', blockedBy: [],
    },
    'codex/snapshot': { subject: 'Foreign snapshot', status: 'completed' },
  });
  const live = aggregate.find((task) => task.key === 'dsh/c1');
  ok('task aggregation is namespace-scoped', aggregate.length === 2 && !aggregate.some((task) => task.session === 'codex'));
  ok('adopted task structure wins over the live stub', live.label === 'Adopted DSH task'
    && live.description === 'adopted description' && live.deps[0] === 'dsh/legacy');
  ok('snapshot-only DSH task remains visible', aggregate.some((task) => task.key === 'dsh/legacy'));

  const raw = dsh.tasks.readTask('dsh/c1', workspace);
  ok('readTask returns the DSH native stub', raw && raw.subject === 'Live DSH task' && raw.metadata.keep === true);
  ok('readTask refuses another namespace', dsh.tasks.readTask('codex/foreign', workspace) === null);
  ok('writeStatus delegates atomically to file-drop', dsh.tasks.writeStatus('dsh/c1', 'in_progress', workspace)
    && filedrop.readTask(workspace, 'dsh/c1').status === 'in_progress');
  ok('readSessionTasksRaw returns parseable DSH stubs', dsh.tasks.readSessionTasksRaw('dsh', workspace).length === 1);
  ok('readSessionTasksRaw refuses unrelated sessions', dsh.tasks.readSessionTasksRaw('session-other', workspace).length === 0);

  const healthy = dsh.tasks.formatHealth(workspace);
  ok('formatHealth counts valid DSH stubs only', healthy.files === 1 && healthy.wellFormed === 1 && healthy.healthy);
  fs.writeFileSync(path.join(filedrop.dirFor(workspace), 'dsh', 'broken.json'), '{');
  const unhealthy = dsh.tasks.formatHealth(workspace);
  ok('formatHealth reports malformed DSH stubs', unhealthy.files === 2 && unhealthy.parsed === 1
    && unhealthy.anomalies.length === 1 && !unhealthy.healthy);

  const originalWatch = filedrop.watch;
  let watchCalled = false;
  let disposed = false;
  filedrop.watch = (callback) => {
    watchCalled = typeof callback === 'function';
    return () => { disposed = true; };
  };
  const dispose = dsh.tasks.watch(() => {});
  dispose();
  filedrop.watch = originalWatch;
  ok('watch delegates to the shared file-drop watcher', watchCalled && disposed);

  const scheduleDir = path.join(tmp, 'scheduler');
  const scheduled = dsh.scheduler.writeScheduledTask({
    id: 'later',
    title: 'DSH follow-up',
    prompt: 'continue the DSH task',
    taskKey: 'dsh/c1',
    when: 'later',
    fireAt: null,
    cwd: workspace,
    orchDir: scheduleDir,
  });
  ok('scheduler uses the shared deferred-note substrate', scheduled.ok && !scheduled.armed
    && fs.existsSync(path.join(scheduleDir, 'scheduled-tasks', 'later', 'NOTE.md')));
  const originalCancelWakeup = dsh.scheduler.cancelWakeup;
  const originalArmWakeup = dsh.scheduler.armWakeup;
  let canceledSession = null;
  let armOptions = null;
  dsh.scheduler.cancelWakeup = ({ session }) => { canceledSession = session; return { ok: true, canceled: true }; };
  dsh.scheduler.armWakeup = (options) => { armOptions = options; return { ok: true, pid: 1 }; };
  const reconcileWake = dsh.usage.onSessionStart({ session: 'session-one', port: 9876 });
  dsh.scheduler.cancelWakeup = originalCancelWakeup;
  dsh.scheduler.armWakeup = originalArmWakeup;
  ok('session start replaces the DSH daily reconcile wake', reconcileWake.ok
    && canceledSession === 'session-one' && armOptions.session === 'session-one'
    && armOptions.delaySeconds === 86400 && armOptions.prompt.includes('"harness":"dsh"'));

  const transcript = path.join(process.env.DSH_SESSION_ROOT, '--workspace--', 'session-one', 'session.jsonl');
  writeJsonl(transcript, [
    { type: 'session', version: 0, id: 'session-one', cwd: workspace, createdAt: 1787904000000, delegationDepth: 0 },
    { type: 'request/context', seq: 0, time: 1787904000100, data: { provider: 'deepseek-official', model: 'deepseek-chat' } },
    { type: 'assistant/chunk', seq: 1, time: 1787904000200, data: {
      turn: 1, step: 1, chunk: { type: 'usage', usage: {
        inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 4, reasoningTokens: 7,
      } },
    } },
    { type: 'assistant/message', seq: 2, time: 1787904000300, data: {
      turn: 1,
      step: 1,
      message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' } },
      usage: { inputTokens: 110, outputTokens: 22, cacheReadTokens: 31, cacheWriteTokens: 5, reasoningTokens: 8 },
    } },
    { type: 'request/context', seq: 3, time: 1787904000400, data: { provider: 'deepseek-official', model: 'deepseek-reasoner' } },
    { type: 'assistant/chunk', seq: 4, time: 1787904000500, data: {
      turn: 1, step: 2, chunk: { type: 'usage', usage: {
        inputTokens: 7, outputTokens: 8, cacheReadTokens: 9, cacheWriteTokens: 1, reasoningTokens: 4,
      } },
    } },
  ]);
  const foreignWorkspace = path.join(tmp, 'foreign-workspace');
  const foreignTranscript = path.join(process.env.DSH_SESSION_ROOT, '--foreign--', 'session-two', 'session.jsonl');
  writeJsonl(foreignTranscript, [
    { type: 'session', version: 0, id: 'session-two', cwd: foreignWorkspace, createdAt: 1787904000000, delegationDepth: 0 },
    { type: 'assistant/message', seq: 0, time: 1787904000100, data: {
      turn: 1, step: 1, message: { source: { model: 'deepseek-chat' } }, usage: { inputTokens: 999, outputTokens: 999 },
    } },
  ]);

  const normalized = dsh.usage.normalizeReported({
    inputTokens: 13,
    outputTokens: 5,
    cacheReadTokens: 7,
    cacheWriteTokens: 2,
    reasoningTokens: 4,
    model: 'deepseek-chat',
  });
  ok('reported DSH TokenUsage maps disjoint cache buckets', normalized.harness === 'dsh'
    && normalized.usage.input_tokens === 13 && normalized.usage.output_tokens === 5
    && normalized.usage.cache_read_input_tokens === 7 && normalized.usage.cache_creation_input_tokens === 2);
  ok('reasoning tokens are not double-counted', normalized.usage.output_tokens === 5);
  ok('unknown DSH pricing is explicit and non-throwing', normalized.cost.usd === 0
    && normalized.cost.unpriced_models[0] === 'deepseek-chat');

  const sampled = dsh.usage.sample(transcript, {
    baseline: { input_tokens: 17, output_tokens: 10 },
    window: { start: '2026-08-28T00:00:00.000Z', end: '2026-08-29T00:00:00.000Z' },
  });
  ok('sample replaces chunk usage with the finalized message for one step', sampled.usage.input_tokens === 100
    && sampled.usage.output_tokens === 20 && sampled.usage.cache_read_input_tokens === 40
    && sampled.usage.cache_creation_input_tokens === 6 && sampled.usage.messages === 2);
  ok('sample preserves gross per-model usage across baseline subtraction', sampled.usage.by_model['deepseek-chat'].input_tokens === 110
    && sampled.usage.by_model['deepseek-reasoner'].output_tokens === 8);

  const listed = dsh.transcripts.listSessionTranscripts();
  ok('DSH session discovery reads durable header ids', listed.length === 2 && listed.some((row) => row.id === 'session-one'));
  ok('sessionTranscriptPath resolves the requested DSH session', dsh.transcripts.sessionTranscriptPath(null, 'session-one') === transcript);
  if (typeof zlib.zstdCompressSync === 'function') {
    const compressed = path.join(tmp, 'frames.zstd');
    fs.writeFileSync(compressed, Buffer.concat([
      zlib.zstdCompressSync(Buffer.from('first\n')),
      zlib.zstdCompressSync(Buffer.from('second\n')),
    ]));
    ok('zstd reader decodes every appended DSH frame', dsh._internal.readSessionText(compressed) === 'first\nsecond\n');
  } else {
    ok('zstd reader is optional on pre-DSH Node runtimes', true);
  }
  const report = dsh.usage.reconcile(workspace);
  ok('reconcile scopes durable sessions by canonical header cwd', report.sessions.length === 1
    && report.sessions[0].id === 'session-one');
  ok('reconcile sums canonical DSH usage', report.totals.input_tokens === 117
    && report.totals.output_tokens === 30 && report.totals.cache_read_input_tokens === 40
    && report.totals.cache_creation_input_tokens === 6);
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
