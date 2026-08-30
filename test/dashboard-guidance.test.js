#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
const ok = (label, condition) => {
  if (condition) { console.log(`PASS  ${label}`); pass++; }
  else { console.error(`FAIL  ${label}`); fail++; }
};

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');
const start = html.indexOf('async function renderGuidance(force){');
const end = html.indexOf('\n// POST a resolution.', start);
const body = start >= 0 && end > start ? html.slice(start, end) : '';

ok('dashboard guidance renderer exists', !!body);
ok('ordinary pending user decisions render in the shared inbox',
  body.includes('const pending=(g&&g.pending)||[]') && body.includes('pending.map(gitem)') && body.includes('Needs You ('));
ok('pending decisions remain task-linked and actionable',
  body.includes('Open task') && body.includes("kind==='task-recovery'") && body.includes("kind==='user-hold'"));
ok('the inbox exposes automatic-recovery decisions',
  body.includes('>Retry</button>') && body.includes('>Keep blocked</button>') && body.includes('>Cancel task</button>') && body.includes('Recommended:'));
ok('internal review lanes remain rendered',
  body.includes('reviewFollowUps.map(gitem)')
  && body.includes('reviewClusters.map(gitem)')
  && body.includes('reviewStale.map(gitem)'));
ok('ordinary pending decisions do not force-open over the current dashboard view',
  !/if\([^\n]*pending\.length[^\n]*\) box\.classList\.add\('show'\)/.test(body));

ok('Needs You control is persistent and names the shared inbox',
  html.includes('id="notifBtn"') && html.includes('>Needs You <span id="notifCount">0</span>'));

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
