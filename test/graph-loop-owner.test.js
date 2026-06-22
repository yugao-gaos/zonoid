'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-graph-loop-owner-'));
const prevOrchData = process.env.ORCH_DATA;
process.env.ORCH_DATA = path.join(SANDBOX, 'data');

const daemon = require('../daemon');
const overlayStore = require('../lib/overlay');
const registry = require('../lib/workspace-registry');
const runtimePaths = require('../lib/runtime-paths');
const {
  HARNESS_JUDGE_DRAIN_KEY,
  HARNESS_LABEL_DRAIN_KEY,
  HARNESS_LEARNER_DRAIN_KEY,
} = require('../lib/harness-task');
const { managedGraphLoopId } = require('../lib/loop-autostart');

const workspacesFile = path.join(runtimePaths.resolveDataDir(), 'workspaces.json');

function resetDaemonState() {
  daemon.__clearLoopsForTest();
  daemon.__clearOverlayCacheForTest();
  daemon.__setWorkspaceForTest(null);
  daemon.__setAgentsForTest({});
}

function registerWorkspace(name) {
  resetDaemonState();
  const ws = path.join(SANDBOX, name);
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  fs.mkdirSync(path.dirname(workspacesFile), { recursive: true });
  fs.writeFileSync(workspacesFile, JSON.stringify({ version: 2, workspaces: {} }));
  registry.addRepo(workspacesFile, { workspace: name, repo: ws });
  return ws;
}

function readyOverlay(ws, tasks) {
  const ov = overlayStore.EMPTY();
  const ts = '2026-06-21T00:00:00.000Z';
  for (const t of tasks) {
    overlayStore.setSnapshot(ov, t.key, {
      subject: t.label,
      description: t.label,
      status: 'pending',
      blockedBy: [],
      owner: null,
      metadata: t.harness ? { harness: true } : {},
    });
    overlayStore.setStatus(ov, t.key, 'ready');
    ov.timestamps[t.key] = { firstSeen: ts, lastChanged: ts, lastStatus: 'ready' };
  }
  daemon.__setWorkspaceForTest(ws);
  daemon.__setOverlayForTest(ov);
}

function loopsById() {
  return daemon.__getLoopsForTest();
}

after(() => {
  resetDaemonState();
  if (prevOrchData === undefined) delete process.env.ORCH_DATA;
  else process.env.ORCH_DATA = prevOrchData;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  setImmediate(() => process.exit(process.exitCode || 0));
});

test('empty registry plus normal ready work creates one managed graph loop and spawn decision', () => {
  const ws = registerWorkspace('normal-ready');
  readyOverlay(ws, [{ key: 'codex/regular-ready', label: 'Regular ready work' }]);

  const decisions = daemon.decideAll();
  const loopId = managedGraphLoopId(ws);

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].loopId, loopId);
  assert.equal(decisions[0].action, 'spawn');
  assert.deepEqual(decisions[0].tasks, [{ key: 'codex/regular-ready', label: 'Regular ready work' }]);

  const loops = loopsById();
  assert.equal(loops.size, 1);
  assert.equal(loops.get(loopId).managed, 'graph');
  assert.equal(loops.get(loopId).workspace, ws);
  assert.equal(loops.get(loopId).session, null);
});

test('standing harness drains alone do not create a generic managed graph loop', () => {
  const ws = registerWorkspace('standing-drains');
  readyOverlay(ws, [
    { key: HARNESS_JUDGE_DRAIN_KEY, label: 'harness: judge drain', harness: true },
    { key: HARNESS_LABEL_DRAIN_KEY, label: 'harness: label drain', harness: true },
    { key: HARNESS_LEARNER_DRAIN_KEY, label: 'harness: learner drain', harness: true },
  ]);

  const decisions = daemon.decideAll();

  assert.deepEqual(decisions, []);
  assert.equal(loopsById().size, 0);
});

test('daemon ensure creates managed graph loop before next_action is consumed', () => {
  const ws = registerWorkspace('ensure-before-heartbeat');
  readyOverlay(ws, [{ key: 'codex/ensure-ready', label: 'Ensure ready work' }]);

  const created = daemon.ensureManagedGraphLoops();
  const loopId = managedGraphLoopId(ws);
  const loops = loopsById();

  assert.equal(created, true);
  assert.equal(loops.size, 1);
  assert.equal(loops.get(loopId).active, true);
  assert.equal(loops.get(loopId).managed, 'graph');

  const decisions = daemon.decideAll();
  assert.equal(decisions[0].loopId, loopId);
  assert.equal(decisions[0].action, 'spawn');
});

test('active managed graph loop is reused, while foreground session loop may coexist', () => {
  const ws = registerWorkspace('reuse-managed');
  readyOverlay(ws, [{ key: 'codex/reuse-ready', label: 'Reuse ready work' }]);
  const loopId = managedGraphLoopId(ws);
  const config = { tokenBudget: 5000000, maxIterations: 6250, minPoll: 30, maxPoll: 300, estPerTick: 800, batch: 4, maxConcurrency: 6, judgeParallelCap: 6 };
  const fresh = new Date().toISOString();
  daemon.__setLoopsForTest([
    [loopId, { id: loopId, active: true, iterations: 0, spent: 0, baseline: 0, real: false, startedAt: fresh, session: null, lastProgress: fresh, workspace: ws, managed: 'graph', config }],
    ['foreground', { id: 'foreground', active: true, iterations: 0, spent: 0, baseline: 0, real: false, startedAt: fresh, session: 'foreground-session', lastProgress: fresh, workspace: ws, managed: null, config }],
  ]);

  const decisions = daemon.decideAll();
  const loops = loopsById();

  assert.equal(loops.size, 2);
  assert.equal(loops.get(loopId).managed, 'graph');
  assert.equal(loops.get(loopId).workspace, ws);
  assert.ok(decisions.some((d) => d.loopId === loopId), 'managed loop should be decided');
  assert.ok(decisions.some((d) => d.loopId === 'foreground'), 'foreground loop should still coexist');
  assert.equal(decisions[0].loopId, 'foreground', 'foreground loop gets first chance at ready work');
  assert.equal(decisions[0].action, 'spawn');
  assert.deepEqual(decisions[0].tasks, [{ key: 'codex/reuse-ready', label: 'Reuse ready work' }]);
});

test('inactive restored managed graph loop is reactivated in place', () => {
  const ws = registerWorkspace('restore-managed');
  readyOverlay(ws, [{ key: 'codex/restore-ready', label: 'Restore ready work' }]);
  const loopId = managedGraphLoopId(ws);
  const config = { tokenBudget: 5000000, maxIterations: 6250, minPoll: 30, maxPoll: 300, estPerTick: 800, batch: 4, maxConcurrency: 6, judgeParallelCap: 6 };
  daemon.__setLoopsForTest([[loopId, { id: loopId, active: false, iterations: 7, spent: 5600, baseline: 0, real: false, startedAt: '2026-06-20T00:00:00.000Z', session: null, lastProgress: '2026-06-20T00:00:00.000Z', workspace: ws, managed: 'graph', config }]]);

  const decisions = daemon.decideAll();
  const loops = loopsById();

  assert.equal(loops.size, 1);
  assert.equal(loops.get(loopId).active, true);
  assert.equal(loops.get(loopId).iterations, 1);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].loopId, loopId);
});
