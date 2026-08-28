#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');

const kanbanTab = html.indexOf('data-view="kanban"');
const frontierTab = html.indexOf('data-view="frontier"');
const cloudTab = html.indexOf('data-view="cloud"');
assert.ok(kanbanTab !== -1 && kanbanTab < frontierTab && frontierTab < cloudTab,
  'top-level tabs must be ordered Kanban Board, Frontier Tasks, Force Cloud');
assert.match(html, /localStorage\.getItem\('orchView'\)[\s\S]*?'kanban'/,
  'Kanban must be the fallback operational view');

assert.ok(html.includes('<div id="kanban" aria-label="Operational Kanban board"></div>'));
assert.ok(html.includes("projection.version!==1"), 'renderer must honor the versioned projection contract');
assert.ok(html.includes("(projection.columns||[]).map(column=>"), 'renderer must use the server-owned lane order');
assert.ok(html.includes("(column.task_keys||[]).map(key=>byCard[key])"), 'renderer must resolve stable task keys into cards');

assert.ok(html.includes('class="kb-count"'), 'lane headers must display counts');
assert.ok(html.includes('class="kb-live-dot"') && html.includes("liveAgentIds.has(card.assignee)"),
  'WIP must distinguish locally live work');
assert.ok(html.includes("cues.user_gate") && html.includes("cues.review") && html.includes("cues.merge"),
  'cards must surface user-gate, review, and merge attention cues');

assert.ok(html.includes('data-task-key="${esc(card.task_key)}"'));
assert.ok(html.includes('openDetail(button.dataset.taskKey)'), 'card selection must reuse the existing detail drawer');
const kanbanRenderer = html.slice(html.indexOf('function renderKanban(d)'), html.indexOf('function fmtK(n)'));
assert.ok(!kanbanRenderer.includes('draggable="true"') && !kanbanRenderer.includes('dragstart'),
  'observational v1 must not imply unsupported drag/drop mutation');

assert.ok(html.includes('grid-template-columns: repeat(5') && html.includes('overflow: auto'),
  'board must preserve five horizontal lanes with overflow on narrow surfaces');
assert.ok(html.includes('#panel.open { width: min(380px, 100vw); }'),
  'the detail drawer must overlay rather than collapse the narrow board');
assert.ok(html.includes('function kanbanHistoryItems(d)') && html.includes('.sort((a,b)=>time(b)-time(a))'),
  'Done history must provide a recency-sorted affordance');
assert.ok(html.includes('onclick="event.stopPropagation();openKanbanHistory()">History ↗</button>'));

console.log('PASS  operational Kanban dashboard contract');
