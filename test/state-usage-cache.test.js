#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-state-usage-cache-'));
process.env.CLAUDE_PLUGIN_DATA = path.join(root, 'runtime');

const usageAccounting = require('../lib/usage-accounting');
const daemon = require('../daemon');
const transcript = path.join(root, 'rollout-test.jsonl');
const usageLine = (input, output) => JSON.stringify({
  message: { usage: { input_tokens: input, output_tokens: output } },
});

fs.writeFileSync(transcript, usageLine(2, 3) + '\n');

const realParse = usageAccounting.parseTranscriptUsage;
const realNow = Date.now;
let nowMs = realNow();
let parses = 0;
usageAccounting.parseTranscriptUsage = (...args) => {
  parses++;
  return realParse(...args);
};
Date.now = () => nowMs;

try {
  daemon.__clearUsageCacheForTest();
  assert.equal(daemon.__usageCachedForTest(transcript).total, 5);

  nowMs += 60_000;
  assert.equal(daemon.__usageCachedForTest(transcript).total, 5);
  assert.equal(parses, 1, 'elapsed time alone must not rescan an unchanged historical transcript');

  fs.appendFileSync(transcript, usageLine(7, 11) + '\n');
  assert.equal(daemon.__usageCachedForTest(transcript).total, 23);
  assert.equal(parses, 2, 'an appended transcript must invalidate immediately and refresh token totals');

  console.log('PASS  state transcript usage cache is source-fresh, not time-expiring');
} finally {
  Date.now = realNow;
  usageAccounting.parseTranscriptUsage = realParse;
  daemon.__clearUsageCacheForTest();
  fs.rmSync(root, { recursive: true, force: true });
}

process.exit(0);
