#!/usr/bin/env node
'use strict';

const assert = require('assert');
const zlib = require('zlib');
const mcpCore = require('../lib/mcp-core');
const uiTools = require('../lib/mcp/tools/ui');
const { dashboardSnapshotHash } = require('../lib/dashboard-snapshot');

const WORKSPACE_A = '/isolated/mobile acceptance a';
const WORKSPACE_B = '/isolated/mobile acceptance b';
const OPAQUE = '019c3ac8-f971-7b80-9d14-1b34dfd3c9e9';
const SECRET = 'mobile-private-token';

const fixtures = new Map([
  [WORKSPACE_A, {
    tasks: [
      { id: OPAQUE, label: `Render from ['/mnt/My Project/private file.txt'] token=${SECRET}`, status: 'in_progress', deps: [] },
      { id: 'codex/failed', label: 'Inspect <"\\\\fileserver\\My Share\\private file.txt">', status: 'failed', deps: [] },
      { id: 'codex/done', label: 'Finish portable renderer', status: 'done', deps: [] },
    ],
    guidance: [{
      id: 'decision-a',
      question: 'Approve {"password":"hunter2"}?',
      severity: 'blocking',
      resolved: false,
      origin_task: OPAQUE,
    }],
  }],
  [WORKSPACE_B, {
    tasks: [
      { id: 'codex/b-ready', label: 'Prepare workspace B snapshot', status: 'ready', deps: [] },
      { id: 'codex/b-wip', label: 'Render workspace B', status: 'in_progress', deps: [] },
    ],
    guidance: [],
  }],
]);

const seamCalls = [];
function requestWorkspace(path) {
  const url = new URL(path, 'http://fixture.invalid');
  return url.searchParams.get('graph_repo') || url.searchParams.get('workspace');
}

async function isolatedCall(method, path) {
  seamCalls.push({ method, path });
  if (method === 'POST' && path === '/analytics/tool-call') return { ok: true };
  const workspace = requestWorkspace(path);
  const fixture = fixtures.get(workspace);
  assert.ok(fixture, `request escaped isolated workspace fixtures: ${path}`);
  if (method === 'GET' && path.startsWith('/state')) {
    return {
      tasks: fixture.tasks,
      kanban: { cards: fixture.tasks.map((task) => ({ task_key: task.id })) },
    };
  }
  if (method === 'GET' && path.startsWith('/guidance')) return { user_attention: fixture.guidance };
  throw new Error(`unexpected external seam: ${method} ${path}`);
}

function showDashboard(workspace, client, extra = {}) {
  return mcpCore.handleRpc({
    jsonrpc: '2.0',
    id: `${client}:${workspace}`,
    method: 'tools/call',
    params: { name: 'show_dashboard', arguments: { workspace } },
  }, {
    client,
    workspace,
    identity: { graph_repo: workspace },
    call: isolatedCall,
    ...extra,
  });
}

function consume(rpc) {
  assert.ok(rpc && rpc.result && !rpc.result.isError);
  const legacy = rpc.result.structuredContent;
  assert.ok(legacy && typeof legacy === 'object', 'legacy fields must use structuredContent');
  const expectedText = legacy.snapshot_summary || legacy.snapshot_text;
  const text = rpc.result.content[0];
  assert.ok(text && text.type === 'text', 'accessible status must remain first-class MCP text content');
  assert.strictEqual(text.text, expectedText, 'accessible status must match the structured fallback');
  assert.ok(!text.text.trimStart().startsWith('{'), 'accessible status must not require a legacy JSON text block');
  const image = rpc.result.content[1];
  if (legacy.snapshot_delivery.image_content) {
    assert.ok(image && image.type === 'image', 'portable image content must follow the text block');
  } else {
    assert.strictEqual(image, undefined, 'text-only fallback must omit the image block');
  }
  return { legacy, text, image };
}

function validatePng(image) {
  assert.deepStrictEqual(Object.keys(image).sort(), ['data', 'mimeType', 'type']);
  assert.strictEqual(image.type, 'image');
  assert.strictEqual(image.mimeType, 'image/png');
  const png = Buffer.from(image.data, 'base64');
  assert.strictEqual(png.toString('base64'), image.data, 'image block must carry canonical base64 bytes');
  assert.deepStrictEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += length + 12;
  }
  assert.strictEqual(offset, png.length, 'PNG chunks must consume the complete image');
  assert.deepStrictEqual(chunks.map((chunk) => chunk.type), ['IHDR', 'IDAT', 'IEND']);
  assert.strictEqual(chunks[0].data.readUInt32BE(0), 720);
  assert.strictEqual(chunks[0].data.readUInt32BE(4), 1280);
  const pixels = zlib.inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)));
  assert.strictEqual(pixels.length, (720 * 4 + 1) * 1280);
  return png;
}

function assertPortableSafe(delivery, workspace) {
  assert.ok(delivery.text && delivery.text.text);
  const png = validatePng(delivery.image);
  for (const leaked of [OPAQUE, WORKSPACE_A, WORKSPACE_B, workspace, '/mnt/', 'My Project', 'fileserver', 'My Share', SECRET, 'hunter2', 'localhost']) {
    assert.ok(!delivery.text.text.includes(leaked), `accessible text leaked ${leaked}`);
    assert.ok(!delivery.legacy.snapshot_text.includes(leaked), `structured accessible fallback leaked ${leaked}`);
    assert.ok(!png.includes(Buffer.from(leaked)), `PNG bytes leaked ${leaked}`);
  }
}

