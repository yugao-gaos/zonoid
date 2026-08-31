#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const runtimePaths = require('../../../lib/runtime-paths');
const graphLifecycle = require('../../../lib/graph-lifecycle');
const mcpCore = require('../../../lib/mcp-core');
const daemonHandoff = require('../../../lib/daemon-handoff');

const REPO_URL = 'https://github.com/yugao-gaos/zonoid';
const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const CODEX_REPO_SKILLS_DIR = path.join('.codex', 'skills');
const OPENCODE_REPO_SKILLS_DIR = path.join('.opencode', 'skills');

// ── Invariant 3: Resolve install dir — prefer local checkout ─────────────────

/**
 * If the repo root above packages/cli/bin contains daemon.js + mcp-graph.js +
 * package.json, treat THAT as the install dir (no clone needed).
 * Otherwise fall back to ~/.claude/orchestrator (the default clone target).
 */
function resolveInstallDir() {
  // packages/cli/bin/zonoid.js → up 3 levels = repo root
  const candidateRoot = path.resolve(__dirname, '..', '..', '..');
  const hasPackageJson = fs.existsSync(path.join(candidateRoot, 'package.json'));
  const hasDaemon      = fs.existsSync(path.join(candidateRoot, 'daemon.js'));
  const hasMcp         = fs.existsSync(path.join(candidateRoot, 'mcp-graph.js'));
  if (hasPackageJson && hasDaemon && hasMcp) {
    return candidateRoot;
  }
  return path.join(os.homedir(), '.claude', 'orchestrator');
}

// Computed once at startup; exported for tests.
const INSTALL_DIR = resolveInstallDir();
// Runtime path resolution is read-only. `init` and daemon startup are the only
// entry points that explicitly perform the copy-first legacy migration.
let ZONOID_DATA_DIR = runtimePaths.resolveDataDir();

// ── output helpers ──────────────────────────────────────────────────────────

function log(msg)       { console.log(`  ${msg}`); }
function ok(msg)        { console.log(`  ✓ ${msg}`); }
function warn(msg)      { console.log(`  ⚠ ${msg}`); }
function fix(msg)       { console.log(`  ↻ ${msg}`); }
function section(title) { console.log(`\n── ${title} ─────────────────────────────`); }

