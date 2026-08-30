#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');
const kanbanTab = html.indexOf('data-view="kanban"');
const frontierTab = html.indexOf('data-view="frontier"');
const cloudTab = html.indexOf('data-view="cloud"');
const architectureTab = html.indexOf('data-view="architecture"');
assert.ok(kanbanTab !== -1 && kanbanTab < frontierTab && frontierTab < cloudTab && cloudTab < architectureTab,
  'Architecture is additive and preserves the established dashboard tab order');
assert.ok(html.includes('<div id="architecture" role="region" aria-label="Code architecture map">'));
assert.ok(html.includes('id="architectureSearchInput"') && html.includes('aria-label="Search architecture files and symbols"'));
assert.ok(html.includes('id="architectureInspector" aria-label="Architecture inspector" aria-live="polite"'));
assert.ok(html.includes('id="architectureBreadcrumbs"') && html.includes('aria-label="Architecture breadcrumb"'),
  'module drilldown has an accessible location and return path');
assert.ok(html.includes('id="architectureNoiseToggle"') && html.includes('Include tests &amp; generated'),
  'auxiliary files are available behind an explicit noise toggle');
assert.ok(html.includes('projection.version!==1'), 'renderer honors the versioned architecture contract');
assert.ok(html.includes("projection.status==='empty'") && html.includes('Nothing indexed yet'),
  'missing code-index data has an honest empty state');
assert.ok(html.includes('arch-legend-line calls') && html.includes("relation.kind==='calls'?'#d29922':'#58a6ff'"),
  'imports and calls have distinct legend and edge treatments');
assert.ok(html.includes('renderArchitectureOverview') && html.includes('data-arch-open-module'),
  'Architecture starts with subsystem cards and requires explicit file drilldown');
assert.ok(html.includes('architectureFocusedRelations(projection.module_relations,architectureFocusedModuleId)')
  && html.includes('architectureFocusedRelations(projection.relations,architectureSelectedId)'),
  'module and file relationships are drawn only for the focused node');
assert.ok(html.includes('if(!selectedId) return []'), 'the overview renders zero relationship paths before focus');
assert.ok(html.includes('normally hidden') && html.includes('arch-file-noise'),
  'search reveals and labels normally hidden noisy files');
assert.ok(html.includes('omitted_symbols') && html.includes('File drilldown is bounded'),
  'the UI discloses server-side file and symbol bounds');
assert.ok(html.includes('@media (max-width: 760px)') && html.includes('.arch-shell { flex-direction: column;'),
  'architecture layout stacks its inspector on narrow screens');
assert.ok(html.includes("v==='cloud'||v==='frontier'||v==='kanban'||v==='architecture'"));
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
  summary: { visible_files: 2, visible_modules: 2 },
  omitted: { files: 0, module_relations: 0 },
  modules: [{
    id: 'module:src',
    name: 'src',
    file_count: 1,
    default_file_count: 1,
    hidden_file_count: 0,
    symbol_count: 1,
    incoming_count: 0,
    outgoing_count: 1,
    file_ids: ['file:src/api.js'],
  }, {
    id: 'module:lib',
    name: 'lib',
    file_count: 1,
    default_file_count: 1,
    hidden_file_count: 0,
    symbol_count: 1,
    incoming_count: 1,
    outgoing_count: 0,
    file_ids: ['file:lib/db.js'],
  }],
  module_relations: [{
    id: 'module-relation:src:calls:lib',
    from: 'module:src',
    to: 'module:lib',
    kind: 'calls',
    count: 1,
    ambiguous_count: 0,
  }],
  files: [{
    id: 'file:src/api.js',
    path: 'src/api.js',
    module: 'src',
    noise: null,
    is_noisy: false,
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
  ['noise classification change', projection => { projection.files[0].noise = 'test'; }],
  ['noise visibility change', projection => { projection.files[0].is_noisy = true; }],
  ['module aggregate change', projection => { projection.modules[0].symbol_count = 2; }],
  ['module relation change', projection => { projection.module_relations[0].count = 2; }],
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
vm.runInNewContext(`${helperSource};this.helpers={architectureFileMatches,architectureVisibleModules,architectureFocusedRelations,architectureVisibleFiles};`, helperContext);
const projection = {
  modules: [
    { id: 'module:src', name: 'src', file_count: 1, default_file_count: 1 },
    { id: 'module:lib', name: 'lib', file_count: 1, default_file_count: 1 },
    { id: 'module:test', name: 'test', file_count: 1, default_file_count: 0 },
  ],
  files: [
    { id: 'file:src/api.js', path: 'src/api.js', module: 'src', is_noisy: false, symbols: [{ name: 'loadUsers', kind: 'function' }] },
    { id: 'file:lib/db.js', path: 'lib/db.js', module: 'lib', is_noisy: false, symbols: [{ name: 'query', kind: 'function' }] },
    { id: 'file:test/api.test.js', path: 'test/api.test.js', module: 'test', noise: 'test', is_noisy: true, symbols: [] },
  ],
  relations: [{ from: 'file:src/api.js', to: 'file:lib/db.js', kind: 'calls' }],
};
assert.ok(helperContext.helpers.architectureFileMatches(projection.files[0], 'loadusers'));
assert.deepEqual(
  helperContext.helpers.architectureVisibleModules(projection, false).map(module => module.id),
  ['module:src', 'module:lib'],
  'the default overview excludes noise-only subsystems',
);
assert.deepEqual(
  helperContext.helpers.architectureVisibleFiles(projection, '', null, false, null),
  [],
  'the initial overview contains no file cards',
);
assert.deepEqual(
  helperContext.helpers.architectureVisibleFiles(projection, '', 'src', false, null).map(file => file.id),
  ['file:src/api.js'],
  'opening a subsystem reveals only its clean files by default',
);
assert.deepEqual(
  helperContext.helpers.architectureVisibleFiles(projection, '', 'test', true, null).map(file => file.id),
  ['file:test/api.test.js'],
  'the explicit toggle reveals auxiliary files in module drilldown',
);
assert.deepEqual(
  helperContext.helpers.architectureVisibleFiles(projection, 'api', null, false, null).map(file => file.id),
  ['file:src/api.js', 'file:test/api.test.js'],
  'search can find normally hidden noisy files and leaves them labelled for the renderer',
);
assert.deepEqual(
  helperContext.helpers.architectureFocusedRelations(projection.relations, null),
  [],
  'no selection means no paths',
);
assert.deepEqual(
  helperContext.helpers.architectureVisibleFiles(projection, '', 'src', false, 'file:src/api.js').map(file => file.id),
  ['file:lib/db.js', 'file:src/api.js'],
  'file focus discloses only its immediate connected peer cards',
);

console.log('PASS  architecture dashboard contract');
