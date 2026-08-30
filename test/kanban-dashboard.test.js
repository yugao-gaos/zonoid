#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');
const stateRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'state.js'), 'utf8');

for (const field of ['vec', 'vecMeta', 'vecs', 'vecsMeta']) {
  assert.ok(stateRoute.includes(`delete projected.${field};`), `/state must omit server-only embedding field ${field}`);
}
assert.ok(stateRoute.includes('dashboardTasks(frontier.archivedTaskList'), 'archived task projection must strip embeddings');
assert.ok(stateRoute.includes('tasks: dashboardTasks(f.tasks)'), 'frontier task projection must strip embeddings');
assert.ok(stateRoute.includes('tasks: dashboardTasks(tasks)'), 'default task projection must strip embeddings');

const kanbanTab = html.indexOf('data-view="kanban"');
const frontierTab = html.indexOf('data-view="frontier"');
const cloudTab = html.indexOf('data-view="cloud"');
assert.ok(kanbanTab !== -1 && kanbanTab < frontierTab && frontierTab < cloudTab,
  'top-level tabs must be ordered Kanban Board, Frontier Tasks, Force Cloud');
assert.match(html, /localStorage\.getItem\('orchView'\)[\s\S]*?'kanban'/,
  'Kanban must be the fallback operational view');

assert.ok(html.includes('<div id="kanban" role="region" aria-label="Operational Kanban board"></div>'));
assert.ok(html.includes('id="viewToggle" role="tablist" aria-label="Dashboard views"'));
assert.ok(html.includes('role="tab" aria-selected="true"') && html.includes("b.setAttribute('aria-selected',String(active))"),
  'top-level views must expose current tab state to assistive technology');
assert.ok(html.includes('id="panel" role="complementary" aria-label="Task inspector"'));
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
const detailSource = html.slice(html.indexOf('async function openDetail(key)'), html.indexOf('function syncSelectedTask()'));
assert.ok(detailSource.indexOf('renderDetail(key,{ task:cached') < detailSource.indexOf("dfetch('/task/detail?key='"),
  'the detail drawer must render cached task fields before requesting slow enrichment');
assert.ok(detailSource.includes("await new Promise(resolve=>setTimeout(resolve,0))"),
  'the cached drawer shell must get a browser turn to paint before enrichment');
assert.ok(detailSource.includes('selected!==key||requestSeq!==detailRequestSeq'),
  'late detail responses must not replace a newer selection or request');
assert.ok(detailSource.includes('selectedDetailData=d'),
  'the selected task detail payload must be cached after enrichment');
assert.ok(detailSource.includes('syncSelectedDetailFromState'),
  'state refreshes must resync the open drawer without reopening the detail request');
const cardDisplaySource = html.slice(
  html.indexOf('const OPAQUE_KANBAN_TASK_KEY='),
  html.indexOf('function kanbanCueLabel'),
);
const cardDisplayContext = {};
vm.runInNewContext(`${cardDisplaySource};this.kanbanCardDisplay=kanbanCardDisplay;`, cardDisplayContext);
const opaqueKey = '019c3ac8-f971-7b80-9d14-1b34dfd3c9e9';
for (const card of [{ task_key: opaqueKey }, { task_key: `${opaqueKey}/42`, label: `${opaqueKey}/42` }]) {
  const display = cardDisplayContext.kanbanCardDisplay(card);
  assert.equal(display.title, 'Untitled legacy task', 'unlabeled opaque task IDs must use a neutral card title');
  assert.equal(display.subtitle, '', 'opaque task IDs must not appear as card subtitles');
}
const labeledOpaque = cardDisplayContext.kanbanCardDisplay({ task_key: opaqueKey, label: 'Recover background review' });
assert.equal(labeledOpaque.title, 'Recover background review', 'human labels must survive opaque internal task keys');
assert.equal(labeledOpaque.subtitle, '', 'labeled opaque keys must remain hidden from the card');
const normalCard = cardDisplayContext.kanbanCardDisplay({ task_key: 'codex/recover-background-review', label: 'Recover background review' });
assert.equal(normalCard.title, 'Recover background review');
assert.equal(normalCard.subtitle, 'codex/recover-background-review', 'human-readable task keys keep their subtitle');
const kanbanRenderer = html.slice(html.indexOf('function renderKanban(d)'), html.indexOf('function fmtK(n)'));
assert.ok(!kanbanRenderer.includes('draggable="true"') && !kanbanRenderer.includes('dragstart'),
  'observational v1 must not imply unsupported drag/drop mutation');

assert.ok(html.includes('grid-template-columns: repeat(5') && html.includes('overflow: auto'),
  'board must preserve five horizontal lanes with overflow on narrow surfaces');
assert.ok(html.includes('#panel.open { width: min(380px, 100vw); }'),
  'the detail drawer must overlay rather than collapse the narrow board');
assert.ok(html.includes('function kanbanHistoryItems(d)') && html.includes('.sort((a,b)=>kanbanTaskTime(b)-kanbanTaskTime(a))'),
  'Done history must provide a recency-sorted affordance');
assert.ok(html.includes('onclick="event.stopPropagation();openKanbanHistory()">History ↗</button>'));
assert.ok(html.includes('const KB_DONE_CAP=12') && html.includes('function recentKanbanCards') && html.includes('.slice(0,cap)'),
  'the Done lane must stay bounded while History retains the complete terminal-task list');
assert.ok(html.includes('Recent ${cards.length} of ${allCards.length}'),
  'Done must label its visible recency window without hiding the total count');
assert.ok(html.includes("dfetch('/events'") && html.includes('handleSSEMessage') && html.includes('tick();'),
  'the live event stream must drive the same state refresh that rerenders Kanban');
const resilientTickSource = html.slice(html.indexOf('const _origTick = tick;'), html.indexOf('// ── Kick off'));
assert.ok(resilientTickSource.includes('return _origTick(stateBody)') && !resilientTickSource.includes('return _origTick();'),
  'the resilience wrapper must render its existing /state response instead of fetching state twice');
assert.ok(resilientTickSource.includes('if(_tickInFlight)') && resilientTickSource.includes('_tickQueued=true'),
  'overlapping SSE and polling ticks must be coalesced');
assert.ok(html.includes('syncSelectedDetailFromState(selected)'),
  'tick should refresh the visible detail shell from lastState without reopening it');
assert.ok(!html.includes('openDetail(selected)'),
  'tick must not reopen rich task detail on every state poll');

const helperSource = html.slice(html.indexOf('const KB_DONE_CAP=12'), html.indexOf('function openKanbanHistory()'));
const helperContext = {};
vm.runInNewContext(`${helperSource};this.helpers={recentKanbanCards,kanbanHistoryItems};`, helperContext);
const terminalTasks = Array.from({ length: 13 }, (_, index) => ({
  id: `done-${index}`,
  status: 'done',
  lastChanged: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
}));
const terminalById = Object.fromEntries(terminalTasks.map(task => [task.id, task]));
const recentKeys = Array.from(helperContext.helpers.recentKanbanCards(
  terminalTasks.map(task => ({ task_key: task.id })), terminalById,
), card => card.task_key);
assert.deepEqual(recentKeys, terminalTasks.slice(1).reverse().map(task => task.id),
  'Done renders only the 12 most recent tasks, including camel-case graph timestamps');
assert.deepEqual(
  Array.from(helperContext.helpers.kanbanHistoryItems({ tasks: terminalTasks }), task => task.id),
  terminalTasks.slice().reverse().map(task => task.id),
  'History keeps the full terminal set in recent-first order');

console.log('PASS  operational Kanban dashboard contract');