// Forward slashes work as path separators on every OS (Node accepts them on
// Windows too) and keep the JSON/TOML config values free of backslash-escaping
// noise. Same convention as bin/install.js `fwd`.
const fwdSlash = (p) => String(p).replace(/\\/g, '/');
function dashboardUrl(cwd = process.cwd(), port = ORCH_PORT, viewer = null) {
  const host = viewer ? `&viewer=${encodeURIComponent(String(viewer).toLowerCase())}` : '';
  return `http://localhost:${port}/graph?workspace=${encodeURIComponent(path.resolve(cwd))}${host}`;
}
function renderClaudeInstructions(content, cwd = process.cwd(), port = ORCH_PORT) {
  const url = dashboardUrl(cwd, port, 'claude');
  return String(content)
    .replace(/http:\/\/localhost:\d+\/graph\?workspace=[^\s`)>\]]+/g, url)
    .replace(/http:\/\/localhost:\d+\/graph(?!\?workspace=)/g, url);
}

function runChecked(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts });
  if (r.status !== 0) {
    const code = r.status == null ? `signal ${r.signal}` : `exit ${r.status}`;
    throw new Error(`${cmd} ${args.join(' ')} failed (${code})`);
  }
  return r;
}

function runCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
  return (r.stdout || '').trim();
}

// ── individual checks & fixes ───────────────────────────────────────────────

// ── Invariant 1: detect live data so we NEVER rm -rf a data dir ─────────────

/**
 * Returns true if `dir` contains live orchestrator data that must not be
 * deleted: legacy root runtime state, a `.zonoid/` runtime dir, or root-level
 * `workspace` / `token` files.
 */
function dirHasLiveData(dir) {
  const liveSubdirs = ['.zonoid', 'overlay', 'sessions', 'worktrees'];
  const liveFiles   = ['workspace', 'token'];
  for (const sub of liveSubdirs) {
    if (fs.existsSync(path.join(dir, sub))) return true;
  }
  for (const f of liveFiles) {
    if (fs.existsSync(path.join(dir, f))) return true;
  }
  return false;
}

function checkInstallDir() {
  const hasPkg    = fs.existsSync(path.join(INSTALL_DIR, 'package.json'));
  const hasDaemon = fs.existsSync(path.join(INSTALL_DIR, 'daemon.js'));
  const hasMcp    = fs.existsSync(path.join(INSTALL_DIR, 'mcp-graph.js'));
  if (hasPkg && hasDaemon && hasMcp) {
    ok(`Install dir present: ${INSTALL_DIR}`);
    return;
  }

  if (fs.existsSync(INSTALL_DIR)) {
    const missing = [!hasPkg && 'package.json', !hasDaemon && 'daemon.js', !hasMcp && 'mcp-graph.js'].filter(Boolean);
    warn(`Install dir exists but is incomplete (missing: ${missing.join(', ')})`);

    // INVARIANT 1: NEVER delete a dir that holds live orchestrator data.
    if (dirHasLiveData(INSTALL_DIR)) {
      // Auto-heal: clone to a temp dir, then copy source files in so data is preserved.
      fix('Install dir has live data — cloning to temp, then copying source files in (data preserved)...');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-clone-'));
      try {
        runChecked('git', ['clone', REPO_URL, tmpDir]);
        // Copy source files from the temp clone into INSTALL_DIR,
        // but skip the data subdirs so they are left untouched.
        // Runtime-state entries written by daemon.js + lib/* under ZONOID_DATA / CLAUDE_PLUGIN_DATA:
        //   .zonoid/    — current runtime layout for universal + adapter runtime artifacts
        //   agents.json  — registered agent registry
        //   loops.json   — loop/heartbeat registry  (loop.json = legacy migration source)
        //   op-cache.json — operation idempotency cache
        //   tool-analytics.json — per-tool usage counters
        //   certs/       — TLS cert + key (orch TLS mode)
        //   models/      — embed + rerank model cache (~200 MB)
        //   tasks/       — filedrop task queue
        //   embed.pid / rerank.pid / rerank-server.log — server PID + log files
        //   *.sock       — IPC socket files (lib/ipc-path.js)
        const protectedNames = new Set([
          // Existing live-data guards
          '.zonoid', 'overlay', 'sessions', 'worktrees', 'workspace', 'token', 'node_modules',
          // Daemon runtime-state entries (C2)
          'agents.json', 'loops.json', 'loop.json', 'op-cache.json',
          'tool-analytics.json', 'certs', 'models', 'tasks',
          'embed.pid', 'rerank.pid', 'rerank-server.log',
        ]);
        for (const entry of fs.readdirSync(tmpDir)) {
          if (protectedNames.has(entry)) continue;
          const src  = path.join(tmpDir, entry);
          const dest = path.join(INSTALL_DIR, entry);
          if (fs.existsSync(dest)) {
            // Cross-platform removal of stale source file/dir
            fs.rmSync(dest, { recursive: true, force: true });
          }
          fs.cpSync(src, dest, { recursive: true });
        }
        ok('Source files refreshed (live data preserved).');
      } finally {
        // Clean up temp clone — safe because it contains no live data.
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      return;
    }

    // No live data — safe to remove and re-clone.
    fix('Removing incomplete install and re-cloning...');
    // INVARIANT 2: use fs.rmSync instead of `rm -rf` shell command.
    fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
  } else {
    fix(`Cloning ${REPO_URL} ...`);
    fs.mkdirSync(path.dirname(INSTALL_DIR), { recursive: true });
  }
  runChecked('git', ['clone', REPO_URL, INSTALL_DIR]);
  ok('Cloned.');
}

function checkNodeModules() {
  const nm = path.join(INSTALL_DIR, 'node_modules');
  if (fs.existsSync(nm) && fs.readdirSync(nm).length > 0) {
    ok('node_modules present');
    return;
  }
  fix('Running npm install — downloading ML model (~200 MB), takes 1–3 min...');
  runChecked('npm', ['install'], { cwd: INSTALL_DIR });
  ok('npm install done.');
}

function checkHooks() {
  // INVARIANT 4: validate the Node .js hooks that bin/install.js actually wires
  // (not the legacy .sh hooks that were stale / Unix-only).
  const required = [
    'orch-gate.js',
    'orch-gate-bash.js',
    'orch-posttool-starttask.js',
    'classify.js',
  ];
  const hooksDir = path.join(INSTALL_DIR, 'hooks');
  const missing = required.filter(h => !fs.existsSync(path.join(hooksDir, h)));
  if (missing.length === 0) { ok('All Node hook scripts present'); return; }
  warn(`Missing hooks: ${missing.join(', ')} — re-run after verifying the install dir`);
}

// The `__INSTALL_DIR__` placeholders sit INSIDE JSON string literals, so the install path has to be
// substituted as JSON source text, not as a raw path. On Windows every separator is a backslash, and
// splicing `C:\Users\…` in verbatim produces `\U` — an invalid JSON escape that makes JSON.parse
// throw "Bad escaped character", aborting `init` at the workspace-config step. A function replacer
// also keeps `$&`/`$1` in the path from being read as replacement patterns.
function jsonStringBody(value) {
  return JSON.stringify(String(value)).slice(1, -1);
}

// "Is this command already wired?" must be answered against the DECODED strings. JSON.stringify()
// doubles every backslash, so a Windows command `C:\Users\…\classify.sh` is searched for in text
// that holds `C:\\Users\\…`, never matches, and `init` re-merges + re-backs-up the same config on
// every run — which is exactly what makes a repeat init non-idempotent on Windows.
function jsonStringLeaves(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const item of node) jsonStringLeaves(item, out);
  else if (node && typeof node === 'object') for (const item of Object.values(node)) jsonStringLeaves(item, out);
  return out;
}

function jsonStringHaystack(node) {
  return jsonStringLeaves(node).join('\n');
}

function fillInstallDirTemplate(source) {
  const installDir = jsonStringBody(INSTALL_DIR);
  return String(source)
    .replace(/__INSTALL_DIR__/g, () => installDir)
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => installDir);
}

function loadSampleSettings() {
  const src = path.join(INSTALL_DIR, '.claude', 'settings.sample.json');
  try {
    return JSON.parse(fillInstallDirTemplate(fs.readFileSync(src, 'utf8')));
  } catch (e) { warn(`Sample not found at ${src}`); return null; }
}

// Merge Zonoid hooks + permissions into existing settings without wiping user config.
// hooks: append any hook entries whose command isn't already present.
// permissions.allow: union (deduplicated).
// statusLine: set only if not already present.
// All other existing keys are preserved unchanged.
function mergeSettings(existing, sample) {
  const out = JSON.parse(JSON.stringify(existing));

  // permissions.allow — union
  const existAllow = (out.permissions && out.permissions.allow) || [];
  const sampleAllow = (sample.permissions && sample.permissions.allow) || [];
  const merged = [...existAllow];
  for (const entry of sampleAllow) {
    if (!merged.includes(entry)) merged.push(entry);
  }
  if (!out.permissions) out.permissions = {};
  out.permissions.allow = merged;

  // hooks — append per-event any entries whose command isn't already wired
  if (!out.hooks) out.hooks = {};
  for (const [event, entries] of Object.entries(sample.hooks || {})) {
    if (!out.hooks[event]) { out.hooks[event] = entries; continue; }
    const existCmds = new Set(
      out.hooks[event].flatMap(e => (e.hooks || []).map(h => h.command))
    );
    for (const entry of entries) {
      const newCmds = (entry.hooks || []).map(h => h.command);
      if (newCmds.some(c => !existCmds.has(c))) {
        out.hooks[event].push(entry);
        newCmds.forEach(c => existCmds.add(c));
      }
    }
  }

  // statusLine — only set if not already present
  if (!out.statusLine && sample.statusLine) out.statusLine = sample.statusLine;

  return out;
}

function checkSettings(cwd) {
  const dest = path.join(cwd, '.claude', 'settings.json');
  const sample = loadSampleSettings();
  if (!sample) return;

  if (!fs.existsSync(dest)) {
    fix('settings.json missing — writing from sample...');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(sample, null, 2));
    ok(`Written: ${dest}`);
    return;
  }

  let existing;
  try { existing = JSON.parse(fs.readFileSync(dest, 'utf8')); }
  catch (e) { warn('Cannot parse settings.json — leaving as-is'); return; }

  // Check if all sample hooks are already wired to this install dir
  const content = jsonStringHaystack(existing);
  const hasTemplate = content.includes('__INSTALL_DIR__') || content.includes('${CLAUDE_PLUGIN_ROOT}');
  const missingHooks = Object.values(sample.hooks || {}).flat()
    .flatMap(e => (e.hooks || []).map(h => h.command))
    .some(cmd => !content.includes(cmd));

  if (!hasTemplate && !missingHooks) { ok('settings.json up to date'); return; }

  fix('Merging Zonoid hooks into existing settings.json...');
  const merged = mergeSettings(existing, sample);
  fs.copyFileSync(dest, dest + '.bak');
  log(`Backed up existing settings to settings.json.bak`);
  fs.writeFileSync(dest, JSON.stringify(merged, null, 2));
  ok('settings.json merged (your existing config preserved)');
}

function checkMcp(cwd, orchClient = null) {
  const dest = path.join(cwd, '.mcp.json');
  if (!fs.existsSync(dest)) {
    fix('.mcp.json missing — writing from sample...');
    writeMcp(cwd, false, orchClient);
    return;
  }
  let content;
  try { content = fs.readFileSync(dest, 'utf8'); } catch (e) { warn('Cannot read .mcp.json'); return; }

  const hasTemplate = content.includes('__INSTALL_DIR__') || content.includes('${CLAUDE_PLUGIN_ROOT}');
  // writeMcp emits forward-slashed paths (valid + escape-free in JSON on every
  // OS), so compare against the forward-slashed install dir — otherwise a
  // correct Windows entry would be flagged "wrong path" and rewritten each run.
  const hasWrongPath = content.includes('mcp-graph.js') && !content.includes(fwdSlash(INSTALL_DIR));
  if (hasTemplate || hasWrongPath) {
    warn(`.mcp.json has ${hasTemplate ? 'unresolved template tokens' : 'wrong path'} — rewriting...`);
    writeMcp(cwd, true, orchClient);
    return;
  }
  ok('.mcp.json looks correct');
}

// Build the orchestrator-graph server entry for .mcp.json, resolving the
// INSTALL_DIR path and (optionally) injecting a per-client ORCH_CLIENT.
// Returns a plain object: { type, command, args, env }.
function orchestratorMcpEntry(orchClient = null) {
  const env = { ORCH_PORT: ORCH_PORT };
  if (orchClient) env.ORCH_CLIENT = orchClient;
  return {
    type: 'stdio',
    command: 'node',
    args: [`${fwdSlash(INSTALL_DIR)}/mcp-graph.js`],
    env,
  };
}

// MERGE the orchestrator-graph server into <cwd>/.mcp.json instead of
// clobbering it. Mirrors bin/install.js installMcp: read existing JSON, set
// mcpServers["orchestrator-graph"], and preserve every other user-added
// server. `overwrite` is retained for call-site compatibility but is a no-op
// now that the write is always a read-modify-write merge — the back-up is
// taken whenever an existing file is rewritten.
function writeMcp(cwd, overwrite = false, orchClient = null) {
  const dest = path.join(cwd, '.mcp.json');

  let existing = {};
  const had = fs.existsSync(dest);
  if (had) {
    try { existing = JSON.parse(fs.readFileSync(dest, 'utf8')); }
    catch (e) { warn(`.mcp.json exists but is not valid JSON — leaving it untouched`); return; }
    fs.copyFileSync(dest, dest + '.bak');
    log(`Backed up existing .mcp.json to ${dest}.bak`);
  }

  existing.mcpServers = existing.mcpServers || {};
  existing.mcpServers['orchestrator-graph'] = orchestratorMcpEntry(orchClient);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(existing, null, 2) + '\n');
  ok(`${had ? 'Merged' : 'Written'}: ${dest}`);
}

function opencodeMcpEntry(cwd) {
  // Relative when the install dir IS the target workspace (committable, like
  // .mcp.json); absolute for global installs used across many workspaces.
  const inWorkspace = cwd && fwdSlash(cwd) === fwdSlash(INSTALL_DIR);
  const scriptArg = inWorkspace ? 'mcp-graph.js' : `${fwdSlash(INSTALL_DIR)}/mcp-graph.js`;
  return {
    type: 'local',
    command: ['node', scriptArg],
    enabled: true,
    environment: {
      ORCH_PORT: ORCH_PORT,
      ORCH_CLIENT: 'opencode',
    },
  };
}

function writeOpencodeMcp(cwd) {
  const dest = path.join(cwd, 'opencode.json');

  let existing = {};
  const had = fs.existsSync(dest);
  if (had) {
    try { existing = JSON.parse(fs.readFileSync(dest, 'utf8')); }
    catch (e) { warn('opencode.json exists but is not valid JSON — leaving it untouched'); return; }
    fs.copyFileSync(dest, dest + '.bak');
    log(`Backed up existing opencode.json to ${dest}.bak`);
  }

  existing.mcp = existing.mcp || {};
  existing.mcp['orchestrator-graph'] = opencodeMcpEntry(cwd);

  // Explicitly register the plugin in opencode.json. opencode 1.15.x does NOT
  // auto-discover .opencode/plugins/*.ts — without this entry the plugin never
  // loads (no write-gate / task_create / classify), even when its deps are
  // installed and the file is symlinked into .opencode/plugins/.
  existing.plugin = Array.isArray(existing.plugin) ? existing.plugin : [];
  const pluginPath = './.opencode/plugins/zonoid.ts';
  if (!existing.plugin.includes(pluginPath)) {
    existing.plugin.push(pluginPath);
    log('Registered zonoid plugin in opencode.json (plugin entry)');
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(existing, null, 2) + '\n');
  ok(`${had ? 'Merged' : 'Written'} OpenCode MCP config: ${dest}`);
}

const DSH_PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

function dshHomePath(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(os.homedir(), '.dsh'));
}

function dshManagedBundleDir(home = dshHomePath()) {
  return path.join(home, 'zonoid', 'packages', 'dsh');
}

function dshProfileDir(profile = 'headless', home = dshHomePath()) {
  return path.join(home, 'profiles', profile);
}

function dshBundleSpec(bundleDir) {
  return `link:${fwdSlash(path.resolve(bundleDir))}`;
}

function renderInstalledDshPatch(source, mcpEntry) {
  const marker = "!!js process.env.ZONOID_DSH_MCP_ENTRY || process.env.ZONOID_ROOT + '/mcp-graph.js'";
  if (!source.includes(marker)) throw new Error('DSH Cordis patch is missing its MCP entry marker');
  return source.replace(marker, JSON.stringify(fwdSlash(path.resolve(mcpEntry))));
}

function dshDirectorySnapshot(root) {
  const rows = [];
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isSymbolicLink()) rows.push([relative, 'link', fs.readlinkSync(full)]);
      else rows.push([relative, 'file', fs.readFileSync(full).toString('base64')]);
    }
  };
  walk(root);
  return JSON.stringify(rows);
}

// Materialize an installer-owned bundle under DSH_HOME. The checked-in patch stays portable for
// manual `--patch` use; this copy pins the stdio entry to the current Zonoid install so ordinary
// `dsh --profile headless` launches need no ambient ZONOID_ROOT variable. Replacement is atomic,
// and the previous managed copy is retained as `<bundle>.zonoid.bak` when content changes.
function materializeDshBundle(options = {}) {
  const installDir = path.resolve(options.installDir || INSTALL_DIR);
  const home = path.resolve(options.dshHome || dshHomePath());
  const sourceDir = path.join(installDir, 'packages', 'dsh');
  const dest = path.resolve(options.bundleDir || dshManagedBundleDir(home));
  if (!fs.existsSync(path.join(sourceDir, 'index.mjs'))) {
    throw new Error(`DSH bundle source missing at ${sourceDir}`);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const stage = path.join(path.dirname(dest), `.dsh.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.cpSync(sourceDir, stage, { recursive: true });
    const packagePath = path.join(stage, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    manifest.dsh = { bundle: { patch: './zonoid.cordis.patch.yml' } };
    fs.writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
    const patchPath = path.join(stage, 'zonoid.cordis.patch.yml');
    const rendered = renderInstalledDshPatch(
      fs.readFileSync(patchPath, 'utf8'),
      path.join(installDir, 'mcp-graph.js'),
    );
    fs.writeFileSync(patchPath, rendered);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }

  if (fs.existsSync(dest) && dshDirectorySnapshot(dest) === dshDirectorySnapshot(stage)) {
    fs.rmSync(stage, { recursive: true, force: true });
    return { path: dest, installed: false, current: true, backup: null };
  }

  const backup = `${dest}.zonoid.bak`;
  const had = fs.existsSync(dest);
  if (had) {
    fs.rmSync(backup, { recursive: true, force: true });
    fs.renameSync(dest, backup);
  }
  try {
    fs.renameSync(stage, dest);
  } catch (error) {
    if (had && !fs.existsSync(dest) && fs.existsSync(backup)) fs.renameSync(backup, dest);
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  return { path: dest, installed: true, current: false, backup: had ? backup : null };
}

function canonicalExistingPath(value) {
  const resolved = path.resolve(value);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function dshProfileHasBundle(profileDir, bundleDir) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')); }
  catch { return false; }
  const dependency = (manifest.dependencies && manifest.dependencies['@zonoid/dsh'])
    || (manifest.devDependencies && manifest.devDependencies['@zonoid/dsh']);
  if (typeof dependency !== 'string' || !dependency.startsWith('link:')) return false;
  const targetText = dependency.slice('link:'.length);
  const target = path.isAbsolute(targetText) ? targetText : path.resolve(profileDir, targetText);
  const bundles = manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles;
  return canonicalExistingPath(target) === canonicalExistingPath(bundleDir)
    && Array.isArray(bundles) && bundles.includes('@zonoid/dsh');
}

function captureDshProfile(profileDir) {
  const existed = fs.existsSync(profileDir);
  const files = new Map();
  for (const name of DSH_PROFILE_FILES) {
    const file = path.join(profileDir, name);
    files.set(name, fs.existsSync(file) ? fs.readFileSync(file) : null);
  }
  return { existed, files };
}

function backupDshProfile(profileDir, captured) {
  if (!captured.existed) return;
  for (const [name, content] of captured.files) {
    if (content == null) continue;
    fs.writeFileSync(path.join(profileDir, `${name}.zonoid.bak`), content);
  }
}

function restoreDshProfile(profileDir, captured) {
  if (!captured.existed) {
    fs.rmSync(profileDir, { recursive: true, force: true });
    return;
  }
  for (const [name, content] of captured.files) {
    const file = path.join(profileDir, name);
    if (content == null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, content);
  }
}

// Windows has no execve: libuv can start a `.exe` found on PATH, but a `.cmd`/`.bat` shim — which
// is exactly what npm installs for `dsh` — must go through the shell. `spawnSync('dsh', …)` fails
// ENOENT for every real DSH install on win32, so resolve the command against PATH + PATHEXT and
// report back only when the hit is a shim (same rule as needsShell in lib/llm-backend.js).
function resolveWindowsShim(command, env = process.env) {
  if (process.platform !== 'win32') return null;
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return /\.(cmd|bat)$/i.test(command) ? command : null;
  }
  const extensions = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of ['', ...extensions]) {
      const candidate = path.join(dir, `${command}${extension}`);
      let stat;
      try { stat = fs.statSync(candidate); } catch { continue; }
      if (!stat.isFile()) continue;
      // The first PATH hit wins, exactly as CreateProcess would resolve it. Only a shim needs
      // the shell; a real executable is left to the normal (safer, unquoted) spawn path.
      return /\.(cmd|bat)$/i.test(candidate) ? candidate : null;
    }
  }
  return null;
}

