#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { buildDashboardLaunch, dashboardOrigin, dashboardViewer } = require('../lib/dashboard-launch');
const { openExternal } = require('../bin/dashboard');
const uiTools = require('../lib/mcp/tools/ui');
const mcpCore = require('../lib/mcp-core');

let passed = 0;
let failed = 0;
function ok(name, condition) {
  if (condition) { passed++; console.log('ok - ' + name); }
  else { failed++; console.error('not ok - ' + name); }
}

const workspace = '/tmp/a repo?not-a-query';
const launch = buildDashboardLaunch({ workspace, port: 8787, resourceUri: 'ui://orchestrator/graph' });
ok('launch contract is versioned and workspace scoped', launch.version === 1 && launch.workspace === workspace && launch.url.endsWith(encodeURIComponent(workspace)));
ok('launch contract is client neutral', launch.preferred_surface === 'mcp_app' && launch.fallback_surface === 'external_browser');
ok('launch contract offers capability-based surfaces', launch.surfaces.map((s) => s.id).join(',') === 'mcp_app,embedded_web,external_browser');
ok('launch contract makes the browser fallback desktop-only', launch.surfaces[2] && launch.surfaces[2].requires === 'desktop_browser');
ok('launch contract keeps MCP resource URI', launch.resource_uri === 'ui://orchestrator/graph' && launch.surfaces[0].resource_uri === launch.resource_uri);
ok('launch contract contains no auth token', !/[#?&](?:token|auth)=/i.test(JSON.stringify(launch)));

const embeddedOnly = buildDashboardLaunch({
  workspace,
  port: 8787,
  resourceUri: 'ui://orchestrator/graph',
  capabilities: { mcp_apps: false, embedded_webview: true, desktop_browser: false },
});
ok('launch capability filter hides unsupported surfaces', embeddedOnly.surfaces.length === 1 && embeddedOnly.surfaces[0].id === 'embedded_web');

const codexLaunch = buildDashboardLaunch({ workspace, port: 8787, viewer: 'Codex' });
ok('launch contract carries normalized viewer presentation context', codexLaunch.viewer === 'codex' && codexLaunch.url.endsWith(`${encodeURIComponent(workspace)}&viewer=codex`));
ok('viewer ids normalize without becoming ledger providers', dashboardViewer(' OpenCode ') === 'opencode');
let unsafeViewerRejected = false;
try { dashboardViewer('codex&workspace=/other'); } catch { unsafeViewerRejected = true; }
ok('unsafe dashboard viewer rejected', unsafeViewerRejected);

ok('explicit dashboard origin is honored', dashboardOrigin({ origin: 'https://dashboard.example.test' }) === 'https://dashboard.example.test');
for (const origin of ['file:///tmp/dashboard', 'https://user:secret@example.test', 'https://example.test/base', 'https://example.test/?token=secret', 'https://example.test/#secret']) {
  let rejected = false;
  try { dashboardOrigin({ origin }); } catch { rejected = true; }
  ok('unsafe dashboard origin rejected: ' + origin.split('secret').join('[redacted]'), rejected);
}

const tool = uiTools({ UI_URI: 'ui://orchestrator/graph', PORT: 8787, DASHBOARD_ORIGIN: null })[0];
ok('MCP descriptor is client neutral and token free', !/Codex|token|auth/i.test(JSON.stringify({ description: tool.description, schema: tool.inputSchema })));

const openCalls = [];
const fakeSpawn = (command, args, options) => { openCalls.push({ command, args, options }); return { status: 0 }; };
openExternal(launch.url, 'darwin', fakeSpawn);
openExternal(launch.url, 'win32', fakeSpawn);
openExternal(launch.url, 'linux', fakeSpawn);
ok('external-browser fallback is cross-platform and shell-free',
  openCalls.map((c) => c.command).join(',') === 'open,rundll32.exe,xdg-open' &&
  openCalls.every((c) => c.args.includes(launch.url)));

(async () => {
  const dashboardCall = async (method, route) => {
    if (method === 'GET' && String(route).startsWith('/state?scope=all')) {
      return {
        tasks: [
          { id: 'task/1', label: 'Task 1', status: 'ready' },
        ],
        kanban: { cards: [{ task_key: 'task/1' }] },
      };
    }
    if (method === 'GET' && String(route).startsWith('/guidance')) return { user_attention: [] };
    return { ok: true };
  };
  const out = await tool.run({ workspace }, dashboardCall);
  ok('show_dashboard preserves legacy URL aliases', out.browser_url === out.deep_link && out.launch.url === out.browser_url);
  ok('show_dashboard launch result contains no auth token', !/[#?&](?:token|auth)=/i.test(JSON.stringify(out)));
  ok('show_dashboard returns portable snapshot delivery', out._mcp_delivery && out._mcp_delivery.text && out._mcp_delivery.image);
  ok('show_dashboard snapshot text is concise', /^PLAN \d+ \| READY \d+ \| WIP \d+ \| REVIEW \d+ \| NEEDS YOU \d+$/.test(out._mcp_delivery.text));
  ok('show_dashboard snapshot exposes summary text', typeof out.snapshot_summary === 'string' && out.snapshot_summary === out._mcp_delivery.text);

  const rpc = await mcpCore.handleRpc({
    jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'show_dashboard', arguments: { workspace } },
  }, {
    client: 'codex', workspace, identity: { graph_repo: workspace }, call: dashboardCall,
  });
  ok('MCP launch derives viewer from the current client host', rpc.result.structuredContent.launch.viewer === 'codex' && rpc.result.structuredContent.launch.url.includes('&viewer=codex'));
  ok('MCP launch returns text plus image content', Array.isArray(rpc.result.content) && rpc.result.content[0].type === 'text' && rpc.result.content.some((item) => item.type === 'image'));
  ok('MCP launch text stays concise', rpc.result.content[0].text === out._mcp_delivery.text);

  const cli = path.join(__dirname, '..', 'bin', 'dashboard.js');
  const cliRun = spawnSync(process.execPath, [cli, '--workspace', workspace, '--viewer', 'codex', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, ORCH_TOKEN: 'must-not-appear', ZONOID_DASHBOARD_ORIGIN: 'http://127.0.0.1:9876' },
  });
  ok('dashboard CLI emits JSON launch contract', cliRun.status === 0 && JSON.parse(cliRun.stdout).version === 1);
  ok('dashboard CLI honors configured origin', JSON.parse(cliRun.stdout).url.startsWith('http://127.0.0.1:9876/graph?workspace='));
  ok('dashboard CLI propagates explicit viewer host', JSON.parse(cliRun.stdout).viewer === 'codex' && JSON.parse(cliRun.stdout).url.includes('&viewer=codex'));
  ok('dashboard CLI output does not leak auth token', !cliRun.stdout.includes('must-not-appear') && !/[#?&](?:token|auth)=/i.test(cliRun.stdout));

  const unsafe = spawnSync(process.execPath, [cli, '--workspace', workspace], {
    encoding: 'utf8',
    env: { ...process.env, ZONOID_DASHBOARD_ORIGIN: 'http://localhost:8787/?token=must-not-appear' },
  });
  ok('dashboard CLI rejects token-bearing origins without echoing the token', unsafe.status !== 0 && !unsafe.stdout.includes('must-not-appear') && !unsafe.stderr.includes('must-not-appear'));

  console.log(`${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
