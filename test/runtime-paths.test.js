#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const runtimePaths = require('../lib/runtime-paths');
const codexSessionBridge = require('../lib/codex-session-bridge');

const oldEnv = {
  ORCH_DATA: process.env.ORCH_DATA,
  ZONOID_DATA: process.env.ZONOID_DATA,
  CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
  HOME: process.env.HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

function setEnv(values) {
  for (const key of Object.keys(oldEnv)) {
    if (values[key] == null) delete process.env[key];
    else process.env[key] = values[key];
  }
}

function cleanChildEnv(values) {
  const env = { ...process.env };
  delete env.ORCH_DATA;
  delete env.ZONOID_DATA;
  delete env.CLAUDE_PLUGIN_DATA;
  for (const [key, value] of Object.entries(values || {})) {
    if (value != null) env[key] = value;
  }
  return env;
}

function shellDataDir(values) {
  const script = '. ./hooks/lib/runtime-paths.sh; orch_data_dir';
  const r = spawnSync('bash', ['-lc', script], {
    cwd: path.join(__dirname, '..'),
    env: cleanChildEnv(values),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout.trim();
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-paths-'));
try {
  const orch = path.join(tmp, 'orch-data');
  const zonoid = path.join(tmp, 'zonoid-data');
  const legacyData = path.join(tmp, 'legacy-data');
  const install = path.join(tmp, 'install-root');
  const home = path.join(tmp, 'home');
  const external = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'zonoid')
    : path.join(home, '.local', 'share', 'zonoid');
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, 'daemon.js'), '');
  fs.writeFileSync(path.join(install, 'mcp-graph.js'), '');
  fs.writeFileSync(path.join(install, 'package.json'), '{}');
  fs.mkdirSync(home, { recursive: true });

  setEnv({ ORCH_DATA: orch, ZONOID_DATA: zonoid, CLAUDE_PLUGIN_DATA: install });
  assert.equal(runtimePaths.resolveDataDir(), path.resolve(orch), 'ORCH_DATA wins exactly');

  setEnv({ ZONOID_DATA: zonoid, CLAUDE_PLUGIN_DATA: install });
  assert.equal(runtimePaths.resolveDataDir(), path.resolve(zonoid), 'ZONOID_DATA wins over CLAUDE_PLUGIN_DATA');

  setEnv({ CLAUDE_PLUGIN_DATA: legacyData });
  assert.equal(runtimePaths.resolveDataDir(), path.resolve(legacyData), 'legacy data dir remains exact when it is not an install root');

  setEnv({ CLAUDE_PLUGIN_DATA: install });
  const canonicalInstall = fs.realpathSync(install);
  assert.equal(runtimePaths.resolveDataDir(), path.join(canonicalInstall, '.zonoid'), 'install root redirects into .zonoid');
  assert.equal(codexSessionBridge.bridgeFile(), path.join(canonicalInstall, '.zonoid', 'adapters', 'codex', 'session-bridge.json'));
  assert.equal(codexSessionBridge.legacyBridgeFile(), path.join(path.resolve(install), 'codex', 'session-bridge.json'));

  const legacyBridge = {
    version: 1,
    latest: { session_id: 'legacy-codex-session', workspace: path.resolve(install), transcript: '', updatedAt: 'now' },
  };
  fs.mkdirSync(path.dirname(codexSessionBridge.legacyBridgeFile()), { recursive: true });
  fs.writeFileSync(codexSessionBridge.legacyBridgeFile(), JSON.stringify(legacyBridge));
  assert.equal(codexSessionBridge.latestSession().session_id, 'legacy-codex-session', 'bridge reads legacy path when new adapter path is absent');

  assert.equal(shellDataDir({ ORCH_DATA: orch, ZONOID_DATA: zonoid, CLAUDE_PLUGIN_DATA: install }), orch, 'shell ORCH_DATA wins exactly');
  assert.equal(shellDataDir({ ZONOID_DATA: zonoid, CLAUDE_PLUGIN_DATA: install }), zonoid, 'shell ZONOID_DATA wins over CLAUDE_PLUGIN_DATA');
  assert.equal(shellDataDir({ CLAUDE_PLUGIN_DATA: legacyData }), legacyData, 'shell legacy data dir remains exact');
  assert.equal(shellDataDir({ CLAUDE_PLUGIN_DATA: install }), path.join(canonicalInstall, '.zonoid'), 'shell install root redirects into .zonoid');

  setEnv({ HOME: home });
  assert.equal(runtimePaths.defaultDataDir({ HOME: home }), path.resolve(external), 'default data dir externalizes new installs');
  assert.equal(runtimePaths.resolveDataDir({ HOME: home }), path.resolve(external), 'resolveDataDir uses external default when no legacy data exists');
  assert.equal(shellDataDir({ HOME: home }), external, 'shell helper externalizes new installs');

  const legacyRuntime = path.join(home, '.claude', 'orchestrator', '.zonoid');
  fs.mkdirSync(path.join(legacyRuntime, 'worktrees'), { recursive: true });
  const canonicalLegacyRuntime = fs.realpathSync(legacyRuntime);
  assert.equal(runtimePaths.defaultDataDir({ HOME: home }), canonicalLegacyRuntime, 'default data dir preserves live legacy runtime data');
  assert.equal(runtimePaths.resolveDataDir({ HOME: home }), canonicalLegacyRuntime, 'resolveDataDir preserves live legacy runtime data');
  assert.equal(shellDataDir({ HOME: home }), canonicalLegacyRuntime, 'shell helper preserves live legacy runtime data');

  const runtimePathsPath = require.resolve('../lib/runtime-paths');
  const gitPath = require.resolve('../lib/git');
  delete require.cache[runtimePathsPath];
  delete require.cache[gitPath];
  setEnv({ HOME: home });
  const freshGit = require('../lib/git');
  const repoHash = crypto.createHash('sha1').update('/repo/example').digest('hex').slice(0, 16);
  assert.equal(freshGit.worktreePath('/repo/example', 'task/1'), path.join(canonicalLegacyRuntime, 'worktrees', repoHash, 'task-1'), 'git worktree allocation follows the resolved runtime data dir');
  delete require.cache[runtimePathsPath];
  delete require.cache[gitPath];

  const setupHttps = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'setup-https.sh'), 'utf8');
  assert.match(setupHttps, /CERT_DIR="\$\(orch_data_dir\)\/certs"/, 'setup-https writes certs under the runtime data dir');

  const setupSkill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'setup', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(setupSkill, /\$BASE\/certs/, 'setup skill does not point cert checks at the install root');
  assert.match(setupSkill, /\$DATA\/certs\/cert\.pem/, 'setup skill points cert checks at runtime data dir');

  const backfillMerged = fs.readFileSync(path.join(__dirname, '..', 'bin', 'backfill-merged.js'), 'utf8');
  assert.doesNotMatch(backfillMerged, /CLAUDE_PLUGIN_DATA \|\| path\.join\(os\.homedir\(\), '\.claude', 'orchestrator'\)/, 'backfill-merged does not resolve workspaces.json from legacy root');
  assert.match(backfillMerged, /const WORKSPACES_FILE = path\.join\(RUNTIME_DIR, 'workspaces\.json'\)/, 'backfill-merged reads workspaces.json from runtime data dir');

  const migrateOverlay = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'migrate-overlay.js'), 'utf8');
  assert.doesNotMatch(migrateOverlay, /const BASE = process\.env\.CLAUDE_PLUGIN_DATA \|\| path\.join\(os\.homedir\(\), '\.claude', 'orchestrator'\)/, 'migrate-overlay does not default overlay reads to legacy root only');
  assert.match(migrateOverlay, /runtimePaths\.runtimePath\('overlay'\)/, 'migrate-overlay reads current overlay path from runtime helper');

  const zonoidCli = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'bin', 'zonoid.js'), 'utf8');
  assert.doesNotMatch(zonoidCli, /const ZONOID_DATA_DIR = path\.join\(INSTALL_DIR, '\.zonoid'\);/, 'service install no longer hardcodes install/.zonoid');
  assert.match(zonoidCli, /const ZONOID_DATA_DIR = runtimePaths\.resolveDataDir\(\);/, 'service install pins the resolved runtime data dir');
} finally {
  setEnv(oldEnv);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('PASS runtime paths');
