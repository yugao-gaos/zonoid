#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { spawn } = require('child_process');
const filedrop = require('../lib/filedrop-tasks');

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {};
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
//
// Probe /health, NOT /ping: daemon.js calls server.listen() before loadState() and /ping is in
// LOADING_WHITELIST, so /ping answers 200 while every non-whitelisted route still 503s
// {phase:'loading'}. Waiting on /ping therefore races boot, and the first real request after it
// can get the 503 body instead of data.
async function waitForReady(port, ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await req(port, 'GET', '/ping');
      if (r.status === 200 && r.body.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function waitForHealthReady(port, ms = 20_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await req(port, 'GET', '/health');
      if (r.status === 200 && r.body && r.body.phase === 'ready') return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function startMcp(entry, env, children) {
  const child = spawn(process.execPath, [entry], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const record = { child, stdout: '', stderr: '', exited: false };
  children.push(record);
  let nextId = 1;
  let buffer = '';
  const pending = new Map();

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    record.stdout += chunk;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  });
  child.stderr.on('data', (chunk) => { record.stderr += chunk; });
  child.once('exit', (code, signal) => {
    record.exited = true;
    record.code = code;
    record.signal = signal;
    const error = new Error(`MCP exited ${code ?? signal}: ${record.stderr}`);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP ${method} timed out`));
    }, 30_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  const notify = (method, params = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };

  return { child, request, notify, record };
}

function terminate(record) {
  if (!record || record.exited) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    record.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      record.child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

test('dashboard snapshot acceptance projects live state and offline HTML without leaking paths', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-dashboard-snapshot-base-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-dashboard-snapshot-workspace-'));
  const port = 19840 + Math.floor(Math.random() * 50);
  const children = [];
  const daemonEnv = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: sandbox,
    ORCH_PORT: String(port),
    ORCH_TOKEN: '',
    HEADLESS_DRAIN_MAX_ITERATIONS: '-1',
    ZONOID_EMBED_PROVIDER: 'voyage',
    VOYAGE_API_KEY: '',
  };
  delete daemonEnv.ORCH_DATA;
  delete daemonEnv.ZONOID_DATA;

  const daemon = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: daemonEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const daemonRecord = { child: daemon, stdout: '', stderr: '', exited: false };
  children.push(daemonRecord);
  daemon.stdout.setEncoding('utf8');
  daemon.stderr.setEncoding('utf8');
  daemon.stdout.on('data', (chunk) => { daemonRecord.stdout += chunk; });
  daemon.stderr.on('data', (chunk) => { daemonRecord.stderr += chunk; });
  daemon.once('exit', (code, signal) => {
    daemonRecord.exited = true;
    daemonRecord.code = code;
    daemonRecord.signal = signal;
  });

  try {
    assert.ok(await waitForReady(port), 'daemon came up on the private port');
    assert.ok(await waitForHealthReady(port), 'daemon finished booting');

    const pin = await req(port, 'POST', '/workspace', { path: workspace });
    assert.equal(pin.status, 200);
    assert.equal(pin.body.ok, true);

    // Resolve the stub path against the SANDBOX data dir, not this process's runtime dir:
    // filedrop.stubFile() reads CLAUDE_PLUGIN_DATA from the caller's own env, which the test
    // process does not set, so it would drop stubs into the live runtime dir while the daemon
    // (spawned with CLAUDE_PLUGIN_DATA=sandbox) reads from the sandbox and syncs nothing.
    const stubDir = path.join(sandbox, 'tasks', filedrop.workspaceKey(workspace), 'codex');
    const dropStub = (id, stub) => {
      const file = path.join(stubDir, `${id}.json`);
      assert(file, `stub file path is available for ${id}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        id,
        subject: stub.subject,
        description: stub.description || '',
        status: stub.status || 'pending',
        blockedBy: stub.blockedBy || [],
        created_by: { harness: 'codex', agent_id: 'dashboard-snapshot-acceptance' },
      }, null, 2));
      fs.renameSync(tmp, file);
    };
    dropStub('alpha', { subject: 'Accessible snapshot alpha', status: 'pending' });
    dropStub('bravo', {
      subject: 'Accessible snapshot bravo',
      status: 'pending',
      blockedBy: ['alpha'],
    });
    const sync = await req(port, 'POST', '/sync', { workspace });
    assert.equal(sync.status, 200);
    assert.equal(sync.body.ok, true);

    const mcpEnv = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: sandbox,
      ORCH_PORT: String(port),
      ORCH_GRAPH_REPO: workspace,
      ORCH_TARGET_REPO: workspace,
      ORCH_CLIENT: 'codex',
    };
    delete mcpEnv.ORCH_DATA;
    delete mcpEnv.ZONOID_DATA;
    const mcp = startMcp(path.join(__dirname, '..', 'mcp-graph.js'), mcpEnv, children);

    try {
      const initialized = await mcp.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'dashboard-snapshot-acceptance', version: '1' },
      });
      assert.equal(initialized.result.serverInfo.name, 'orchestrator-graph');
      mcp.notify('notifications/initialized');

      const tools = await mcp.request('tools/list');
      const toolNames = tools.result.tools.map((tool) => tool.name);
      assert(toolNames.includes('get_graph'));
      assert(toolNames.includes('show_dashboard'));
      assert(toolNames.includes('subconscious_assignment'));

      const resources = await mcp.request('resources/list');
      assert(resources.result.resources.some((resource) => resource.uri === 'ui://orchestrator/graph'));

      let projection = null;
      for (let i = 0; i < 20; i++) {
        const graph = await mcp.request('tools/call', {
          name: 'get_graph',
          arguments: { scope: 'all', compact: true },
        });
        assert.equal(graph.result.isError, false, `${graph.result.content && graph.result.content[0]
          && graph.result.content[0].text}\ndaemon exit=${daemonRecord.code ?? daemonRecord.signal ?? 'running'}\n${daemonRecord.stderr}`);
        projection = JSON.parse(graph.result.content[0].text);
        const ready = projection.tasks.some((task) => task.id === 'codex/alpha' && task.status === 'ready');
        const blocked = projection.tasks.some((task) => task.id === 'codex/bravo' && task.status === 'not_ready');
        if (ready && blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert(projection);
      assert.equal(projection.summary.tasks_total, 2);
      assert.equal(projection.tasks.length, 2);
      assert(projection.tasks.some((task) => task.id === 'codex/alpha' && task.label === 'Accessible snapshot alpha'));
      assert(projection.tasks.some((task) => task.id === 'codex/bravo' && task.label === 'Accessible snapshot bravo'));
      assert(projection.edges.some((edge) => edge.origin === 'native-blockedBy' && edge.from === 'codex/alpha' && edge.to === 'codex/bravo'));

      const dashboard = await mcp.request('tools/call', {
        name: 'show_dashboard',
        arguments: { workspace, viewer: 'codex' },
      });
      assert.equal(dashboard.result.isError, false);
      // Portable snapshot delivery moved the legacy fields to structuredContent; content[0] is now
      // the accessible status text. Fall back to the JSON text block when no snapshot was delivered.
      const dash = dashboard.result.structuredContent
        || JSON.parse(dashboard.result.content[0].text);
      assert.equal(dash.workspace, workspace);
      assert.equal(dash.launch.version, 1);
      assert.equal(dash.launch.preferred_surface, 'mcp_app');
      assert.equal(dash.launch.fallback_surface, 'external_browser');
      assert(dash.launch.surfaces.some((surface) => surface.id === 'embedded_web'));
      assert.equal(dash.browser_url, dash.deep_link);
      assert.equal(dash.launch.viewer, 'codex');
      assert.ok(!/[#?&](?:token|auth)=/i.test(dash.launch.url));

      const resource = await mcp.request('resources/read', { uri: 'ui://orchestrator/graph' });
      assert.equal(resource.result.contents[0].mimeType, 'text/html;profile=mcp-app');
      const html = resource.result.contents[0].text;
      assert(html.includes('Open in Codex browser'));
      assert(html.includes('Open in Claude browser'));
      assert(html.includes('Open dashboard'));
      assert(html.includes('Inspect frontier'));
      assert(html.includes('Refresh'));
      assert(html.includes('id="refreshBtn"'));
      assert(html.includes("fetch(DAEMON + scoped('/state')"));
      assert(html.includes("bridgeCall('get_graph')"));
      assert(html.includes("EventSource(DAEMON + scoped('/events'))"));
      assert(html.includes('setInterval(refresh, 3000)'));
      assert(html.includes('setTimeout(start, 1000)'));
      assert.ok(!html.includes(workspace));
      assert.ok(!html.includes('codex/alpha'));
      assert.ok(!html.includes('codex/bravo'));
      assert.ok(!/[#?&](?:token|auth)=/i.test(html));
      assert.ok(!/file:\/\//i.test(html));
    } finally {
      mcp.child.stdin.end();
      await terminate(children.find((record) => record.child === mcp.child));
    }
  } finally {
    await Promise.all(children.map(terminate));
    try { daemon.kill('SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(sandbox, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
