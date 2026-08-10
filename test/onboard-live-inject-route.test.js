#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const onboardRoute = require('../routes/onboard');
const learner = require('../scripts/onboard-learn');
const {
  defaultOnboardOutDir,
  legacyGraphOnboardOutDir,
  legacyBenchOnboardOutDir,
} = require('../lib/onboard-paths');

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function writeQueue(outDir, total, cursor, kept = [], generation) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
    total,
    cursor,
    kept,
    rejected: [],
    pending: [],
    ...(generation ? { generation } : {}),
  }));
}

function makeCtx(body, sent, notify, registeredRepos) {
  return {
    readBody: async () => body,
    send: (_res, status, payload) => sent.push({ status, payload }),
    notifyChange: notify,
    registeredWorkspaces: () => new Set(registeredRepos || (body && body.repo ? [body.repo] : [])),
  };
}

function dashboardStatusComplete(status) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');
  const sourceFor = (name) => {
    const start = html.indexOf(`function ${name}(s) {`);
    assert.notEqual(start, -1, `${name} must exist in the dashboard`);
    let depth = 0;
    let opened = false;
    for (let i = start; i < html.length; i++) {
      if (html[i] === '{') { depth++; opened = true; }
      if (html[i] === '}') depth--;
      if (opened && depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(`could not extract ${name}`);
  };
  const predicate = Function(
    `'use strict';\n${sourceFor('onboardStatusDrained')}\n${sourceFor('onboardStatusComplete')}\nreturn onboardStatusComplete;`
  )();
  return predicate(status);
}

function dashboardStatusUpdater() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');
  const sourceFor = (name) => {
    const start = html.indexOf(`function ${name}(s) {`);
    assert.notEqual(start, -1, `${name} must exist in the dashboard`);
    let depth = 0;
    let opened = false;
    for (let i = start; i < html.length; i++) {
      if (html[i] === '{') { depth++; opened = true; }
      if (html[i] === '}') depth--;
      if (opened && depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(`could not extract ${name}`);
  };
  return Function(`'use strict';
    const view = { status: null, injectVisible: null, prepareVisible: null, stage: null };
    const cloud = { classList: { toggle() {} } };
    const landing = { dataset: {} };
    const document = {
      querySelector() { return cloud; },
      getElementById(id) { return id === 'onboard-landing' ? landing : null; }
    };
    function setOnboardProgress() {}
    function renderOnboardCloud() {}
    function setOnboardStage(stage) { view.stage = stage; }
    function setOnboardInjectVisible(visible, busy) { view.injectVisible = { visible, busy }; }
    function setOnboardPrepareVisible(visible, busy) { view.prepareVisible = { visible, busy }; }
    function setOnboardStatus(message, isError) { view.status = { message, isError: !!isError }; }
    function completeOnboardLearning() {}
    function setTimeout() {}
    ${sourceFor('onboardStatusDrained')}
    ${sourceFor('onboardStatusComplete')}
    ${sourceFor('updateOnboardFromStatus')}
    return {
      apply(status) { return { stopped: updateOnboardFromStatus(status), view: JSON.parse(JSON.stringify(view)) }; }
    };
  `)();
}

function dashboardPollHarness(sequence) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');
  const start = html.indexOf('async function pollOnboardLearning() {');
  assert.notEqual(start, -1, 'pollOnboardLearning must exist in the dashboard');
  let depth = 0;
  let opened = false;
  let source = '';
  for (let i = start; i < html.length; i++) {
    if (html[i] === '{') { depth++; opened = true; }
    if (html[i] === '}') depth--;
    if (opened && depth === 0) { source = html.slice(start, i + 1); break; }
  }
  assert.ok(source);
  return Function('sequence', `'use strict';
    let onboardPollTimer = null;
    let onboardPollFailures = 0;
    const ONBOARD_POLL_MS = 1200;
    const ONBOARD_POLL_MAX_MS = 10000;
    const scheduled = [];
    const visible = [];
    const landing = { dataset: { repo: '/repo', outDir: '/repo/.zonoid/onboard/repo', draining: '1' } };
    const document = { getElementById(id) { return id === 'onboard-landing' ? landing : null; } };
    function clearTimeout() {}
    function setTimeout(fn, ms) { const timer = { fn, ms }; scheduled.push(timer); return timer; }
    function setOnboardStatus(message, isError) { visible.push({ message, isError: !!isError }); }
    function updateOnboardFromStatus(status) { visible.push({ status }); return status.stop === true; }
    async function dfetch() {
      const next = sequence.shift();
      if (!next) throw new Error('unexpected status request');
      if (next.networkError) throw new Error(next.networkError);
      return { async json() {
        if (next.jsonError) throw new Error(next.jsonError);
        return next.body;
      } };
    }
    ${source}
    return {
      async poll() { await pollOnboardLearning(); },
      async runNext() { const timer = scheduled.shift(); if (!timer) throw new Error('no scheduled retry'); await timer.fn(); },
      state() { return { scheduled: scheduled.map(t => t.ms), failures: onboardPollFailures,
        draining: landing.dataset.draining, visible: JSON.parse(JSON.stringify(visible)) }; }
    };
  `)(sequence.slice());
}

function dashboardDiscoveryHarness(sequence, initialStorage = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');
  const sourceFor = (name) => {
    const asyncMarker = `async function ${name}(`;
    const marker = `function ${name}(`;
    const asyncStart = html.indexOf(asyncMarker);
    const start = asyncStart >= 0 ? asyncStart : html.indexOf(marker);
    assert.notEqual(start, -1, `${name} must exist in the dashboard`);
    let depth = 0;
    let opened = false;
    for (let i = start; i < html.length; i++) {
      if (html[i] === '{') { depth++; opened = true; }
      if (html[i] === '}') depth--;
      if (opened && depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(`could not extract ${name}`);
  };
  return Function('sequence', 'initialStorage', `'use strict';
    let onboardAutoStartInFlight = false;
    let onboardDiscoveryInFlight = false;
    let onboardDiscoveryTimer = null;
    const ONBOARD_POLL_MS = 1200;
    const ONBOARD_POLL_MAX_MS = 10000;
    const scheduled = [];
    const requests = [];
    const storage = new Map(Object.entries(initialStorage));
    const landing = { dataset: {} };
    const document = { getElementById(id) { return id === 'onboard-landing' ? landing : null; } };
    const localStorage = {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    };
    function currentOnboardWorkspace() { return '/repo'; }
    function onboardStoreKey(suffix) { return 'onboard_' + suffix + '_/repo'; }
    function onboardCompletedKey() { return onboardStoreKey('completed'); }
    function candidateOnboardOutDirs() { return ['/repo/default', '/repo/legacy-a', '/repo/legacy-b']; }
    function showOnboardLanding() {}
    function renderOnboardCloud() {}
    function setOnboardInjectVisible() {}
    function setOnboardPrepareVisible() {}
    function setOnboardStage() {}
    function setOnboardProgress() {}
    function setOnboardStatus() {}
    function updateOnboardFromStatus(status) { return status.stop === true; }
    function onboardStatusComplete(status) { return status.complete === true; }
    function onboardStatusNeedsResume(status) { return status.resume === true; }
    let completed = 0;
    let polled = 0;
    function completeOnboardLearning() { completed++; }
    function pollOnboardLearning() { polled++; }
    function clearTimeout() {}
    function setTimeout(fn, ms) { const timer = { fn, ms }; scheduled.push(timer); return timer; }
    async function dfetch(url, options = {}) {
      const next = sequence.shift();
      if (!next) throw new Error('unexpected request ' + url);
      const method = options.method || 'GET';
      requests.push({ url, method });
      if (next.networkError) throw new Error(next.networkError);
      const status = next.status === undefined ? 200 : next.status;
      return {
        status,
        ok: next.ok === undefined ? status >= 200 && status < 300 : next.ok,
        async json() {
          if (next.jsonError) throw new Error(next.jsonError);
          return next.body;
        },
      };
    }
    ${sourceFor('hasInjectedOnboardNotes')}
    ${sourceFor('scheduleOnboardDiscoveryRetry')}
    ${sourceFor('clearOnboardDiscoveryRetry')}
    ${sourceFor('ensureOnboardLearning')}
    ${sourceFor('checkOnboardingState')}
    return {
      async check() { await checkOnboardingState(); },
      async runNext() { const timer = scheduled.shift(); if (!timer) throw new Error('no scheduled retry'); await timer.fn(); },
      state() { return { requests: requests.slice(), scheduled: scheduled.map(t => t.ms),
        storage: Object.fromEntries(storage), completed, polled, landing: JSON.parse(JSON.stringify(landing)) }; },
    };
  `)(sequence.slice(), initialStorage);
}

test('pre-outDir candidate and search failures stay inconclusive with reload-persisted bounded retry', async () => {
  const completedKey = 'onboard_completed_/repo';
  const first = dashboardDiscoveryHarness([{ networkError: 'candidate offline' }], { [completedKey]: '1' });
  await first.check();
  const firstState = first.state();
  assert.equal(firstState.completed, 0, 'a transient candidate probe must not trust the stale completion latch');
  assert.deepEqual(firstState.scheduled, [1200]);
  assert.equal(firstState.storage['onboard_discovery_failures_/repo'], '1');

  const reloaded = dashboardDiscoveryHarness([{ jsonError: 'candidate JSON truncated' }], firstState.storage);
  await reloaded.check();
  assert.deepEqual(reloaded.state().scheduled, [2400], 'the bounded retry attempt survives a reload');

  const searchFailure = dashboardDiscoveryHarness([
    { status: 404, body: { ok: false } },
    { status: 404, body: { ok: false } },
    { status: 404, body: { ok: false } },
    { jsonError: 'search JSON truncated' },
  ]);
  await searchFailure.check();
  const searchState = searchFailure.state();
  assert.deepEqual(searchState.scheduled, [1200]);
  assert.equal(searchState.requests.some((r) => r.method === 'POST'), false,
    'an inconclusive search must not start a fresh enqueue');
});

test('enqueue and drain response loss retries discovery without duplicating accepted work', async () => {
  const enqueueLoss = dashboardDiscoveryHarness([
    { status: 404, body: { ok: false } },
    { status: 404, body: { ok: false } },
    { status: 404, body: { ok: false } },
    { body: { results: [] } },
    { jsonError: 'enqueue response lost' },
    { body: { ok: true, status: { resume: true } } },
    { body: { ok: true, status: { stop: true } } },
  ]);
  await enqueueLoss.check();
  assert.deepEqual(enqueueLoss.state().scheduled, [1200]);
  await enqueueLoss.runNext();
  const enqueueRecovered = enqueueLoss.state();
  assert.equal(enqueueRecovered.requests.filter((r) => r.url === '/onboard/enqueue').length, 1,
    'candidate recovery finds the accepted queue instead of enqueuing it twice');
  assert.equal(enqueueRecovered.requests.filter((r) => r.url === '/onboard/drain-queue').length, 1);

  const drainLoss = dashboardDiscoveryHarness([
    { status: 404, body: { ok: false } },
    { status: 404, body: { ok: false } },
    { status: 404, body: { ok: false } },
    { body: { results: [] } },
    { body: { ok: true, outDir: '/repo/default', total: 1, remaining: 1 } },
    { jsonError: 'drain response lost' },
  ]);
  await drainLoss.check();
  const lostState = drainLoss.state();
  assert.equal(lostState.storage['onboard_outdir_/repo'], '/repo/default');
  const afterReload = dashboardDiscoveryHarness([
    { body: { ok: true, status: { resume: false } } },
  ], lostState.storage);
  await afterReload.check();
  const recovered = afterReload.state();
  assert.equal(recovered.requests.some((r) => r.method === 'POST'), false,
    'reload observes the already accepted drain instead of posting another enqueue or drain');
  assert.equal(recovered.polled, 1);
});

test('onboarding routes accept only the default and documented legacy roots of a registered repo', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-supported-roots-'));
  const roots = [defaultOnboardOutDir(repo), legacyGraphOnboardOutDir(repo), legacyBenchOnboardOutDir(repo)];
  try {
    for (const outDir of roots) {
      const sent = [];
      const route = onboardRoute(makeCtx({ repo, outDir }, sent, () => {}, [repo]));
      await route('/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue'));
      assert.equal(sent[0].status, 200, `${outDir} should remain supported`);
      assert.equal(sent[0].payload.outDir, outDir);
      assert.equal(fs.existsSync(path.join(outDir, 'onboard-drain-status.json')), true);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('onboarding rejects unregistered, custom, outside, traversal, and symlink output paths before creation', async () => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-path-reject-'));
  const repo = path.join(container, 'repo');
  const outside = path.join(container, 'outside', 'onboard');
  fs.mkdirSync(repo, { recursive: true });
  const customInside = path.join(repo, '.zonoid', 'onboard', 'custom');
  const traversal = path.join(repo, '.zonoid', 'onboard', 'ghost') + `${path.sep}..${path.sep}${path.basename(repo)}`;
  try {
    const rejected = [customInside, outside, traversal];
    for (const outDir of rejected) {
      const sent = [];
      const route = onboardRoute(makeCtx({ repo, outDir }, sent, () => {}, [repo]));
      await route('/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue'));
      assert.equal(sent[0].status, 400, `${outDir} must be rejected`);
      assert.equal(fs.existsSync(outDir), false, 'a rejected target must never be created');
    }

    const unregisteredOut = defaultOnboardOutDir(repo);
    const unregistered = [];
    await onboardRoute(makeCtx({ repo }, unregistered, () => {}, []))(
      '/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue')
    );
    assert.equal(unregistered[0].status, 403);
    assert.equal(fs.existsSync(unregisteredOut), false);

    const missingRepo = path.join(container, 'missing-repo');
    const missing = [];
    await onboardRoute(makeCtx({ repo: missingRepo }, missing, () => {}, [missingRepo]))(
      '/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue')
    );
    assert.equal(missing[0].status, 400);
    assert.equal(fs.existsSync(missingRepo), false, 'a missing registered path must not be created as a project');

    const linkedOutside = path.join(container, 'linked-outside');
    fs.mkdirSync(linkedOutside, { recursive: true });
    fs.symlinkSync(linkedOutside, path.join(repo, '.zonoid'));
    const symlinked = [];
    await onboardRoute(makeCtx({ repo }, symlinked, () => {}, [repo]))(
      '/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue')
    );
    assert.equal(symlinked[0].status, 400);
    assert.match(symlinked[0].payload.error, /symlink/i);
    assert.equal(fs.existsSync(path.join(linkedOutside, 'onboard')), false);
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('every onboarding route validates the canonical repo and output before touching state', async () => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-all-path-gates-'));
  const repo = path.join(container, 'repo');
  const outDir = path.join(container, 'outside-state');
  fs.mkdirSync(repo, { recursive: true });
  const cases = [
    { path: '/onboard/enqueue', method: 'POST', body: { repo, outDir } },
    { path: '/onboard/drain-queue', method: 'POST', body: { repo, outDir } },
    { path: '/onboard/inject', method: 'POST', body: { repo, outDir } },
    { path: '/onboard/retry-inject', method: 'POST', body: { repo, outDir } },
    { path: '/onboard/drain-next', method: 'POST', body: { repo, outDir } },
  ];
  try {
    for (const item of cases) {
      const sent = [];
      const route = onboardRoute(makeCtx(item.body, sent, () => {}, [repo]));
      await route(item.path, item.method, {}, {}, new URL(`http://localhost${item.path}`));
      assert.equal(sent[0].status, 400, `${item.method} ${item.path} must reject the outside root`);
      assert.equal(fs.existsSync(outDir), false);
    }
    const sent = [];
    const route = onboardRoute(makeCtx({}, sent, () => {}, [repo]));
    const url = new URL(`http://localhost/onboard/drain-queue?repo=${encodeURIComponent(repo)}&outDir=${encodeURIComponent(outDir)}`);
    await route('/onboard/drain-queue', 'GET', {}, {}, url);
    assert.equal(sent[0].status, 400);
    assert.equal(fs.existsSync(outDir), false);
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('POST /onboard/drain-queue records status and returns without owning drain loop', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-'));
  const outDir = path.join(tmpDir, 'bench', 'onboard', path.basename(tmpDir));
  const repo = tmpDir;
  const sent = [];
  let notifyCount = 0;
  const previousJobs = global.__drainJobs;
  delete global.__drainJobs;

  try {
    writeQueue(outDir, 5, 2, [{ title: 'Live note', summary: 'Shown in cloud', kind: 'decision' }]);
    const route = onboardRoute(makeCtx({ repo, outDir, batchSize: 13 }, sent, () => { notifyCount++; }));
    const handled = await route('/onboard/drain-queue', 'POST', {}, {}, new URL('http://localhost/onboard/drain-queue'));

    assert.equal(handled, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].status, 200);
    assert.equal(sent[0].payload.ok, true);
    assert.equal(sent[0].payload.status.total, 5);
    assert.equal(sent[0].payload.status.processed, 2);
    assert.equal(sent[0].payload.status.remaining, 3);
    assert.equal(sent[0].payload.status.kept, 1);
    assert.equal(sent[0].payload.status.keptNotes[0].title, 'Live note');
    assert.equal(sent[0].payload.status.injectedKept, 0);
    assert.equal(sent[0].payload.status.autoInject, true);
    assert.equal(sent[0].payload.status.done, false);
    assert.equal(notifyCount, 1);

    const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(meta.repo, repo);
    assert.equal(meta.outDir, outDir);
    assert.equal(meta.batchSize, 13);
    assert.equal(meta.autoInject, true);
    assert.equal(meta.injecting, false);
  } finally {
    if (previousJobs === undefined) delete global.__drainJobs;
    else global.__drainJobs = previousJobs;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GET /onboard/drain-queue recovers status from queue files after in-memory job loss', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-get-'));
  const outDir = path.join(tmpDir, 'bench', 'onboard', path.basename(tmpDir));
  const repo = tmpDir;
  const sent = [];
  const previousJobs = global.__drainJobs;
  delete global.__drainJobs;

  try {
    writeQueue(outDir, 4, 4);
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo,
      outDir,
      autoInject: true,
      injected: true,
    }));
    const route = onboardRoute(makeCtx({}, sent, () => {}, [repo]));
    const url = new URL(`http://localhost/onboard/drain-queue?repo=${encodeURIComponent(repo)}&outDir=${encodeURIComponent(outDir)}`);
    const handled = await route('/onboard/drain-queue', 'GET', {}, {}, url);

    assert.equal(handled, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].status, 200);
    assert.equal(sent[0].payload.status.processed, 4);
    assert.equal(sent[0].payload.status.remaining, 0);
    assert.equal(sent[0].payload.status.done, true);
    assert.equal(sent[0].payload.status.injected, false);
    assert.equal(sent[0].payload.status.injectionState, 'not_needed');
  } finally {
    if (previousJobs === undefined) delete global.__drainJobs;
    else global.__drainJobs = previousJobs;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('persisted background injection failure overrides stale POST state and blocks dashboard completion', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-inject-failure-'));
  const outDir = path.join(tmpDir, 'bench', 'onboard', path.basename(tmpDir));
  const repo = tmpDir;
  const sent = [];
  const previousJobs = global.__drainJobs;
  delete global.__drainJobs;

  try {
    writeQueue(outDir, 2, 2, [
      { title: 'Previously injected', summary: 'Already live', kind: 'decision' },
      { title: 'Newly learned', summary: 'Injection will fail', kind: 'gotcha' },
    ]);
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ kept: [], rejected: [] }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo,
      outDir,
      autoInject: true,
      injected: true,
      injectedKept: 1,
    }));

    const route = onboardRoute(makeCtx({ repo, outDir, autoInject: true }, sent, () => {}));
    await route('/onboard/drain-queue', 'POST', {}, {}, new URL('http://localhost/onboard/drain-queue'));
    assert.equal(sent[0].status, 200);
    assert.equal(sent[0].payload.status.injected, false, 'one newly kept note still needs injection');
    assert.equal(sent[0].payload.status.done, false);

    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo,
      outDir,
      autoInject: true,
      injecting: false,
      injected: true,
      injectedKept: 1,
      error: 'inject exited 1',
    }));
    const statusUrl = new URL(`http://localhost/onboard/drain-queue?repo=${encodeURIComponent(repo)}&outDir=${encodeURIComponent(outDir)}`);
    await route('/onboard/drain-queue', 'GET', {}, {}, statusUrl);

    const failed = sent[1].payload.status;
    assert.equal(failed.error, 'inject exited 1');
    assert.equal(failed.injected, false);
    assert.equal(failed.done, false, 'a failed injection remains live until retry succeeds');
    assert.equal(dashboardStatusComplete(failed), false, 'a terminal failure must not latch onboarding as complete');

    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo,
      outDir,
      autoInject: true,
      injecting: false,
      injected: true,
      injectedKept: 2,
      error: null,
    }));
    await route('/onboard/drain-queue', 'GET', {}, {}, statusUrl);
    const recovered = sent[2].payload.status;
    assert.equal(recovered.error, null);
    assert.equal(recovered.injected, true);
    assert.equal(recovered.done, true);
    assert.equal(dashboardStatusComplete(recovered), true, 'a later successful injection may complete onboarding');
  } finally {
    if (previousJobs === undefined) delete global.__drainJobs;
    else global.__drainJobs = previousJobs;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('generic learner failure is reported retryable while queue work remains and clears on recovery', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-drain-recovery-'));
  const outDir = defaultOnboardOutDir(repo);
  const sent = [];
  const url = new URL(`http://localhost/onboard/drain-queue?repo=${encodeURIComponent(repo)}&outDir=${encodeURIComponent(outDir)}`);
  try {
    writeQueue(outDir, 2, 1, [], 'generation-drain-recovery');
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo,
      outDir,
      autoInject: true,
      error: 'onboarding drain exited 1',
    }));
    const route = onboardRoute(makeCtx({}, sent, () => {}, [repo]));
    await route('/onboard/drain-queue', 'GET', {}, {}, url);
    assert.equal(sent[0].status, 200);
    assert.equal(sent[0].payload.status.retryablePending, true);
    assert.equal(sent[0].payload.status.done, false);

    writeQueue(outDir, 2, 2, [], 'generation-drain-recovery');
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo,
      outDir,
      autoInject: true,
      error: null,
    }));
    await route('/onboard/drain-queue', 'GET', {}, {}, url);
    assert.equal(sent[1].payload.status.retryablePending, false);
    assert.equal(sent[1].payload.status.error, null);
    assert.equal(sent[1].payload.status.injectionState, 'not_needed');
    assert.equal(sent[1].payload.status.done, true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('generic learner failure remains retryable after the queue cursor reaches final injection', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-final-recovery-'));
  const outDir = defaultOnboardOutDir(repo);
  const sent = [];
  const kept = [{ title: 'Final', summary: 'Still needs graph injection' }];
  try {
    writeQueue(outDir, 1, 1, kept, 'generation-final-recovery');
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ kept, rejected: [] }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo, outDir, autoInject: true, error: 'onboarding drain exited 1',
    }));
    const route = onboardRoute(makeCtx({}, sent, () => {}, [repo]));
    const url = new URL(`http://localhost/onboard/drain-queue?repo=${encodeURIComponent(repo)}&outDir=${encodeURIComponent(outDir)}`);
    await route('/onboard/drain-queue', 'GET', {}, {}, url);

    const status = sent[0].payload.status;
    assert.equal(status.remaining, 0);
    assert.equal(status.done, false);
    assert.equal(status.injected, false);
    assert.equal(status.retryablePending, true, 'finalization recovery must keep the UI polling');
    assert.equal(dashboardStatusUpdater().apply(status).stopped, false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('pending or running injection never reuses a successful watermark to latch completion', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-inject-pending-'));
  const outDir = defaultOnboardOutDir(repo);
  const sent = [];
  try {
    const generation = 'generation-pending';
    writeQueue(outDir, 2, 2, [
      { title: 'A', summary: 'A' },
      { title: 'B', summary: 'B' },
    ], generation);
    const statusFile = path.join(outDir, 'onboard-drain-status.json');
    const url = new URL(`http://localhost/onboard/drain-queue?repo=${encodeURIComponent(repo)}&outDir=${encodeURIComponent(outDir)}`);
    const route = onboardRoute(makeCtx({}, sent, () => {}, [repo]));

    for (const state of ['pending', 'running']) {
      fs.writeFileSync(statusFile, JSON.stringify({
        repo,
        outDir,
        autoInject: true,
        injected: true,
        injectedGeneration: generation,
        injectedKept: 2,
        injectionGeneration: generation,
        injectionState: state,
        injecting: state === 'running',
      }));
      await route('/onboard/drain-queue', 'GET', {}, {}, url);
      const status = sent.at(-1).payload.status;
      assert.equal(status.done, false, `${state} injection must remain incomplete`);
      assert.equal(status.injected, false, `${state} injection cannot reuse the old success flag`);
      assert.equal(dashboardStatusComplete(status), false);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('an explicit zero injection watermark stays zero and requires injection', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-zero-watermark-'));
  const outDir = defaultOnboardOutDir(repo);
  const sent = [];
  try {
    const generation = 'generation-zero';
    writeQueue(outDir, 1, 1, [{ title: 'A', summary: 'A' }], generation);
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo,
      outDir,
      autoInject: true,
      injected: true,
      injectedGeneration: generation,
      injectedKept: 0,
      injectionGeneration: generation,
      injectionState: 'succeeded',
    }));
    const route = onboardRoute(makeCtx({}, sent, () => {}, [repo]));
    const url = new URL(`http://localhost/onboard/drain-queue?repo=${encodeURIComponent(repo)}&outDir=${encodeURIComponent(outDir)}`);
    await route('/onboard/drain-queue', 'GET', {}, {}, url);
    const status = sent[0].payload.status;
    assert.equal(status.injectedKept, 0);
    assert.equal(status.injected, false);
    assert.equal(status.done, false);
    assert.equal(dashboardStatusComplete(status), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('force replacement allocates a fresh generation and invalidates the old injection watermark', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-force-generation-'));
  const outDir = defaultOnboardOutDir(repo);
  const sent = [];
  try {
    const oldGeneration = 'generation-old';
    writeQueue(outDir, 1, 1, [{ title: 'Old', summary: 'Old' }], oldGeneration);
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo,
      outDir,
      autoInject: true,
      queueGeneration: oldGeneration,
      injected: true,
      injectedGeneration: oldGeneration,
      injectedKept: 1,
      injectionGeneration: oldGeneration,
      injectionState: 'succeeded',
    }));
    const route = onboardRoute(makeCtx({ repo, outDir, force: true }, sent, () => {}));
    await route('/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue'));
    const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.notEqual(meta.preparationGeneration, oldGeneration);
    assert.equal(meta.injectedGeneration, null);
    assert.equal(meta.injectedKept, 0);
    assert.equal(meta.injectionState, 'idle');

    const url = new URL(`http://localhost/onboard/drain-queue?repo=${encodeURIComponent(repo)}&outDir=${encodeURIComponent(outDir)}`);
    await onboardRoute(makeCtx({}, sent, () => {}, [repo]))('/onboard/drain-queue', 'GET', {}, {}, url);
    const status = sent[1].payload.status;
    assert.equal(status.preparing, true);
    assert.equal(status.injected, false);
    assert.equal(status.done, false);
    assert.equal(dashboardStatusComplete(status), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('force replacement conflicts with a live injection lease, then succeeds after expiry and fences old writes', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-force-live-injection-'));
  const outDir = defaultOnboardOutDir(repo);
  const generation = 'generation-live';
  const kept = [{ title: 'Live', summary: 'Live generation', kind: 'decision', evidence_refs: ['source:live'] }];
  const statusFile = path.join(outDir, 'onboard-drain-status.json');
  try {
    writeQueue(outDir, 1, 1, kept, generation);
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ kept, rejected: [] }));
    fs.writeFileSync(statusFile, JSON.stringify({
      repo,
      outDir,
      autoInject: true,
      injectionGeneration: generation,
      injectionState: 'running',
      injecting: true,
      injectionOwner: 'live-owner',
      injectionPid: process.pid,
      injectionLeaseExpiresAt: Date.now() + 60000,
    }));

    const blocked = [];
    await onboardRoute(makeCtx({ repo, outDir, force: true }, blocked, () => {}, [repo]))(
      '/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue')
    );
    assert.equal(blocked[0].status, 409);
    assert.equal(blocked[0].payload.retryable, true);
    assert.equal(blocked[0].payload.conflict, 'injection_in_progress');
    assert.equal(JSON.parse(fs.readFileSync(statusFile, 'utf8')).injectionOwner, 'live-owner');

    const expired = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    expired.injectionLeaseExpiresAt = Date.now() - 1;
    fs.writeFileSync(statusFile, JSON.stringify(expired));
    const accepted = [];
    await onboardRoute(makeCtx({ repo, outDir, force: true }, accepted, () => {}, [repo]))(
      '/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue')
    );
    assert.equal(accepted[0].status, 200);
    const replacement = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    assert.notEqual(replacement.preparationGeneration, generation);
    assert.equal(replacement.injectionOwner, null);

    let graphRequests = 0;
    await assert.rejects(
      learner.injectOnboardNotes(path.join(outDir, 'onboard-notes.json'), true, repo, async () => {
        graphRequests++;
        return {};
      }, { expectedGeneration: generation }),
      /stale onboarding generation/
    );
    assert.equal(graphRequests, 0, 'an expired old-generation injector is fenced before another graph request');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('an exact existing note keeps its graph key and upserts every evidence edge on every retry', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-inject-existing-edges-'));
  const outDir = defaultOnboardOutDir(repo);
  const generation = 'generation-existing';
  const kept = [{
    title: 'Stable note',
    summary: 'Stable summary',
    kind: 'decision',
    evidence_refs: ['source:a', 'source:b'],
  }];
  const calls = [];
  try {
    writeQueue(outDir, 1, 1, kept, generation);
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ kept, rejected: [] }));
    const request = async (method, url, body) => {
      calls.push({ method, url, body });
      if (method === 'GET' && url.startsWith('/state')) {
        return { tasks: [{ id: 'note:stable-existing', label: '[ingest] Stable note', summary: 'Stable summary' }] };
      }
      if (url === '/overlay/edge') return { ok: true };
      throw new Error(`unexpected request ${method} ${url}`);
    };

    await learner.injectOnboardNotes(path.join(outDir, 'onboard-notes.json'), true, repo, request, { expectedGeneration: generation });
    await learner.injectOnboardNotes(path.join(outDir, 'onboard-notes.json'), true, repo, request, { expectedGeneration: generation });

    assert.equal(calls.filter((call) => call.url === '/overlay/note').length, 0);
    const edges = calls.filter((call) => call.url === '/overlay/edge');
    assert.equal(edges.length, 4, 'both evidence edges are idempotently upserted on both passes');
    assert.ok(edges.every((call) => call.body.to === 'note:stable-existing'));
    assert.deepEqual(edges.map((call) => call.body.from), ['source:a', 'source:b', 'source:a', 'source:b']);
    const receipt = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-injection-receipt.json'), 'utf8'));
    assert.equal(receipt.generation, generation);
    assert.equal(receipt.confirmed.length, 1, 'repeated completion does not duplicate the receipt watermark');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('edge failure after note persistence retries to a complete graph without duplicate notes or false receipt', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-inject-edge-repair-'));
  const outDir = defaultOnboardOutDir(repo);
  const generation = 'generation-edge-repair';
  const kept = [{
    title: 'Repair note',
    summary: 'Repair summary',
    kind: 'gotcha',
    evidence_refs: ['source:first', 'source:second'],
  }];
  let persistedNote = null;
  let noteCreates = 0;
  let failSecondEdge = true;
  const graphEdges = new Set();
  try {
    writeQueue(outDir, 1, 1, kept, generation);
    const notesFile = path.join(outDir, 'onboard-notes.json');
    fs.writeFileSync(notesFile, JSON.stringify({ kept, rejected: [] }));
    const request = async (method, url, body) => {
      if (method === 'GET' && url.startsWith('/state')) return { tasks: persistedNote ? [persistedNote] : [] };
      if (url === '/overlay/note') {
        noteCreates++;
        persistedNote = { id: 'note:repair-stable', label: body.title, summary: body.summary };
        return { key: persistedNote.id };
      }
      if (url === '/overlay/edge') {
        if (body.from === 'source:second' && failSecondEdge) {
          failSecondEdge = false;
          throw new Error('transient edge failure');
        }
        graphEdges.add(`${body.from}->${body.to}`);
        return { ok: true };
      }
      throw new Error(`unexpected request ${method} ${url}`);
    };

    await assert.rejects(
      learner.injectOnboardNotes(notesFile, true, repo, request, { expectedGeneration: generation }),
      /transient edge failure/
    );
    assert.equal(noteCreates, 1);
    assert.equal(fs.existsSync(path.join(outDir, 'onboard-injection-receipt.json')), false,
      'a partial graph must not advance the durable injection receipt');

    await learner.injectOnboardNotes(notesFile, true, repo, request, { expectedGeneration: generation });
    await learner.injectOnboardNotes(notesFile, true, repo, request, { expectedGeneration: generation });
    assert.equal(noteCreates, 1, 'retry finds and preserves the exact persisted note');
    assert.deepEqual(Array.from(graphEdges).sort(), [
      'source:first->note:repair-stable',
      'source:second->note:repair-stable',
    ]);
    const receipt = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-injection-receipt.json'), 'utf8'));
    assert.equal(receipt.confirmed.length, 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('confirmed injection fails closed when graph state cannot establish the idempotency key', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-inject-state-failure-'));
  const outDir = defaultOnboardOutDir(repo);
  const generation = 'generation-state-failure';
  const kept = [{ title: 'Unknown note', summary: 'State read must succeed', kind: 'gotcha' }];
  let noteCreates = 0;
  try {
    writeQueue(outDir, 1, 1, kept, generation);
    const notesFile = path.join(outDir, 'onboard-notes.json');
    fs.writeFileSync(notesFile, JSON.stringify({ kept, rejected: [] }));
    await assert.rejects(
      learner.injectOnboardNotes(notesFile, true, repo, async (method, url) => {
        if (method === 'GET' && url.startsWith('/state')) throw new Error('state unavailable');
        if (url === '/overlay/note') noteCreates++;
        return {};
      }, { expectedGeneration: generation }),
      /could not read \/state for idempotent injection/
    );
    assert.equal(noteCreates, 0);
    assert.equal(fs.existsSync(path.join(outDir, 'onboard-injection-receipt.json')), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('dashboard keeps retryable learner errors live, clears them on success, and stops terminal states', () => {
  const dashboard = dashboardStatusUpdater();
  const retryable = dashboard.apply({
    total: 2, processed: 1, remaining: 1, kept: 0,
    error: 'onboarding drain exited 1', retryablePending: true,
  });
  assert.equal(retryable.stopped, false);
  assert.equal(retryable.view.status.isError, true);
  assert.match(retryable.view.status.message, /Retrying automatically/);

  const recovered = dashboard.apply({ total: 2, processed: 1, remaining: 1, kept: 0, error: null });
  assert.equal(recovered.stopped, false);
  assert.equal(recovered.view.status.isError, false, 'later success clears the visible error without reload');

  const terminal = dashboard.apply({ total: 0, processed: 0, remaining: 0, error: 'terminal drain failure' });
  assert.equal(terminal.stopped, true);
  const capped = dashboard.apply({
    total: 1, processed: 1, remaining: 0, kept: 1,
    injectionState: 'failed', injectionRetryCapped: true, injectionError: 'inject exhausted', error: 'inject exhausted',
  });
  assert.equal(capped.stopped, true);
  assert.equal(capped.view.injectVisible.visible, true, 'capped injection exposes the manual retry control');
  const backoff = dashboard.apply({
    total: 1, processed: 1, remaining: 0, kept: 1,
    injectionState: 'backoff', injectionRetryAt: Date.now() + 1000,
    injectionError: 'inject retry', error: 'inject retry',
  });
  assert.equal(backoff.stopped, false, 'automatic backoff keeps polling');
});

test('dashboard status poll survives network and JSON failures, bounds backoff, and resumes without reload', async () => {
  const dashboard = dashboardPollHarness([
    { networkError: 'socket reset' },
    { jsonError: 'truncated JSON' },
    { body: { ok: true, status: { stop: false } } },
    { body: { ok: true, status: { stop: true } } },
  ]);

  await dashboard.poll();
  let state = dashboard.state();
  assert.equal(state.draining, '1');
  assert.deepEqual(state.scheduled, [1200]);
  assert.equal(state.failures, 1);

  await dashboard.runNext();
  state = dashboard.state();
  assert.equal(state.draining, '1');
  assert.deepEqual(state.scheduled, [2400]);
  assert.equal(state.failures, 2);

  await dashboard.runNext();
  state = dashboard.state();
  assert.equal(state.failures, 0, 'a successful status response resets transient backoff');
  assert.deepEqual(state.scheduled, [1200]);

  await dashboard.runNext();
  state = dashboard.state();
  assert.deepEqual(state.scheduled, [], 'a terminal status stops only after a successful response');
  assert.ok(state.visible.some((item) => /socket reset|truncated JSON/.test(item.message || '')));
});

test('real injector honors ORCH_PORT and shared bearer auth when ORCH_DAEMON is absent', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-inject-transport-'));
  const outDir = defaultOnboardOutDir(repo);
  const token = 'custom-port-injection-token';
  const requests = [];
  const notes = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: raw });
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'GET' && req.url.startsWith('/state')) res.end(JSON.stringify({ tasks: notes.map((note) => ({ ...note })) }));
      else if (req.method === 'POST' && req.url === '/overlay/note') {
        const body = JSON.parse(raw);
        notes.push({ id: `note:transport-${notes.length + 1}`, label: body.title, summary: body.summary });
        res.end(JSON.stringify({ key: notes[notes.length - 1].id }));
      }
      else res.end('{}');
    });
  });
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const generation = 'generation-transport';
    const kept = [{ title: 'Transport', summary: 'Uses configured daemon', kind: 'decision' }];
    writeQueue(outDir, 1, 1, kept, generation);
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ kept, rejected: [] }));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const env = { ...process.env, ORCH_PORT: String(port), ORCH_TOKEN: token };
    delete env.ORCH_DAEMON;
    const result = await runNode([
      path.join(__dirname, '..', 'scripts', 'onboard-learn.js'),
      '--repo', repo, '--in', outDir, '--inject', '--confirm', '--generation', generation,
    ], env);

    assert.equal(result.code, 0, result.stderr);
    const duplicate = await runNode([
      path.join(__dirname, '..', 'scripts', 'onboard-learn.js'),
      '--repo', repo, '--in', outDir, '--inject', '--confirm', '--generation', generation,
    ], env);
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.ok(requests.some((request) => request.url.startsWith('/state')));
    assert.equal(requests.filter((request) => request.url === '/overlay/note').length, 1,
      'a retry confirms the durable duplicate without creating a second note');

    const replacementGeneration = 'generation-transport-replacement';
    const replacementKept = [{ title: 'Transport', summary: 'Uses the replacement endpoint', kind: 'decision' }];
    writeQueue(outDir, 1, 1, replacementKept, replacementGeneration);
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ kept: replacementKept, rejected: [] }));
    const replacement = await runNode([
      path.join(__dirname, '..', 'scripts', 'onboard-learn.js'),
      '--repo', repo, '--in', outDir, '--inject', '--confirm', '--generation', replacementGeneration,
    ], env);
    assert.equal(replacement.code, 0, replacement.stderr);
    const noteRequests = requests.filter((request) => request.url === '/overlay/note');
    assert.equal(noteRequests.length, 2, 'same title with changed content creates a current-generation note');
    assert.equal(JSON.parse(noteRequests[1].body).supersedes, 'note:transport-1');
    assert.ok(requests.every((request) => request.authorization === `Bearer ${token}`));
    const receipt = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-injection-receipt.json'), 'utf8'));
    assert.equal(receipt.generation, replacementGeneration);
    assert.equal(receipt.confirmed.length, 1);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('manual injection retry resets a capped hold and wakes the learner without a reload', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-manual-retry-'));
  const outDir = defaultOnboardOutDir(repo);
  const sent = [];
  let notifyCount = 0;
  try {
    const generation = 'generation-retry';
    writeQueue(outDir, 1, 1, [{ title: 'Retry', summary: 'Retry' }], generation);
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ kept: [{ title: 'Retry' }], rejected: [] }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo,
      outDir,
      autoInject: true,
      injected: false,
      injectedKept: 0,
      injectionGeneration: generation,
      injectionState: 'failed',
      injectionAttempts: 3,
      injectionRetryCapped: true,
      injectionError: 'inject exited 1',
      error: 'inject exited 1',
    }));
    const route = onboardRoute(makeCtx({ repo, outDir }, sent, () => { notifyCount++; }));
    await route('/onboard/retry-inject', 'POST', {}, {}, new URL('http://localhost/onboard/retry-inject'));
    assert.equal(sent[0].status, 200);
    assert.equal(sent[0].payload.status.injectionState, 'pending');
    assert.equal(sent[0].payload.status.injectionAttempts, 0);
    assert.equal(sent[0].payload.status.injectionRetryAt, null);
    assert.equal(sent[0].payload.status.injectionRetryCapped, false);
    assert.equal(sent[0].payload.status.error, null);
    assert.equal(notifyCount, 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('explicit autoInject false completes a drained queue without claiming injection', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-no-auto-inject-'));
  const outDir = defaultOnboardOutDir(repo);
  const sent = [];
  try {
    writeQueue(outDir, 1, 1, [{ title: 'Review', summary: 'Review' }], 'generation-manual');
    const route = onboardRoute(makeCtx({ repo, outDir, autoInject: false }, sent, () => {}));
    await route('/onboard/drain-queue', 'POST', {}, {}, new URL('http://localhost/onboard/drain-queue'));
    const status = sent[0].payload.status;
    assert.equal(status.autoInject, false);
    assert.equal(status.done, true);
    assert.equal(status.injected, false);
    assert.equal(status.needsReview, true);
    assert.equal(dashboardStatusComplete(status), true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('explicit no-candidates queue remains a successful terminal onboarding state', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-no-candidates-'));
  const outDir = defaultOnboardOutDir(repo);
  const sent = [];
  try {
    writeQueue(outDir, 0, 0, [], 'generation-empty');
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo,
      outDir,
      autoInject: true,
      preparationState: 'ready',
      injectionGeneration: 'generation-empty',
      injectionState: 'not_needed',
      injectedKept: 0,
    }));
    const route = onboardRoute(makeCtx({}, sent, () => {}, [repo]));
    const url = new URL(`http://localhost/onboard/drain-queue?repo=${encodeURIComponent(repo)}&outDir=${encodeURIComponent(outDir)}`);
    await route('/onboard/drain-queue', 'GET', {}, {}, url);
    const status = sent[0].payload.status;
    assert.equal(status.noCandidates, true);
    assert.equal(status.done, true);
    assert.equal(status.injectedKept, 0);
    assert.equal(dashboardStatusComplete(status), true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('drained zero-kept queues persist the same not-needed terminal state the dashboard completes', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-zero-kept-terminal-'));
  const outDir = defaultOnboardOutDir(repo);
  const sent = [];
  try {
    writeQueue(outDir, 3, 3, [], 'generation-zero-kept');
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo,
      outDir,
      autoInject: true,
      preparationState: 'ready',
      injectionGeneration: 'generation-zero-kept',
      injectionState: 'failed',
      injectionError: 'arbitrary injector failure',
      error: 'arbitrary injector failure',
      injectedKept: 0,
    }));
    const route = onboardRoute(makeCtx({}, sent, () => {}, [repo]));
    const url = new URL(`http://localhost/onboard/drain-queue?repo=${encodeURIComponent(repo)}&outDir=${encodeURIComponent(outDir)}`);
    await route('/onboard/drain-queue', 'GET', {}, {}, url);
    const status = sent[0].payload.status;
    const persisted = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.noNotesToInject, true);
    assert.equal(status.injectionState, 'not_needed');
    assert.equal(status.done, true);
    assert.equal(status.error, null);
    assert.equal(persisted.injectionState, 'not_needed');
    assert.equal(persisted.injectionGeneration, 'generation-zero-kept');
    assert.equal(dashboardStatusComplete(status), true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('POST /onboard/enqueue reuses completed route queue instead of overwriting it', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-enqueue-'));
  const outDir = path.join(tmpDir, 'bench', 'onboard', path.basename(tmpDir));
  const repo = tmpDir;
  const sent = [];

  try {
    writeQueue(outDir, 4, 4, [{ title: 'Already learned', summary: 'Keep this queue', kind: 'decision' }]);
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({ repo, outDir, autoInject: true }));
    const before = fs.readFileSync(path.join(outDir, 'onboard-queue.json'), 'utf8');
    const route = onboardRoute(makeCtx({ repo, outDir }, sent, () => {}));
    const handled = await route('/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue'));

    assert.equal(handled, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].status, 200);
    assert.equal(sent[0].payload.ok, true);
    assert.equal(sent[0].payload.total, 4);
    assert.equal(sent[0].payload.remaining, 0);
    assert.equal(sent[0].payload.outDir, outDir);
    assert.equal(sent[0].payload.reused, true);
    assert.equal(sent[0].payload.completed, true);
    assert.equal(fs.readFileSync(path.join(outDir, 'onboard-queue.json'), 'utf8'), before);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('POST /onboard/enqueue resumes a valid partial queue without overwriting progress or project work', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-resume-'));
  const repo = tmpDir;
  const outDir = defaultOnboardOutDir(repo);
  const source = path.join(repo, 'src', 'worked-on.js');
  const sourceBody = 'exports.alreadyBuilt = true;\n';
  const sent = [];

  try {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, sourceBody);
    writeQueue(outDir, 9, 4, [{ title: 'Kept already', summary: 'Do not discard', kind: 'decision' }]);
    const before = fs.readFileSync(path.join(outDir, 'onboard-queue.json'), 'utf8');

    const route = onboardRoute(makeCtx({ repo }, sent, () => {}));
    const handled = await route('/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue'));

    assert.equal(handled, true);
    assert.equal(sent[0].status, 200);
    assert.equal(sent[0].payload.ok, true);
    assert.equal(sent[0].payload.reused, true);
    assert.equal(sent[0].payload.completed, false);
    assert.equal(sent[0].payload.remaining, 5);
    assert.equal(fs.readFileSync(path.join(outDir, 'onboard-queue.json'), 'utf8'), before);
    assert.equal(fs.readFileSync(source, 'utf8'), sourceBody);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('POST /onboard/enqueue defaults to ignored .zonoid onboarding outDir', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-default-'));
  const repo = tmpDir;
  const outDir = defaultOnboardOutDir(repo);
  const sent = [];

  try {
    writeQueue(outDir, 3, 3, [{ title: 'Already learned', summary: 'Keep this queue', kind: 'decision' }]);
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({ repo, outDir, autoInject: true }));
    const before = fs.readFileSync(path.join(outDir, 'onboard-queue.json'), 'utf8');
    const route = onboardRoute(makeCtx({ repo }, sent, () => {}));
    const handled = await route('/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue'));

    assert.equal(handled, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].status, 200);
    assert.equal(sent[0].payload.ok, true);
    assert.equal(sent[0].payload.outDir, outDir);
    assert.equal(sent[0].payload.reused, true);
    assert.match(outDir, /[/\\]\.zonoid[/\\]onboard[/\\]/);
    assert.equal(fs.readFileSync(path.join(outDir, 'onboard-queue.json'), 'utf8'), before);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('POST /onboard/enqueue persists preparation before returning and duplicate requests reuse it', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-prepare-'));
  const outDir = defaultOnboardOutDir(repo);
  const sent = [];
  let notifyCount = 0;

  try {
    const route = onboardRoute(makeCtx({ repo }, sent, () => { notifyCount++; }));
    const startedAt = Date.now();
    await route('/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue'));
    assert.ok(Date.now() - startedAt < 1000, 'enqueue should persist intent, not wait for miners');
    assert.equal(sent[0].status, 200);
    assert.equal(sent[0].payload.queued, true);
    assert.equal(sent[0].payload.preparationState, 'pending');
    assert.equal(fs.existsSync(path.join(outDir, 'onboard-queue.json')), false);

    const before = fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8');
    const firstMeta = JSON.parse(before);
    assert.equal(firstMeta.repo, repo);
    assert.equal(firstMeta.preparationState, 'pending');
    assert.ok(firstMeta.preparationRequestedAt);

    await route('/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue'));
    assert.equal(sent[1].status, 200);
    assert.equal(sent[1].payload.reused, true);
    assert.equal(sent[1].payload.preparing, true);
    assert.equal(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'), before,
      'duplicate enqueue must not restart or rewrite an in-flight persisted request');
    assert.equal(notifyCount, 1, 'only the first enqueue needs to wake the headless runner');

    const drain = onboardRoute(makeCtx({ repo, outDir, autoInject: true }, sent, () => { notifyCount++; }));
    await drain('/onboard/drain-queue', 'POST', {}, {}, new URL('http://localhost/onboard/drain-queue'));
    assert.equal(sent[2].status, 200);
    assert.equal(sent[2].payload.status.preparing, true);
    assert.equal(sent[2].payload.status.preparationState, 'pending');

    delete global.__drainJobs;
    const statusRoute = onboardRoute(makeCtx({}, sent, () => {}, [repo]));
    const statusUrl = new URL(`http://localhost/onboard/drain-queue?repo=${encodeURIComponent(repo)}&outDir=${encodeURIComponent(outDir)}`);
    await statusRoute('/onboard/drain-queue', 'GET', {}, {}, statusUrl);
    assert.equal(sent[3].status, 200, 'persisted preparation must survive in-memory job loss');
    assert.equal(sent[3].payload.status.preparationState, 'pending');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('failed preparation remains visible until enqueue explicitly rearms it', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-prepare-failed-'));
  const outDir = defaultOnboardOutDir(repo);
  const sent = [];
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo,
      outDir,
      preparationState: 'failed',
      preparationAttempts: 1,
      error: 'onboarding preparation (onboard-mine-git.js) exited 7',
    }));

    const drain = onboardRoute(makeCtx({ repo, outDir, autoInject: true }, sent, () => {}));
    await drain('/onboard/drain-queue', 'POST', {}, {}, new URL('http://localhost/onboard/drain-queue'));
    assert.equal(sent[0].status, 200);
    assert.match(sent[0].payload.status.error, /exited 7/);
    assert.equal(sent[0].payload.status.done, true);
    assert.equal(sent[0].payload.status.preparationState, 'failed');

    const enqueue = onboardRoute(makeCtx({ repo }, sent, () => {}));
    await enqueue('/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue'));
    assert.equal(sent[1].status, 200);
    assert.equal(sent[1].payload.preparationState, 'pending');
    const rearmed = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(rearmed.preparationState, 'pending');
    assert.equal(rearmed.error, null);
    assert.equal(rearmed.preparationAttempts, 1, 'retry count advances only when a worker actually starts');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('explicit preparation rearm replaces a failed force generation instead of reusing its old queue', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-route-prepare-rearm-'));
  const outDir = defaultOnboardOutDir(repo);
  const sent = [];
  try {
    writeQueue(outDir, 1, 1, [{ title: 'Old' }], 'generation-old');
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo,
      outDir,
      preparationGeneration: 'generation-failed',
      preparationState: 'failed',
      preparationForce: true,
      preparationAttempts: 1,
      error: 'project evidence miner failed',
    }));
    const route = onboardRoute(makeCtx({ repo, outDir, rearm: true }, sent, () => {}, [repo]));
    await route('/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue'));
    assert.equal(sent[0].status, 200);
    assert.equal(sent[0].payload.queued, true);
    assert.notEqual(sent[0].payload.reused, true);
    const status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.preparationState, 'pending');
    assert.equal(status.preparationForce, true);
    assert.notEqual(status.preparationGeneration, 'generation-failed');
    assert.equal(status.error, null);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