// One pre-quoted command line for `shell: true`. Node concatenates argv unquoted under a shell
// (DEP0190), so build the line here and spawn it with an empty argv instead.
function windowsShellCommandLine(command, args) {
  const quote = (value) => {
    const text = String(value);
    return /[\s&|<>^"()]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [command, ...args].map(quote).join(' ');
}

// Use DSH's public plugin manager rather than rewriting a user's profile or Cordis patch. The
// plugin command performs an additive dependency/bundle merge; we back up its metadata inputs and
// restore them on any non-zero or unverifiable result. User cordis.patch.yml, other dependencies,
// other bundle layers, and MCP rows are never opened by this installer.
function installDshProfile(options = {}) {
  const home = path.resolve(options.dshHome || dshHomePath());
  const profile = options.profile || 'headless';
  const profileDir = dshProfileDir(profile, home);
  const bundle = materializeDshBundle({
    installDir: options.installDir || INSTALL_DIR,
    dshHome: home,
    bundleDir: options.bundleDir,
  });
  if (dshProfileHasBundle(profileDir, bundle.path)) {
    ok(`DSH profile '${profile}' already includes the Zonoid bundle`);
    return { ok: true, installed: false, current: true, profile, profileDir, bundleDir: bundle.path };
  }

  const captured = captureDshProfile(profileDir);
  backupDshProfile(profileDir, captured);
  const command = options.command || 'dsh';
  const args = ['plugin', '--profile', profile, 'add', dshBundleSpec(bundle.path)];
  // An injected spawner is a test double and always receives the logical command; only the real
  // spawn needs the win32 shim treatment.
  const shim = options.spawnSyncFn ? null : resolveWindowsShim(command);
  let result;
  try {
    result = (options.spawnSyncFn || spawnSync)(
      shim ? windowsShellCommandLine(shim, args) : command,
      shim ? [] : args,
      {
        cwd: options.cwd || INSTALL_DIR,
        env: { ...process.env, DSH_HOME: home },
        encoding: 'utf8',
        windowsHide: true,
        shell: !!shim,
      },
    );
  } catch (error) {
    restoreDshProfile(profileDir, captured);
    throw error;
  }
  if (!result || result.status !== 0 || !dshProfileHasBundle(profileDir, bundle.path)) {
    restoreDshProfile(profileDir, captured);
    const detail = result && (result.stderr || result.stdout || result.error && result.error.message);
    throw new Error(`DSH profile install failed${detail ? `: ${String(detail).trim()}` : ''}`);
  }
  ok(`DSH profile '${profile}' now includes the Zonoid Cordis/MCP bundle`);
  return { ok: true, installed: true, current: false, profile, profileDir, bundleDir: bundle.path };
}

function checkClaude(cwd) {
  const dest = path.join(cwd, 'CLAUDE.md');
  const src  = path.join(INSTALL_DIR, 'CLAUDE.md');
  if (!fs.existsSync(src)) { warn('Source CLAUDE.md not found in install dir'); return; }
  const srcContent = renderClaudeInstructions(fs.readFileSync(src, 'utf8'), cwd);
  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, 'utf8');
    if (existing.includes('Orchestrator dashboard')) { ok('CLAUDE.md already has orchestrator section'); return; }
    fix('Appending orchestrator section to CLAUDE.md...');
    fs.writeFileSync(dest, existing + '\n\n' + srcContent);
  } else {
    fix('Creating CLAUDE.md...');
    fs.writeFileSync(dest, srcContent);
  }
  ok('CLAUDE.md updated.');
}

/**
 * Try to create a directory link from `dest` pointing at `src`, using
 * the best available strategy on this platform.
 *
 * Injection points (`symlinkFn`, `cpFn`) exist so tests can stub the OS
 * primitives and force the junction / copy fallback branches to execute
 * on any host — not just Windows without elevation.
 *
 * @param {string} src        - source directory path
 * @param {string} dest       - destination path (must not already exist)
 * @param {Function} [symlinkFn=fs.symlinkSync]  - injectable symlink primitive
 * @param {Function} [cpFn=fs.cpSync]            - injectable copy primitive
 * @returns {'symlink'|'junction'|'copy'|null}   - winning strategy, or null on total failure
 */
function linkSkill(src, dest, symlinkFn = fs.symlinkSync, cpFn = fs.cpSync) {
  // Strategy 1: plain symlink (works on Unix and Windows with elevation)
  try {
    symlinkFn(src, dest);
    return 'symlink';
  } catch (_e1) { /* fall through */ }

  // Strategy 2: junction (works without elevation on Windows for directories)
  try {
    symlinkFn(src, dest, 'junction');
    return 'junction';
  } catch (_e2) { /* fall through */ }

  // Strategy 3: deep copy (always works, but no live-update benefit)
  try {
    cpFn(src, dest, { recursive: true });
    return 'copy';
  } catch (_e3) { /* total failure */ }

  return null;
}

function checkSkills() {
  const srcDir = path.join(INSTALL_DIR, 'skills');
  if (!fs.existsSync(srcDir)) { warn('No skills/ dir in install — skipping'); return; }

  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const skills = fs.readdirSync(srcDir).filter(
    s => fs.statSync(path.join(srcDir, s)).isDirectory()
  );

  let installed = 0, skipped = 0, repaired = 0;
  for (const skill of skills) {
    const src  = path.join(srcDir, skill);
    const dest = path.join(SKILLS_DIR, skill);

    if (fs.existsSync(dest)) {
      try {
        const stat = fs.lstatSync(dest);
        if (stat.isSymbolicLink()) {
          const target = fs.readlinkSync(dest);
          if (target === src) { skipped++; continue; }
          warn(`Skill '${skill}' symlink points to wrong target — relinking`);
        } else {
          // Real dir: valid if skill.md present
          const hasSkillMd = fs.existsSync(path.join(dest, 'skill.md')) ||
                             fs.existsSync(path.join(dest, 'SKILL.md'));
          if (hasSkillMd) { skipped++; continue; }
          warn(`Skill '${skill}' directory looks broken — reinstalling`);
        }
      } catch (e) {
        warn(`Skill '${skill}' unreadable — reinstalling`);
      }
      fix(`Reinstalling skill '${skill}'...`);
      fs.rmSync(dest, { recursive: true, force: true });
      repaired++;
    }

    // Install as symlink so updates to the repo are picked up automatically.
    // INVARIANT 2: linkSkill() falls through symlink → junction → cpSync for
    // cross-platform compatibility (Windows bare symlinks require elevation).
    const strategy = linkSkill(src, dest);
    if (strategy) {
      installed++;
      ok(`Skill installed: ${skill}`);
    } else {
      warn(`Skill '${skill}' could not be installed (all strategies failed)`);
    }
  }

  if (skipped > 0)  ok(`${skipped} skill(s) already up to date`);
  if (repaired > 0) ok(`${repaired} skill(s) repaired`);
}

function installRepoSkill(cwd, skill, harness = 'codex') {
  const src = path.join(INSTALL_DIR, 'skills', skill);
  if (!fs.existsSync(path.join(src, 'SKILL.md')) && !fs.existsSync(path.join(src, 'skill.md'))) {
    warn(`Repo skill '${skill}' missing in install dir — skipping`);
    return false;
  }

  const destRoot = harness === 'codex'
    ? path.join(cwd, CODEX_REPO_SKILLS_DIR)
    : harness === 'opencode'
      ? path.join(cwd, OPENCODE_REPO_SKILLS_DIR)
      : path.join(cwd, '.zonoid', 'skills');
  const dest = path.join(destRoot, skill);
  fs.mkdirSync(destRoot, { recursive: true });

  if (fs.existsSync(dest)) {
    const hasSkillMd = fs.existsSync(path.join(dest, 'SKILL.md')) ||
                       fs.existsSync(path.join(dest, 'skill.md'));
    if (hasSkillMd) {
      ok(`Repo skill already present: ${path.relative(cwd, dest)}`);
      return true;
    }
    warn(`Repo skill '${skill}' exists but is incomplete — reinstalling`);
    fs.rmSync(dest, { recursive: true, force: true });
  }

  fs.cpSync(src, dest, { recursive: true });
  ok(`Repo skill installed: ${path.relative(cwd, dest)}`);
  return true;
}

function installCodexRepoSkills(cwd) {
  installRepoSkill(cwd, 'zonoid-orchestrator', 'codex');
}

function installOpencodeRepoSkills(cwd) {
  return installRepoSkill(cwd, 'zonoid-orchestrator', 'opencode');
}

function daemonReport(deps, kind, message) {
  if (deps && deps.quiet === true) return;
  if (kind === 'ok') ok(message);
  else if (kind === 'warn') warn(message);
  else fix(message);
}

async function checkDaemon(deps = {}) {
  const port = deps.port || ORCH_PORT;
  const result = await daemonHandoff.ensureCurrentDaemon({
    port,
    daemonPath: deps.daemonPath || path.join(INSTALL_DIR, 'daemon.js'),
    env: deps.env,
    expectedIdentity: deps.expectedIdentity,
    healthTimeoutMs: deps.healthTimeoutMs,
    startupTimeoutMs: deps.startupTimeoutMs,
    handoffTimeoutMs: deps.handoffTimeoutMs,
    pollMs: deps.pollMs,
    childCleanupGraceMs: deps.childCleanupGraceMs,
    pidFile: deps.pidFile,
    lockFile: deps.lockFile,
    probe: deps.probe,
    signalProcess: deps.signalProcess,
    gracefulSignal: deps.gracefulSignal,
    isProcessAlive: deps.isProcessAlive,
    spawnDaemon: deps.spawnDaemon,
    acquireLock: deps.acquireLock,
    sleep: deps.sleep,
    now: deps.now,
  });
  if (result.ok) {
    const verb = result.action === 'replaced' ? 'replaced stale owner and is ready'
      : result.action === 'started' ? 'started and is ready'
        : result.action === 'joined' ? 'is ready after concurrent handoff'
          : 'is running';
    daemonReport(deps, 'ok', `Daemon ${verb} (localhost:${port})`);
    return true;
  }
  daemonReport(deps, 'warn', `Daemon handoff failed (${result.reason || 'unknown'}; localhost:${port})`);
  return false;
}

function daemonJsonHeaders(body, deps = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  const token = Object.prototype.hasOwnProperty.call(deps, 'token') ? deps.token : mcpCore.readToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function registerWorkspace(cwd, workspace, deps = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return false;
      settled = true;
      resolve(value);
      return true;
    };
    // Resolve cwd -> its containing repo root (nearest ancestor with .graph/.git); fall back to the
    // cwd itself when no marker is found so the daemon still gets a path to register.
    let repoPath = cwd;
    try {
      const { repoRoot } = require(path.join(INSTALL_DIR, 'lib', 'workspace-registry.js'));
      repoPath = repoRoot(cwd) || cwd;
    } catch { /* lib unavailable (older install) — register the cwd verbatim */ }
    const payload = { path: repoPath };
    if (workspace) payload.workspace = workspace;
    const body = JSON.stringify(payload);
    const req = http.request(
      { hostname: 'localhost', port: deps.port || ORCH_PORT, path: '/workspace', method: 'POST',
        headers: daemonJsonHeaders(body, deps) },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* handled below */ }
          const accepted = res.statusCode >= 200 && res.statusCode < 300
            && parsed && parsed.ok === true;
          if (accepted) {
            if (finish(repoPath)) daemonReport(deps, 'ok', `Workspace registered (${res.statusCode})`);
          } else {
            const detail = parsed && parsed.error ? `: ${parsed.error}` : '';
            if (finish(null)) {
              daemonReport(deps, 'warn', `Could not register workspace (daemon returned ${res.statusCode}${detail})`);
            }
          }
        });
      }
    );
    req.on('error', () => {
      if (finish(null)) daemonReport(deps, 'warn', 'Could not register workspace (daemon may still be starting)');
    });
    req.setTimeout(deps.registrationTimeoutMs || 3000, () => {
      if (finish(null)) daemonReport(deps, 'warn', 'Could not register workspace (request timed out)');
      req.destroy(new Error('daemon workspace registration timed out'));
    });
    req.write(body);
    req.end();
  });
}

function postDaemonJson(route, payload, timeoutMs = 120000, deps = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { hostname: 'localhost', port: deps.port || ORCH_PORT, path: route, method: 'POST',
        headers: daemonJsonHeaders(body, deps) },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* handled below */ }
          if (res.statusCode < 200 || res.statusCode >= 300 || !parsed) {
            reject(new Error((parsed && parsed.error) || `daemon returned ${res.statusCode}`));
            return;
          }
          resolve(parsed);
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('daemon onboarding request timed out')));
    req.write(body);
    req.end();
  });
}

