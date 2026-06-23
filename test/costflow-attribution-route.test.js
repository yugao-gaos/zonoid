#!/usr/bin/env node
// Regression coverage for /costflow's route-level claim/session attribution glue.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const analyticsRoute = require('../routes/analytics');
const { sessionCatchalls } = require('../lib/costflow');
const codex = require('../lib/adapters/codex');
const { taskTranscript } = require('../daemon.js');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const { claimedOutputForSession } = analyticsRoute._internal;

{
  const claims = [
    { id: 'T1', session: 'S1', transcript: '/tmp/S1.jsonl' },
    { id: 'T2', session: null, transcript: '/tmp/S1.jsonl' },
    { id: 'T3', session: 'S2', transcript: '/tmp/S2.jsonl' },
  ];
  const ownTok = new Map([['T1', 100], ['T2', 150], ['T3', 200]]);
  const claimed = claimedOutputForSession({ id: 'S1', path: '/tmp/S1.jsonl', total: 1000 }, claims, ownTok);
  ok('claimedOutputForSession matches both session id and transcript path without double-counting', claimed === 250);

  const ca = sessionCatchalls(
    [{ id: 'S1', total: 1000, claimed }],
    [{ id: 'T1', session: 'S1' }, { id: 'T2', session: 'S1' }],
  );
  const node = ca.nodes.find((n) => n.id === 'session:S1');
  ok('session catch-all subtracts task-attributed output from transcript-path claims', node && node.own === 750);
}

{
  const claims = [{ id: 'T3', session: 'S2', transcript: null }];
  const ownTok = new Map([['T3', 200]]);
  const claimed = claimedOutputForSession({ id: 'S2', total: 500 }, claims, ownTok);
  ok('claimedOutputForSession matches usage-record sessions when no transcript path exists', claimed === 200);
}

{
  const claims = [{ id: 'T4', session: 'S2', transcript: '/tmp/S1.jsonl' }];
  const ownTok = new Map([['T4', 300]]);
  const byTranscript = claimedOutputForSession({ id: 'S1', path: '/tmp/S1.jsonl', total: 700 }, claims, ownTok);
  const bySession = claimedOutputForSession({ id: 'S2', path: '/tmp/S2.jsonl', total: 800 }, claims, ownTok);
  ok('claimedOutputForSession prefers transcript match over conflicting session id', byTranscript === 300 && bySession === 0);
}

