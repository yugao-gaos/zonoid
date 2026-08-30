'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const learner = require('../scripts/onboard-learn');

function tempFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-learn-api-test-'));
  const repo = path.join(root, 'repo');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(repo);
  fs.mkdirSync(outDir);
  return { root, repo, outDir, outFile: path.join(outDir, 'batch.json') };
}

function apiDeps(provider, config = {}) {
  return {
    overlayStore: { load: () => ({}) },
    backendLib: {
      getActiveBackend: () => ({
        provider,
        providerId: provider.id,
        model: 'selected-model',
        config: { provider: provider.id, model: 'selected-model', key: 'selected-key', ...config },
      }),
    },
  };
}

function candidates() {
  return [
    { title: 'First', summary: 'first summary', kind: 'gotcha', source: 'missing-a.js:1' },
    { title: 'Second', summary: 'second summary', kind: 'decision', source: 'missing-b.js:2' },
  ];
}

async function captureErrors(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { value: await fn(), text: lines.join('\n') };
  } finally {
    console.error = original;
  }
}

test('API learner uses selected provider model/key and atomically writes a complete JSON classification', async (t) => {
  const fixture = tempFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let request;
  const provider = {
    id: 'test-api',
    displayName: 'Test API',
    kind: 'api',
    async callApi(args) {
      request = args;
      return {
        text: JSON.stringify({
          kept: [{ title: 'First', summary: 'why', evidence: 'a.js:1', kind: 'gotcha', source: '0' }],
          rejected: [{ candidate: 'Second', reason: 'unverifiable' }],
        }),
      };
    },
  };

  const status = await learner.runLearner(
    fixture.repo, candidates(), fixture.outFile, null, 20, 4321, apiDeps(provider),
  );

  assert.equal(status, 0);
  assert.equal(request.model, 'selected-model');
  assert.equal(request.key, 'selected-key');
  assert.equal(request.timeoutMs, 4321);
  assert.deepEqual(request.responseFormat, { type: 'json_object' });
  assert.ok(request.maxTokens >= 2048);
  assert.match(request.messages[1].content, /return a JSON object directly in your response/);
  assert.doesNotMatch(request.messages[1].content, /write a JSON file to/);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.outFile, 'utf8')), {
    kept: [{ title: 'First', summary: 'why', evidence: 'a.js:1', kind: 'gotcha', source: '0' }],
    rejected: [{ candidate: 'Second', reason: 'unverifiable' }],
  });
  assert.deepEqual(fs.readdirSync(fixture.outDir), ['batch.json']);
});

test('invalid or incomplete API JSON fails without publishing over the output', async (t) => {
  const fixture = tempFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(fixture.outFile, '{"sentinel":true}\n');
  const before = fs.readFileSync(fixture.outFile);
  const provider = {
    id: 'test-api',
    kind: 'api',
    callApi: async () => ({ text: '{"kept":[],"rejected":[]}' }),
  };

  const run = await captureErrors(() => learner.runLearner(
    fixture.repo, candidates(), fixture.outFile, null, 20, 4321, apiDeps(provider),
  ));

  assert.equal(run.value, 1);
  assert.match(run.text, /classified 0\/2 candidates/);
  assert.deepEqual(fs.readFileSync(fixture.outFile), before);
  assert.deepEqual(fs.readdirSync(fixture.outDir), ['batch.json']);
});

test('malformed API JSON returns a parse error without creating output', async (t) => {
  const fixture = tempFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const provider = {
    id: 'test-api',
    kind: 'api',
    callApi: async () => ({ text: 'not-json' }),
  };

  const run = await captureErrors(() => learner.runLearner(
    fixture.repo, candidates(), fixture.outFile, null, 20, 4321, apiDeps(provider),
  ));

  assert.equal(run.value, 1);
  assert.match(run.text, /learner API returned invalid JSON/);
  assert.equal(fs.existsSync(fixture.outFile), false);
});

test('API auth/credit failures are actionable and a failed batch reservation remains recoverable', async (t) => {
  const fixture = tempFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const qf = path.join(fixture.outDir, 'onboard-queue.json');
  fs.writeFileSync(qf, JSON.stringify({
    generation: 'api-failure-generation',
    total: 2,
    cursor: 0,
    kept: [],
    rejected: [],
    pending: candidates(),
  }, null, 2));
  const reservation = learner.reserveQueueBatch(qf, 2, Infinity, Date.now(), 10000);
  const provider = {
    id: 'test-api',
    kind: 'api',
    callApi: async () => { throw new Error('OpenRouter API returned HTTP 402: insufficient credits'); },
  };

  const run = await captureErrors(() => learner.runLearner(
    fixture.repo, reservation.batch, fixture.outFile, null, 20, 4321, apiDeps(provider),
  ));
  const released = learner.failQueueBatch(qf, reservation);
  const queue = JSON.parse(fs.readFileSync(qf, 'utf8'));

  assert.equal(run.value, 1);
  assert.match(run.text, /provider=test-api/);
  assert.match(run.text, /HTTP 402: insufficient credits/);
  assert.equal(fs.existsSync(fixture.outFile), false);
  assert.equal(released.stale, false);
  assert.equal(queue.cursor, 0);
  assert.deepEqual(queue.inflight, {});
  assert.deepEqual(queue.completed, {});
});

test('API timeout maps to the learner timeout exit and does not publish output', async (t) => {
  const fixture = tempFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const provider = {
    id: 'test-api',
    kind: 'api',
    callApi: async () => { throw new Error('Test API request timed out'); },
  };

  const run = await captureErrors(() => learner.runLearner(
    fixture.repo, candidates(), fixture.outFile, null, 20, 4321, apiDeps(provider),
  ));

  assert.equal(run.value, learner.EXIT_TIMEOUT);
  assert.match(run.text, /request timed out/);
  assert.equal(fs.existsSync(fixture.outFile), false);
});
