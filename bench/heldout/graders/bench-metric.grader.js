'use strict';
// HELD-OUT grader for bench-metric (computeRatio). Agent never sees this file.
// Usage: node bench-metric.grader.js <frozen-artifact.js>
// Prints JSON: { ok, cases, pass, total, edgePass, edgeTotal }
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const artifact = process.argv[2];
if (!artifact || !fs.existsSync(artifact)) {
  console.log(JSON.stringify({ ok: false, error: 'artifact missing: ' + artifact, cases: [], pass: 0, total: 0, edgePass: 0, edgeTotal: 0 }));
  process.exit(0);
}

let computeRatio, loadErr = null;
try { ({ computeRatio } = require(path.resolve(artifact))); }
catch (e) { loadErr = e.message; }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-metric-grader-'));
process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

let fileIdx = 0;
function writeTranscript(lines) {
  const p = path.join(tmpDir, `t${fileIdx++}.jsonl`);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function r4(n) { return Math.round((n + Number.EPSILON) * 10000) / 10000; }
function approx(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) < 0.0002;
}
function resultOk(got, want) {
  if (!got || typeof got !== 'object') return false;
  return approx(got.gross, want.gross) && approx(got.net, want.net) && approx(got.output, want.output);
}

const cases = [];
function check(name, edge, onLines, offLines, want) {
  const onPath  = writeTranscript(onLines);
  const offPath = writeTranscript(offLines);
  let got = null, err = null, pass = false;
  if (loadErr) { err = loadErr; }
  else if (typeof computeRatio !== 'function') { err = 'no computeRatio export'; }
  else {
    try { got = computeRatio(onPath, offPath); pass = resultOk(got, want); }
    catch (e) { err = e.message; }
  }
  cases.push({ name, edge, pass, want, got, err });
}

// Example 1 from spec — non-edge, no MCP plumbing
check('spec example 1 — no MCP', false, [
  '{"role":"assistant","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}',
  '{"role":"assistant","usage":{"input_tokens":80,"output_tokens":30,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}',
], [
  '{"role":"assistant","usage":{"input_tokens":200,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}',
], { gross: r4(260/300), net: r4(260/300), output: r4(80/100) });

// Example 2 from spec — edge, with MCP plumbing + large cache_read
check('spec example 2 — MCP plumbing + large cache_read', true, [
  '{"role":"assistant","usage":{"input_tokens":50,"output_tokens":40,"cache_read_input_tokens":2000,"cache_creation_input_tokens":0}}',
  '{"role":"assistant","source":"mcp_tool","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":1800,"cache_creation_input_tokens":0}}',
], [
  '{"role":"assistant","usage":{"input_tokens":200,"output_tokens":80,"cache_read_input_tokens":200,"cache_creation_input_tokens":0}}',
], { gross: r4(3905/480), net: r4(2090/480), output: r4(45/80) });

// Edge: invalid JSON lines skipped silently
check('invalid JSON lines skipped', true, [
  'NOT JSON',
  '{"role":"assistant","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}',
  '{{{{',
], [
  '{"role":"assistant","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}',
], { gross: 1, net: 1, output: 1 });

// Edge: missing usage sub-fields treated as 0
check('missing usage sub-fields default to 0', true, [
  '{"role":"assistant","usage":{"output_tokens":60}}',
], [
  '{"role":"assistant","usage":{"output_tokens":60}}',
], { gross: 1, net: 1, output: 1 });

// Edge: zero denominator returns null
check('zero denominator returns null', true, [
  '{"role":"assistant","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}',
], [
  '{"role":"user","content":"no usage here"}',
], { gross: null, net: null, output: null });

// Non-edge: lines without usage are skipped
check('lines without usage skipped', false, [
  '{"role":"user","content":"hello"}',
  '{"role":"assistant","usage":{"input_tokens":50,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}',
], [
  '{"role":"assistant","usage":{"input_tokens":100,"output_tokens":40,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}',
], { gross: r4(70/140), net: r4(70/140), output: r4(20/40) });

// Edge: cache_creation_input_tokens counted in gross
check('cache_creation_input_tokens counted', true, [
  '{"role":"assistant","usage":{"input_tokens":10,"output_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":500}}',
], [
  '{"role":"assistant","usage":{"input_tokens":10,"output_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}',
], { gross: r4(520/20), net: r4(520/20), output: 1 });

const pass = cases.filter((c) => c.pass).length;
const edge = cases.filter((c) => c.edge);
const edgePass = edge.filter((c) => c.pass).length;
console.log(JSON.stringify({
  ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length,
}));