async function startWorkspaceOnboarding(repoPath, deps = {}) {
  const post = deps.post || ((route, payload) => postDaemonJson(
    route,
    payload,
    deps.onboardingTimeoutMs || deps.timeoutMs || 120000,
    deps
  ));
  try {
    const enqueued = await post('/onboard/enqueue', { repo: repoPath });
    if (!enqueued || !enqueued.ok || !enqueued.outDir) {
      throw new Error((enqueued && enqueued.error) || 'onboarding enqueue failed');
    }
    const drained = await post('/onboard/drain-queue', {
      repo: repoPath,
      outDir: enqueued.outDir,
      autoInject: true,
      liveInject: true,
    });
    if (!drained || !drained.ok) {
      throw new Error((drained && drained.error) || 'onboarding drain queue failed');
    }
    daemonReport(deps, 'ok', enqueued.reused ? 'Project onboarding resumed in background.' : 'Project onboarding queued in background.');
    return { ok: true, outDir: enqueued.outDir, reused: !!enqueued.reused };
  } catch (err) {
    daemonReport(deps, 'warn', `Could not start project onboarding: ${err && err.message ? err.message : err}`);
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

async function startWorkspaceInitialization(cwd, workspace, deps = {}) {
  let repoPath = cwd;
  try {
    const { registrationRepoRoot } = require(path.join(INSTALL_DIR, 'lib', 'workspace-registry.js'));
    repoPath = registrationRepoRoot(cwd) || cwd;
  } catch { /* older installs fall back to the requested cwd */ }
  const post = deps.post || ((route, payload) => postDaemonJson(
    route,
    payload,
    deps.transactionTimeoutMs || deps.onboardingTimeoutMs || deps.registrationTimeoutMs || deps.timeoutMs || 120000,
    deps
  ));
  try {
    const payload = { repo: repoPath };
    if (workspace) payload.workspace_id = workspace;
    const accepted = await post('/onboard/init', payload);
    if (!accepted || accepted.ok !== true || accepted.accepted !== true
        || accepted.registered !== true || !accepted.graph_repo || !accepted.outDir) {
      throw new Error((accepted && accepted.error) || 'daemon did not accept the workspace onboarding transaction');
    }
    daemonReport(deps, 'ok', accepted.reused
      ? 'Workspace registration and project onboarding resumed.'
      : 'Workspace registration and project onboarding queued.');
    return {
      ok: true,
      repo: accepted.graph_repo,
      outDir: accepted.outDir,
      reused: !!accepted.reused,
    };
  } catch (err) {
    daemonReport(deps, 'warn', `Could not initialize workspace onboarding: ${err && err.message ? err.message : err}`);
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// ── main ────────────────────────────────────────────────────────────────────

function ask(question) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

const PLACEHOLDER_NAMES = new Set(['orchestrator', 'root', 'admin', 'user']);

async function checkGitIdentity() {
  const gitName  = (() => { try { return runCapture('git', ['config', 'user.name']); } catch { return ''; } })();
  const gitEmail = (() => { try { return runCapture('git', ['config', 'user.email']); } catch { return ''; } })();

  const nameMissing  = !gitName  || PLACEHOLDER_NAMES.has(gitName.toLowerCase());
  const emailMissing = !gitEmail || gitEmail.endsWith('@localhost');

  if (!nameMissing && !emailMissing) {
    ok(`git identity: ${gitName} <${gitEmail}>`);
    return;
  }

  warn('git user.name / user.email not set (commits will be anonymous)');
  const name  = nameMissing  ? await ask(`  Your name  [${gitName  || 'e.g. Jane Smith'}]: `) : gitName;
  const email = emailMissing ? await ask(`  Your email [${gitEmail || 'e.g. you@example.com'}]: `) : gitEmail;

  if (name)  { runChecked('git', ['config', '--global', 'user.name', name], { stdio: 'ignore' });  ok(`set user.name  = ${name}`); }
  if (email) { runChecked('git', ['config', '--global', 'user.email', email], { stdio: 'ignore' }); ok(`set user.email = ${email}`); }
}

const ORCH_PORT = process.env.ORCH_PORT || '8787';
const ORCH_BIND_HOST = process.env.ORCH_BIND_HOST || '';
const PLIST_LABEL = 'com.zonoid.daemon';
const PLIST_PATH  = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
const SYSTEMD_UNIT = 'zonoid-daemon.service';
const SYSTEMD_PATH = path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT);

function installLaunchdService() {
  const nodeBin = process.execPath;
  const daemonJs = path.join(INSTALL_DIR, 'daemon.js');
  const bindEnvironment = ORCH_BIND_HOST
    ? `    <key>ORCH_BIND_HOST</key>\n    <string>${ORCH_BIND_HOST}</string>\n`
    : '';

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${daemonJs}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ORCH_PORT</key>
    <string>${ORCH_PORT}</string>
${bindEnvironment}    <key>ZONOID_DATA</key>
    <string>${ZONOID_DATA_DIR}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/zonoid-daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/zonoid-daemon.log</string>
</dict>
</plist>`;

  try {
    fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
    fs.writeFileSync(PLIST_PATH, plist);
  } catch (e) { warn(`Could not write plist: ${e.message}`); return; }

  spawnSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore', windowsHide: true });
  const load = spawnSync('launchctl', ['load', '-w', PLIST_PATH], { encoding: 'utf8', windowsHide: true });
  if (load.status === 0) ok(`launchd service installed (${PLIST_PATH}) — starts on login, restarts on crash`);
  else warn(`launchctl load failed: ${(load.stderr || '').trim()}`);
}

function installSystemdService() {
  const nodeBin = process.execPath;
  const daemonJs = path.join(INSTALL_DIR, 'daemon.js');
  const bindEnvironment = ORCH_BIND_HOST ? `Environment=ORCH_BIND_HOST=${ORCH_BIND_HOST}\n` : '';

  const unit = `[Unit]
Description=Zonoid orchestrator daemon
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${daemonJs}
Environment=ORCH_PORT=${ORCH_PORT}
${bindEnvironment}Environment=ZONOID_DATA=${ZONOID_DATA_DIR}
Restart=always
RestartSec=5
StandardOutput=append:/tmp/zonoid-daemon.log
StandardError=append:/tmp/zonoid-daemon.log

[Install]
WantedBy=default.target
`;

  try {
    fs.mkdirSync(path.dirname(SYSTEMD_PATH), { recursive: true });
    fs.writeFileSync(SYSTEMD_PATH, unit);
  } catch (e) { warn(`Could not write systemd unit: ${e.message}`); return; }

  const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8', windowsHide: true });
  if (reload.status !== 0) {
    warn(`systemctl daemon-reload failed: ${(reload.stderr || reload.stdout || '').trim()}`);
    log(`Unit written to ${SYSTEMD_PATH} — run: systemctl --user enable --now ${SYSTEMD_UNIT}`);
    return;
  }
  const enable = spawnSync('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT], { encoding: 'utf8', windowsHide: true });
  if (enable.status === 0) ok(`systemd user service installed (${SYSTEMD_PATH}) — enabled and started`);
  else {
    warn(`systemctl enable failed: ${(enable.stderr || enable.stdout || '').trim()}`);
    log(`Unit written to ${SYSTEMD_PATH} — run: systemctl --user enable --now ${SYSTEMD_UNIT}`);
  }
}

function installService() {
  if (process.platform === 'darwin') installLaunchdService();
  else if (process.platform === 'linux') installSystemdService();
  else warn(`User service install not supported on ${process.platform}`);
}

const VALID_HARNESSES = new Set(['claude', 'cursor', 'codex', 'dsh', 'opencode']);

// ── Graph auto-commit hook ──────────────────────────────────────────────────

/**
 * Returns the verbatim content for .git/hooks/post-commit that snapshots
 * .graph/*.jsonl files after each commit when ORCH_GRAPH_AUTOCOMMIT=1.
 */
function graphAutocommitHookScript() {
  const cli = fwdSlash(path.join(INSTALL_DIR, 'packages', 'cli', 'bin', 'zonoid.js'));
  return `#!/bin/sh
[ "\${ORCH_GRAPH_AUTOCOMMIT}" = "1" ] || exit 0

REPO_ROOT=$(git rev-parse --show-toplevel)
CHECKPOINT=$(git rev-parse --git-path GRAPH_CHECKPOINT)
COMMIT_HASH=$(git rev-parse --short HEAD)

# Submodule mode is deterministic and direct: commit/push inside the graph repository only.
if git -C "$REPO_ROOT/.graph" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  "${fwdSlash(process.execPath)}" "${cli}" graph flush --repo "$REPO_ROOT" >/dev/null 2>&1 &
  exit 0
fi

# On first run, catch all pending changes
[ -f "$CHECKPOINT" ] || touch -t 197001010000 "$CHECKPOINT"

# Find .graph/ files modified since last snapshot
CHANGED=$(find .graph -name "*.jsonl" -newer "$CHECKPOINT" 2>/dev/null)
[ -n "$CHANGED" ] || exit 0

claude --dangerously-skip-permissions -p "
The git commit $COMMIT_HASH just landed in $REPO_ROOT.
Stage and commit these .graph/ files (changed since last graph snapshot):

$CHANGED

Steps:
1. git add $CHANGED
2. git commit --no-verify -m 'chore: graph snapshot [$COMMIT_HASH]'
3. touch $CHECKPOINT

Do not touch anything outside .graph/.
" 2>/dev/null &
`;
}

/**
 * Returns a NEW merged settings object with ORCH_GRAPH_AUTOCOMMIT set in env.
 * Safety rule: never downgrade an existing "1" to "0".
 * If enable=true  → set env.ORCH_GRAPH_AUTOCOMMIT = "1"
 * If enable=false → only ADD "0" when the key is ABSENT (never overwrite "1")
 */
function mergeGraphAutocommitFlag(settings, enable) {
  const out = JSON.parse(JSON.stringify(settings));
  if (!out.env) out.env = {};
  if (enable) {
    out.env.ORCH_GRAPH_AUTOCOMMIT = '1';
  } else {
    // Only add "0" if the key doesn't already exist
    if (!Object.prototype.hasOwnProperty.call(out.env, 'ORCH_GRAPH_AUTOCOMMIT')) {
      out.env.ORCH_GRAPH_AUTOCOMMIT = '0';
    }
    // If it's already "1", leave it as "1" — no downgrade
  }
  return out;
}

// ── Pre-push test guard ─────────────────────────────────────────────────────

function prePushTestCommand(cwd) {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); }
  catch (_) { return null; }

  const scripts = pkg && pkg.scripts;
  if (!scripts || typeof scripts !== 'object') return null;
  if (typeof scripts['test:all'] === 'string' && scripts['test:all'].trim()) return 'npm run test:all';
  if (typeof scripts.test === 'string' && scripts.test.trim()) return 'npm test';
  return null;
}

function prePushTestHookScript(command) {
  return `#!/bin/sh
# Zonoid pre-push test guard
set -eu

echo "zonoid: running ${command} before push"
${command}
`;
}

function checkPrePushTestHook(cwd) {
  const command = prePushTestCommand(cwd);
  if (!command) {
    warn('No package.json test script found — skipping pre-push test guard');
    return;
  }

  let hooksDir;
  try {
    const raw = runCapture('git', ['rev-parse', '--git-path', 'hooks'], { cwd });
    hooksDir = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  } catch (_) {
    warn('not a git repo — skipping pre-push test guard');
    return;
  }

  const hookPath = path.join(hooksDir, 'pre-push');
  const MARKER = 'Zonoid pre-push test guard';

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (existing.includes(MARKER)) {
      if (existing.includes(command)) {
        ok('pre-push test guard already installed');
      } else {
        fix('Updating pre-push test guard...');
        fs.writeFileSync(hookPath, prePushTestHookScript(command));
        try { fs.chmodSync(hookPath, 0o755); } catch (_) { /* harmless on Windows */ }
        ok('pre-push test guard updated');
      }
    } else if (existing.trim() === '') {
      fix('Writing pre-push test guard (replacing empty file)...');
      fs.writeFileSync(hookPath, prePushTestHookScript(command));
      try { fs.chmodSync(hookPath, 0o755); } catch (_) { /* harmless on Windows */ }
      ok('pre-push test guard installed');
    } else {
      warn('A foreign pre-push hook exists — not overwriting. Add the Zonoid test guard manually.');
    }
  } else {
    fix('Writing pre-push test guard...');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hookPath, prePushTestHookScript(command));
    try { fs.chmodSync(hookPath, 0o755); } catch (_) { /* harmless on Windows */ }
    ok('pre-push test guard installed');
  }
}

/**
 * Check and install the graph auto-commit post-commit hook into the git repo
 * at `cwd`. Also merges ORCH_GRAPH_AUTOCOMMIT into ~/.claude/settings.json.
 * opts.enable=true → write "1" into env; false/absent → write "0" (only if absent).
 */
function checkGraphAutocommitHook(cwd, opts = {}) {
  // Resolve hooks dir via git (handles worktrees + core.hooksPath)
  let hooksDir;
  try {
    const raw = runCapture('git', ['rev-parse', '--git-path', 'hooks'], { cwd });
    // May be relative — resolve relative to cwd
    hooksDir = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  } catch (_) {
    warn('not a git repo — skipping graph auto-commit hook');
    return;
  }

  const hookPath = path.join(hooksDir, 'post-commit');
  const MARKER = 'ORCH_GRAPH_AUTOCOMMIT';

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (existing.includes(MARKER)) {
      const wanted = graphAutocommitHookScript();
      if (existing === wanted) {
        ok('post-commit hook already installed');
      } else {
        fix('Updating graph auto-commit post-commit hook...');
        fs.writeFileSync(hookPath, wanted);
        try { fs.chmodSync(hookPath, 0o755); } catch (_) { /* harmless on Windows */ }
        ok('post-commit hook updated');
      }
    } else if (existing.trim() === '') {
      // Empty file — safe to replace with our hook
      fix('Writing graph auto-commit post-commit hook (replacing empty file)...');
      fs.writeFileSync(hookPath, graphAutocommitHookScript());
      try { fs.chmodSync(hookPath, 0o755); } catch (_) { /* harmless on Windows */ }
      ok('post-commit hook installed');
    } else {
      // Non-empty, foreign post-commit — do NOT overwrite
      warn('A foreign post-commit hook exists — not overwriting. Add ORCH_GRAPH_AUTOCOMMIT guard manually.');
    }
  } else {
    // Hook does not exist — write it
    fix('Writing graph auto-commit post-commit hook...');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hookPath, graphAutocommitHookScript());
    try { fs.chmodSync(hookPath, 0o755); } catch (_) { /* harmless on Windows */ }
    ok('post-commit hook installed');
  }

  // Merge the flag into ~/.claude/settings.json
  const claudeDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
    catch (_) { settings = {}; }
  }
  const merged = mergeGraphAutocommitFlag(settings, opts.enable);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
  if (opts.enable) {
    ok('ORCH_GRAPH_AUTOCOMMIT=1 set in ~/.claude/settings.json');
  } else if (merged.env && merged.env.ORCH_GRAPH_AUTOCOMMIT === '0') {
    fix('ORCH_GRAPH_AUTOCOMMIT added as "0" in ~/.claude/settings.json');
    log('Tip: set ORCH_GRAPH_AUTOCOMMIT=1 in ~/.claude/settings.json env to enable graph auto-snapshots');
  } else {
    ok('~/.claude/settings.json env updated (existing ORCH_GRAPH_AUTOCOMMIT preserved)');
  }
}

function graphSubmoduleSyncHookBlock() {
  const cli = fwdSlash(path.join(INSTALL_DIR, 'packages', 'cli', 'bin', 'zonoid.js'));
  return `# >>> Zonoid graph submodule sync >>>
if [ -f .gitmodules ] && git config -f .gitmodules --get-regexp '^submodule\\..*\\.path$' 2>/dev/null | grep -q '[[:space:]]\\.graph$'; then
  "${fwdSlash(process.execPath)}" "${cli}" graph sync --repo "$(git rev-parse --show-toplevel)" >/dev/null 2>&1 || true
fi
# <<< Zonoid graph submodule sync <<<`;
}

function installManagedHookBlock(cwd, hookName, marker, block) {
  const raw = runCapture('git', ['rev-parse', '--git-path', 'hooks'], { cwd });
  const hooksDir = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  const hookPath = path.join(hooksDir, hookName);
  fs.mkdirSync(hooksDir, { recursive: true });
  const existing = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, 'utf8') : '#!/bin/sh\n';
  if (existing.includes(marker)) return;
  const prefix = existing.trim() ? existing.replace(/\s*$/, '\n\n') : '#!/bin/sh\n';
  fs.writeFileSync(hookPath, `${prefix}${block}\n`);
  try { fs.chmodSync(hookPath, 0o755); } catch (_) { /* harmless on Windows */ }
}

function checkGraphSubmoduleGit(cwd) {
  const modules = path.join(cwd, '.gitmodules');
  if (!fs.existsSync(modules)) return { configured: false, reason: 'no_gitmodules' };
  let graphPath;
  try { graphPath = runCapture('git', ['config', '-f', '.gitmodules', '--get', 'submodule..graph.path'], { cwd }); }
  catch (_) {
    try {
      const entries = runCapture('git', ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], { cwd });
      graphPath = entries.split(/\r?\n/).find((line) => /\s\.graph$/.test(line));
    } catch (_) { graphPath = null; }
  }
  if (!graphPath || !String(graphPath).includes('.graph')) return { configured: false, reason: 'no_graph_submodule' };

  runChecked('git', ['config', 'push.recurseSubmodules', 'on-demand'], { cwd });
  const update = spawnSync('git', ['submodule', 'update', '--init', '--recursive', '--', '.graph'], {
    cwd, encoding: 'utf8', windowsHide: true,
  });
  if (update.status !== 0) warn(`graph submodule sync deferred: ${(update.stderr || update.stdout || '').trim()}`);
  const block = graphSubmoduleSyncHookBlock();
  installManagedHookBlock(cwd, 'post-merge', 'Zonoid graph submodule sync', block);
  installManagedHookBlock(cwd, 'post-checkout', 'Zonoid graph submodule sync', block);
  return { configured: true, synced: update.status === 0 };
}

function parseGraphArgs(argv) {
  const graphIndex = argv[0] === 'graph' ? 0 : argv[1] === 'graph' ? 1 : argv[2] === 'graph' ? 2 : -1;
  if (graphIndex < 0) throw new Error('expected: zonoid graph <init|sync|flush|checkpoint|status|recover-rebase>');
  const rest = argv.slice(graphIndex + 1);
  const command = rest.shift();
  if (!['init', 'sync', 'flush', 'checkpoint', 'status', 'recover-rebase'].includes(command)) {
    throw new Error('graph command must be init, sync, flush, checkpoint, status, or recover-rebase');
  }
  const out = {
    command,
    repo: process.cwd(),
    remote: undefined,
    createRemote: false,
    private: true,
    yes: false,
    dryRun: false,
    latest: undefined,
    push: true,
    drainsPaused: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--remote' && rest[i + 1]) {
      out.remote = rest[++i];
    } else if (arg === '--create-remote') {
      out.createRemote = true;
    } else if (arg === '--private') {
      out.private = true;
    } else if (arg === '--public') {
      out.private = false;
    } else if (arg === '--yes') {
      out.yes = true;
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--latest=false') {
      out.latest = false;
    } else if (arg === '--latest') {
      out.latest = true;
    } else if (arg === '--no-push') {
      out.push = false;
    } else if (arg === '--confirm-drains-paused') {
      out.drainsPaused = true;
    } else if (arg === '--repo' && rest[i + 1]) {
      out.repo = rest[++i];
    } else {
      throw new Error(`unknown graph option: ${arg}`);
    }
  }
  return out;
}

