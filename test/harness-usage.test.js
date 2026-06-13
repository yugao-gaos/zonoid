#!/usr/bin/env node
// Harness usage-source abstraction: self-reported fallback, adapter contract, costflow split.
// Run: node test/harness-usage.test.js — exits non-zero on any failure.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const usage = require('../lib/harness-usage');
const stub = require('../lib/adapters/stub');
const claude = require('../lib/adapters/claude');
const { splitSessionTokens } = require('../lib/costflow');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

{
  ok('null agent -> null', usage.parseReportedUsage(null) === null);
  ok('empty agent -> null', usage.parseReportedUsage({}) === null);
  const u = usage.parseReportedUsage({ reported_usage: { input_tokens: 100, output_tokens: 50 } });
  ok('reported_usage parsed', u && u.input_tokens === 100 && u.output_tokens === 50);
  ok('source tagged self_reported', u && u.source === 'self_reported');
  ok('legacy usage alias', usage.parseReportedUsage({ usage: { output_tokens: 42 } }).output_tokens === 42);
  ok('zero-only usage -> null', usage.parseReportedUsage({ reported_usage: { input_tokens: 0, output_tokens: 0 } }) === null);
}

{
  const agg = usage.aggregateSelfReported({
    a1: { reported_usage: { input_tokens: 10, output_tokens: 20 }, lastSeen: '2026-06-12T12:00:00Z' },
    a2: { reported_usage: { input_tokens: 5, output_tokens: 15 }, lastSeen: '2026-06-12T13:00:00Z' },
    a3: { lastSeen: '2026-06-12T13:00:00Z' },
  });
  ok('aggregates two agents', agg.agents === 2 && agg.output_tokens === 35);
  ok('since filter excludes old agent', usage.aggregateSelfReported({
    old: { reported_usage: { output_tokens: 999 }, lastSeen: '2026-06-01T00:00:00Z' },
    new: { reported_usage: { output_tokens: 7 }, lastSeen: '2026-06-12T12:00:00Z' },
  }, { since: '2026-06-10' }).output_tokens === 7);
  ok('empty registry -> zeros', usage.aggregateSelfReported(null).output_tokens === 0);
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-usage-'));
  try {
    fs.writeFileSync(path.join(tmp, 'sess1.jsonl'), '{}');
    fs.writeFileSync(path.join(tmp, 'readme.txt'), 'x');
    const listed = usage.listSessionTranscripts(tmp);
    ok('lists jsonl files', listed.length === 1 && listed[0].id === 'sess1');
    ok('missing dir -> []', usage.listSessionTranscripts('/no/such/dir').length === 0);
    ok('null dir -> []', usage.listSessionTranscripts(null).length === 0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

{
  ok('claude source transcripts', claude.transcripts.source === 'transcripts');
  ok('claude projectDir non-null', typeof claude.transcripts.projectDir('/tmp/ws') === 'string');
  ok('claude has listSessionTranscripts', typeof claude.transcripts.listSessionTranscripts === 'function');
  ok('claude has taskUsageFromAgent', typeof claude.transcripts.taskUsageFromAgent === 'function');
}

{
  ok('stub source self_reported', stub.transcripts.source === 'self_reported');
  ok('stub projectDir null', stub.transcripts.projectDir('/ws') === null);
  ok('stub humanInput empty', stub.transcripts.humanInputTokens(null, {}).tokens === 0);
  ok('stub overhead empty', stub.transcripts.harnessOverheadTokens(null, {}).tokens === 0);
  const sr = stub.transcripts.selfReportedUsage({ w: { reported_usage: { output_tokens: 88 } } });
  ok('stub selfReportedUsage sums', sr.output_tokens === 88);
}

{
  const claims = [
    { id: 'local/t1', transcript: '/t/a.jsonl', window: { start: '2026-06-12T10:00:00Z', end: '2026-06-12T10:10:00Z' } },
    { id: 'local/t2', transcript: null, window: { start: '2026-06-12T10:00:00Z', end: '2026-06-12T10:05:00Z' } },
  ];
  const usageFor = (tp, claim) => {
    if (tp) return { total: 1000 };
    if (claim && claim.id === 'local/t2') return { total: 250 };
    return { total: 0 };
  };
  const own = splitSessionTokens(claims, usageFor);
  ok('transcript task gets split share', Math.abs(own.get('local/t1') - 1000) < 1e-6);
  ok('no-transcript task gets self-reported total', own.get('local/t2') === 250);
  ok('no source -> zero', splitSessionTokens([{ id: 'x', transcript: null }], () => ({ total: 0 })).get('x') === 0);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
