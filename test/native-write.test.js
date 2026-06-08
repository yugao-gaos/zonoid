#!/usr/bin/env node
// Plain Node test for lib/native-tasks.js writeStatus (no framework; matches test/git.test.js style).
// Run: node test/native-write.test.js  — exits non-zero on any failed assertion.
// Uses a clearly-fake session id under ~/.claude/tasks and cleans it up; never touches real sessions.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const nt = require('../lib/native-tasks');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const SESSION = 'TESTFAKE-native-write-0000';
const dir = path.join(os.homedir(), '.claude', 'tasks', SESSION);
const read = (id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
const write = (id, obj) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(obj, null, 2));

try {
  fs.mkdirSync(dir, { recursive: true });
  write('1', { id: '1', subject: 'demo', status: 'pending', blockedBy: ['9'], description: 'keep me' });

  ok('writeStatus returns true on existing file', nt.writeStatus(SESSION, '1', 'completed') === true);
  const after = read('1');
  ok('status updated to completed', after.status === 'completed');
  ok('subject preserved', after.subject === 'demo');
  ok('blockedBy preserved', Array.isArray(after.blockedBy) && after.blockedBy[0] === '9');
  ok('description preserved', after.description === 'keep me');
  ok('id preserved', after.id === '1');

  ok('writeStatus returns true on second write', nt.writeStatus(SESSION, '1', 'in_progress') === true);
  ok('status flips to in_progress', read('1').status === 'in_progress');

  ok('no tmp file left behind', fs.readdirSync(dir).every((f) => !f.includes('.tmp')));

  // best-effort: missing file / missing session must not throw, returns false
  ok('writeStatus false on missing file', nt.writeStatus(SESSION, 'nope', 'completed') === false);
  ok('writeStatus false on missing session', nt.writeStatus('TESTFAKE-does-not-exist', '1', 'completed') === false);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