function githubRepoName(remote) {
  const value = String(remote || '').replace(/\/+$/, '');
  const match = value.match(/^(?:https?:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) throw new Error(`cannot derive GitHub OWNER/NAME from remote: ${remote}`);
  return `${match[1]}/${match[2]}`;
}

function ghResult(repoRoot, args, deps = {}) {
  if (typeof deps.gh === 'function') return Promise.resolve(deps.gh(args, repoRoot));
  const result = spawnSync('gh', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  if (result.status !== 0) throw new Error((result.stderr || 'gh repo create failed').trim());
  return Promise.resolve({ stdout: result.stdout || '' });
}

function githubCreateRemote(repoRoot, graphArgs, deps = {}) {
  return async ({ ownerRemote }) => {
    const name = githubRepoName(ownerRemote);
    const visibility = graphArgs.private === false ? '--public' : '--private';
    const created = await ghResult(repoRoot, ['repo', 'create', name, visibility], deps);
    const createdText = typeof created === 'string' ? created : created && created.stdout;
    const match = String(createdText || '').match(/https?:\/\/github\.com\/[^\s)]+/i);
    if (match) return match[0].replace(/[.,]$/, '').replace(/\/?$/, '.git');
    const viewed = await ghResult(repoRoot, ['repo', 'view', name, '--json', 'url', '--jq', '.url'], deps);
    const url = String(typeof viewed === 'string' ? viewed : viewed && viewed.stdout || '').trim();
    if (!url) throw new Error('gh did not return a clone URL');
    return `${url.replace(/\/+$/, '')}.git`;
  };
}

function graphExitCode(command, result, graphArgs = {}) {
  if (command === 'status' || result.dryRun === true) return 0;
  if (command === 'recover-rebase' && ['recovered', 'not-needed'].includes(result.status)) return 0;
  if (command === 'flush' && graphArgs.push === false && result.status === 'pending' && !result.error) return 0;
  return ['initialized', 'exists', 'synced', 'pushed', 'pending', 'staged'].includes(result.status)
    && !['pending'].includes(result.status) ? 0 : 1;
}

async function runGraphCommand(graphArgs, deps = {}) {
  const lifecycle = deps.lifecycle || graphLifecycle;
  const repoRoot = path.resolve(graphArgs.repo || deps.cwd || process.cwd());
  const output = deps.output || ((value) => console.log(JSON.stringify(value, null, 2)));
  const lifecycleOptions = {
    remote: graphArgs.remote,
    private: graphArgs.private,
    createRemote: graphArgs.createRemote,
    yes: graphArgs.yes,
    dryRun: graphArgs.dryRun,
    latest: graphArgs.latest,
    push: graphArgs.push,
    drainsPaused: graphArgs.drainsPaused,
  };
  if (graphArgs.command === 'recover-rebase') {
    lifecycleOptions.operatorRoot = path.resolve(deps.operatorRoot || INSTALL_DIR);
    lifecycleOptions.daemonPath = path.join(lifecycleOptions.operatorRoot, 'daemon.js');
  }

  if (graphArgs.command === 'init' && !graphArgs.yes && !graphArgs.dryRun) {
    const plan = await lifecycle.init(repoRoot, { ...lifecycleOptions, dryRun: true });
    const result = {
      ...plan,
      status: 'confirmation-required',
      action: 'convert ordinary .graph into a graph submodule',
      requires: '--yes',
      exitCode: 1,
    };
    output(result);
    return result;
  }

  if (graphArgs.command === 'init' && graphArgs.createRemote) {
    lifecycleOptions.createRemoteCallback = githubCreateRemote(repoRoot, graphArgs, deps);
  }
  if (graphArgs.command === 'recover-rebase' && !graphArgs.drainsPaused && !graphArgs.dryRun) {
    const plan = await lifecycle.recoverRebase(repoRoot, { ...lifecycleOptions, dryRun: true });
    const result = {
      ...plan,
      status: 'confirmation-required',
      action: 'quiesce the daemon and recover graph state, or resume an exact locked post-push daemon restart',
      requires: '--confirm-drains-paused',
      exitCode: 1,
    };
    output(result);
    return result;
  }
  let result;
  if (graphArgs.command === 'init') result = await lifecycle.init(repoRoot, lifecycleOptions);
  else if (graphArgs.command === 'sync') result = await lifecycle.sync(repoRoot, lifecycleOptions);
  else if (graphArgs.command === 'flush') result = await lifecycle.flush(repoRoot, lifecycleOptions);
  else if (graphArgs.command === 'checkpoint') result = await lifecycle.checkpoint(repoRoot, lifecycleOptions);
  else if (graphArgs.command === 'recover-rebase') result = await lifecycle.recoverRebase(repoRoot, lifecycleOptions);
  else result = await lifecycle.status(repoRoot, lifecycleOptions);
  if ((graphArgs.command === 'init' && result.status === 'initialized') || graphArgs.command === 'sync') {
    checkGraphSubmoduleGit(repoRoot);
  }
  result = { ...result, exitCode: graphExitCode(graphArgs.command, result, graphArgs) };
  output(result);
  return result;
}

// Parse `--harness` as comma-separated AND/OR repeatable, e.g.
//   --harness claude,codex            → ['claude','codex']
//   --harness claude --harness codex  → ['claude','codex']
// De-duplicated, order preserved. Defaults to ['claude'] when none given.
// `harness` (singular) is kept as the first selection for back-compat with
// existing callers/tests that read a single value.
// `--graph-autocommit` toggles the post-commit graph snapshot hook (main).
function parseInitArgs(argv) {
  const rest = argv.slice(3);
  const harnesses = [];
  let workspace;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--harness' && rest[i + 1]) {
      for (const h of rest[i + 1].split(',')) {
        const name = h.trim();
        if (name && !harnesses.includes(name)) harnesses.push(name);
      }
      i++; // consume the value
    } else if (rest[i] === '--workspace' && rest[i + 1]) {
      workspace = rest[i + 1].trim();
      i++; // consume the value
    }
  }
  if (harnesses.length === 0) harnesses.push('claude');
  return {
    service: rest.includes('--service'),
    harnesses,
    harness: harnesses[0],
    enableGraphAutocommit: rest.includes('--graph-autocommit'),
    workspace,
  };
}

function parseOnboardArgs(argv) {
  const rest = argv.slice(3);
  const out = { repo: process.cwd(), passThrough: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--repo' && rest[i + 1]) {
      out.repo = rest[i + 1];
      out.passThrough.push(a, rest[i + 1]);
      i++;
    } else {
      out.passThrough.push(a);
    }
  }
  if (!out.passThrough.includes('--repo')) out.passThrough.unshift('--repo', out.repo);
  return out;
}

