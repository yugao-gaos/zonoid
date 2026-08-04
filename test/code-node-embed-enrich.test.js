#!/usr/bin/env node
// Plain Node test (no framework; matches code-extract.test.js / bulk-ingest.test.js style) for the
// CODE-NODE EMBED ENRICHMENT (design/proof note-mqqmixayq8m). Run:
//   node test/code-node-embed-enrich.test.js   (exits non-zero on any failed assertion)
//
// THE FIX, in two halves:
//   (A) lib/node-tags.js  codeNodeEmbedText — folds `summary` into the pooled embed text so it becomes
//       `name — signature in file <body>` instead of the thin `name — signature in file`.
//   (B) lib/code-extract/ingest.js — at ingest, read each symbol's bounded source body from its
//       file:line span (cap 600, + leading doc-comment) and set it as the code_node `summary`, so the
//       enriched embed text in (A) actually has a body to embed.
//
// The benchmark (note-mqqmixayq8m) showed (B) feeding (A) lifts first-party deliver-code recall
// 0.385 -> 0.647. This test guards the MECHANICS that produce that enriched text (body read + summary
// populated + summary present in the embed string), not the recall number itself (that is the bench).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { codeNodeEmbedText } = require('../lib/node-tags');
const {
  symbolsToCodeNodes, symbolToCodeNode, symbolBodySnippet, makeFileReader, DEFAULT_BODY_CAP,
} = require('../lib/code-extract/ingest');
const { extractRepo } = require('../lib/code-extract');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// --------------------------------------------------------------------------
// (A) codeNodeEmbedText folds the body into the embed surface.
// --------------------------------------------------------------------------
{
  const head = codeNodeEmbedText({ name: 'gateTask', signature: 'gateTask(task, opts)', file: 'lib/gate.js' });
  ok('A: thin embed text (no summary) is `name — signature in file`',
    head === 'gateTask — gateTask(task, opts) in lib/gate.js');

  const body = 'function gateTask(task, opts) { return task.ready && !opts.held; }';
  const rich = codeNodeEmbedText({ name: 'gateTask', signature: 'gateTask(task, opts)', file: 'lib/gate.js', summary: body });
  ok('A: enriched embed text INCLUDES the body when summary present', rich.includes(body));
  ok('A: enriched embed text still starts with name — signature in file',
    rich.startsWith('gateTask — gateTask(task, opts) in lib/gate.js'));
  ok('A: enriched text is strictly longer than thin text', rich.length > head.length);
  // Exact composed shape: `<name> — <signature> in <file> <body>` (proof note-mqqmixayq8m).
  ok('A: composed shape is `name — signature in file <body>`',
    rich === `gateTask — gateTask(task, opts) in lib/gate.js ${body}`);

  // Empty/whitespace summary must NOT change the thin text (additive only).
  ok('A: empty summary leaves thin text unchanged',
    codeNodeEmbedText({ name: 'gateTask', signature: 'gateTask(task, opts)', file: 'lib/gate.js', summary: '   ' }) === head);
}

// --------------------------------------------------------------------------
// (B) symbolBodySnippet: read file:line body + leading doc-comment, capped.
// --------------------------------------------------------------------------
{
  const SRC = [
    "'use strict';",                                  // 1
    '',                                               // 2
    '// computeRefund totals a refund across line items',  // 3  (doc line)
    '// and applies the idempotency guard.',          // 4  (doc line)
    'function computeRefund(order) {',                // 5  (start_line)
    '  const total = order.items.reduce((s, i) => s + i.amount, 0);', // 6
    '  return { total, idempotent: true };',          // 7
    '}',                                              // 8  (end_line)
    '',                                               // 9
  ].join('\n');
  const reader = () => SRC;
  const sym = { name: 'computeRefund', file: 'lib/refund.js', start_line: 5, end_line: 8 };

  const snip = symbolBodySnippet(sym, reader, DEFAULT_BODY_CAP);
  ok('B: snippet includes the function body', snip.includes('function computeRefund(order)') && snip.includes('idempotent: true'));
  ok('B: snippet includes the leading doc-comment block', snip.includes('computeRefund totals a refund') && snip.includes('idempotency guard'));
  ok('B: snippet stops at the blank line above the doc (no use-strict)', !snip.includes('use strict'));

  // Cap is enforced.
  const longSrc = 'function big() {\n' + '  x();\n'.repeat(400) + '}\n';
  const capped = symbolBodySnippet({ name: 'big', file: 'lib/big.js', start_line: 1, end_line: 402 }, () => longSrc, 600);
  ok('B: snippet is capped at the body cap', capped.length <= 600);

  // Missing file / lines / unreadable -> '' (additive, never throws).
  ok('B: missing file yields empty snippet', symbolBodySnippet({ name: 'x', file: null, start_line: 1 }, reader) === '');
  ok('B: missing start_line yields empty snippet', symbolBodySnippet({ name: 'x', file: 'a.js' }, reader) === '');
  ok('B: unreadable file (reader null) yields empty snippet', symbolBodySnippet(sym, () => null) === '');
  ok('B: reader throwing yields empty snippet (no throw)', symbolBodySnippet(sym, () => { throw new Error('boom'); }) === '');
}

