#!/usr/bin/env node
// Plain Node tests for gate node support — mintGateKey + acknowledgeDaemonRestartOnBoot gate sweep.
// Run: node test/gate-node.test.js
'use strict';
const ov = require('../lib/overlay');
const fu = require('../lib/followups');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Helper: add a gate snapshot to the overlay (simulates what /overlay/gate does)
function addGateSnapshot(o, kind, createdAt, blockingTaskKey) {
  const key = fu.mintGateKey(o, kind);
  const snap = {
    subject: `Gate: ${kind}`,
    description: 'test gate',
    status: 'pending',
    blockedBy: [],
    owner: null,
    metadata: { gate_kind: kind, created_at: createdAt, created_by: 'dispatcher', blocking_task: blockingTaskKey },
  };
  ov.setSnapshot(o, key, snap);
  ov.setStatus(o, key, 'not_ready', `gate/${kind}: waiting`);
  return key;
}

// --- mintGateKey -------------------------------------------------------------------------------
{
  const o = ov.EMPTY();
  const key = fu.mintGateKey(o, 'daemon-restart');
  ok('mintGateKey returns key starting with gate/daemon-restart-', typeof key === 'string' && key.startsWith('gate/daemon-restart-'));

  const key2 = fu.mintGateKey(o, 'main-commit');
  ok('mintGateKey returns key starting with gate/main-commit-', typeof key2 === 'string' && key2.startsWith('gate/main-commit-'));

  const key3 = fu.mintGateKey(o, 'human-approval');
  ok('mintGateKey returns key starting with gate/human-approval-', typeof key3 === 'string' && key3.startsWith('gate/human-approval-'));

  let threw = false;
  try { fu.mintGateKey(o, 'unknown-kind'); } catch { threw = true; }
  ok('mintGateKey throws on unknown kind', threw);
}

// --- acknowledgeDaemonRestartOnBoot clears gate node created before boot ----------------------
{
  const bootAt = '2027-06-13T12:00:00.000Z';
  const beforeBoot = '2027-06-13T11:59:00.000Z'; // one minute before boot

  // Create overlay with the restart bucket + a gate node created before boot
  const o = ov.EMPTY();
  fu.apply(o, 's/1', [{ title: 'Restart prod daemon', prompt: 'Kill + relaunch.', disruptive: true }]);
  const bucketKey = 'followup/harness-daemon-restart';
  const g = o.guidance.find((x) => x.action && x.action.task_key === bucketKey);
  fu.resolveGate(o, g.action, 'approve'); // approve so bucket is not_ready → ready

  const gateKey = addGateSnapshot(o, 'daemon-restart', beforeBoot, 's/task-1');
  ok('precondition: gate starts not_ready', o.status[gateKey] === 'not_ready');

  const ack = fu.acknowledgeDaemonRestartOnBoot(o, { bootedAt: bootAt });
  ok('ack clears gate created before boot (status → done)', o.status[gateKey] === 'done');
  ok('ack reports gate in gatesCleaned', Array.isArray(ack.gatesCleaned) && ack.gatesCleaned.includes(gateKey));
  ok('ack sets summary on cleared gate', o.summaries[gateKey] === `Gate cleared on daemon boot at ${bootAt}.`);
}

// --- acknowledgeDaemonRestartOnBoot does NOT clear gate created after boot --------------------
{
  const bootAt = '2027-06-13T12:00:00.000Z';
  const afterBoot = '2027-06-13T12:01:00.000Z'; // one minute after boot

  const o = ov.EMPTY();
  fu.apply(o, 's/2', [{ title: 'Restart prod daemon', prompt: 'Kill + relaunch.', disruptive: true }]);
  const bucketKey = 'followup/harness-daemon-restart';
  const g = o.guidance.find((x) => x.action && x.action.task_key === bucketKey);
  fu.resolveGate(o, g.action, 'approve');

  const gateKey = addGateSnapshot(o, 'daemon-restart', afterBoot, 's/task-2');
  ok('precondition: gate (after boot) starts not_ready', o.status[gateKey] === 'not_ready');

  const ack = fu.acknowledgeDaemonRestartOnBoot(o, { bootedAt: bootAt });
  ok('gate created after boot NOT cleared (timing guard)', o.status[gateKey] === 'not_ready');
  ok('gatesCleaned is empty for post-boot gate', Array.isArray(ack.gatesCleaned) && ack.gatesCleaned.length === 0);
}

// --- one boot call clears multiple daemon-restart gates (two tasks, each with own gate) -------
{
  const bootAt = '2027-06-13T12:00:00.000Z';
  const beforeBoot = '2027-06-13T10:00:00.000Z';

  const o = ov.EMPTY();
  fu.apply(o, 's/3', [{ title: 'Restart prod daemon', prompt: 'Kill + relaunch.', disruptive: true }]);
  const bucketKey = 'followup/harness-daemon-restart';
  const g = o.guidance.find((x) => x.action && x.action.task_key === bucketKey);
  fu.resolveGate(o, g.action, 'approve');

  const gateKey1 = addGateSnapshot(o, 'daemon-restart', beforeBoot, 's/task-a');
  const gateKey2 = addGateSnapshot(o, 'daemon-restart', beforeBoot, 's/task-b');
  ok('precondition: gate1 not_ready', o.status[gateKey1] === 'not_ready');
  ok('precondition: gate2 not_ready', o.status[gateKey2] === 'not_ready');

  const ack = fu.acknowledgeDaemonRestartOnBoot(o, { bootedAt: bootAt });
  ok('gate1 cleared on boot', o.status[gateKey1] === 'done');
  ok('gate2 cleared on boot', o.status[gateKey2] === 'done');
  ok('both gates in gatesCleaned', ack.gatesCleaned.includes(gateKey1) && ack.gatesCleaned.includes(gateKey2));
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