(async () => {
  uiTools._test.snapshotCache.clear();

  const toolList = await mcpCore.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { client: 'dsh', call: isolatedCall });
  const descriptor = toolList.result.tools.find((tool) => tool.name === 'show_dashboard');
  assert.strictEqual(descriptor._meta.ui.resourceUri, 'ui://orchestrator/graph');
  const resources = await mcpCore.handleRpc({ jsonrpc: '2.0', id: 2, method: 'resources/list' }, { client: 'claude', call: isolatedCall });
  assert.ok(resources.result.resources.some((resource) => resource.uri === 'ui://orchestrator/graph'));

  const firstA = consume(await showDashboard(WORKSPACE_A, 'codex'));
  assertPortableSafe(firstA, WORKSPACE_A);
  assert.strictEqual(firstA.legacy.rendered, true);
  assert.strictEqual(firstA.legacy.workspace, WORKSPACE_A);
  assert.strictEqual(firstA.legacy.browser_url, firstA.legacy.deep_link);
  assert.match(firstA.legacy.browser_url, /^http:\/\/localhost:8787\/graph\?/);
  assert.strictEqual(firstA.legacy.launch.resource_uri, 'ui://orchestrator/graph');
  assert.strictEqual(firstA.legacy.snapshot_delivery.interactive_resource, 'ui://orchestrator/graph');
  assert.strictEqual(firstA.legacy.snapshot_changed, true);
  assert.ok(firstA.legacy.snapshot_event);

  const firstB = consume(await showDashboard(WORKSPACE_B, 'claude'));
  assertPortableSafe(firstB, WORKSPACE_B);
  assert.notStrictEqual(firstB.legacy.snapshot_hash, firstA.legacy.snapshot_hash);
  assert.notStrictEqual(firstB.text.text, firstA.text.text, 'workspace snapshots must not bleed across cache keys');

  await new Promise((resolve) => setTimeout(resolve, 15));
  const unchangedA = consume(await showDashboard(WORKSPACE_A, 'opencode'));
  assert.strictEqual(unchangedA.legacy.snapshot_changed, false);
  assert.strictEqual(unchangedA.legacy.snapshot_event, null);
  assert.strictEqual(unchangedA.legacy.snapshot_hash, firstA.legacy.snapshot_hash);
  assert.strictEqual(unchangedA.legacy.snapshot_generated_at, firstA.legacy.snapshot_generated_at,
    'generated timestamp alone must not perturb unchanged delivery');
  assert.strictEqual(unchangedA.image.data, firstA.image.data);

  fixtures.get(WORKSPACE_A).tasks[0] = {
    ...fixtures.get(WORKSPACE_A).tasks[0],
    label: 'Render meaningfully updated mobile status',
  };
  const changedA = consume(await showDashboard(WORKSPACE_A, 'dsh'));
  assert.strictEqual(changedA.legacy.snapshot_changed, true);
  assert.ok(changedA.legacy.snapshot_event);
  assert.notStrictEqual(changedA.legacy.snapshot_hash, firstA.legacy.snapshot_hash);

  const unchangedB = consume(await showDashboard(WORKSPACE_B, 'codex'));
  assert.strictEqual(unchangedB.legacy.snapshot_changed, false, 'workspace A mutation must not invalidate workspace B');
  assert.strictEqual(unchangedB.legacy.snapshot_hash, firstB.legacy.snapshot_hash);
  assert.strictEqual(unchangedB.image.data, firstB.image.data);

  const clientText = [];
  for (const client of ['codex', 'claude', 'opencode', 'dsh']) {
    const parsed = consume(await showDashboard(WORKSPACE_B, client));
    assertPortableSafe(parsed, WORKSPACE_B);
    assert.strictEqual(parsed.legacy.launch.viewer, client);
    clientText.push(parsed.text.text);
  }
  assert.strictEqual(new Set(clientText).size, 1, 'portable consumption must be client-neutral');

  const textOnly = consume(await showDashboard(WORKSPACE_A, 'claude', { resultCapabilities: { image: false } }));
  assert.ok(textOnly.text && textOnly.text.text);
  assert.strictEqual(textOnly.image, undefined);
  assert.strictEqual(textOnly.legacy.snapshot_delivery.image_content, false);
  assert.ok(textOnly.legacy.browser_url && textOnly.legacy.launch.resource_uri,
    'capability fallback retains legacy desktop and App fields');

  assert.strictEqual(
    dashboardSnapshotHash({ generated_at: '2026-01-01T00:00:00Z', counts: { wip: 1 } }),
    dashboardSnapshotHash({ generated_at: '2030-01-01T00:00:00Z', counts: { wip: 1 } }),
    'stable snapshot hash must exclude the presentation timestamp',
  );
  assert.ok(seamCalls.every((entry) => entry.path.startsWith('/state')
    || entry.path.startsWith('/guidance') || entry.path === '/analytics/tool-call'));

  console.log('PASS  hermetic mobile dashboard snapshot portability acceptance');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
