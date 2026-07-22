#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-request-identity-')));
process.env.CLAUDE_PLUGIN_DATA = sandbox;

const requestIdentity = require('../lib/request-identity');
const mcpCore = require('../lib/mcp-core');
const daemon = require('../daemon');

const graphRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-graph-repo-')));
const otherRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-other-repo-')));
const linkedPrimary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-linked-primary-')));
const linkedWorktree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-linked-worktree-')));
fs.mkdirSync(path.join(linkedPrimary, '.graph'));
const linkedGitDir = path.join(linkedPrimary, '.git', 'worktrees', 'identity-test');
fs.mkdirSync(linkedGitDir, { recursive: true });
fs.writeFileSync(path.join(linkedGitDir, 'commondir'), '../..\n');
fs.mkdirSync(path.join(linkedWorktree, '.graph'));
fs.writeFileSync(path.join(linkedWorktree, '.git'), `gitdir: ${linkedGitDir}\n`);

test('canonical request fields win while deprecated aliases remain identical', () => {
  const identity = requestIdentity.fromRequest({
    workspace_id: 'product',
    graph_repo: graphRepo,
    workspace: otherRepo,
    target_repo: otherRepo,
    repo_path: graphRepo,
  });
  assert.equal(identity.workspace_id, 'product');
  assert.equal(identity.graph_repo, graphRepo);
  assert.equal(identity.target_repo, otherRepo);

  const legacy = requestIdentity.fromRequest({ workspace: graphRepo, repo_path: otherRepo });
  assert.equal(legacy.graph_repo, graphRepo);
  assert.equal(legacy.target_repo, otherRepo);
  assert.deepEqual(requestIdentity.responseFields(identity), {
    workspace_id: 'product',
    graph_repo: graphRepo,
    target_repo: otherRepo,
    workspace: graphRepo,
    repo_path: otherRepo,
  });
});

test('client composition only defaults target_repo for an unambiguous named workspace', () => {
  const single = { version: 2, workspaces: { product: { repos: [graphRepo] } } };
  const multi = { version: 2, workspaces: { product: { repos: [graphRepo, otherRepo] } } };
  assert.deepEqual(requestIdentity.composeClientIdentity({ graph_repo: graphRepo }, single), {
    workspace_id: 'product', graph_repo: graphRepo, target_repo: graphRepo,
  });
  assert.deepEqual(requestIdentity.composeClientIdentity({ graph_repo: graphRepo }, multi), {
    workspace_id: 'product', graph_repo: graphRepo, target_repo: null,
  });
});

test('client composition canonicalizes tracked-graph worktrees and prefers a human workspace ID', () => {
  const registry = { version: 2, workspaces: {
    [linkedPrimary]: { repos: [linkedPrimary] },
    product: { repos: [linkedPrimary] },
  } };
  assert.deepEqual(requestIdentity.composeClientIdentity({ graph_repo: linkedWorktree }, registry), {
    workspace_id: 'product', graph_repo: linkedPrimary, target_repo: linkedPrimary,
  });
  assert.ok(registry.workspaces[linkedPrimary], 'legacy absolute-path workspace entry is retained');
});

test('targetOverlay accepts graph_repo and has no process-global repo fallback', () => {
  const canonical = daemon.targetOverlay({ workspace_id: 'product', graph_repo: graphRepo }, null);
  assert.equal(canonical.workspace_id, 'product');
  assert.equal(canonical.graph_repo, graphRepo);
  assert.equal(canonical.ws, graphRepo);
  assert.equal(canonical.workspace, graphRepo);
  assert.equal(daemon.targetOverlay({}, null).graph_repo, null);
  assert.equal(daemon.targetOverlay({}, null).ws, null);
  assert.equal(daemon.isPrimaryCheckout(), false);
});

test('canonical MCP client forwarding carries canonical fields and deprecated aliases', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const call = mcpCore.makeCall(server.address().port, {
    workspace_id: 'product', graph_repo: graphRepo, target_repo: otherRepo,
  });
  await call('GET', '/state?scope=frontier');
  await call('POST', '/git/worktree', { key: 'task/one' });
  await new Promise((resolve) => server.close(resolve));

  const get = new URL(seen[0].url, 'http://localhost');
  assert.equal(get.searchParams.get('workspace_id'), 'product');
  assert.equal(get.searchParams.get('graph_repo'), graphRepo);
  assert.equal(get.searchParams.get('workspace'), graphRepo);
  assert.equal(get.searchParams.get('target_repo'), otherRepo);
  assert.equal(get.searchParams.get('repo_path'), otherRepo);
  assert.equal(seen[1].body.graph_repo, graphRepo);
  assert.equal(seen[1].body.workspace, graphRepo);
  assert.equal(seen[1].body.target_repo, otherRepo);
  assert.equal(seen[1].body.repo_path, otherRepo);
});

test('every MCP tool schema accepts canonical identities and deprecated aliases', () => {
  for (const tool of mcpCore.TOOLS) {
    const properties = tool.inputSchema && tool.inputSchema.properties;
    assert.ok(properties && properties.workspace_id, `${tool.name}: workspace_id`);
    assert.ok(properties.graph_repo, `${tool.name}: graph_repo`);
    assert.ok(properties.target_repo, `${tool.name}: target_repo`);
    assert.ok(properties.workspace, `${tool.name}: workspace alias`);
    assert.ok(properties.repo_path, `${tool.name}: repo_path alias`);
  }
});

test('per-tool canonical identity is forwarded instead of the MCP session default', async () => {
  const calls = [];
  const call = async (method, requestPath, body) => {
    calls.push({ method, requestPath, body });
    return {};
  };
  const response = await mcpCore.handleRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'get_graph', arguments: { graph_repo: otherRepo } },
  }, {
    call,
    identity: { workspace_id: 'product', graph_repo: graphRepo, target_repo: null },
  });
  assert.equal(response.result.isError, false);
  const graphCall = calls.find((entry) => entry.method === 'GET' && entry.requestPath.startsWith('/state?'));
  assert.ok(graphCall);
  const url = new URL(graphCall.requestPath, 'http://localhost');
  assert.equal(url.searchParams.get('graph_repo'), otherRepo);
  assert.equal(url.searchParams.get('workspace'), otherRepo);
});

test.after(() => {
  for (const dir of [graphRepo, otherRepo, linkedPrimary, linkedWorktree, sandbox]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Requiring daemon.js starts the embedding sidecar; terminate after node:test flushes its report.
  setTimeout(() => process.exit(process.exitCode || 0), 100);
});