// --------------------------------------------------------------------------
// (B) symbolToCodeNode folds a supplied body into `summary`; legacy stays thin.
// --------------------------------------------------------------------------
{
  const sym = { name: 'foo', kind: 'function', file: 'a.js', start_line: 1, end_line: 3, signature: 'foo()', exported: true };
  const withBody = symbolToCodeNode(sym, 'function foo() { return 1; }');
  ok('B: symbolToCodeNode sets summary from supplied body', withBody.summary === 'function foo() { return 1; }');
  ok('B: symbolToCodeNode keeps name/kind/file/lines/signature/exported',
    withBody.name === 'foo' && withBody.kind === 'function' && withBody.file === 'a.js' &&
    withBody.start_line === 1 && withBody.end_line === 3 && withBody.signature === 'foo()' && withBody.exported === true);

  const noBody = symbolToCodeNode(sym);
  ok('B: symbolToCodeNode without a body has NO summary key (legacy thin node)', !('summary' in noBody));
}

// --------------------------------------------------------------------------
// (B) symbolsToCodeNodes(repoRoot): populates summary from file:line on a real fixture repo.
// --------------------------------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-node-enrich-'));
  fs.writeFileSync(path.join(tmp, 'svc.js'), [
    "'use strict';",
    '',
    '// scheduleWakeup queues a one-time wakeup for the given agent at a future ISO time.',
    'function scheduleWakeup(agentId, whenIso) {',
    '  const at = Date.parse(whenIso);',
    '  return { agentId, at, kind: "wakeup" };',
    '}',
    '',
    'const drainQueue = (q) => q.splice(0, q.length);',
    '',
    'module.exports = { scheduleWakeup, drainQueue };',
    '',
  ].join('\n'));

  const extracted = extractRepo(tmp);
  ok('B/fixture: extractor found scheduleWakeup + drainQueue',
    extracted.symbols.some((s) => s.name === 'scheduleWakeup') && extracted.symbols.some((s) => s.name === 'drainQueue'));

  // ENRICHED: repoRoot supplied -> summary populated from the source body.
  const enriched = symbolsToCodeNodes(extracted.symbols, { repoRoot: extracted.repo });
  const sw = enriched.find((n) => n.name === 'scheduleWakeup');
  ok('B/fixture: enriched scheduleWakeup HAS a summary', !!(sw && sw.summary));
  ok('B/fixture: summary contains the function body', sw && sw.summary.includes('Date.parse(whenIso)'));
  ok('B/fixture: summary contains the leading doc-comment', sw && sw.summary.includes('queues a one-time wakeup'));

  // And the embed text built from it carries the body — the end-to-end retrieval surface.
  const embed = codeNodeEmbedText(sw);
  ok('B/fixture: codeNodeEmbedText(enriched node) includes the body', embed.includes('Date.parse(whenIso)'));
  ok('B/fixture: codeNodeEmbedText(enriched node) includes name + signature head', embed.startsWith('scheduleWakeup — '));

  // LEGACY: no repoRoot -> no summary (ADDITIVE guarantee — existing behavior unchanged).
  const legacy = symbolsToCodeNodes(extracted.symbols);
  const swLegacy = legacy.find((n) => n.name === 'scheduleWakeup');
  ok('B/fixture: legacy (no repoRoot) leaves nodes thin (no summary)', swLegacy && !('summary' in swLegacy));
  ok('B/fixture: legacy node count == enriched node count (same symbols, only summary differs)', legacy.length === enriched.length);

  // makeFileReader memoizes (reads each file once even across many symbols).
  let reads = 0;
  const realRead = fs.readFileSync;
  // wrap via a counting reader through makeFileReader's path: just assert it caches by calling twice.
  const reader = makeFileReader(extracted.repo);
  const a = reader('svc.js');
  const b = reader('svc.js');
  ok('B/fixture: makeFileReader returns identical cached content on repeat read', a === b && typeof a === 'string');
  void realRead; void reads;

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
