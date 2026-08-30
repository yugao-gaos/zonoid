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
assert.ok(html.includes('id="architectureInspector" aria-label="Architecture inspector" aria-live="polite"'));
assert.ok(html.includes('id="architectureBreadcrumbs"') && html.includes('aria-label="Architecture breadcrumb"'),
  'compound selection has an accessible hierarchy path');
assert.ok(html.includes('id="architectureNoiseToggle"') && html.includes('Include tests &amp; generated'),
  'auxiliary files are available behind an explicit noise toggle');
assert.ok(html.includes('id="architectureFitButton"') && html.includes('aria-label="Fit architecture canvas"'));
assert.ok(html.includes('projection.version!==1'), 'renderer honors the versioned architecture contract');
assert.ok(html.includes("projection.status==='empty'") && html.includes('Nothing indexed yet'),
  'missing code-index data has an honest empty state');
assert.ok(html.includes('arch-legend-line calls') && html.includes('.arch-canvas-edge.calls { stroke: #d29922;')
  && html.includes('arch-canvas-imports') && html.includes('arch-canvas-calls'),
  'imports and calls have distinct legend and edge treatments');
assert.ok(html.includes('id="architectureCanvas" role="region" aria-label="Pan and zoom architecture hierarchy" tabindex="0"')
  && html.includes('d3.zoom().scaleExtent([.12,3.5])'),
  'Architecture is a real pan/zoom SVG canvas');
assert.ok(html.includes('architectureExpandedIds') && html.includes('architectureVisibleHierarchy'),
  'compound modules and groups expand recursively');
assert.ok(html.includes('architectureRetargetEndpoint') && html.includes('architectureRetargetRelations'),
  'file relationships retarget to the deepest currently visible endpoint');
assert.ok(html.includes('data-parent-id') && html.includes('arch-compound'),
  'nested groups render inside explicit compound boundaries');
assert.ok(html.indexOf('<g class="arch-compound-backgrounds">') < html.indexOf('<g class="arch-canvas-edges">')
  && html.indexOf('<g class="arch-canvas-edges">') < html.indexOf('<g class="arch-canvas-nodes">'),
  'compound fills render below relations while interactive headers and files render above them');
assert.ok(html.includes('architectureSearchMatchIds') && html.includes('arch-file-noise'),
  'search still reveals and labels normally hidden noisy files');
assert.ok(html.includes('omitted_symbols') && html.includes('detail omitted by limit'),
  'the UI discloses server-side file and symbol bounds');
assert.ok(html.includes('@media (max-width: 760px)') && html.includes('.arch-shell { flex-direction: column;'),
  'architecture layout stacks its inspector on narrow screens');
