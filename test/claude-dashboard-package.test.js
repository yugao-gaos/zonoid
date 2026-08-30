#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { PACKAGE_FILES, build, readPackageFile, validateSource } = require('../packages/claude-dashboard-mcpb/build');

const packageDir = path.join(__dirname, '..', 'packages', 'claude-dashboard-mcpb');

function storedZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    assert.equal(method, 0, 'builder uses deterministic stored entries');
    const nameStart = offset + 30;
    const bodyStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    entries.set(name, buffer.subarray(bodyStart, bodyStart + size));
    offset = bodyStart + size;
  }
  return entries;
}

test('Claude dashboard manifest uses MCPB 0.3 and configured checkout launcher', () => {
  const manifest = validateSource(packageDir);
  assert.equal(manifest.manifest_version, '0.3');
  assert.equal(manifest.server.type, 'node');
  assert.equal(manifest.server.entry_point, 'server/index.js');
  assert.deepEqual(manifest.server.mcp_config.args, ['${__dirname}/server/index.js']);
  assert.equal(manifest.server.mcp_config.env.ZONOID_INSTALL_DIR, '${user_config.zonoid_install_dir}');
  assert.equal(manifest.server.mcp_config.env.ORCH_CLIENT, 'claude');
  assert.equal(manifest.user_config.zonoid_install_dir.type, 'directory');
  assert.equal(manifest.user_config.zonoid_install_dir.required, true);
  assert.ok(manifest.tools.some((item) => item.name === 'show_dashboard'));
});

test('MCPB builder is deterministic and checked archive matches its sources', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-mcpb-'));
  try {
    const first = path.join(temp, 'first.mcpb');
    const second = path.join(temp, 'second.mcpb');
    build({ root: packageDir, output: first });
    build({ root: packageDir, output: second });
    const a = fs.readFileSync(first);
    const b = fs.readFileSync(second);
    const checked = fs.readFileSync(path.join(packageDir, 'zonoid-dashboard.mcpb'));
    assert.equal(crypto.createHash('sha256').update(a).digest('hex'), crypto.createHash('sha256').update(b).digest('hex'));
    assert.deepEqual(checked, a);

    const entries = storedZipEntries(a);
    assert.deepEqual([...entries.keys()].sort(), PACKAGE_FILES.slice().sort());
    // Compare against the canonical (LF) source form, not the raw checkout bytes: a Windows
    // checkout materialises these text sources with CRLF, and the archive stores the committed
    // content. Still an exact byte comparison — just against the same bytes the builder packs.
    for (const name of PACKAGE_FILES) {
      assert.deepEqual(entries.get(name), readPackageFile(packageDir, name));
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('bundled launcher fails clearly when the configured checkout is absent', () => {
  const result = spawnSync(process.execPath, [path.join(packageDir, 'server', 'index.js')], {
    env: { ...process.env, ZONOID_INSTALL_DIR: path.join(packageDir, 'missing') },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires ZONOID_INSTALL_DIR/);
});

test('bundled launcher proxies stdio to a configured Zonoid MCP server', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-mcpb-checkout-'));
  try {
    fs.writeFileSync(path.join(temp, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(temp, 'daemon.js'), '// fixture\n');
    fs.writeFileSync(path.join(temp, 'mcp-graph.js'), [
      "'use strict';",
      "process.stdin.on('data', (chunk) => process.stdout.write(`${process.env.ORCH_CLIENT}:${chunk}`));",
      "process.stdin.on('end', () => process.exit(0));",
      '',
    ].join('\n'));
    const result = spawnSync(process.execPath, [path.join(packageDir, 'server', 'index.js')], {
      env: { ...process.env, ZONOID_INSTALL_DIR: temp },
      input: 'ping',
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'claude:ping');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
