#!/usr/bin/env node
// Native task aggregation should not let a stale native pending echo reopen a terminal snapshot.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-native-tasks-'));
process.env.HOME = tmp;

const nt = require('../lib/native-tasks');

const workspace = path.join(tmp, 'workspace');
const session = '12345678-1234-1234-1234-123456789abc';
const taskId = '42';
const projectDir = path.join(tmp, '.claude', 'projects', nt.encodeWorkspace(workspace));
const taskDir = path.join(tmp, '.claude', 'tasks', session);
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(taskDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, `${session}.jsonl`), '');
fs.writeFileSync(path.join(taskDir, `${taskId}.json`), JSON.stringify({
  id: taskId,
  subject: 'live task',
  status: 'pending',
  blockedBy: ['1'],
}, null, 2));

const key = `${session}/${taskId}`;
const tasks = nt.aggregateWorkspace(workspace, {
  [key]: {
    subject: 'snapshot task',
    description: 'durable terminal snapshot',
    status: 'done',
    blockedBy: [],
  },
});
const task = tasks.find((t) => t.key === key);

ok('task returned', !!task);
ok('terminal snapshot status wins over native pending', task && task.native_status === 'done');
ok('snapshot deps remain authoritative', task && task.deps.length === 0);

fs.rmSync(tmp, { recursive: true, force: true });

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
