#!/usr/bin/env node
'use strict';

const assert = require('assert');
const mcpCore = require('../lib/mcp-core');
const uiTools = require('../lib/mcp/tools/ui');

const OPAQUE = '019c3ac8-f971-7b80-9d14-1b34dfd3c9e9';
const rawPath = '/mnt/private workspace/task.txt';
const rawToken = 'mobile-secret-token';
let revision = 1;
const calls = [];

function tasks() {
  return [
    {
      id: OPAQUE,
      label: revision === 1
        ? `Render status from "${rawPath}" token=${rawToken}`
        : 'Render updated portable status',
      status: 'in_progress',
      deps: [],
      lastChanged: '2026-08-30T18:00:00Z',
    },
    { id: 'codex/ready', label: 'Deliver snapshot', status: 'ready', deps: [] },
    { id: 'codex/done', label: 'Finish renderer', status: 'done', deps: [], lastChanged: '2026-08-30T17:00:00Z' },
  ];
}

async function call(method, path) {
  calls.push({ method, path });
  if (method === 'GET' && path.startsWith('/state')) {
    const current = tasks();
    return {
      tasks: current,
      kanban: { cards: current.map((task) => ({ task_key: task.id })) },
    };
  }
  if (method === 'GET' && path.startsWith('/guidance')) {
    return {
      user_attention: [{
        id: 'decision',
        question: 'Approve {"password":"hunter2"}?',
        severity: 'blocking',
        resolved: false,
        origin_task: OPAQUE,
      }],
    };
  }
  return { ok: true };
}

function request(workspace, client, extraCtx = {}, includeWorkspace = true) {
  return mcpCore.handleRpc({
    jsonrpc: '2.0',
    id: `${client}-${workspace}`,
    method: 'tools/call',
    params: { name: 'show_dashboard', arguments: includeWorkspace ? { workspace } : {} },
  }, {
    client,
    workspace,
    identity: { graph_repo: workspace },
    call,
    ...extraCtx,
  });
}

function parsedResult(rpc) {
  assert.ok(rpc && rpc.result && !rpc.result.isError);
  const legacy = rpc.result.structuredContent;
  assert.ok(legacy && typeof legacy === 'object', 'legacy fields must use structuredContent');
  const expectedText = legacy.snapshot_summary || legacy.snapshot_text;
  const status = rpc.result.content.find((item) => item.type === 'text' && item.text === expectedText);
  assert.ok(status, 'accessible status must remain first-class MCP text content');
  assert.ok(!status.text.trimStart().startsWith('{'), 'accessible status must not require a legacy JSON text block');
  const image = rpc.result.content.find((item) => item.type === 'image');
  return { legacy, status, image };
}

(async () => {
  uiTools._test.snapshotCache.clear();

  const hashes = [];
  for (const client of ['codex', 'claude', 'opencode', 'dsh']) {
    const workspace = `/delivery-${client}`;
    const rpc = await request(workspace, client);
    const { legacy, status, image } = parsedResult(rpc);
    assert.strictEqual(legacy.workspace, workspace, `${client} keeps the legacy scoped result`);
    assert.strictEqual(legacy.browser_url, legacy.deep_link, `${client} keeps the desktop fallback aliases`);
    assert.strictEqual(legacy.launch.resource_uri, 'ui://orchestrator/graph', `${client} keeps the MCP App enhancement`);
    assert.strictEqual(legacy.snapshot_delivery.image_content, true, `${client} reports MCP image delivery`);
    assert.ok(status && status.text, `${client} parses portable text content`);
    assert.ok(image && image.mimeType === 'image/png', `${client} parses portable image content`);
    assert.deepStrictEqual([...Buffer.from(image.data, 'base64').subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    for (const leaked of [OPAQUE, rawPath, rawToken, 'hunter2']) {
      assert.ok(!status.text.includes(leaked), `${client} portable text leaked ${leaked}`);
    }
    hashes.push(legacy.snapshot_hash);
  }
  assert.strictEqual(new Set(hashes).size, 1, 'snapshot delivery is client-neutral and never hostname-branched');

  const fallback = parsedResult(await request('/delivery-text-only', 'claude', { supportsImageContent: false }));
  assert.ok(fallback.status, 'capability fallback retains accessible text');
  assert.strictEqual(fallback.image, undefined, 'capability fallback omits unsupported image content');
  assert.strictEqual(fallback.legacy.snapshot_delivery.image_content, false);
  assert.ok(fallback.legacy.browser_url, 'capability fallback retains the desktop dashboard link');

  const first = parsedResult(await request('/delivery-debounce', 'codex'));
  const second = parsedResult(await request('/delivery-debounce', 'codex'));
  assert.strictEqual(first.legacy.snapshot_changed, true);
  assert.ok(first.legacy.snapshot_event, 'first meaningful snapshot emits through the status result');
  assert.strictEqual(second.legacy.snapshot_changed, false);
  assert.strictEqual(second.legacy.snapshot_event, null, 'unchanged status is debounced');
  assert.strictEqual(second.legacy.snapshot_hash, first.legacy.snapshot_hash);
  assert.strictEqual(second.image.data, first.image.data, 'unchanged status reuses the same portable image bytes');

  revision = 2;
  const changed = parsedResult(await request('/delivery-debounce', 'codex'));
  assert.strictEqual(changed.legacy.snapshot_changed, true);
  assert.ok(changed.legacy.snapshot_event, 'meaningful state change emits through the status result');
  assert.notStrictEqual(changed.legacy.snapshot_hash, first.legacy.snapshot_hash);

  const injected = parsedResult(await request('/delivery-explicit', 'opencode', {}, false));
  assert.strictEqual(injected.legacy.workspace, '/delivery-explicit', 'explicit request inherits the session workspace');
  assert.ok(calls.some((entry) => entry.method === 'GET' && entry.path.startsWith('/state')));
  assert.ok(calls.some((entry) => entry.method === 'GET' && entry.path.startsWith('/guidance')));
  assert.ok(!calls.some((entry) => /notification|push/i.test(entry.path)), 'delivery does not invent a cross-harness push channel');

  console.log('PASS  capability-based portable dashboard snapshot delivery');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
