#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PINNED_DSH_REVISION = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e';
const PINNED_DSH_VERSION = '0.1.1-rc.2';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function copyTrackedInstall(destination) {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' });
  assert.strictEqual(listed.status, 0, listed.stderr && listed.stderr.toString());
  for (const relative of listed.stdout.toString().split('\0').filter(Boolean)) {
    const source = path.join(ROOT, relative);
    let stat;
    try { stat = fs.statSync(source); } catch { continue; }
    if (!stat.isFile()) continue;
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, stat.mode);
  }
  // The CLI only tests that dependencies were installed. Its DSH path and this acceptance
  // scenario use local/core modules, so a marker keeps the disposable package offline.
  fs.mkdirSync(path.join(destination, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(destination, 'node_modules', '.acceptance-present'), 'hermetic\n');
}

function writeDshCommand(binDir, officialSource) {
  fs.mkdirSync(binDir, { recursive: true });
  const script = path.join(binDir, 'dsh.js');
  const command = path.join(binDir, process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
  const officialBin = officialSource && path.join(officialSource, 'apps', 'cli', 'lib', 'bin.js');
  const source = officialSource
    ? `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');
fs.appendFileSync(process.env.ZONOID_DSH_ACCEPTANCE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const result = spawnSync(process.execPath, [${JSON.stringify(officialBin)}, ...process.argv.slice(2)], {
  env: process.env, stdio: 'inherit', windowsHide: true,
});
if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
`
    : `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('${PINNED_DSH_VERSION}'); process.exit(0); }
if (args[0] !== 'plugin' || args[1] !== '--profile' || args[3] !== 'add' || !args[4]) {
  console.error('unsupported acceptance DSH command:', args.join(' '));
  process.exit(2);
}
fs.appendFileSync(process.env.ZONOID_DSH_ACCEPTANCE_LOG, JSON.stringify(args) + '\\n');
const profileDir = path.join(process.env.DSH_HOME, 'profiles', args[2]);
const manifestPath = path.join(profileDir, 'package.json');
fs.mkdirSync(profileDir, { recursive: true });
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : { name: 'dsh-profile-' + args[2], private: true };
manifest.dependencies = { ...(manifest.dependencies || {}), '@zonoid/dsh': args[4] };
manifest.dsh = manifest.dsh || {};
manifest.dsh.profile = manifest.dsh.profile || {};
manifest.dsh.profile.bundles = [...new Set([
  ...(manifest.dsh.profile.bundles || []), '@zonoid/dsh',
])];
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n');
fs.writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\\n');
`;
  fs.writeFileSync(script, source);
  fs.chmodSync(script, 0o755);
  if (process.platform === 'win32') {
    fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0\\dsh.js" %*\r\n`);
  } else {
    fs.copyFileSync(script, command);
    fs.chmodSync(command, 0o755);
  }
  return command;
}

function bodyOf(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

async function createAcceptanceServer(temp) {
  const state = {
    requests: [],
    initCalls: 0,
    claimed: false,
    claim: null,
    permit: null,
    teardownCompleted: false,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = {};
    try { body = await bodyOf(req); } catch { /* invalid bodies are irrelevant to this fixture */ }
    state.requests.push({ method: req.method, pathname: url.pathname, query: url.searchParams, body });
    const send = (status, value, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };

    if (url.pathname === '/health') {
      send(200, { ok: true, phase: 'ready' }, { 'x-zonoid-health-signature': 'zonoid-orchestrator-health-v1' });
    } else if (url.pathname === '/ping' || url.pathname === '/search') {
      send(200, { ok: true });
    } else if (url.pathname === '/onboard/init') {
      state.initCalls++;
      send(202, {
        ok: true,
        accepted: true,
        registered: true,
        graph_repo: body.repo,
        outDir: path.join(temp, 'onboarding'),
        reused: state.initCalls > 1,
      });
    } else if (url.pathname === '/workspace' || url.pathname === '/agent/start') {
      send(200, { ok: true });
    } else if (url.pathname === '/classify') {
      send(200, { additional_context: '[acceptance] canonical DSH context' });
    } else if (url.pathname === '/ready') {
      send(200, { ready: [] });
    } else if (url.pathname === '/should-stop') {
      send(200, { stop: false });
    } else if (url.pathname === '/active-claim') {
      send(200, state.claimed ? { claimed: true, claims: [state.claim] } : { claimed: false, claims: [] });
    } else if (url.pathname === '/task/detail') {
      send(200, { task: { git: { branch: state.permit.branch, worktree: state.permit.worktree } } });
    } else if (url.pathname === '/subconscious/permit') {
      send(200, { execution_permit: state.permit });
    } else if (url.pathname === '/agent/done') {
      setTimeout(() => {
        state.teardownCompleted = true;
        send(200, { ok: true });
      }, 35);
    } else if (url.pathname === '/analytics/tool-call') {
      send(200, { ok: true });
    } else {
      send(404, { error: `unhandled acceptance route ${url.pathname}` });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, state, port: server.address().port };
}

function runChild(command, args, options, children, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      encoding: undefined,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record = { child, command, args, stdout: '', stderr: '', exited: false };
    children.push(record);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { record.stdout += chunk; });
    child.stderr.on('data', (chunk) => { record.stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      record.exited = true;
      record.code = code;
      record.signal = signal;
      if (code === 0) resolve(record);
      else reject(new Error(`${command} ${args.join(' ')} exited ${code ?? signal}\n${record.stdout}\n${record.stderr}`));
    });
  });
}

