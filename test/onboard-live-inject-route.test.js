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
