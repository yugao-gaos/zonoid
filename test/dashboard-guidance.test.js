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
ok('ordinary pending decisions are not rendered',
  !body.includes('g.pending') && !body.includes('pending.map(gitem)') && !body.includes('Dashboard decisions'));
ok('ordinary pending decisions cannot auto-open the popup',
  !/if\([^\n]*pending\.length[^\n]*\) box\.classList\.add\('show'\)/.test(body));
ok('internal review lanes remain rendered',
  body.includes('reviewFollowUps.map(gitem)')
  && body.includes('reviewClusters.map(gitem)')
  && body.includes('reviewStale.map(gitem)'));

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