function startMcp(entry, options, children) {
  const child = spawn(process.execPath, [entry], {
    ...options,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const record = { child, command: process.execPath, args: [entry], stdout: '', stderr: '', exited: false };
  children.push(record);
  let nextId = 1;
  let buffer = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { record.stderr += chunk; });
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
    }, 10_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const notify = (method, params = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };
  const eof = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('MCP did not exit after stdio EOF'));
    }, 10_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`MCP EOF exit was ${code ?? signal}: ${record.stderr}`));
    });
    child.stdin.end();
  });
  return { child, request, notify, eof, record };
}

function waitForWatch(promise, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DSH file-drop watch did not fire')), timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function terminateChild(record) {
  if (record.exited) return Promise.resolve();
  return new Promise((resolve) => {
    let forceTimer = null;
    let doneTimer = null;
    const finished = () => {
      clearTimeout(forceTimer);
      clearTimeout(doneTimer);
      resolve();
    };
    record.child.once('exit', finished);
    try { record.child.kill('SIGTERM'); } catch { finished(); return; }
    forceTimer = setTimeout(() => {
      try { record.child.kill('SIGKILL'); } catch { /* already exited */ }
    }, 500);
    doneTimer = setTimeout(resolve, 1_500);
  });
}

test('integrated DSH target-host acceptance remains hermetic and leak-free', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-dsh-e2e-'));
  const install = path.join(temp, 'install');
  const repo = path.join(temp, 'repo');
  const home = path.join(temp, 'home');
  const dshHome = path.join(temp, 'dsh-home');
  const sessionRoot = path.join(dshHome, 'sessions');
  const orchData = path.join(temp, 'zonoid-data');
  const binDir = path.join(temp, 'bin');
  const dshLog = path.join(temp, 'dsh-command.jsonl');
  const children = [];
  let watchDispose = null;
  let bridge = null;
  let acceptanceServer = null;
  const previousEnv = {
    ORCH_DATA: process.env.ORCH_DATA,
    DSH_HOME: process.env.DSH_HOME,
    DSH_SESSION_ROOT: process.env.DSH_SESSION_ROOT,
  };

  try {
    copyTrackedInstall(install);
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), '# disposable DSH acceptance repo\n');
    for (const args of [
      ['init'],
      ['config', 'user.name', 'DSH Acceptance'],
      ['config', 'user.email', 'dsh-acceptance@example.invalid'],
    ]) {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.strictEqual(result.status, 0, result.stderr);
    }

    const officialSource = process.env.ZONOID_DSH_SOURCE
      ? path.resolve(process.env.ZONOID_DSH_SOURCE)
      : null;
    if (officialSource) {
      assert.strictEqual(
        spawnSync('git', ['rev-parse', 'HEAD'], { cwd: officialSource, encoding: 'utf8' }).stdout.trim(),
        PINNED_DSH_REVISION,
      );
      assert(fs.existsSync(path.join(officialSource, 'apps', 'cli', 'lib', 'bin.js')),
        'build the pinned DSH checkout before setting ZONOID_DSH_SOURCE');
    }
    writeDshCommand(binDir, officialSource);

    const profileDir = path.join(dshHome, 'profiles', 'headless');
    const userProfile = {
      name: 'user-headless',
      private: true,
      dependencies: { '@user/dsh-plugin': '1.0.0' },
      dsh: { profile: { extends: ['base', 'headless'], bundles: ['@user/dsh-plugin'] } },
    };
    writeJson(path.join(profileDir, 'package.json'), userProfile);
    const userPatch = '- insert:\n  - id: user-mcp\n    name: user-plugin\n';
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), userPatch);

    acceptanceServer = await createAcceptanceServer(temp);
    const cliEnv = {
      ...process.env,
      HOME: home,
      DSH_HOME: dshHome,
      DSH_SESSION_ROOT: sessionRoot,
      DSH_TELEMETRY_DISABLED: '1',
      ORCH_DATA: orchData,
      ZONOID_DATA: orchData,
      ORCH_PORT: String(acceptanceServer.port),
      ZONOID_SKIP_LIVE: '1',
      ZONOID_DSH_ACCEPTANCE_LOG: dshLog,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    };
    const cli = path.join(install, 'packages', 'cli', 'bin', 'zonoid.js');
    const firstInit = await runChild(
      process.execPath,
      [cli, 'init', '--harness', 'dsh'],
      { cwd: repo, env: cliEnv },
      children,
      45_000,
    );
    assert.match(firstInit.stdout, /DSH profile 'headless' now includes/);
    assert.match(firstInit.stdout, /Next steps \(dsh\)/);
    assert.strictEqual(acceptanceServer.state.initCalls, 1);

    const managedDir = path.join(dshHome, 'zonoid', 'packages', 'dsh');
    const managedPatch = fs.readFileSync(path.join(managedDir, 'zonoid.cordis.patch.yml'), 'utf8');
    assert(
      managedPatch.includes(JSON.stringify(path.join(fs.realpathSync(install), 'mcp-graph.js'))),
      `managed MCP entry did not point at the disposable install:\n${managedPatch}`,
    );
    assert.match(managedPatch, /ORCH_CLIENT: dsh/);
    const installedProfile = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    assert.strictEqual(installedProfile.dependencies['@user/dsh-plugin'], '1.0.0');
    assert.match(installedProfile.dependencies['@zonoid/dsh'], /^link:/);
    assert.deepStrictEqual(installedProfile.dsh.profile.bundles, ['@user/dsh-plugin', '@zonoid/dsh']);
    assert.strictEqual(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), userPatch);
    assert.deepStrictEqual(
      fs.readFileSync(path.join(profileDir, 'package.json.zonoid.bak')),
      Buffer.from(`${JSON.stringify(userProfile, null, 2)}\n`),
    );
    const stableProfile = fs.readFileSync(path.join(profileDir, 'package.json'));
    const stablePatchHash = crypto.createHash('sha256').update(managedPatch).digest('hex');

    const secondInit = await runChild(
      process.execPath,
      [cli, 'init', '--harness', 'dsh'],
      { cwd: repo, env: cliEnv },
      children,
      45_000,
    );
    assert.match(secondInit.stdout, /already includes the Zonoid bundle/);
    assert.strictEqual(acceptanceServer.state.initCalls, 2);
    assert.deepStrictEqual(fs.readFileSync(path.join(profileDir, 'package.json')), stableProfile);
    assert.strictEqual(
      crypto.createHash('sha256').update(fs.readFileSync(path.join(managedDir, 'zonoid.cordis.patch.yml'))).digest('hex'),
      stablePatchHash,
    );
    const dshInvocations = fs.readFileSync(dshLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.strictEqual(dshInvocations.length, 1, 'repeat init must not invoke the DSH package manager again');
    assert.deepStrictEqual(dshInvocations[0].slice(0, 4), ['plugin', '--profile', 'headless', 'add']);

    // Exercise the actual installed stdio entry through initialize, filtered list, call, and EOF.
    const mcp = startMcp(path.join(install, 'mcp-graph.js'), {
      cwd: repo,
      env: {
        ...cliEnv,
        ORCH_CLIENT: 'dsh',
        ORCH_GRAPH_REPO: repo,
        ORCH_TARGET_REPO: repo,
      },
    }, children);
    const initialized = await mcp.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-e2e-acceptance', version: '1' },
    });
    assert.strictEqual(initialized.result.serverInfo.name, 'orchestrator-graph');
    mcp.notify('notifications/initialized');
    const listed = await mcp.request('tools/list');
    const toolNames = listed.result.tools.map((tool) => tool.name);
    assert(toolNames.includes('subconscious_assignment'));
    assert(toolNames.includes('show_dashboard'));
    assert(!toolNames.includes('merge_attempt'));
    assert(!toolNames.includes('submit_judge_verdict'));
    const dashboard = await mcp.request('tools/call', {
      name: 'show_dashboard',
      arguments: { workspace: repo },
    });
    assert.strictEqual(dashboard.result.isError, false);
    const dashboardResult = JSON.parse(dashboard.result.content[0].text);
    assert.strictEqual(dashboardResult.workspace, repo);
    assert.match(dashboardResult.launch.url, new RegExp(`localhost:${acceptanceServer.port}/graph\\?workspace=`));
    await mcp.eof();
    assert.strictEqual(mcp.record.code, 0, 'stdio EOF must cleanly terminate the MCP child');

    // Use the production HTTP relay and bridge against the acceptance server. The DSH session
    // identity is intentionally different from the authoritative prepared worker identity.
    const { createRelay } = await import('../packages/dsh/lib/relay.mjs');
    const { createBridge } = await import('../packages/dsh/lib/bridge.mjs');
    const workspaceLink = path.join(temp, 'repo-link');
    fs.symlinkSync(repo, workspaceLink);
    const sessionId = 'dsh-live-session';
    const workerId = 'prepared-dsh-worker';
    const taskKey = 'dsh/e2e-task';
    acceptanceServer.state.claim = { key: taskKey, agent_id: workerId, workspace: repo };
    acceptanceServer.state.permit = {
      status: 'active',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      session_id: sessionId,
      agent_id: workerId,
      task_key: taskKey,
      branch: 'orch/attempt/dsh-e2e-task',
      worktree: repo,
      allowed_paths: [repo],
    };
    bridge = createBridge({
      relay: createRelay({ port: acceptanceServer.port }),
      port: acceptanceServer.port,
    });
    const injected = [];
    const agent = {
      id: sessionId,
      session: { id: sessionId, header: { cwd: workspaceLink } },
      inject(message) { injected.push(message); },
    };
    await bridge.sessionStart(agent);
    assert.strictEqual(injected.length, 1);
    const startRequest = acceptanceServer.state.requests.find((request) => request.pathname === '/agent/start');
    assert.deepStrictEqual(startRequest.body, {
      agent_id: sessionId,
      agent_type: 'dsh',
      session: sessionId,
      workspace: fs.realpathSync(repo),
    });
    const step = await bridge.preStep({
      agent,
      signal: new AbortController().signal,
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'acceptance task' }] }],
    }, async () => ({ kind: 'enter', messages: [] }));
    assert.strictEqual(step.messages[0].content[0].text, '[acceptance] canonical DSH context');

    let toolBodies = 0;
    const unclaimed = await bridge.preTool({
      name: 'write', arguments: { path: path.join(repo, 'unclaimed.js') }, agent,
      signal: new AbortController().signal,
    }, async () => { toolBodies++; return { kind: 'allow' }; });
    assert.strictEqual(unclaimed.kind, 'deny');
    assert.match(unclaimed.reason, /accept a prepared Subconscious assignment/);
    acceptanceServer.state.claimed = true;
    const allowed = await bridge.preTool({
      name: 'write', arguments: { path: path.join(repo, 'inside.js') }, agent,
      signal: new AbortController().signal,
    }, async () => { toolBodies++; return { kind: 'allow' }; });
    assert.deepStrictEqual(allowed, { kind: 'allow' });
    const outside = await bridge.preTool({
      name: 'write', arguments: { path: path.join(temp, 'outside.js') }, agent,
      signal: new AbortController().signal,
    }, async () => { toolBodies++; return { kind: 'allow' }; });
    assert.strictEqual(outside.kind, 'deny');
    assert.match(outside.reason, /outside the assigned worktree/);
    assert.strictEqual(toolBodies, 1, 'only the in-worktree claimed write reaches the tool body');
    const permitRequest = acceptanceServer.state.requests.find((request) => request.pathname === '/subconscious/permit');
    assert.strictEqual(permitRequest.query.get('session_id'), sessionId);
    assert.strictEqual(permitRequest.query.get('agent_id'), workerId);
    await bridge.agentDisposed(agent);
    assert.strictEqual(acceptanceServer.state.teardownCompleted, true,
      'agent disposal must await the delayed daemon completion response');
    await bridge.close();
    bridge = null;

    // Exercise the real DSH file-drop adapter, including its recursive watcher and health path.
    process.env.ORCH_DATA = orchData;
    process.env.DSH_HOME = dshHome;
    process.env.DSH_SESSION_ROOT = sessionRoot;
    const filedrop = require('../lib/filedrop-tasks');
    const dsh = require('../lib/harnesses/dsh');
    const firstStub = filedrop.stubFile(repo, 'dsh/task-one');
    atomicJson(firstStub, {
      id: 'task-one', subject: 'E2E task one', status: 'pending', blockedBy: [],
    });
    let watchArmed = false;
    let resolveWatch;
    const watched = new Promise((resolve) => { resolveWatch = resolve; });
    watchDispose = dsh.tasks.watch(() => { if (watchArmed) resolveWatch(); });
    watchArmed = true;
    atomicJson(filedrop.stubFile(repo, 'dsh/task-two'), {
      id: 'task-two', subject: 'E2E task two', status: 'pending', blockedBy: ['task-one'],
    });
    await waitForWatch(watched);
    assert.strictEqual(dsh.tasks.readTask('dsh/task-one', repo).subject, 'E2E task one');
    assert.strictEqual(dsh.tasks.writeStatus('dsh/task-one', 'in_progress', repo), true);
    assert.strictEqual(dsh.tasks.readTask('dsh/task-one', repo).status, 'in_progress');
    assert.deepStrictEqual(
      dsh.tasks.aggregateWorkspace(repo).find((task) => task.key === 'dsh/task-two').deps,
      ['dsh/task-one'],
    );
    assert.deepStrictEqual(dsh.tasks.formatHealth(repo), {
      sessions: 1, files: 2, parsed: 2, wellFormed: 2, anomalies: [], healthy: true,
    });
    watchDispose();
    watchDispose = null;

    // DSH appends independent zstd frames. A finalized message replaces the earlier chunk for
    // the same step, while the next frame's second step remains additive during reconciliation.
    if (typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function') {
      const transcript = path.join(sessionRoot, '--repo--', sessionId, 'session.jsonl.zstd');
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      const frameOne = [
        { type: 'session', version: 0, id: sessionId, cwd: repo, createdAt: 1788048000000, delegationDepth: 0 },
        { type: 'request/context', seq: 0, time: 1788048000100, data: { model: 'deepseek-chat' } },
        { type: 'assistant/chunk', seq: 1, time: 1788048000200, data: {
          turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
        } },
      ].map(JSON.stringify).join('\n') + '\n';
      const frameTwo = [
        { type: 'assistant/message', seq: 2, time: 1788048000300, data: {
          turn: 1, step: 1,
          message: { source: { kind: 'model', model: 'deepseek-chat' } },
          usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 },
        } },
        { type: 'assistant/chunk', seq: 3, time: 1788048000400, data: {
          turn: 1, step: 2,
          chunk: { type: 'usage', usage: { inputTokens: 4, outputTokens: 1 } },
        } },
      ].map(JSON.stringify).join('\n') + '\n';
      fs.writeFileSync(transcript, Buffer.concat([
        zlib.zstdCompressSync(Buffer.from(frameOne)),
        zlib.zstdCompressSync(Buffer.from(frameTwo)),
      ]));
      assert.strictEqual(dsh._internal.readSessionText(transcript), frameOne + frameTwo);
      const usage = dsh.usage.reconcile(repo);
      assert.strictEqual(usage.sessions.length, 1);
      assert.strictEqual(usage.sessions[0].id, sessionId);
      assert.strictEqual(usage.totals.input_tokens, 16);
      assert.strictEqual(usage.totals.output_tokens, 4);
      assert.strictEqual(usage.totals.cache_read_input_tokens, 2);
      assert.strictEqual(usage.totals.cache_creation_input_tokens, 1);
    } else {
      t.diagnostic('framed zstd reconciliation skipped: this Node runtime has no zstd API');
    }

    if (officialSource) {
      const profileDump = await runChild(
        process.execPath,
        [path.join(officialSource, 'apps', 'cli', 'lib', 'bin.js'), '--profile', 'headless', '--dump-config'],
        { cwd: repo, env: cliEnv },
        children,
        45_000,
      );
      assert.match(profileDump.stdout, /@deepseek-ai\/dsh-mcp-client/);
      assert.match(profileDump.stdout, /@zonoid\/dsh/);
      await runChild(
        process.execPath,
        [path.join(ROOT, 'scripts', 'probe-dsh-host-contract.js'), '--dsh-source', officialSource],
        { cwd: ROOT, env: cliEnv },
        children,
        45_000,
      );
    } else {
      const receipt = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'test', 'fixtures', 'dsh-host-contract', 'probe-receipt.json'),
        'utf8',
      ));
      assert.strictEqual(receipt.host.version, PINNED_DSH_VERSION);
      assert.strictEqual(receipt.host.revision, PINNED_DSH_REVISION);
      assert.deepStrictEqual(receipt.teardown, { pluginDisposed: true, mcpStdioClosed: true });
      assert.strictEqual(receipt.mcp.requests.at(-1), 'stdio/eof');
      t.diagnostic('official host load uses the pinned live receipt; set ZONOID_DSH_SOURCE for a fresh built-host probe');
    }

    assert(children.every((record) => record.exited), 'every spawned child must be reaped');
    for (const record of children) {
      assert.strictEqual(record.code, 0, `${record.command} did not exit cleanly`);
      assert.throws(() => process.kill(record.child.pid, 0), { code: 'ESRCH' });
    }
  } finally {
    if (watchDispose) watchDispose();
    if (bridge) await bridge.close();
    await Promise.all(children.map(terminateChild));
    if (acceptanceServer) {
      await new Promise((resolve) => acceptanceServer.server.close(resolve));
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
