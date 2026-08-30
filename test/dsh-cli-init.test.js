#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  parseInitArgs,
  VALID_HARNESSES,
  dshBundleSpec,
  dshManagedBundleDir,
  dshProfileHasBundle,
  installDshProfile,
  materializeDshBundle,
} = require('../packages/cli/bin/zonoid.js');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'packages', 'cli', 'bin', 'zonoid.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-dsh-init-'));

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function simulatedDshPlugin(calls) {
  return (command, args, options) => {
    calls.push({ command, args: [...args], options });
    assert.strictEqual(command, 'dsh');
    assert.deepStrictEqual(args.slice(0, 4), ['plugin', '--profile', 'headless', 'add']);
    const profileDir = path.join(options.env.DSH_HOME, 'profiles', 'headless');
    const manifestPath = path.join(profileDir, 'package.json');
    const manifest = fs.existsSync(manifestPath)
      ? readJson(manifestPath)
      : {
          name: 'dsh-profile-headless',
          private: true,
          dependencies: {},
          dsh: { profile: { extends: ['base', 'headless'], bundles: [] } },
        };
    manifest.dependencies = { ...(manifest.dependencies || {}), '@zonoid/dsh': args[4] };
    manifest.dsh = manifest.dsh || {};
    manifest.dsh.profile = manifest.dsh.profile || {};
    manifest.dsh.profile.bundles = [...new Set([
      ...(manifest.dsh.profile.bundles || []),
      '@zonoid/dsh',
    ])];
    writeJson(manifestPath, manifest);
    fs.writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    return { status: 0, stdout: '', stderr: '' };
  };
}