function mergeCursorHooks(existing, sample, extras = []) {
  const out = JSON.parse(JSON.stringify(existing));
  if (!out.version) out.version = sample.version || 1;
  if (!out.hooks) out.hooks = {};
  const append = (event, entries) => {
    if (!entries || entries.length === 0) return;
    if (!out.hooks[event]) { out.hooks[event] = entries; return; }
    const existCmds = new Set(out.hooks[event].map((e) => e.command));
    for (const entry of entries) {
      if (!existCmds.has(entry.command)) {
        out.hooks[event].push(entry);
        existCmds.add(entry.command);
      }
    }
  };
  for (const [event, entries] of Object.entries(sample.hooks || {})) append(event, entries);
  for (const { event, entries } of extras) append(event, entries);
  return out;
}

function cursorTodoMintEntry() {
  return [{
    command: `${INSTALL_DIR}/adapters/cursor/post-todo-adopt.sh`,
    matcher: 'TodoWrite|todo_write',
    timeout: 10,
  }];
}

function scheduleWakeupScriptPath() {
  return path.join(INSTALL_DIR, 'adapters', 'common', 'schedule-wakeup.sh');
}

function opencodePluginHasScheduleWakeup(content) {
  return typeof content === 'string' && content.includes('schedule_wakeup');
}

function checkScheduleWakeupShim(harness) {
  if (harness === 'claude') return;
  const script = scheduleWakeupScriptPath();
  if (!fs.existsSync(script)) {
    warn(`ScheduleWakeup script missing at ${script}`);
    return;
  }
  try { fs.chmodSync(script, 0o755); } catch (e) { warn(`Could not chmod schedule-wakeup.sh: ${e.message}`); }
  ok(`ScheduleWakeup shim: ${script}`);
}

function verifyOpencodeScheduleWakeup() {
  const pluginTs = path.join(INSTALL_DIR, 'packages', 'opencode-plugin', 'zonoid.ts');
  const swLib = path.join(INSTALL_DIR, 'packages', 'opencode-plugin', 'lib', 'schedule-wakeup.js');
  try {
    const content = fs.readFileSync(pluginTs, 'utf8');
    if (opencodePluginHasScheduleWakeup(content)) ok('OpenCode plugin exposes schedule_wakeup tool');
    else warn('OpenCode plugin missing schedule_wakeup — update install dir');
    if (fs.existsSync(swLib)) ok(`OpenCode schedule-wakeup lib: ${swLib}`);
    else warn(`OpenCode schedule-wakeup lib missing at ${swLib}`);
  } catch (e) {
    warn(`Cannot verify OpenCode schedule_wakeup: ${e.message}`);
  }
}

function chmodScripts(dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sh'))) {
    try { fs.chmodSync(path.join(dir, f), 0o755); } catch (_) { /* ignore */ }
  }
}

function checkCursorHooks(cwd) {
  const samplePath = path.join(INSTALL_DIR, 'adapters', 'cursor', 'hooks.json.sample');
  const dest = path.join(cwd, '.cursor', 'hooks.json');
  if (!fs.existsSync(samplePath)) { warn(`Cursor hook sample missing at ${samplePath}`); return; }
  chmodScripts(path.join(INSTALL_DIR, 'adapters', 'cursor'));
  const sample = JSON.parse(fillInstallDirTemplate(fs.readFileSync(samplePath, 'utf8')));
  const classifyMarker = `${INSTALL_DIR}/adapters/cursor/classify.sh`;
  const gateMarker = `${INSTALL_DIR}/adapters/cursor/orch-gate.sh`;
  const todoMarker = `${INSTALL_DIR}/adapters/cursor/post-todo-adopt.sh`;
  const extras = [{ event: 'postToolUse', entries: cursorTodoMintEntry() }];

  if (fs.existsSync(dest)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(dest, 'utf8')); }
    catch (e) { warn('Cannot parse .cursor/hooks.json — leaving as-is'); return; }
    const content = jsonStringHaystack(existing);
    if (content.includes(classifyMarker) && content.includes(gateMarker) && content.includes(todoMarker)) {
      ok('.cursor/hooks.json already references this install');
      return;
    }
    fix('Merging Cursor hooks into .cursor/hooks.json...');
    fs.copyFileSync(dest, dest + '.bak');
    log('Backed up existing hooks.json to hooks.json.bak');
    const merged = mergeCursorHooks(existing, sample, extras);
    fs.writeFileSync(dest, JSON.stringify(merged, null, 2));
    ok('hooks.json merged (your existing config preserved)');
  } else {
    fix('Writing .cursor/hooks.json from sample...');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const merged = mergeCursorHooks({ version: 1, hooks: {} }, sample, extras);
    fs.writeFileSync(dest, JSON.stringify(merged, null, 2));
    ok(`Written: ${dest}`);
  }
  log('Trust the workspace in Cursor so project hooks run.');
}

const DASHBOARD_EXTENSION_ID = 'zonoid.zonoid-dashboard';
const EDITOR_CLI_TIMEOUT_MS = 15000;

function dashboardExtensionVsixPath() {
  return path.join(INSTALL_DIR, 'packages', 'vscode-dashboard', 'zonoid-dashboard-0.1.0.vsix');
}

function dashboardExtensionInstallDirs(editor, version, homeDir = os.homedir()) {
  const folder = `${DASHBOARD_EXTENSION_ID}-${version}`;
  const roots = editor === 'cursor'
    ? ['.cursor/extensions', '.cursor-server/extensions']
    : ['.vscode/extensions', '.vscode-server/extensions', '.vscode-server-insiders/extensions'];
  return roots.map((root) => path.join(homeDir, root, folder));
}

// Install through the editor's documented CLI so the extension lands in the
// correct local or remote extension host. The helper is editor-neutral: Cursor
// init calls it with "cursor", and VS Code users can use the same path with
// "code". Missing editor CLIs are non-fatal because the MCP/hooks wiring is
// still useful and the exact manual command is printed.
function installDashboardExtension(editor = 'cursor', options = {}) {
  const spawnImpl = options.spawnImpl || spawnSync;
  const vsixPath = options.vsixPath || dashboardExtensionVsixPath();
  if (!fs.existsSync(vsixPath)) {
    warn(`Dashboard extension package missing at ${vsixPath}`);
    return { ok: false, reason: 'vsix_missing', editor, vsixPath };
  }

  const version = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'packages', 'vscode-dashboard', 'package.json'), 'utf8')).version;
  const installDirs = dashboardExtensionInstallDirs(editor, version, options.homeDir);
  if (installDirs.some((dir) => fs.existsSync(dir))) {
    ok(`${editor} dashboard extension already installed (${DASHBOARD_EXTENSION_ID}@${version})`);
    return { ok: true, installed: false, current: true, editor, vsixPath };
  }
  const expected = `${DASHBOARD_EXTENSION_ID}@${version}`.toLowerCase();
  const list = spawnImpl(editor, ['--list-extensions', '--show-versions'], {
    encoding: 'utf8', windowsHide: true, timeout: EDITOR_CLI_TIMEOUT_MS,
  });
  if (list.error || list.status == null) {
    warn(`${editor} CLI unavailable — install the dashboard panel manually:`);
    log(`${editor} --install-extension "${vsixPath}"`);
    return { ok: false, reason: 'cli_unavailable', editor, vsixPath };
  }
  const installed = String(list.stdout || '').split(/\r?\n/).map((line) => line.trim().toLowerCase());
  if (installed.includes(expected)) {
    ok(`${editor} dashboard extension already installed (${DASHBOARD_EXTENSION_ID}@${version})`);
    return { ok: true, installed: false, current: true, editor, vsixPath };
  }

  fix(`Installing Zonoid dashboard extension in ${editor}...`);
  const result = spawnImpl(editor, ['--install-extension', vsixPath, '--force'], {
    encoding: 'utf8', windowsHide: true, timeout: EDITOR_CLI_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    warn(`${editor} dashboard extension install failed — retry manually:`);
    log(`${editor} --install-extension "${vsixPath}"`);
    return { ok: false, reason: 'install_failed', editor, vsixPath, status: result.status };
  }
  ok(`Installed Zonoid dashboard extension in ${editor}`);
  return { ok: true, installed: true, current: false, editor, vsixPath };
}

function claudeDashboardMcpbPath() {
  return path.join(INSTALL_DIR, 'packages', 'claude-dashboard-mcpb', 'zonoid-dashboard.mcpb');
}

function checkClaudeDashboardPackage() {
  const packageDir = path.dirname(claudeDashboardMcpbPath());
  try {
    const builder = require(path.join(packageDir, 'build.js'));
    builder.validateSource(packageDir);
    if (!fs.existsSync(claudeDashboardMcpbPath())) {
      warn('Claude Desktop dashboard extension source is valid, but the .mcpb artifact is missing; run npm run build:claude-dashboard');
      return { ok: false, reason: 'artifact_missing', path: claudeDashboardMcpbPath() };
    }
    const expected = builder.createZip(builder.PACKAGE_FILES.map((name) => ({
      name,
      body: fs.readFileSync(path.join(packageDir, name)),
    })));
    if (!fs.readFileSync(claudeDashboardMcpbPath()).equals(expected)) {
      throw new Error('checked .mcpb artifact is stale; run npm run build:claude-dashboard');
    }
    ok(`Claude Desktop dashboard extension ready: ${claudeDashboardMcpbPath()}`);
    return { ok: true, path: claudeDashboardMcpbPath() };
  } catch (error) {
    warn(`Claude Desktop dashboard extension is invalid: ${error.message}`);
    return { ok: false, reason: 'invalid_package', path: claudeDashboardMcpbPath() };
  }
}

// opencode rewrites "@opencode-ai/plugin": "latest" to a "@local" tag that
// fails to resolve (NpmInstallFailedError), which makes opencode SILENTLY SKIP
// the plugin entirely — so the write-gate, task_create, and classify injection
// never load. Pin to the INSTALLED opencode's minor so npm resolves a real
// published SDK version instead.
function installedOpencodeVersion() {
  try {
    const res = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
    const root = (res.stdout || '').trim();
    if (!root) return null;
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'opencode-ai', 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch { return null; }
}
function opencodePluginDepVersion() {
  const v = installedOpencodeVersion();
  if (v) {
    const m = String(v).match(/^(\d+)\.(\d+)\./);
    if (m) return `~${m[1]}.${m[2]}.0`;
  }
  return '^1.15.0'; // fallback: never 'latest' (opencode's @local rewrite breaks it)
}

const OPENCODE_DASHBOARD_COMMAND_MARKER = '<!-- zonoid-managed-dashboard-command -->';

function installOpencodeDashboardCommand(cwd) {
  const source = path.join(INSTALL_DIR, 'packages', 'opencode-plugin', 'commands', 'dashboard.md');
  const dest = path.join(cwd, '.opencode', 'commands', 'dashboard.md');
  if (!fs.existsSync(source)) {
    warn(`OpenCode /dashboard command source missing at ${source}`);
    return { ok: false, reason: 'source_missing', path: dest };
  }

  const desired = fs.readFileSync(source, 'utf8');
  const existed = fs.existsSync(dest);
  if (existed) {
    const existing = fs.readFileSync(dest, 'utf8');
    if (existing === desired) {
      ok('.opencode/commands/dashboard.md already installed');
      return { ok: true, installed: false, current: true, path: dest };
    }
    if (!existing.includes(OPENCODE_DASHBOARD_COMMAND_MARKER)) {
      warn('.opencode/commands/dashboard.md is user-owned — leaving it untouched');
      return { ok: false, reason: 'user_owned', path: dest };
    }
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, desired);
  ok(`${existed ? 'Updated' : 'Installed'} OpenCode /dashboard command`);
  return { ok: true, installed: true, current: false, path: dest };
}

function checkOpencodePlugin(cwd) {
  const srcDir = path.join(INSTALL_DIR, 'packages', 'opencode-plugin');
  const pluginDir = path.join(cwd, '.opencode', 'plugins');
  const opencodeDir = path.join(cwd, '.opencode');
  const depVersion = opencodePluginDepVersion();
  if (!fs.existsSync(path.join(srcDir, 'zonoid.ts'))) {
    warn(`OpenCode plugin missing at ${srcDir}`);
    return;
  }
  fs.mkdirSync(pluginDir, { recursive: true });
  for (const [name, target] of [
    ['zonoid.ts', path.join(srcDir, 'zonoid.ts')],
    ['lib', path.join(srcDir, 'lib')],
  ]) {
    const dest = path.join(pluginDir, name);
    if (fs.existsSync(dest)) {
      try {
        if (fs.lstatSync(dest).isSymbolicLink() && fs.readlinkSync(dest) === target) {
          ok(`.opencode/plugins/${name} already linked`);
          continue;
        }
      } catch (_) { /* reinstall below */ }
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.symlinkSync(target, dest);
    ok(`Linked .opencode/plugins/${name} → install dir`);
  }
  verifyOpencodeScheduleWakeup();
  const pkgPath = path.join(opencodeDir, 'package.json');
  const defaultPkg = JSON.stringify({ dependencies: { '@opencode-ai/plugin': depVersion } }, null, 2) + '\n';
  if (fs.existsSync(pkgPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const current = existing.dependencies && existing.dependencies['@opencode-ai/plugin'];
      if (current === depVersion) {
        ok(`.opencode/package.json already pins @opencode-ai/plugin@${depVersion}`);
      } else {
        fix(current
          ? `Repinning @opencode-ai/plugin '${current}' → '${depVersion}' ('latest' triggers opencode's broken @local resolution)`
          : 'Merging @opencode-ai/plugin into .opencode/package.json...');
        existing.dependencies = { ...(existing.dependencies || {}), '@opencode-ai/plugin': depVersion };
        fs.writeFileSync(pkgPath, JSON.stringify(existing, null, 2) + '\n');
        ok('Updated .opencode/package.json');
      }
    } catch (_) {
      fs.writeFileSync(pkgPath, defaultPkg);
      ok('Written .opencode/package.json');
    }
  } else {
    fix('Writing .opencode/package.json...');
    fs.writeFileSync(pkgPath, defaultPkg);
    ok('Written .opencode/package.json');
  }
  // Install plugin deps now so the plugin loads on opencode's next start.
  // opencode's own background install is unreliable here: it rewrites the dep
  // to a failing "@local" tag and skips when bun is absent, leaving the plugin
  // unloaded (no gate / task_create / classify). Pre-installing makes
  // `zonoid init --harness opencode` self-contained.
  const pluginInstalled = fs.existsSync(path.join(opencodeDir, 'node_modules', '@opencode-ai', 'plugin', 'package.json'));
  if (pluginInstalled) {
    ok('.opencode deps already installed (@opencode-ai/plugin present)');
  } else {
    fix(`Installing .opencode deps (@opencode-ai/plugin@${depVersion})...`);
    const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: opencodeDir, encoding: 'utf8' });
    if (install.status === 0) ok('.opencode deps installed — plugin loads on next opencode restart');
    else warn(`npm install in .opencode exited ${install.status} — plugin may not load until deps resolve`);
  }
}