async function runAsyncTests() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'costflow-codex-'));
  const prevHome = process.env.CODEX_HOME;
  const routeWorkspace = path.join(__dirname, '..');
  const fullId = '2026-06-22T09-58-03-019eef9f-bc70-7541-8f76-379400ff71e1';
  const rolloutPath = path.join(tmp, 'rollout-' + fullId + '.jsonl');
  try {
    process.env.CODEX_HOME = tmp;
    fs.writeFileSync(rolloutPath, [
      JSON.stringify({ type: 'session_meta', payload: { model: 'gpt-5-codex' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 1000 } },
        },
      }),
    ].join('\n') + '\n');
    fs.utimesSync(rolloutPath, new Date('2026-06-22T10:20:00.000Z'), new Date('2026-06-22T10:20:00.000Z'));

    const makeCostflowRoute = (tasks, ov, ws) => analyticsRoute({
      send(_res, code, body) { _res.statusCode = code; _res.body = body; },
      buildGraph() { return { tasks, ghosts: [] }; },
      state: { sessions: {} },
      targetOverlay() { return { ws, ov, save() {} }; },
      taskTranscript,
      usageCached() { return { output_tokens: 0 }; },
      respCacheGet() { return undefined; },
      respCachePut(_ws, _key, body) { return body; },
      isTruthy: Boolean,
      now() { return '2026-06-22T10:21:00.000Z'; },
      harness: codex,
      harnessRegistry: { get(name) { if (name === 'codex') return codex; throw new Error(name); } },
      notifyChange() {},
      CATCHALL_ESCALATE_TOKENS: 1e9,
    });

    const uuid = '119eef9f-bc70-7541-8f76-379400ff71e2';
    const uuidFullId = '2026-06-22T10-30-00-' + uuid;
    const uuidDir = path.join(tmp, 'sessions', '2026', '06', '22');
    const uuidRolloutPath = path.join(uuidDir, 'rollout-' + uuidFullId + '.jsonl');
    fs.mkdirSync(uuidDir, { recursive: true });
    fs.writeFileSync(uuidRolloutPath, [
      JSON.stringify({ type: 'session_meta', payload: { model: 'gpt-5-codex' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 1000 } },
        },
      }),
    ].join('\n') + '\n');
    fs.utimesSync(uuidRolloutPath, new Date('2026-06-22T10:35:00.000Z'), new Date('2026-06-22T10:35:00.000Z'));

    const taskA = 'codex/task-a';
    const taskB = 'codex/task-b';
    const uuidTaskA = 'codex/uuid-task-a';
    const uuidTaskB = 'codex/uuid-task-b';
    const ov = {
      assignee: {},
      timestamps: {
        [taskA]: { firstSeen: '2026-06-22T10:00:00.000Z', lastChanged: '2026-06-22T10:15:00.000Z' },
        [taskB]: { firstSeen: '2026-06-22T10:15:00.000Z', lastChanged: '2026-06-22T10:20:00.000Z' },
        [uuidTaskA]: { firstSeen: '2026-06-22T08:00:00.000Z', lastChanged: '2026-06-22T08:15:00.000Z' },
        [uuidTaskB]: { firstSeen: '2026-06-22T08:15:00.000Z', lastChanged: '2026-06-22T08:20:00.000Z' },
      },
      work_sessions: {
        [taskA]: [{ start_ts: '2026-06-22T10:00:00.000Z', end_ts: '2026-06-22T10:15:00.000Z' }],
        [taskB]: [{ start_ts: '2026-06-22T10:15:00.000Z', end_ts: '2026-06-22T10:20:00.000Z' }],
        [uuidTaskA]: [{ start_ts: '2026-06-22T08:00:00.000Z', end_ts: '2026-06-22T08:15:00.000Z' }],
        [uuidTaskB]: [{ start_ts: '2026-06-22T08:15:00.000Z', end_ts: '2026-06-22T08:20:00.000Z' }],
      },
      usage_records: {},
      usage_reconcile_snapshot: {
        harness: 'codex',
        totals: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, by_model: {} },
        cost: { usd: 0, source: 'real', by_model: {} },
        human: { tokens: 0, chars: 0, messages: 0, dropped: 0 },
        sessions: [
          { id: fullId, path: rolloutPath, total: 1000, model: 'gpt-5-codex' },
          {
            id: uuidFullId,
            path: uuidRolloutPath,
            total: 1000,
            model: 'gpt-5-codex',
            startedAt: '2026-06-22T10:30:00.000Z',
            endedAt: '2026-06-22T10:35:00.000Z',
          },
        ],
      },
      edges: [],
      guidance: [],
    };
    const st = { sessions: {}, overlay: ov, agents: {} };
    ok('taskTranscript resolves Codex rollout by claim window', taskTranscript(taskA, 'codex', true, st) === rolloutPath);
    ok('taskTranscript resolves Codex rollout by UUID session without binding or window overlap', taskTranscript(uuidTaskA, uuid, true, st) === uuidRolloutPath);

    const tasks = [
      { id: taskA, kind: 'task', session: 'codex', firstSeen: '2026-06-22T10:00:00.000Z', lastChanged: '2026-06-22T10:15:00.000Z', deps: [], context_deps: [], git: { merged: true }, status: 'done', label: 'Codex task A' },
      { id: taskB, kind: 'task', session: 'codex', firstSeen: '2026-06-22T10:15:00.000Z', lastChanged: '2026-06-22T10:20:00.000Z', deps: [], context_deps: [], git: { merged: true }, status: 'done', label: 'Codex task B' },
      { id: uuidTaskA, kind: 'task', session: uuid, firstSeen: '2026-06-22T08:00:00.000Z', lastChanged: '2026-06-22T08:15:00.000Z', deps: [], context_deps: [], git: { merged: true }, status: 'done', label: 'Codex UUID task A' },
      { id: uuidTaskB, kind: 'task', session: uuid, firstSeen: '2026-06-22T08:15:00.000Z', lastChanged: '2026-06-22T08:20:00.000Z', deps: [], context_deps: [], git: { merged: true }, status: 'done', label: 'Codex UUID task B' },
    ];
    const res = {};
    const route = makeCostflowRoute(tasks, ov, routeWorkspace);
    const handled = await route('/costflow', 'GET', {}, res, new URL(`http://127.0.0.1/costflow?workspace=${encodeURIComponent(routeWorkspace)}`), null);
    ok('/costflow route handled Codex fixture', handled === true && res.statusCode === 200);
    const ownByTask = Object.fromEntries((res.body.results || []).map((r) => [r.task, r.own]));
    ok('/costflow splits Codex rollout own tokens by task windows', ownByTask[taskA] === 750 && ownByTask[taskB] === 250);
    ok('/costflow splits UUID-resolved Codex rollout own tokens by task windows', ownByTask[uuidTaskA] === 750 && ownByTask[uuidTaskB] === 250);
    ok('/costflow subtracts claimed Codex rollout tokens from catch-all remainder', res.body.sessions.unattributed === 0);
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

runAsyncTests().then(() => {
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  fail++;
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(1);
});