assert.ok(html.includes("event.key==='Enter'||event.key===' '"),
  'compound nodes support keyboard expansion');
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
  summary: { visible_files: 2, visible_modules: 2, visible_groups: 1 },
  omitted: { files: 0, module_relations: 0, hierarchy_relations: 0 },
  modules: [{
    id: 'module:src',
    name: 'src',
    parent_id: null,
    child_ids: ['group:src/api'],
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
    parent_id: null,
    child_ids: ['file:lib/db.js'],
    file_count: 1,
    default_file_count: 1,
    hidden_file_count: 0,
    symbol_count: 1,
    incoming_count: 1,
    outgoing_count: 0,
    file_ids: ['file:lib/db.js'],
  }],
  groups: [{
    id: 'group:src/api',
    name: 'api',
    path: 'src/api',
    parent_id: 'module:src',
    child_ids: ['file:src/api.js'],
    file_ids: ['file:src/api.js'],
    depth: 1,
    module: 'src',
    direct_file_count: 1,
    file_count: 1,
    default_file_count: 1,
    hidden_file_count: 0,
    symbol_count: 1,
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
    parent_id: 'group:src/api',
    ancestor_ids: ['group:src/api', 'module:src'],
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
  hierarchy_relations: [{
    id: 'hierarchy-relation:src/api.js:calls:lib/db.js',
    from: 'file:src/api.js',
    to: 'file:lib/db.js',
    from_ancestors: ['group:src/api', 'module:src'],
    to_ancestors: ['module:lib'],
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
  ['file parent change', projection => { projection.files[0].parent_id = 'module:src'; }],
  ['module aggregate change', projection => { projection.modules[0].symbol_count = 2; }],
  ['module child change', projection => { projection.modules[0].child_ids = []; }],
  ['group parent change', projection => { projection.groups[0].parent_id = 'module:other'; }],
  ['module relation change', projection => { projection.module_relations[0].count = 2; }],
  ['relation detail change', projection => { projection.relations[0].ambiguous_count = 1; }],
  ['hierarchy ancestry change', projection => { projection.hierarchy_relations[0].from_ancestors = ['module:src']; }],
]) {
  const changed = JSON.parse(JSON.stringify(fingerprintProjection));
  mutate(changed);
  assert.notEqual(fingerprintContext.stateFingerprint({ architecture: changed }), baseFingerprint,
    `${label} invalidates the Architecture render fingerprint without changing counts`);
}

const helperSource = html.slice(
  html.indexOf('function architectureFileMatches'),
  html.indexOf('function architectureCanvasNodeLabel'),
);
const helperContext = {};
vm.runInNewContext(`${helperSource};this.helpers={architectureFileMatches,architectureSearchMatchIds,architectureEffectiveExpandedIds,architectureVisibleHierarchy,architectureRetargetEndpoint,architectureRetargetRelations,architectureBreadcrumbIds,architectureLayoutHierarchy};`, helperContext);
const projection = {
  modules: [
    { id: 'module:src', name: 'src', child_ids: ['group:src/api'], file_count: 2, default_file_count: 2 },
    { id: 'module:lib', name: 'lib', child_ids: ['group:lib/db'], file_count: 1, default_file_count: 1 },
    { id: 'module:test', name: 'test', child_ids: ['group:test/api'], file_count: 1, default_file_count: 0 },
  ],
  groups: [
    { id: 'group:src/api', name: 'api', path: 'src/api', parent_id: 'module:src', child_ids: ['group:src/api/http', 'file:src/api/helper.js'], file_count: 2, default_file_count: 2 },
    { id: 'group:src/api/http', name: 'http', path: 'src/api/http', parent_id: 'group:src/api', child_ids: ['file:src/api/http/routes.js'], file_count: 1, default_file_count: 1 },
    { id: 'group:lib/db', name: 'db', path: 'lib/db', parent_id: 'module:lib', child_ids: ['file:lib/db/query.js'], file_count: 1, default_file_count: 1 },
    { id: 'group:test/api', name: 'api', path: 'test/api', parent_id: 'module:test', child_ids: ['file:test/api/routes.test.js'], file_count: 1, default_file_count: 0 },
  ],
  files: [
    { id: 'file:src/api/http/routes.js', name: 'routes.js', path: 'src/api/http/routes.js', module: 'src', parent_id: 'group:src/api/http', ancestor_ids: ['group:src/api/http', 'group:src/api', 'module:src'], is_noisy: false, symbols: [{ name: 'loadUsers', kind: 'function' }] },
    { id: 'file:src/api/helper.js', name: 'helper.js', path: 'src/api/helper.js', module: 'src', parent_id: 'group:src/api', ancestor_ids: ['group:src/api', 'module:src'], is_noisy: false, symbols: [{ name: 'loadHelper', kind: 'function' }] },
    { id: 'file:lib/db/query.js', name: 'query.js', path: 'lib/db/query.js', module: 'lib', parent_id: 'group:lib/db', ancestor_ids: ['group:lib/db', 'module:lib'], is_noisy: false, symbols: [{ name: 'query', kind: 'function' }] },
    { id: 'file:test/api/routes.test.js', name: 'routes.test.js', path: 'test/api/routes.test.js', module: 'test', parent_id: 'group:test/api', ancestor_ids: ['group:test/api', 'module:test'], noise: 'test', is_noisy: true, symbols: [{ name: 'routeTest', kind: 'function' }] },
  ],
  hierarchy_relations: [
    { from: 'file:src/api/http/routes.js', to: 'file:lib/db/query.js', from_ancestors: ['group:src/api/http', 'group:src/api', 'module:src'], to_ancestors: ['group:lib/db', 'module:lib'], kind: 'calls', count: 2, ambiguous_count: 0 },
    { from: 'file:src/api/helper.js', to: 'file:lib/db/query.js', from_ancestors: ['group:src/api', 'module:src'], to_ancestors: ['group:lib/db', 'module:lib'], kind: 'calls', count: 1, ambiguous_count: 0 },
  ],
};
assert.ok(helperContext.helpers.architectureFileMatches(projection.files[0], 'loadusers'));
assert.deepEqual(
  helperContext.helpers.architectureVisibleHierarchy(projection, new Set(), '', false).nodes.map(node => node.id),
  ['module:src', 'module:lib'],
  'the default canvas contains only collapsed clean top-level modules',
);
assert.deepEqual(
  helperContext.helpers.architectureVisibleHierarchy(projection, new Set(['module:src']), '', false).nodes.map(node => node.id),
  ['module:src', 'group:src/api', 'module:lib'],
  'expanding a module reveals only its immediate nested group',
);
assert.deepEqual(
  helperContext.helpers.architectureVisibleHierarchy(projection, new Set(['module:src', 'group:src/api']), '', false).nodes.map(node => node.id),
  ['module:src', 'group:src/api', 'group:src/api/http', 'file:src/api/helper.js', 'module:lib'],
  'recursive expansion reveals only the next hierarchy level',
);
const collapsedRelations = helperContext.helpers.architectureRetargetRelations(
  projection, new Set(), new Set(['module:src', 'module:lib']),
);
assert.deepEqual(collapsedRelations.map(edge => [edge.from, edge.to, edge.kind, edge.count]), [
  ['module:src', 'module:lib', 'calls', 3],
], 'collapsed modules receive aggregated file relations');
const oneSideExpanded = helperContext.helpers.architectureRetargetRelations(
  projection,
  new Set(['module:src']),
  new Set(['module:src', 'group:src/api', 'module:lib']),
);
assert.deepEqual(oneSideExpanded.map(edge => [edge.from, edge.to, edge.count]), [
  ['group:src/api', 'module:lib', 3],
], 'an expanded side retargets to its visible child while its peer remains collapsed');
const deepestExpanded = new Set(['module:src', 'group:src/api', 'group:src/api/http', 'module:lib', 'group:lib/db']);
const deepestRelations = helperContext.helpers.architectureRetargetRelations(projection, deepestExpanded);
assert.ok(deepestRelations.some(edge => edge.from === 'file:src/api/http/routes.js' && edge.to === 'file:lib/db/query.js'),
  'when both sides are expanded, edges terminate at the deepest visible files');
const searchVisible = helperContext.helpers.architectureVisibleHierarchy(projection, new Set(), 'routetest', false);
assert.ok(searchVisible.nodes.some(node => node.id === 'file:test/api/routes.test.js'),
  'search auto-expands ancestors and reveals a normally hidden noisy match');
const toggledVisible = helperContext.helpers.architectureVisibleHierarchy(projection, new Set(['module:test', 'group:test/api']), '', true);
assert.ok(toggledVisible.nodes.some(node => node.id === 'file:test/api/routes.test.js'),
  'the auxiliary toggle reveals noisy hierarchy nodes');
assert.deepEqual(
  helperContext.helpers.architectureBreadcrumbIds(projection, 'file:src/api/http/routes.js'),
  ['module:src', 'group:src/api', 'group:src/api/http', 'file:src/api/http/routes.js'],
  'breadcrumbs preserve the visible containment path',
);
const nestedVisible = helperContext.helpers.architectureVisibleHierarchy(projection, new Set(['module:src']), '', false);
const nestedLayout = helperContext.helpers.architectureLayoutHierarchy(nestedVisible);
const parentBox = nestedLayout.boxes.get('module:src');
const childBox = nestedLayout.boxes.get('group:src/api');
assert.ok(childBox.x > parentBox.x && childBox.y > parentBox.y
  && childBox.x + childBox.w < parentBox.x + parentBox.w
  && childBox.y + childBox.h < parentBox.y + parentBox.h,
  'expanded children are laid out inside their compound parent boundary');

console.log('PASS  architecture dashboard contract');
