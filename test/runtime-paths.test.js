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
  const external = runtimePaths.externalDataDir({ HOME: home, USERPROFILE: home });
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, 'daemon.js'), '');
  fs.writeFileSync(path.join(install, 'mcp-graph.js'), '');
  fs.writeFileSync(path.join(install, 'package.json'), '{}');
  fs.mkdirSync(home, { recursive: true });

  setEnv({ ORCH_DATA: orch, ZONOID_DATA: zonoid, CLAUDE_PLUGIN_DATA: install });
  assert.equal(runtimePaths.resolveDataDir(), path.resolve(orch), 'ORCH_DATA wins exactly');
  assert.equal(runtimePaths.resolveWorktreeDir(), path.join(path.resolve(orch), 'worktrees'), 'ORCH_DATA keeps worktrees under the explicit data root');

  setEnv({ ZONOID_DATA: zonoid, CLAUDE_PLUGIN_DATA: install });
  assert.equal(runtimePaths.resolveDataDir(), path.resolve(zonoid), 'ZONOID_DATA wins over CLAUDE_PLUGIN_DATA');
  assert.equal(runtimePaths.resolveWorktreeDir(), path.join(path.resolve(zonoid), 'worktrees'), 'ZONOID_DATA keeps worktrees under the explicit data root');

  setEnv({ CLAUDE_PLUGIN_DATA: legacyData });
  assert.equal(runtimePaths.resolveDataDir(), path.resolve(legacyData), 'legacy data dir remains exact when it is not an install root');
  assert.equal(runtimePaths.resolveWorktreeDir(), path.join(path.resolve(legacyData), 'worktrees'), 'legacy data override keeps worktrees under the explicit data root');

  setEnv({ CLAUDE_PLUGIN_DATA: install });
  const canonicalInstall = fs.realpathSync(install);
  assert.equal(runtimePaths.resolveDataDir(), path.join(canonicalInstall, '.zonoid'), 'install root redirects into .zonoid');
  assert.equal(runtimePaths.resolveWorktreeDir(), path.join(canonicalInstall, '.zonoid', 'worktrees'), 'install root keeps worktrees under its runtime data root');
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
  assert.equal(runtimePaths.resolveWorktreeDir({ HOME: home }), path.join(path.resolve(external), 'worktrees'), 'worktree dir uses the external default');
  assert.equal(shellDataDir({ HOME: home }), external, 'shell helper externalizes new installs');

  const legacyRuntime = path.join(home, '.claude', 'orchestrator', '.zonoid');
  fs.mkdirSync(path.join(legacyRuntime, 'overlay'), { recursive: true });
  fs.mkdirSync(path.join(legacyRuntime, 'worktrees', 'legacy-attempt'), { recursive: true });
  fs.writeFileSync(path.join(legacyRuntime, 'overlay', 'state.json'), 'legacy overlay');
  fs.writeFileSync(path.join(legacyRuntime, 'agents.json'), 'legacy agents');
  fs.writeFileSync(path.join(legacyRuntime, 'worktrees', 'legacy-attempt', 'marker'), 'legacy worktree');
  fs.mkdirSync(path.join(external, 'worktrees', 'external-attempt'), { recursive: true });
  fs.writeFileSync(path.join(external, 'worktrees', 'external-attempt', 'marker'), 'external worktree');

  const canonicalLegacyRuntime = fs.realpathSync(legacyRuntime);
  assert.equal(runtimePaths.hasAuthoritativeRuntimeData(external), false, 'external worktrees alone are not authoritative universal state');
  assert.equal(runtimePaths.defaultDataDir({ HOME: home }), canonicalLegacyRuntime, 'read-only default selection keeps authoritative legacy state before migration');
  assert.equal(runtimePaths.resolveDataDir({ HOME: home }), canonicalLegacyRuntime, 'read-only resolver keeps authoritative legacy state before migration');
  assert.equal(shellDataDir({ HOME: home }), canonicalLegacyRuntime, 'read-only shell helper keeps authoritative legacy state before migration');
  assert.equal(fs.existsSync(path.join(external, 'agents.json')), false, 'generic runtime resolution does not copy universal files');
  assert.equal(fs.existsSync(path.join(external, 'overlay')), false, 'generic runtime resolution does not copy universal directories');
  const migration = runtimePaths.migrateLegacyRuntime({ HOME: home });
  const canonicalExternal = fs.realpathSync(external);
  assert.equal(migration.status, 'migrated', 'live legacy universal state migrates');
  assert.equal(migration.dataDir, canonicalExternal, 'migration switches to external runtime data');
  assert.equal(fs.readFileSync(path.join(external, 'agents.json'), 'utf8'), 'legacy agents', 'universal files copy to external runtime');
  assert.equal(fs.readFileSync(path.join(external, 'overlay', 'state.json'), 'utf8'), 'legacy overlay', 'universal directories copy to external runtime');
  assert.equal(fs.readFileSync(path.join(external, 'worktrees', 'external-attempt', 'marker'), 'utf8'), 'external worktree', 'existing external worktrees are preserved');
  assert.equal(fs.existsSync(path.join(external, 'worktrees', 'legacy-attempt')), false, 'legacy worktrees are not copied');
  assert.equal(fs.readFileSync(path.join(legacyRuntime, 'agents.json'), 'utf8'), 'legacy agents', 'legacy source is never deleted or changed');
  assert.equal(fs.existsSync(path.join(external, '.legacy-migration-incomplete')), false, 'successful migration clears its incomplete marker');
  assert.equal(runtimePaths.defaultDataDir({ HOME: home }), canonicalExternal, 'default data dir stays external after migration');
  assert.equal(runtimePaths.resolveDataDir({ HOME: home }), canonicalExternal, 'resolveDataDir stays external after migration');
  assert.equal(runtimePaths.resolveWorktreeDir({ HOME: home }), path.join(canonicalExternal, 'worktrees'), 'new worktrees stay external while the legacy source remains preserved');
  assert.equal(shellDataDir({ HOME: home }), canonicalExternal, 'shell helper uses migrated external runtime data');

  const authoritativeHome = path.join(tmp, 'authoritative-home');
  const authoritativeExternal = runtimePaths.externalDataDir({ HOME: authoritativeHome, USERPROFILE: authoritativeHome });
  const authoritativeLegacy = path.join(authoritativeHome, '.claude', 'orchestrator', '.zonoid');
  fs.mkdirSync(path.join(authoritativeLegacy, 'overlay'), { recursive: true });
  fs.mkdirSync(authoritativeExternal, { recursive: true });
  fs.writeFileSync(path.join(authoritativeLegacy, 'agents.json'), 'legacy must not win');
  fs.writeFileSync(path.join(authoritativeLegacy, 'overlay', 'state.json'), 'legacy only');
  fs.writeFileSync(path.join(authoritativeExternal, 'agents.json'), 'external authoritative');
  const canonicalAuthoritativeExternal = fs.realpathSync(authoritativeExternal);
  assert.equal(runtimePaths.defaultDataDir({ HOME: authoritativeHome }), canonicalAuthoritativeExternal, 'read-only selection prefers authoritative external state');
  assert.equal(runtimePaths.resolveDataDir({ HOME: authoritativeHome }), canonicalAuthoritativeExternal, 'resolver prefers authoritative external state');
  const refused = runtimePaths.migrateLegacyRuntime({ HOME: authoritativeHome });
  assert.equal(refused.status, 'external_authoritative', 'authoritative external runtime blocks legacy migration');
  assert.equal(fs.readFileSync(path.join(authoritativeExternal, 'agents.json'), 'utf8'), 'external authoritative', 'authoritative external files are never overwritten');
  assert.equal(fs.existsSync(path.join(authoritativeExternal, 'overlay')), false, 'legacy state is not merged into an authoritative external runtime');
  assert.equal(fs.readFileSync(path.join(authoritativeLegacy, 'agents.json'), 'utf8'), 'legacy must not win', 'refused migration leaves legacy source untouched');
  assert.equal(shellDataDir({ HOME: authoritativeHome }), canonicalAuthoritativeExternal, 'shell helper respects authoritative external runtime');

  const shellHome = path.join(tmp, 'shell-home');
  const shellExternal = runtimePaths.externalDataDir({ HOME: shellHome, USERPROFILE: shellHome });
  const shellLegacy = path.join(shellHome, '.claude', 'orchestrator', '.zonoid');
  fs.mkdirSync(path.join(shellLegacy, 'overlay'), { recursive: true });
  fs.mkdirSync(path.join(shellLegacy, 'worktrees', 'legacy-attempt'), { recursive: true });
  fs.mkdirSync(path.join(shellExternal, 'worktrees', 'external-attempt'), { recursive: true });
  fs.writeFileSync(path.join(shellLegacy, 'overlay', 'state.json'), 'shell legacy overlay');
  fs.writeFileSync(path.join(shellLegacy, 'agents.json'), 'shell legacy agents');
  fs.writeFileSync(path.join(shellLegacy, 'worktrees', 'legacy-attempt', 'marker'), 'legacy worktree');
  fs.writeFileSync(path.join(shellExternal, 'worktrees', 'external-attempt', 'marker'), 'external worktree');
  assert.equal(shellDataDir({ HOME: shellHome }), fs.realpathSync(shellLegacy), 'shell helper selects legacy state when external contains only worktrees');
  assert.equal(fs.existsSync(path.join(shellExternal, 'agents.json')), false, 'shell helper never copies universal files');
  assert.equal(fs.existsSync(path.join(shellExternal, 'overlay')), false, 'shell helper never copies universal directories');
  assert.equal(fs.readFileSync(path.join(shellExternal, 'worktrees', 'external-attempt', 'marker'), 'utf8'), 'external worktree', 'shell selection leaves external worktrees untouched');
  assert.equal(fs.readFileSync(path.join(shellLegacy, 'agents.json'), 'utf8'), 'shell legacy agents', 'shell selection leaves legacy state untouched');

  const resumeHome = path.join(tmp, 'resume-home');
  const resumeExternal = runtimePaths.externalDataDir({ HOME: resumeHome, USERPROFILE: resumeHome });
  const resumeLegacy = path.join(resumeHome, '.claude', 'orchestrator', '.zonoid');
  fs.mkdirSync(path.join(resumeLegacy, 'overlay', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(resumeExternal, 'overlay'), { recursive: true });
  fs.writeFileSync(path.join(resumeLegacy, 'agents.json'), 'legacy agents');
  fs.writeFileSync(path.join(resumeLegacy, 'overlay', 'existing.json'), 'legacy must not overwrite');
  fs.writeFileSync(path.join(resumeLegacy, 'overlay', 'nested', 'missing.json'), 'missing nested content');
  fs.writeFileSync(path.join(resumeExternal, 'overlay', 'existing.json'), 'already copied content');
  fs.writeFileSync(path.join(resumeExternal, 'agents.json'), 'already copied');
  fs.writeFileSync(path.join(resumeExternal, '.legacy-migration-incomplete'), 'retry');
  const canonicalResumeLegacy = fs.realpathSync(resumeLegacy);
  assert.equal(runtimePaths.defaultDataDir({ HOME: resumeHome }), canonicalResumeLegacy, 'incomplete marker keeps read-only default selection on legacy');
  assert.equal(runtimePaths.resolveDataDir({ HOME: resumeHome }), canonicalResumeLegacy, 'incomplete marker keeps clients on legacy');
  assert.equal(shellDataDir({ HOME: resumeHome }), canonicalResumeLegacy, 'incomplete marker keeps shell hooks on legacy');
  assert.equal(fs.existsSync(path.join(resumeExternal, 'overlay', 'nested', 'missing.json')), false, 'read-only incomplete selection does not resume nested copying');
  const resumed = runtimePaths.migrateLegacyRuntime({ HOME: resumeHome });
  assert.equal(resumed.status, 'migrated', 'incomplete copy resumes even after some universal state exists');
  assert.equal(fs.readFileSync(path.join(resumeExternal, 'agents.json'), 'utf8'), 'already copied', 'resume never overwrites an existing destination entry');
  assert.equal(fs.readFileSync(path.join(resumeExternal, 'overlay', 'existing.json'), 'utf8'), 'already copied content', 'resume preserves an existing file inside a partial directory');
  assert.equal(fs.readFileSync(path.join(resumeExternal, 'overlay', 'nested', 'missing.json'), 'utf8'), 'missing nested content', 'resume recursively fills missing nested content');
  assert.equal(fs.existsSync(path.join(resumeExternal, '.legacy-migration-incomplete')), false, 'resume clears the incomplete marker');

  const overrideHome = path.join(tmp, 'override-home');
  const overrideLegacy = path.join(overrideHome, '.claude', 'orchestrator', '.zonoid');
  const overrideExternal = runtimePaths.externalDataDir({ HOME: overrideHome, USERPROFILE: overrideHome });
  fs.mkdirSync(overrideLegacy, { recursive: true });
  fs.writeFileSync(path.join(overrideLegacy, 'agents.json'), 'legacy agents');
  const explicit = runtimePaths.migrateLegacyRuntime({ HOME: overrideHome, ORCH_DATA: orch });
  assert.equal(explicit.status, 'explicit_override', 'explicit data-dir override bypasses migration');
  assert.equal(explicit.dataDir, path.resolve(orch), 'explicit data-dir override remains exact');
  assert.equal(fs.existsSync(overrideExternal), false, 'explicit override does not create the external runtime directory');

  const runtimePathsPath = require.resolve('../lib/runtime-paths');
  const gitPath = require.resolve('../lib/git');
  delete require.cache[runtimePathsPath];
  delete require.cache[gitPath];
  setEnv({ HOME: home });
  const freshGit = require('../lib/git');
  const repoHash = crypto.createHash('sha1').update('/repo/example').digest('hex').slice(0, 16);
  assert.equal(freshGit.worktreePath('/repo/example', 'task/1'), path.join(canonicalExternal, 'worktrees', repoHash, 'task-1'), 'git attempt worktree allocation externalizes independently of live legacy state');
  assert.equal(freshGit.featureWorktreePath('/repo/example', 'feature/1'), path.join(canonicalExternal, 'worktrees', repoHash, 'feature-feature-1'), 'git feature worktree allocation externalizes independently of live legacy state');
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
  assert.match(zonoidCli, /let ZONOID_DATA_DIR = runtimePaths\.resolveDataDir\(\);/, 'service install performs read-only runtime selection at import time');
  assert.match(zonoidCli, /ZONOID_DATA_DIR = runtimeMigration\.dataDir;/, 'service install follows the safe migration result, including legacy fallback on copy failure');
  assert.match(zonoidCli, /runtimePaths\.migrateLegacyRuntime\(\)/, 'CLI init runs the copy-first legacy migration');

  const daemon = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  assert.match(daemon, /require\.main === module[\s\S]*runtimePaths\.migrateLegacyRuntime\(\)\.dataDir[\s\S]*runtimePaths\.resolveDataDir\(\)/, 'executable daemon startup owns migration while module imports stay read-only');
} finally {
  setEnv(oldEnv);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('PASS runtime paths');