function codexHookCommands(sample) {
  const out = new Set();
  for (const entries of Object.values((sample && sample.hooks) || {})) {
    for (const entry of entries || []) {
      for (const h of (entry && entry.hooks) || []) {
        if (h && h.command) out.add(h.command);
      }
    }
  }
  return out;
}

function isCodexHookCommand(command, sampleCommands) {
  if (sampleCommands.has(command)) return true;
  return typeof command === 'string' && command.replace(/\\/g, '/').includes('/adapters/codex/hooks/');
}

function mergeCodexHooks(existing, sample) {
  const out = JSON.parse(JSON.stringify(existing || {}));
  if (!out.hooks) out.hooks = {};
  const sampleCommands = codexHookCommands(sample);
  for (const [event, entries] of Object.entries(out.hooks)) {
    out.hooks[event] = (entries || [])
      .map((entry) => {
        const hooks = ((entry && entry.hooks) || []).filter((h) => !isCodexHookCommand(h && h.command, sampleCommands));
        return hooks.length ? { ...entry, hooks } : null;
      })
      .filter(Boolean);
    if (out.hooks[event].length === 0) delete out.hooks[event];
  }
  for (const [event, entries] of Object.entries((sample && sample.hooks) || {})) {
    out.hooks[event] = (out.hooks[event] || []).concat(JSON.parse(JSON.stringify(entries || [])));
  }
  return out;
}

function checkCodexHooks() {
  const sample = path.join(INSTALL_DIR, 'adapters', 'codex', 'hooks.json.sample');
  const dest = path.join(os.homedir(), '.codex', 'hooks.json');
  if (!fs.existsSync(sample)) { warn(`Codex hook sample missing at ${sample}`); return; }
  const sampleJson = JSON.parse(fillInstallDirTemplate(fs.readFileSync(sample, 'utf8')));
  chmodScripts(path.join(INSTALL_DIR, 'adapters', 'codex', 'hooks'));
  if (fs.existsSync(dest)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(dest, 'utf8')); }
    catch (e) { warn('Cannot parse ~/.codex/hooks.json — leaving as-is'); return; }
    const merged = mergeCodexHooks(existing, sampleJson);
    if (JSON.stringify(existing) === JSON.stringify(merged)) {
      ok('~/.codex/hooks.json already references this install');
      return;
    }
    fix('Merging Codex hooks into ~/.codex/hooks.json...');
    fs.copyFileSync(dest, dest + '.bak');
    log('Backed up existing hooks.json to hooks.json.bak');
    fs.writeFileSync(dest, JSON.stringify(merged, null, 2) + '\n');
    ok(`Merged: ${dest}`);
  } else {
    fix('Writing ~/.codex/hooks.json from sample...');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(sampleJson, null, 2) + '\n');
    ok(`Written: ${dest}`);
  }
  log('Open /hooks in Codex CLI to review and trust hook definitions.');
}

// Render the orchestrator-graph server as a TOML [mcp_servers.*] block for
// Codex's native ~/.codex/config.toml. Codex reads MCP from config.toml (TOML),
// NOT from .mcp.json — so the Codex server identity must live here.
function codexMcpTomlBlock() {
  const scriptArg = `${fwdSlash(INSTALL_DIR)}/mcp-graph.js`;
  return [
    '[mcp_servers.orchestrator-graph]',
    'command = "node"',
    `args = ["${scriptArg}"]`,
    '',
    '[mcp_servers.orchestrator-graph.env]',
    `ORCH_PORT = "${ORCH_PORT}"`,
    'ORCH_CLIENT = "codex"',
  ].join('\n');
}

// Idempotently strip any prior [mcp_servers.orchestrator-graph] table (and its
// nested [mcp_servers.orchestrator-graph.env] subtable) from a TOML document,
// WITHOUT a TOML-parser dependency. We operate line-wise: a table header line
// `[...]` opens a table that runs until the next top-level/sibling header. We
// drop the orchestrator-graph table and any header that is a child of it
// (prefix `[mcp_servers.orchestrator-graph.` or `[mcp_servers.orchestrator-graph]`),
// preserving every other [mcp_servers.*] and unrelated config untouched.
function stripCodexOrchTable(toml) {
  const lines = toml.split(/\r?\n/);
  const out = [];
  const isHeader = (l) => /^\s*\[\[?[^\]]+\]\]?\s*$/.test(l);
  const headerName = (l) => {
    const m = l.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/);
    return m ? m[1].trim() : null;
  };
  const isOrchHeader = (name) =>
    name === 'mcp_servers.orchestrator-graph' ||
    name.startsWith('mcp_servers.orchestrator-graph.');

  let dropping = false;
  for (const line of lines) {
    if (isHeader(line)) {
      const name = headerName(line);
      // Entering a new table — decide whether to drop it.
      dropping = name != null && isOrchHeader(name);
      if (dropping) continue;
    }
    if (dropping) continue; // body lines under a dropped table
    out.push(line);
  }
  // Collapse any run of blank lines left behind, and trim trailing blanks.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '');
}

// Write/merge the orchestrator-graph MCP server into Codex's NATIVE store:
// ~/.codex/config.toml under [mcp_servers.orchestrator-graph]. Idempotent —
// re-running replaces only our table and leaves all other config intact. Backs
// up once when an existing config.toml is rewritten. `configPath` is injectable
// for tests; defaults to ~/.codex/config.toml.
function writeCodexMcp(configPath = path.join(os.homedir(), '.codex', 'config.toml')) {
  const block = codexMcpTomlBlock();
  let next;
  const had = fs.existsSync(configPath);
  if (had) {
    let existing;
    try { existing = fs.readFileSync(configPath, 'utf8'); }
    catch (e) { warn(`Cannot read ${configPath} — leaving it untouched`); return; }
    fs.copyFileSync(configPath, configPath + '.bak');
    log(`Backed up existing config.toml to ${configPath}.bak`);
    const stripped = stripCodexOrchTable(existing);
    next = stripped.length ? `${stripped}\n\n${block}\n` : `${block}\n`;
  } else {
    next = `${block}\n`;
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, next);
  ok(`${had ? 'Merged into' : 'Wrote'} Codex MCP config: ${configPath} (ORCH_CLIENT=codex)`);
}

// ── Invariant 4: Delegate Claude harness wiring to bin/install.js ──────────

/**
 * For the 'claude' harness, spawn `node <INSTALL_DIR>/bin/install.js
 * --workspace <cwd>` so that .mcp.json + .claude/settings.json get the
 * canonical Node .js hooks (including orch-gate-bash, orch-posttool-starttask)
 * from bin/install.js.  This avoids drift between what zonoid.js hand-rolls
 * and what bin/install.js writes.
 *
 * checkClaude() (CLAUDE.md merge) is kept separately because bin/install.js
 * does not own CLAUDE.md.
 */
function checkClaudeWiring(cwd) {
  const installScript = path.join(INSTALL_DIR, 'bin', 'install.js');
  if (!fs.existsSync(installScript)) {
    warn(`bin/install.js not found at ${installScript} — falling back to inline settings wiring`);
    checkSettings(cwd);
    checkMcp(cwd);
    return;
  }

  fix('Delegating .mcp.json + settings.json wiring to bin/install.js...');
  const args = [installScript, '--workspace', cwd];
  if (process.env.ORCH_PORT) args.push('--port', process.env.ORCH_PORT);

  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  });

  if (result.status === 0) {
    ok('bin/install.js completed Claude harness wiring');
  } else {
    warn(`bin/install.js exited with status ${result.status} — check output above`);
  }
}

// Run ONE harness's additive workspace wiring. Each branch is idempotent and
// only touches that harness's own files, so wiring a 2nd harness over a 1st
// does not disturb the 1st (Codex → ~/.codex/config.toml; OpenCode →
// <cwd>/opencode.json; claude/cursor → MERGE into <cwd>/.mcp.json preserving
// sibling servers; DSH → its public profile plugin manager without reading user patches).
function wireHarness(harness, cwd) {
  if (harness === 'claude') {
    // INVARIANT 4: delegate .mcp.json + settings.json to bin/install.js
    checkClaudeWiring(cwd);
    // CLAUDE.md merge is kept here (bin/install.js doesn't own CLAUDE.md)
    checkClaude(cwd);
    checkClaudeDashboardPackage();
  } else if (harness === 'cursor') {
    checkCursorHooks(cwd);
    checkMcp(cwd, 'cursor');
    installDashboardExtension('cursor');
    warn('Cursor init uses native .cursor/hooks.json — do not also wire adapters/cursor/settings.sample.json (double execution)');
  } else if (harness === 'codex') {
    checkCodexHooks();
    // Codex reads MCP from ~/.codex/config.toml (TOML), NOT <cwd>/.mcp.json.
    writeCodexMcp();
    installCodexRepoSkills(cwd);
    warn('Codex init skips Claude settings.json / CLAUDE.md — wire hooks via ~/.codex/hooks.json');
  } else if (harness === 'dsh') {
    installDshProfile();
    warn("DSH init adds Zonoid to the 'headless' profile; user patches, plugins, and MCP servers stay untouched");
  } else if (harness === 'opencode') {
    checkOpencodePlugin(cwd);
    installOpencodeDashboardCommand(cwd);
    writeOpencodeMcp(cwd);
    installOpencodeRepoSkills(cwd);
    warn('OpenCode init skips Claude hooks — restart OpenCode after native opencode.json MCP wiring');
  }
}

