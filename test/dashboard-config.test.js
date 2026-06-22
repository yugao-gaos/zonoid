#!/usr/bin/env node
// Static regressions for graph.html settings/config fetch behavior.
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');

ok('settings save no longer references undefined loadData', !html.includes('setInterval(loadData'));
ok('settings save schedules tick polling', html.includes('setInterval(tick, interval*1000)'));
ok('saved daemonUrl initializes mutable BASE', html.includes('let BASE = loadSavedDaemonUrl() || DEFAULT_BASE'));
ok('settings save refreshes mutable BASE', html.includes('setDaemonBase(url);'));
ok('workspace discovery uses token-aware dfetch',
  !html.includes("fetch(BASE + '/workspaces')") && (html.match(/dfetch\('\/workspaces'\)/g) || []).length >= 2);

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
