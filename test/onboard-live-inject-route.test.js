#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const onboardRoute = require('../routes/onboard');
const { defaultOnboardOutDir } = require('../lib/onboard-paths');

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
    const route = onboardRoute(makeCtx({}, sent, () => {}));

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
    const route = onboardRoute(makeCtx({}, sent, () => {}));
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
    await onboardRoute(makeCtx({}, sent, () => {}))('/onboard/drain-queue', 'GET', {}, {}, url);
    const status = sent[1].payload.status;
    assert.equal(status.preparing, true);
    assert.equal(status.injected, false);
    assert.equal(status.done, false);
    assert.equal(dashboardStatusComplete(status), false);
  } finally {
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
    const route = onboardRoute(makeCtx({}, sent, () => {}));
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