function printNextSteps(harness, cwd = process.cwd()) {
  const dash = dashboardUrl(cwd, ORCH_PORT, harness);
  if (harness === 'codex') {
    console.log('  Next steps (codex):');
    console.log('    1. Open /hooks in Codex CLI and trust the Zonoid hook definitions');
    console.log('    2. Restart Codex in this directory');
    console.log(`    3. Open the dashboard: ${dash}`);
    console.log('    4. Mint tasks with Codex MCP create_task (file-drop stub + /sync), then start_task before editing');
    console.log('    5. Heartbeat: MCP ScheduleWakeup(delaySeconds, reason, prompt) — run the returned');
    console.log('       delivery.command when delivery.supported is true; otherwise the fallback is timer-only');
    console.log('    6. Repo skill installed at .codex/skills/zonoid-orchestrator for task-mint workflow');
    console.log('    7. orchestrator-loop skill (installed under ~/.claude/skills) documents the full loop pattern');
  } else if (harness === 'cursor') {
    console.log('  Next steps (cursor):');
    console.log('    1. Trust the workspace in Cursor so project hooks run');
    console.log('    2. Restart Cursor in this directory');
    console.log(`    3. Open the dashboard: ${dash}`);
    console.log('    4. Mint tasks via todo adoption or MCP, then start_task before editing');
    console.log('    5. Heartbeat: MCP ScheduleWakeup(delaySeconds, reason, prompt) — monitor stdout with');
    console.log('       the returned tail command (notify_pattern ORCH_SCHEDULED_TASK) and re-inject the prompt');
    console.log('    6. orchestrator-loop skill (installed under ~/.claude/skills) documents the full loop pattern');
  } else if (harness === 'dsh') {
    console.log('  Next steps (dsh):');
    console.log('    1. Run DSH with the installed headless profile: dsh --profile headless "task"');
    console.log('    2. The profile bundle starts the Zonoid MCP server over stdio with ORCH_CLIENT=dsh');
    console.log(`    3. Open the dashboard: ${dash}`);
    console.log('    4. Re-run init safely after either Zonoid or DSH updates; profile metadata is backed up before changes');
  } else if (harness === 'opencode') {
    console.log('  Next steps (opencode):');
    console.log('    1. Restart OpenCode in this directory after opencode.json MCP wiring');
    console.log(`    2. Run /dashboard (or use dashboard_open); external fallback: ${dash}`);
    console.log('    3. Mint tasks with the task_create tool (file-drop stub + /sync), then start_task before editing');
    console.log('    4. Heartbeat: schedule_wakeup(delaySeconds, reason, prompt) — monitor ORCH_SCHEDULED_TASK on the session .fire file');
    console.log('    5. Repo skill installed at .opencode/skills/zonoid-orchestrator for task-mint workflow');
    console.log('    6. orchestrator-loop skill (installed under ~/.claude/skills) documents the full loop pattern');
  } else {
    console.log('  Next steps (claude):');
    console.log(`    1. Claude Desktop: install ${claudeDashboardMcpbPath()} for the interactive MCP App`);
    console.log('    2. Claude Code: restart in this directory; it cannot render the Desktop MCP App');
    console.log(`    3. Claude Code fallback: call show_dashboard or run zonoid-dashboard --open (${dash})`);
    console.log('    4. Ask Claude to start working — it will create tasks automatically');
    console.log('');
    console.log('  Tip: if Claude says "no task claimed", that\'s the gate working —');
    console.log('  Claude will create a task automatically before editing.');
  }
  console.log('    Repo learning starts automatically in the background; open the dashboard to monitor it.');
}

async function init(opts = {}) {
  const cwd = process.cwd();
  // Accept either the new harnesses[] (multi) or legacy single harness.
  const harnesses = (opts.harnesses && opts.harnesses.length)
    ? opts.harnesses
    : [opts.harness || 'claude'];
  for (const h of harnesses) {
    if (!VALID_HARNESSES.has(h)) {
      console.error(`Unknown --harness "${h}" — use claude|cursor|codex|dsh|opencode`);
      process.exit(1);
    }
  }
  console.log(`\nZonoid init — workspace: ${cwd}`);
  console.log(`Install dir:  ${INSTALL_DIR}`);
  console.log(`Harness:      ${harnesses.join(', ')}\n`);

  // Treat daemon readiness, workspace registration, and durable onboarding enqueue as the
  // transaction boundary for init. Until all three are accepted, do not migrate runtime state,
  // install skills/services, or write any project config/hooks. The preflight is quiet so a failed
  // init never prints a success marker for work that will not be completed.
  const daemonDeps = { ...(opts.daemonDeps || {}), quiet: true };
  const daemonReady = await checkDaemon(daemonDeps);
  if (!daemonReady) {
    const port = daemonDeps.port || ORCH_PORT;
    throw new Error(
      `Initialization aborted: no verified Zonoid daemon is ready on localhost:${port}. ` +
      'Workspace registration and project onboarding were not attempted.'
    );
  }
  const initialization = await startWorkspaceInitialization(cwd, opts.workspace, daemonDeps);
  if (!initialization.ok) {
    throw new Error(`Initialization aborted: workspace registration and project onboarding were not durably accepted: ${initialization.error}`);
  }

  section('0. Daemon preflight');
  ok(`Daemon verified (localhost:${daemonDeps.port || ORCH_PORT})`);
  ok('Workspace registration and project onboarding accepted.');

  const runtimeMigration = runtimePaths.migrateLegacyRuntime();
  ZONOID_DATA_DIR = runtimeMigration.dataDir;
  if (runtimeMigration.migrated) {
    ok(`Runtime state copied to ${runtimeMigration.dataDir} (legacy source preserved)`);
  } else if (runtimeMigration.status === 'migration_failed') {
    warn(`Runtime migration incomplete; continuing with legacy state: ${runtimeMigration.error}`);
  }

  section('1. Core install');
  checkInstallDir();
  checkNodeModules();
  checkHooks();

  // Run EACH selected harness's additive wiring in one invocation.
  section('2. Workspace config');
  for (const h of harnesses) {
    if (harnesses.length > 1) log(`── harness: ${h} ──`);
    wireHarness(h, cwd);
  }

  // ScheduleWakeup shim for any non-claude harness selected.
  const nonClaude = harnesses.filter((h) => h !== 'claude');
  if (nonClaude.length) {
    section('2b. ScheduleWakeup');
    for (const h of nonClaude) {
      checkScheduleWakeupShim(h);
      if (h === 'opencode') verifyOpencodeScheduleWakeup();
    }
  }

  section('3. Git identity');
  await checkGitIdentity();

  section('4. Skills');
  checkSkills();

  section('5. Daemon');
  if (opts.service) installService();
  ok(`Daemon is ready (localhost:${daemonDeps.port || ORCH_PORT})`);

  section('6. Graph auto-commit hook');
  checkGraphAutocommitHook(cwd, { enable: opts.enableGraphAutocommit });

  section('7. Pre-push test guard');
  checkPrePushTestHook(cwd);

  section('8. Graph submodule');
  checkGraphSubmoduleGit(cwd);

  section('9. Warmup');
  const warmupScript = path.join(INSTALL_DIR, 'scripts', 'warmup-embeddings.js');
  if (fs.existsSync(warmupScript)) {
    fix('Warming up embedding model (first search_knowledge will be instant)...');
    const r = spawnSync('node', [warmupScript], { encoding: 'utf8', timeout: 130000, windowsHide: true });
    if (r.status === 0) ok('Embedding model ready.');
    else warn('Warmup timed out — first search_knowledge may be slow.');
  }

  console.log('\n✓ Done.\n');
  harnesses.forEach((h, i) => {
    if (i > 0) console.log('');
    printNextSteps(h, cwd);
  });

  // Graph auto-commit hook tip — workspace-level (the hook is always installed
  // by checkGraphAutocommitHook regardless of harness), so print it once after
  // the per-harness next steps rather than inside any one harness branch.
  console.log('');
  console.log('  Graph auto-commit hook:');
  console.log('    A post-commit hook was installed in .git/hooks/post-commit.');
  console.log('    It snapshots .graph/*.jsonl changes after each commit when enabled.');
  console.log('    To enable: set ORCH_GRAPH_AUTOCOMMIT=1 in ~/.claude/settings.json env block,');
  console.log('    or re-run: npx @zonoid/cli init --graph-autocommit');
  console.log('');
  console.log('  Pre-push test guard:');
  console.log('    A local .git/hooks/pre-push guard runs npm run test:all when available,');
  console.log('    otherwise npm test. Git hooks can be bypassed with --no-verify; keep CI');
  console.log('    and branch protection as the server-side backstop.');
  console.log('');
}

function onboard(opts = {}) {
  const repo = path.resolve(opts.repo || process.cwd());
  checkInstallDir();
  checkNodeModules();
  const script = path.join(INSTALL_DIR, 'scripts', 'onboard.js');
  if (!fs.existsSync(script)) {
    console.error(`onboard script not found at ${script}`);
    process.exit(1);
  }
  const args = [script, ...opts.passThrough];
  const r = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    cwd: repo,
    env: process.env,
    windowsHide: true,
  });
  process.exit(r.status == null ? 1 : r.status);
}

const cmd = process.argv[2];
if (require.main === module) {
  if (cmd === 'init') {
    init(parseInitArgs(process.argv)).catch((err) => { console.error(err); process.exit(1); });
  } else if (cmd === 'graph') {
    runGraphCommand(parseGraphArgs(process.argv)).then((result) => {
      if (result.exitCode) process.exit(result.exitCode);
    }).catch((err) => { console.error(err && err.message || err); process.exit(1); });
  } else if (cmd === 'onboard') {
    onboard(parseOnboardArgs(process.argv));
  } else {
    console.log('Usage:');
    console.log('  npx @zonoid/cli init [--harness claude|cursor|codex|dsh|opencode] [--service] [--graph-autocommit] [--workspace <name>]');
    console.log('  npx @zonoid/cli onboard [--repo <path>] [--force] [--skip-learn] [--model opus] [--max-keep 20]');
    console.log('  npx @zonoid/cli graph init [--remote GRAPH_REPO_URL] [--create-remote] [--private|--public] [--yes] [--dry-run]');
    console.log('  npx @zonoid/cli graph sync [--latest=false]');
    console.log('  npx @zonoid/cli graph flush [--no-push]');
    console.log('  npx @zonoid/cli graph checkpoint');
    console.log('  npx @zonoid/cli graph status');
    console.log('  npx @zonoid/cli graph recover-rebase [--dry-run] [--confirm-drains-paused]');
    console.log('');
    console.log('Commands:');
    console.log('  init      Wire daemon, hooks/plugins, MCP, skills, and dashboard for this workspace.');
    console.log('  onboard   Mine + validate repo KB and stop at a human review gate before injection.');
    console.log('');
    console.log('  --harness  claude (default) | cursor | codex | dsh | opencode — adapter wiring.');
    console.log('             Accepts a comma-separated list and/or repeats, e.g.');
    console.log('             --harness claude,codex  → wires BOTH in one run (coexistence).');
    console.log('  --service  Install user-level launchd (macOS) or systemd (Linux) service');
    console.log('             so the daemon starts on login and survives IDE restarts.');
    console.log('  --graph-autocommit  Set ORCH_GRAPH_AUTOCOMMIT=1 in ~/.claude/settings.json env');
    console.log('             to enable automatic graph snapshot commits after each git commit.');
    console.log('             Without this flag the hook is installed but disabled (flag is "0").');
    console.log('  --workspace <name>  Register this repo under a NAMED workspace group (a workspace');
    console.log('             groups many repos). Defaults to a single-repo workspace keyed by repo name.');
    process.exit(cmd ? 1 : 0);
  }
} else {
  module.exports = {
    // existing exports
    parseInitArgs,
    mergeCursorHooks,
    mergeCodexHooks,
    VALID_HARNESSES,
    scheduleWakeupScriptPath,
    opencodePluginHasScheduleWakeup,
    INSTALL_DIR,
    // new exports for test coverage (invariants 1, 3, 2)
    dirHasLiveData,
    resolveInstallDir,
    // C1: extracted link strategy helper — injectable stubs enable fallback branch coverage
    linkSkill,
    installRepoSkill,
    installCodexRepoSkills,
    installOpencodeRepoSkills,
    opencodePluginDepVersion,
    DASHBOARD_EXTENSION_ID,
    dashboardExtensionVsixPath,
    dashboardExtensionInstallDirs,
    installDashboardExtension,
    claudeDashboardMcpbPath,
    checkClaudeDashboardPackage,
    installOpencodeDashboardCommand,
    dshHomePath,
    dshManagedBundleDir,
    dshProfileDir,
    dshBundleSpec,
    renderInstalledDshPatch,
    materializeDshBundle,
    dshProfileHasBundle,
    installDshProfile,
    wireHarness,
    // CDX-2: Claude+Codex coexistence — MCP store split + multi-harness init
    writeMcp,
    writeCodexMcp,
    writeOpencodeMcp,
    orchestratorMcpEntry,
    opencodeMcpEntry,
    codexMcpTomlBlock,
    stripCodexOrchTable,
    // graph auto-commit hook helpers
    graphAutocommitHookScript,
    graphSubmoduleSyncHookBlock,
    checkGraphSubmoduleGit,
    mergeGraphAutocommitFlag,
    prePushTestCommand,
    prePushTestHookScript,
    checkPrePushTestHook,
    parseOnboardArgs,
    init,
    checkDaemon,
    registerWorkspace,
    postDaemonJson,
    startWorkspaceOnboarding,
    startWorkspaceInitialization,
    dashboardUrl,
    renderClaudeInstructions,
    parseGraphArgs,
    runGraphCommand,
  };
}
