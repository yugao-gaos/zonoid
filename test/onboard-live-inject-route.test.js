#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const onboardRoute = require('../routes/onboard');
const { defaultOnboardOutDir } = require('../lib/onboard-paths');

function writeQueue(outDir, total, cursor, kept = []) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
    total,
    cursor,
    kept,
    rejected: [],
    pending: [],
  }));
}

function makeCtx(body, sent, notify) {
  return {
    readBody: async () => body,
    send: (_res, status, payload) => sent.push({ status, payload }),
    notifyChange: notify,
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
    const route = onboardRoute(makeCtx({}, sent, () => {}));
    const url = new URL(`http://localhost/onboard/drain-queue?repo=${encodeURIComponent(repo)}&outDir=${encodeURIComponent(outDir)}`);
    const handled = await route('/onboard/drain-queue', 'GET', {}, {}, url);

    assert.equal(handled, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].status, 200);
    assert.equal(sent[0].payload.status.processed, 4);
    assert.equal(sent[0].payload.status.remaining, 0);
    assert.equal(sent[0].payload.status.done, true);
    assert.equal(sent[0].payload.status.injected, true);
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
    assert.equal(failed.done, true, 'the failed attempt is terminal even though it is not successful');
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
    const statusRoute = onboardRoute(makeCtx({}, sent, () => {}));
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