try {
  assert.strictEqual(parseInitArgs(['node', 'zonoid', 'init', '--harness', 'dsh']).harness, 'dsh');
  assert(VALID_HARNESSES.has('dsh'));
  const usage = spawnSync(process.execPath, [CLI], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(usage.status, 0);
  assert.match(usage.stdout, /claude\|cursor\|codex\|dsh\|opencode/);

  const dshManifest = readJson(path.join(ROOT, 'packages', 'dsh', 'package.json'));
  assert.strictEqual(dshManifest.dsh.bundle.patch, './zonoid.cordis.patch.yml');
  assert(dshManifest.files.includes('zonoid.cordis.patch.yml'));
  assert(readJson(path.join(ROOT, 'package.json')).files.includes('packages/dsh/'));

  const materializedHome = path.join(temp, 'materialized-home');
  const firstBundle = materializeDshBundle({ installDir: ROOT, dshHome: materializedHome });
  assert.strictEqual(firstBundle.installed, true);
  assert.strictEqual(firstBundle.path, dshManagedBundleDir(materializedHome));
  const installedPatch = fs.readFileSync(path.join(firstBundle.path, 'zonoid.cordis.patch.yml'), 'utf8');
  // The installed patch pins the MCP entry as a JSON-quoted, FORWARD-SLASHED absolute path
  // (renderInstalledDshPatch -> fwdSlash in packages/cli/bin/zonoid.js): a native win32
  // backslash path would not survive the Cordis YAML/JS config value.
  const expectedMcpEntry = path.join(ROOT, 'mcp-graph.js').replace(/\\/g, '/');
  assert(installedPatch.includes(JSON.stringify(expectedMcpEntry)));
  assert.match(installedPatch, /ORCH_CLIENT: dsh/);
  assert.match(installedPatch, /@deepseek-ai\/dsh-mcp-client/);
  assert.match(installedPatch, /@zonoid\/dsh/);
  const bundleBeforeRepeat = fs.readFileSync(path.join(firstBundle.path, 'zonoid.cordis.patch.yml'));
  const repeatedBundle = materializeDshBundle({ installDir: ROOT, dshHome: materializedHome });
  assert.strictEqual(repeatedBundle.current, true);
  assert.deepStrictEqual(
    fs.readFileSync(path.join(firstBundle.path, 'zonoid.cordis.patch.yml')),
    bundleBeforeRepeat,
  );
  fs.writeFileSync(path.join(firstBundle.path, 'README.md'), 'previous managed bundle\n');
  const refreshedBundle = materializeDshBundle({ installDir: ROOT, dshHome: materializedHome });
  assert.strictEqual(refreshedBundle.installed, true);
  assert.strictEqual(refreshedBundle.backup, `${firstBundle.path}.zonoid.bak`);
  assert.strictEqual(
    fs.readFileSync(path.join(refreshedBundle.backup, 'README.md'), 'utf8'),
    'previous managed bundle\n',
  );

  // A fresh DSH home is created through the public plugin command. Repeating init avoids
  // both profile mutation and a second subprocess call once the same bundle is active.
  const createdHome = path.join(temp, 'created-home');
  const createCalls = [];
  const created = installDshProfile({
    dshHome: createdHome,
    installDir: ROOT,
    spawnSyncFn: simulatedDshPlugin(createCalls),
  });
  assert.strictEqual(created.installed, true);
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(createCalls[0].args[4], dshBundleSpec(dshManagedBundleDir(createdHome)));
  assert.strictEqual(createCalls[0].options.env.DSH_HOME, createdHome);
  assert(dshProfileHasBundle(created.profileDir, created.bundleDir));
  const createdManifest = fs.readFileSync(path.join(created.profileDir, 'package.json'));
  const repeated = installDshProfile({
    dshHome: createdHome,
    installDir: ROOT,
    spawnSyncFn: simulatedDshPlugin(createCalls),
  });
  assert.strictEqual(repeated.current, true);
  assert.strictEqual(createCalls.length, 1);
  assert.deepStrictEqual(fs.readFileSync(path.join(created.profileDir, 'package.json')), createdManifest);

  // Existing dependencies, bundle layers, DSH fields, user patches, and other harness files
  // survive the additive install byte-for-byte except for DSH-owned profile metadata.
  const preservedHome = path.join(temp, 'preserved-home');
  const preservedProfile = path.join(preservedHome, 'profiles', 'headless');
  const originalManifest = {
    name: 'user-headless',
    private: true,
    dependencies: { '@user/cordis-plugin': '1.2.3' },
    dsh: {
      keep: { user: true },
      profile: {
        extends: ['base', 'headless'],
        bundles: ['@user/cordis-plugin'],
      },
    },
    custom: { untouched: true },
  };
  writeJson(path.join(preservedProfile, 'package.json'), originalManifest);
  fs.writeFileSync(path.join(preservedProfile, 'pnpm-lock.yaml'), 'user-lock: true\n');
  fs.writeFileSync(path.join(preservedProfile, 'pnpm-workspace.yaml'), 'packages: []\n');
  const userPatch = '- insert:\n  - id: user-mcp\n    name: user-plugin\n';
  fs.writeFileSync(path.join(preservedProfile, 'cordis.patch.yml'), userPatch);
  const otherHarnessDir = path.join(temp, 'workspace');
  fs.mkdirSync(path.join(otherHarnessDir, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(otherHarnessDir, '.mcp.json'), '{"mcpServers":{"keep":{}}}\n');
  fs.writeFileSync(path.join(otherHarnessDir, 'opencode.json'), '{"mcp":{"keep":{}}}\n');
  fs.writeFileSync(path.join(otherHarnessDir, '.codex', 'config.toml'), '[mcp_servers.keep]\n');
  const otherHarnessBefore = [
    '.mcp.json',
    'opencode.json',
    path.join('.codex', 'config.toml'),
  ].map((name) => fs.readFileSync(path.join(otherHarnessDir, name)));
  const preserveCalls = [];
  installDshProfile({
    dshHome: preservedHome,
    installDir: ROOT,
    cwd: otherHarnessDir,
    spawnSyncFn: simulatedDshPlugin(preserveCalls),
  });
  const preserved = readJson(path.join(preservedProfile, 'package.json'));
  assert.strictEqual(preserved.dependencies['@user/cordis-plugin'], '1.2.3');
  assert.strictEqual(preserved.dependencies['@zonoid/dsh'], dshBundleSpec(dshManagedBundleDir(preservedHome)));
  assert.deepStrictEqual(preserved.dsh.profile.extends, ['base', 'headless']);
  assert.deepStrictEqual(preserved.dsh.profile.bundles, ['@user/cordis-plugin', '@zonoid/dsh']);
  assert.deepStrictEqual(preserved.dsh.keep, { user: true });
  assert.deepStrictEqual(preserved.custom, { untouched: true });
  assert.strictEqual(fs.readFileSync(path.join(preservedProfile, 'cordis.patch.yml'), 'utf8'), userPatch);
  assert.deepStrictEqual(
    fs.readFileSync(path.join(preservedProfile, 'package.json.zonoid.bak')),
    Buffer.from(`${JSON.stringify(originalManifest, null, 2)}\n`),
  );
  [
    '.mcp.json',
    'opencode.json',
    path.join('.codex', 'config.toml'),
  ].forEach((name, index) => {
    assert.deepStrictEqual(fs.readFileSync(path.join(otherHarnessDir, name)), otherHarnessBefore[index]);
  });

  // If DSH exits non-zero after partially changing profile metadata, originals are restored and
  // files it introduced are removed. The user Cordis patch is outside the rollback set.
  const rollbackHome = path.join(temp, 'rollback-home');
  const rollbackProfile = path.join(rollbackHome, 'profiles', 'headless');
  const rollbackManifest = Buffer.from('{"name":"rollback-profile","dependencies":{"keep":"1"}}\n');
  const rollbackLock = Buffer.from('user-lock: original\n');
  fs.mkdirSync(rollbackProfile, { recursive: true });
  fs.writeFileSync(path.join(rollbackProfile, 'package.json'), rollbackManifest);
  fs.writeFileSync(path.join(rollbackProfile, 'pnpm-lock.yaml'), rollbackLock);
  fs.writeFileSync(path.join(rollbackProfile, 'cordis.patch.yml'), userPatch);
  assert.throws(() => installDshProfile({
    dshHome: rollbackHome,
    installDir: ROOT,
    spawnSyncFn(_command, _args, options) {
      const profile = path.join(options.env.DSH_HOME, 'profiles', 'headless');
      fs.writeFileSync(path.join(profile, 'package.json'), '{"corrupt":true}\n');
      fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'corrupt\n');
      fs.writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'introduced: true\n');
      return { status: 1, stdout: '', stderr: 'simulated failure' };
    },
  }), /DSH profile install failed: simulated failure/);
  assert.deepStrictEqual(fs.readFileSync(path.join(rollbackProfile, 'package.json')), rollbackManifest);
  assert.deepStrictEqual(fs.readFileSync(path.join(rollbackProfile, 'pnpm-lock.yaml')), rollbackLock);
  assert(!fs.existsSync(path.join(rollbackProfile, 'pnpm-workspace.yaml')));
  assert.strictEqual(fs.readFileSync(path.join(rollbackProfile, 'cordis.patch.yml'), 'utf8'), userPatch);
  assert.deepStrictEqual(fs.readFileSync(path.join(rollbackProfile, 'package.json.zonoid.bak')), rollbackManifest);
  assert.deepStrictEqual(fs.readFileSync(path.join(rollbackProfile, 'pnpm-lock.yaml.zonoid.bak')), rollbackLock);

  console.log('dsh-cli-init.test.js: all assertions passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
