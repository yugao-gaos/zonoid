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
const knowledgeTab = html.indexOf('data-view="cloud"');
const architectureTab = html.indexOf('data-view="architecture"');
assert.ok(
  specTab !== -1 && specTab < kanbanTab && kanbanTab < frontierTab
    && frontierTab < knowledgeTab && knowledgeTab < architectureTab,
  'top-level tabs are ordered Spec, Kanban, Frontier, Knowledge, Architecture',
);
for (const [view, label] of [
  ['spec', 'Spec'],
  ['kanban', 'Kanban'],
  ['frontier', 'Frontier'],
  ['cloud', 'Knowledge'],
  ['architecture', 'Architecture'],
]) {
  assert.match(html, new RegExp(`data-view="${view}"[^>]*>${label}<\\/button>`), `${view} uses the requested label`);
}

assert.ok(html.includes('<div id="spec" role="region" aria-label="Project specification">'));
assert.ok(html.includes('id="specEditor"') && html.includes('id="specSaveBtn"'));
assert.ok(html.includes("v==='spec'||v==='cloud'||v==='frontier'||v==='kanban'||v==='architecture'"));
assert.ok(html.includes("document.getElementById('spec').classList.toggle('show', v==='spec')"));
assert.ok(html.includes("if(currentView==='spec') renderSpec(d)"));

const helperSource = html.slice(
  html.indexOf('function canonicalSpecTitle'),
  html.indexOf('function renderSpec'),
);
const helperContext = { currentRepoName: () => 'zonoid' };
vm.runInNewContext(`${helperSource};this.helpers={canonicalSpecTitle,currentSpecTask};`, helperContext);
assert.equal(helperContext.helpers.canonicalSpecTitle(), 'SPEC: zonoid');
const current = helperContext.helpers.currentSpecTask({ tasks: [
  { id: 'note:old', kind: 'note', label: 'SPEC: zonoid', category: 'system', validTo: '2026-01-01', created_at: '2025-01-01' },
  { id: 'note:wrong-category', kind: 'note', label: 'SPEC: zonoid', category: 'preference', created_at: '2026-01-01' },
  { id: 'note:other', kind: 'note', label: 'SPEC: other', category: 'system', created_at: '2026-02-01' },
  { id: 'note:current', kind: 'note', label: 'SPEC: zonoid', category: 'system', created_at: '2026-03-01', summary: 'Current spec' },
] });
assert.equal(current.id, 'note:current', 'only the current canonical workspace system note is editable');
assert.equal(helperContext.helpers.currentSpecTask({ tasks: [] }), null, 'a missing spec has an honest empty state');

const saveSource = html.slice(html.indexOf('async function saveSpec'), html.indexOf('// ---- Architecture:'));
assert.ok(saveSource.includes("dfetch('/overlay/note'"), 'saving uses the existing versioned note route');
assert.ok(saveSource.includes("category:'system'"), 'saved specs remain system-tier notes');
assert.ok(saveSource.includes('supersedes:current.id'), 'editing creates a successor instead of mutating history');
assert.ok(saveSource.includes('specSaving'), 'the save action guards duplicate submissions');
assert.ok(saveSource.includes('summary===currentSummary'), 'unchanged text does not mint a redundant spec version');

assert.match(html, /localStorage\.getItem\('orchView'\)[\s\S]*?'kanban'/,
  'Kanban remains the operational default even though Spec is the first navigation tab');

console.log('PASS  project Spec dashboard contract');
