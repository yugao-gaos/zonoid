#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');
const between = (start, end) => html.slice(html.indexOf(start), html.indexOf(end));

assert.equal((html.match(/id="panel"/g) || []).length, 1,
  'all task surfaces must reuse one detail inspector');

const openDetail = between('async function openDetail(key)', 'function syncSelectedTask()');
assert.match(openDetail, /selected=key/,
  'opening a task from any surface must update the shared selected key');
assert.match(openDetail, /if\(selected!==key\) return/,
  'a stale detail response must not replace a newer selection');
assert.match(openDetail, /Token usage/);
assert.match(openDetail, /Hold reason/);
assert.match(openDetail, /Focus view/);
assert.match(openDetail, />ID</);
assert.match(openDetail, />Dependencies</);
assert.match(openDetail, />Knowledge</);
assert.match(openDetail, /Transcript/,
  'the shared inspector must retain its existing fields and actions');

assert.match(openDetail, /class="dep-link" data-task-key=/,
  'blocking dependencies must be interactive task references');
assert.match(openDetail, /navigateToDependency\(button\.dataset\.taskKey\)/);
const dependencyNavigation = between('function navigateToDependency(key)', 'function closeDetail()');
assert.ok(dependencyNavigation.indexOf('selected=key') < dependencyNavigation.indexOf("setView('cloud')"),
  'dependency navigation must keep the dependency selected while switching to Force Cloud');
assert.match(dependencyNavigation, /openDetail\(key\)/,
  'dependency navigation must reuse the same inspector');

assert.match(html, /openDetail\(button\.dataset\.taskKey\)/,
  'Kanban cards must use the shared inspector');
assert.match(html, /na\.on\('click',\(ev,t\)=>openDetail\(t\.id\)\)/,
  'Frontier nodes must use the shared inspector');
assert.match(html, /else openDetail\(n\.id\)/,
  'Force Cloud nodes must use the shared inspector');

const setView = between('function setView(v)', 'function focusNode(key)');
assert.ok(!setView.includes("cloudSearchText=''"),
  'tab switches must preserve the Force Cloud search filter');
assert.match(html, /function captureViewState\(v\)/);
assert.match(html, /viewUiState\.kanban=\{scrollLeft:root\.scrollLeft,scrollTop:root\.scrollTop\}/);
assert.match(html, /root\.scrollLeft=viewUiState\.kanban\.scrollLeft/);
assert.match(html, /root\.scrollTop=viewUiState\.kanban\.scrollTop/,
  'Kanban scroll state must survive both polling renders and tab switches');

assert.match(html, /if\(currentView!==\'focus\'\) focusReturnView=currentView/);
assert.match(html, /setView\(focusReturnView\)/,
  'Focus View must return to the originating tab instead of forcing Frontier');
assert.match(html, /n\.id===selected\) return 1/,
  'the point-cloud renderer must visibly retain the shared selection');

console.log('PASS  shared Kanban task selection and inspector browser contract');
