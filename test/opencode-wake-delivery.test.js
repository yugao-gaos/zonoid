#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createWakeDelivery } = require('../packages/opencode-plugin/lib/wake-delivery');

// Drive the substrate's fire-path resolution into an isolated temp dir.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-delivery-'));
process.env.ORCH_DATA = tmpDir;

const substrate = require('../lib/schedule-wakeup');

function makeClient() {
  const calls = [];
  const client = {
    session: {
      promptAsync: async (opts) => {
        calls.push(opts);
        return { data: { statusCode: 204 } };
      },
    },
  };
  return { client, calls };
}

function appendFire(session, line) {
  const p = substrate.fireFile(session);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, line + '\n');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('armed fire line is re-injected once via client.session.promptAsync', async () => {
  const session = 'sess-once';
  const { client, calls } = makeClient();
  appendFire(session, 'ORCH_SCHEDULED_TASK {"delaySeconds":1,"reason":"x","prompt":"hello-loop"}');

  const delivery = createWakeDelivery({ client, intervalMs: 40 });
  const arm = delivery.arm(session);
  assert.equal(arm.ok, true);

  await wait(150);
  delivery.cancel(session);

  assert.equal(calls.length, 1, `expected 1 delivery, got ${calls.length}`);
  assert.deepEqual(calls[0], {
    path: { id: session },
    body: { parts: [{ type: 'text', text: 'hello-loop' }] },
  });
});

test('re-arm does not re-fire an already-delivered line', async () => {
  const session = 'sess-rearm';
  const { client, calls } = makeClient();
  appendFire(session, 'ORCH_SCHEDULED_TASK {"delaySeconds":1,"reason":"x","prompt":"once-only"}');

  const delivery = createWakeDelivery({ client, intervalMs: 40 });
  delivery.arm(session);
  await wait(120);
  delivery.arm(session); // re-arm: cancel + new watcher
  await wait(120);
  delivery.cancel(session);

  assert.equal(calls.length, 1, `expected exactly 1 delivery across re-arm, got ${calls.length}`);
  assert.equal(calls[0].body.parts[0].text, 'once-only');
});

test('a newly appended line after arm is delivered', async () => {
  const session = 'sess-append';
  const { client, calls } = makeClient();
  const delivery = createWakeDelivery({ client, intervalMs: 40 });
  delivery.arm(session);
  await wait(60);
  appendFire(session, 'ORCH_SCHEDULED_TASK {"delaySeconds":2,"reason":"tick","prompt":"second"}');
  await wait(150);
  delivery.cancel(session);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.parts[0].text, 'second');
});

test('malformed JSON line does not throw and yields no delivery', async () => {
  const session = 'sess-malformed';
  const { client, calls } = makeClient();
  appendFire(session, 'ORCH_SCHEDULED_TASK {not-valid-json');
  appendFire(session, 'ORCH_SCHEDULED_TASK {"delaySeconds":1,"reason":"x","prompt":"good"}');

  const delivery = createWakeDelivery({ client, intervalMs: 40 });
  delivery.arm(session);
  await wait(150);
  delivery.cancel(session);

  assert.equal(calls.length, 1, `expected only the well-formed line to deliver, got ${calls.length}`);
  assert.equal(calls[0].body.parts[0].text, 'good');
});

test('arm without a client reports an error instead of throwing', () => {
  const delivery = createWakeDelivery({});
  const r = delivery.arm('sess-noclient');
  assert.equal(r.ok, false);
  assert.match(r.error, /promptAsync/);
});

test('cancel without prior arm is a no-op', () => {
  const { client } = makeClient();
  const delivery = createWakeDelivery({ client });
  assert.doesNotThrow(() => delivery.cancel('sess-noop'));
});
