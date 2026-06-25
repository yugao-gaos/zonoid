#!/usr/bin/env node
// Registry smoke: all(), get(), route() namespace dispatch (local/ms1).
'use strict';
const harness = require('../lib/harness');

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { console.log('PASS  ' + l); pass++; } else { console.log('FAIL  ' + l); fail++; } };

ok('all returns adapters', harness.all().length >= 5);
ok('get claude', harness.get('claude').name === 'claude');
ok('get cursor', harness.get('cursor').name === 'cursor');
ok('get opencode', harness.get('opencode').name === 'opencode');
ok('route uuid session to claude', harness.route('a1b2c3d4-e5f6-7890-abcd-ef1234567890/t1').name === 'claude');
ok('route cursor key to cursor', harness.route('cursor/abc').name === 'cursor');
ok('route codex key to codex', harness.route('codex/x').name === 'codex');
ok('route opencode key to opencode', harness.route('opencode/x').name === 'opencode');
ok('no active export', typeof harness.active === 'undefined');
ok('no select export', typeof harness.select === 'undefined');

console.log('-----');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
