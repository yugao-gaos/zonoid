#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');
const specTab = html.indexOf('data-view="spec"');
const kanbanTab = html.indexOf('data-view="kanban"');
const frontierTab = html.indexOf('data-view="frontier"');
const cloudTab = html.indexOf('data-view="cloud"');
const architectureTab = html.indexOf('data-view="architecture"');
assert.ok(specTab !== -1 && specTab < kanbanTab && kanbanTab < frontierTab && frontierTab < cloudTab && cloudTab < architectureTab,
  'Architecture is last in the Spec, Kanban, Frontier, Knowledge, Architecture tab order');
assert.ok(html.includes('<div id="architecture" role="region" aria-label="Code architecture map">'));
assert.ok(html.includes('id="architectureSearchInput"') && html.includes('aria-label="Search architecture files and symbols"'));
assert.ok(html.includes('id="architectureInspector" aria-label="Architecture file inspector"'));
assert.ok(html.includes('projection.version!==1'), 'renderer honors the versioned architecture contract');
assert.ok(html.includes("projection.status==='empty'") && html.includes('Nothing indexed yet'),
  'missing code-index data has an honest empty state');
assert.ok(html.includes('arch-legend-line calls') && html.includes("relation.kind==='calls'?'#d29922':'#58a6ff'"),
  'imports and calls have distinct legend and edge treatments');
assert.ok(html.includes('architectureSelectedId') && html.includes('architectureRelatedIds'),
  'file selection focuses its immediate architecture neighborhood');
assert.ok(html.includes('omitted by limit') && html.includes('omitted_symbols'),
  'the UI discloses server-side file and symbol bounds');
assert.ok(html.includes('@media (max-width: 760px)') && html.includes('.arch-shell { flex-direction: column;'),
  'architecture layout stacks its inspector on narrow screens');
assert.ok(html.includes("v==='spec'||v==='cloud'||v==='frontier'||v==='kanban'||v==='architecture'"));
assert.ok(html.includes("document.getElementById('architecture').classList.toggle('show', v==='architecture')"));
assert.ok(html.includes("else if(currentView==='architecture') renderArchitecture(d)"));

const fingerprintSource = html.slice(
  html.indexOf('function architectureFingerprint'),
  html.indexOf('function statusLabel'),
);
const fingerprintContext = {};
vm.runInNewContext(`${fingerprintSource};this.stateFingerprint=stateFingerprint;`, fingerprintContext);
const fingerprintProjection = {
  version: 1,
  status: 'ready',
  summary: { visible_files: 1 },
  omitted: { files: 0 },
  files: [{
    id: 'file:src/api.js',
    path: 'src/api.js',
    module: 'src',
    symbol_count: 1,
    exported_count: 1,
    incoming_count: 0,
    outgoing_count: 1,
    internal_count: 0,
    omitted_symbols: 0,
    symbols: [{
      id: 'code:src/api.js#loadUsers',
      name: 'loadUsers',
      kind: 'function',
      signature: 'loadUsers()',
      summary: 'Loads users',
      exported: true,
      start_line: 8,
      end_line: 10,
    }],
  }],
  relations: [{
    id: 'relation:src/api.js:calls:lib/db.js',
    from: 'file:src/api.js',
    to: 'file:lib/db.js',
    kind: 'calls',
    count: 1,
    ambiguous_count: 0,
  }],
};
const baseFingerprint = fingerprintContext.stateFingerprint({ architecture: fingerprintProjection });
assert.equal(
  fingerprintContext.stateFingerprint({ architecture: JSON.parse(JSON.stringify(fingerprintProjection)) }),
  baseFingerprint,
  'the Architecture fingerprint is deterministic for identical bounded projections',
);
for (const [label, mutate] of [
  ['symbol rename', projection => { projection.files[0].symbols[0].name = 'loadAccounts'; }],
  ['signature change', projection => { projection.files[0].symbols[0].signature = 'loadUsers(limit)'; }],
  ['summary change', projection => { projection.files[0].symbols[0].summary = 'Loads active users'; }],
  ['export change', projection => { projection.files[0].symbols[0].exported = false; }],
  ['line change', projection => { projection.files[0].symbols[0].start_line = 9; }],
  ['relation detail change', projection => { projection.relations[0].ambiguous_count = 1; }],
]) {
  const changed = JSON.parse(JSON.stringify(fingerprintProjection));
  mutate(changed);
  assert.notEqual(fingerprintContext.stateFingerprint({ architecture: changed }), baseFingerprint,
    `${label} invalidates the Architecture render fingerprint without changing counts`);
}

const helperSource = html.slice(
  html.indexOf('function architectureFileMatches'),
  html.indexOf('function architectureCard'),
);
const helperContext = {};
vm.runInNewContext(`${helperSource};this.helpers={architectureFileMatches,architectureVisibleIds};`, helperContext);
const projection = {
  files: [
    { id: 'file:src/api.js', path: 'src/api.js', module: 'src', symbols: [{ name: 'loadUsers', kind: 'function' }] },
    { id: 'file:lib/db.js', path: 'lib/db.js', module: 'lib', symbols: [{ name: 'query', kind: 'function' }] },
    { id: 'file:test/api.test.js', path: 'test/api.test.js', module: 'test', symbols: [] },
  ],
  relations: [{ from: 'file:src/api.js', to: 'file:lib/db.js', kind: 'calls' }],
};
assert.ok(helperContext.helpers.architectureFileMatches(projection.files[0], 'loadusers'));
assert.deepEqual(
  [...helperContext.helpers.architectureVisibleIds(projection, 'api')].sort(),
  ['file:lib/db.js', 'file:src/api.js', 'file:test/api.test.js'],
  'search includes matches and their directly related files',
);
assert.deepEqual(
  [...helperContext.helpers.architectureVisibleIds(projection, 'query')].sort(),
  ['file:lib/db.js', 'file:src/api.js'],
);

console.log('PASS  architecture dashboard contract');
