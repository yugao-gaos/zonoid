#!/usr/bin/env node
// Harness-scoped MCP tool list (P7-G1): default surface unchanged; codex adds create_task.
// Run: node test/mcp-harness-tools.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { TOOLS, handleRpc, makeCall, formatToolsList } = require('../lib/mcp-core');
const { extraToolsForHarness } = require('../lib/mcp-harness-tools');
const filedrop = require('../lib/filedrop-tasks');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mcp-harness-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mcp-harness-ws-')));
const PORT = 19720 + Math.floor(Math.random() * 100);

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForPing(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await req('GET', '/ping'); if (r.status === 200) return true; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

(async () => {
  const baselinePayload = JSON.stringify(formatToolsList(TOOLS));
  const defaultList = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { call: () => ({}) });
  ok('default tools/list count matches TOOLS.length', defaultList.result.tools.length === TOOLS.length);
  ok('default tools/list byte-identical to formatToolsList(TOOLS)', JSON.stringify(defaultList.result.tools) === baselinePayload);
  ok('default surface has no create_task', !defaultList.result.tools.some((t) => t.name === 'create_task'));

  const codexExtra = extraToolsForHarness('codex', WS);
  ok('codex extraTools is exactly one tool', codexExtra.length === 1 && codexExtra[0].name === 'create_task');
  ok('claude extraTools empty', extraToolsForHarness('claude', WS).length === 0);
  ok('cursor extraTools empty', extraToolsForHarness('cursor', WS).length === 0);

  const codexList = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { call: () => ({}), extraTools: codexExtra });
  ok('codex tools/list adds create_task', codexList.result.tools.length === TOOLS.length + 1);
  ok('codex list still includes get_full_graph', codexList.result.tools.some((t) => t.name === 'get_full_graph'));
  ok('codex default core names unchanged', JSON.stringify(codexList.result.tools.slice(0, TOOLS.length)) === baselinePayload);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });

  try {
    ok('daemon up', await waitForPing());
    await req('POST', '/workspace', { path: WS });
    const call = makeCall(PORT, WS);
    const mint = await handleRpc({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'create_task', arguments: { id: 'mint1', subject: 'codex minted task', agent_id: 'test-codex' } },
    }, { call, extraTools: codexExtra });
    const out = JSON.parse(mint.result.content[0].text);
    ok('create_task returns ok', out.ok === true);
    ok('create_task task_key', out.task_key === 'codex/mint1');
    ok('create_task sync shape', Array.isArray(out.adopted));
    ok('stub file on disk', fs.existsSync(path.join(filedrop.dirFor(WS), 'codex', 'mint1.json')));
    const stub = JSON.parse(fs.readFileSync(path.join(filedrop.dirFor(WS), 'codex', 'mint1.json'), 'utf8'));
    ok('stub created_by harness', stub.created_by && stub.created_by.harness === 'codex');

    const httpList = await req('POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/list' });
    ok('HTTP /mcp has no create_task (default surface)', !httpList.body.result.tools.some((t) => t.name === 'create_task'));
  } finally {
    child.kill();
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
