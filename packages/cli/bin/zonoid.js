#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const http = require('http');

const REPO_URL = 'https://github.com/yugao-gaos/zonoid';
const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const CODEX_REPO_SKILLS_DIR = path.join('.codex', 'skills');

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
function dashboardUrl(cwd = process.cwd(), port = ORCH_PORT) {
  return `http://localhost:${port}/graph?workspace=${encodeURIComponent(path.resolve(cwd))}`;
}
function renderClaudeInstructions(content, cwd = process.cwd(), port = ORCH_PORT) {
  const url = dashboardUrl(cwd, port);
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
 * deleted: overlay/, sessions/, worktrees/, a `workspace` file, or a `token`
 * file at the root level.
 */
function dirHasLiveData(dir) {
  const liveSubdirs = ['overlay', 'sessions', 'worktrees'];
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
        // Runtime-state entries written by daemon.js + lib/* under CLAUDE_PLUGIN_DATA:
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
          'overlay', 'sessions', 'worktrees', 'workspace', 'token', 'node_modules',
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

function loadSampleSettings() {
  const src = path.join(INSTALL_DIR, '.claude', 'settings.sample.json');
  try {
    return JSON.parse(
      fs.readFileSync(src, 'utf8')
        .replace(/__INSTALL_DIR__/g, INSTALL_DIR)
        .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, INSTALL_DIR)
    );
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
  const content = JSON.stringify(existing);
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

function checkDaemon() {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port: 8787, path: '/ping', method: 'GET' },
      (res) => {
        res.resume();
        if (res.statusCode === 200) ok('Daemon is running (localhost:8787)');
        else warn(`Daemon responded with ${res.statusCode}`);
        resolve();
      }
    );
    req.on('error', () => {
      fix('Daemon not running — starting it...');
      spawnSync('node', [path.join(INSTALL_DIR, 'daemon.js')], { detached: true, stdio: 'ignore', windowsHide: true });
      ok('Daemon started.');
      resolve();
    });
    req.setTimeout(1500, () => { req.destroy(); warn('Daemon ping timed out'); resolve(); });
    req.end();
  });
}

function registerWorkspace(cwd) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ path: cwd });
    const req = http.request(
      { hostname: 'localhost', port: 8787, path: '/workspace', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { res.resume(); ok(`Workspace registered (${res.statusCode})`); resolve(); }
    );
    req.on('error', () => { warn('Could not register workspace (daemon may still be starting)'); resolve(); });
    req.setTimeout(3000, () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
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
const PLIST_LABEL = 'com.zonoid.daemon';
const PLIST_PATH  = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
const SYSTEMD_UNIT = 'zonoid-daemon.service';
const SYSTEMD_PATH = path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT);

function installLaunchdService() {
  const nodeBin = process.execPath;
  const daemonJs = path.join(INSTALL_DIR, 'daemon.js');

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
    <key>CLAUDE_PLUGIN_DATA</key>
    <string>${INSTALL_DIR}</string>
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

  const unit = `[Unit]
Description=Zonoid orchestrator daemon
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${daemonJs}
Environment=ORCH_PORT=${ORCH_PORT}
Environment=CLAUDE_PLUGIN_DATA=${INSTALL_DIR}
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

const VALID_HARNESSES = new Set(['claude', 'cursor', 'codex', 'opencode']);

// ── Graph auto-commit hook ──────────────────────────────────────────────────

/**
 * Returns the verbatim content for .git/hooks/post-commit that snapshots
 * .graph/*.jsonl files after each commit when ORCH_GRAPH_AUTOCOMMIT=1.
 */
function graphAutocommitHookScript() {
  return `#!/bin/sh
[ "\${ORCH_GRAPH_AUTOCOMMIT}" = "1" ] || exit 0

CHECKPOINT=".git/GRAPH_CHECKPOINT"
REPO_ROOT=$(git rev-parse --show-toplevel)
COMMIT_HASH=$(git rev-parse --short HEAD)

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
3. touch $REPO_ROOT/$CHECKPOINT

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
      ok('post-commit hook already installed');
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
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--harness' && rest[i + 1]) {
      for (const h of rest[i + 1].split(',')) {
        const name = h.trim();
        if (name && !harnesses.includes(name)) harnesses.push(name);
      }
      i++; // consume the value
    }
  }
  if (harnesses.length === 0) harnesses.push('claude');
  return {
    service: rest.includes('--service'),
    harnesses,
    harness: harnesses[0],
    enableGraphAutocommit: rest.includes('--graph-autocommit'),
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
  const sample = JSON.parse(
    fs.readFileSync(samplePath, 'utf8').replace(/__INSTALL_DIR__/g, INSTALL_DIR)
  );
  const classifyMarker = `${INSTALL_DIR}/adapters/cursor/classify.sh`;
  const gateMarker = `${INSTALL_DIR}/adapters/cursor/orch-gate.sh`;
  const todoMarker = `${INSTALL_DIR}/adapters/cursor/post-todo-adopt.sh`;
  const extras = [{ event: 'postToolUse', entries: cursorTodoMintEntry() }];

  if (fs.existsSync(dest)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(dest, 'utf8')); }
    catch (e) { warn('Cannot parse .cursor/hooks.json — leaving as-is'); return; }
    const content = JSON.stringify(existing);
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

function checkOpencodePlugin(cwd) {
  const srcDir = path.join(INSTALL_DIR, 'packages', 'opencode-plugin');
  const pluginDir = path.join(cwd, '.opencode', 'plugins');
  const opencodeDir = path.join(cwd, '.opencode');
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
  const defaultPkg = JSON.stringify({ dependencies: { '@opencode-ai/plugin': 'latest' } }, null, 2) + '\n';
  if (fs.existsSync(pkgPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (existing.dependencies && existing.dependencies['@opencode-ai/plugin']) {
        ok('.opencode/package.json already has @opencode-ai/plugin');
      } else {
        fix('Merging @opencode-ai/plugin into .opencode/package.json...');
        existing.dependencies = { ...(existing.dependencies || {}), '@opencode-ai/plugin': 'latest' };
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
  log('OpenCode runs bun install in .opencode/ at startup.');
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
  const sampleJson = JSON.parse(fs.readFileSync(sample, 'utf8').replace(/__INSTALL_DIR__/g, INSTALL_DIR));
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
// does not disturb the 1st (Codex → ~/.codex/config.toml; claude/cursor/opencode
// → MERGE into <cwd>/.mcp.json preserving sibling servers).
function wireHarness(harness, cwd) {
  if (harness === 'claude') {
    // INVARIANT 4: delegate .mcp.json + settings.json to bin/install.js
    checkClaudeWiring(cwd);
    // CLAUDE.md merge is kept here (bin/install.js doesn't own CLAUDE.md)
    checkClaude(cwd);
  } else if (harness === 'cursor') {
    checkCursorHooks(cwd);
    checkMcp(cwd, 'cursor');
    warn('Cursor init uses native .cursor/hooks.json — do not also wire adapters/cursor/settings.sample.json (double execution)');
  } else if (harness === 'codex') {
    checkCodexHooks();
    // Codex reads MCP from ~/.codex/config.toml (TOML), NOT <cwd>/.mcp.json.
    writeCodexMcp();
    installCodexRepoSkills(cwd);
    warn('Codex init skips Claude settings.json / CLAUDE.md — wire hooks via ~/.codex/hooks.json');
  } else if (harness === 'opencode') {
    checkOpencodePlugin(cwd);
    checkMcp(cwd);
    warn('OpenCode init skips Claude hooks — wire orchestrator MCP in opencode.json for start_task / complete_task');
  }
}

function printNextSteps(harness, cwd = process.cwd()) {
  const dash = dashboardUrl(cwd);
  if (harness === 'codex') {
    console.log('  Next steps (codex):');
    console.log('    1. Open /hooks in Codex CLI and trust the Zonoid hook definitions');
    console.log('    2. Restart Codex in this directory');
    console.log(`    3. Open the dashboard: ${dash}`);
    console.log('    4. Mint tasks with Codex MCP create_task (file-drop stub + /sync), then start_task before editing');
    console.log('    5. Heartbeat: MCP ScheduleWakeup(delaySeconds, reason, prompt) — run the returned');
    console.log('       tail command on the session .fire file; on ORCH_SCHEDULED_TASK, re-inject the prompt');
    console.log('    6. Repo skill installed at .codex/skills/zonoid-orchestrator for task-mint workflow');
    console.log('    7. orch-loop skill (installed under ~/.claude/skills) documents the full loop pattern');
  } else if (harness === 'cursor') {
    console.log('  Next steps (cursor):');
    console.log('    1. Trust the workspace in Cursor so project hooks run');
    console.log('    2. Restart Cursor in this directory');
    console.log(`    3. Open the dashboard: ${dash}`);
    console.log('    4. Mint tasks via todo adoption or MCP, then start_task before editing');
    console.log('    5. Heartbeat: MCP ScheduleWakeup(delaySeconds, reason, prompt) — monitor stdout with');
    console.log('       the returned tail command (notify_pattern ORCH_SCHEDULED_TASK) and re-inject the prompt');
    console.log('    6. orch-loop skill (installed under ~/.claude/skills) documents the full loop pattern');
  } else if (harness === 'opencode') {
    console.log('  Next steps (opencode):');
    console.log('    1. Wire orchestrator MCP in opencode.json (stdio transport)');
    console.log('    2. Restart OpenCode in this directory');
    console.log(`    3. Open the dashboard: ${dash}`);
    console.log('    4. Use task_create (file-drop stub + /sync) to mint, then start_task before editing');
    console.log('    5. Heartbeat: schedule_wakeup(delaySeconds, reason, prompt) — monitor ORCH_SCHEDULED_TASK on the session .fire file');
  } else {
    console.log('  Next steps (claude):');
    console.log('    1. Restart Claude Code in this directory');
    console.log(`    2. Open the dashboard: ${dash}`);
    console.log('    3. Ask Claude to start working — it will create tasks automatically');
    console.log('');
    console.log('  Tip: if Claude says "no task claimed", that\'s the gate working —');
    console.log('  Claude will create a task automatically before editing.');
  }
  console.log('    Repo learning: run `npx @zonoid/cli onboard` to mine, validate, and review KB notes');
}

async function init(opts = {}) {
  const cwd = process.cwd();
  // Accept either the new harnesses[] (multi) or legacy single harness.
  const harnesses = (opts.harnesses && opts.harnesses.length)
    ? opts.harnesses
    : [opts.harness || 'claude'];
  for (const h of harnesses) {
    if (!VALID_HARNESSES.has(h)) {
      console.error(`Unknown --harness "${h}" — use claude|cursor|codex|opencode`);
      process.exit(1);
    }
  }
  console.log(`\nZonoid init — workspace: ${cwd}`);
  console.log(`Install dir:  ${INSTALL_DIR}`);
  console.log(`Harness:      ${harnesses.join(', ')}\n`);

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
  await checkDaemon();
  await registerWorkspace(cwd);

  section('6. Graph auto-commit hook');
  checkGraphAutocommitHook(cwd, { enable: opts.enableGraphAutocommit });

  section('7. Warmup');
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
  } else if (cmd === 'onboard') {
    onboard(parseOnboardArgs(process.argv));
  } else {
    console.log('Usage:');
    console.log('  npx @zonoid/cli init [--harness claude|cursor|codex|opencode] [--service] [--graph-autocommit]');
    console.log('  npx @zonoid/cli onboard [--repo <path>] [--force] [--skip-learn] [--model opus] [--max-keep 20]');
    console.log('');
    console.log('Commands:');
    console.log('  init      Wire daemon, hooks/plugins, MCP, skills, and dashboard for this workspace.');
    console.log('  onboard   Mine + validate repo KB and stop at a human review gate before injection.');
    console.log('');
    console.log('  --harness  claude (default) | cursor | codex | opencode — adapter wiring.');
    console.log('             Accepts a comma-separated list and/or repeats, e.g.');
    console.log('             --harness claude,codex  → wires BOTH in one run (coexistence).');
    console.log('  --service  Install user-level launchd (macOS) or systemd (Linux) service');
    console.log('             so the daemon starts on login and survives IDE restarts.');
    console.log('  --graph-autocommit  Set ORCH_GRAPH_AUTOCOMMIT=1 in ~/.claude/settings.json env');
    console.log('             to enable automatic graph snapshot commits after each git commit.');
    console.log('             Without this flag the hook is installed but disabled (flag is "0").');
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
    // CDX-2: Claude+Codex coexistence — MCP store split + multi-harness init
    writeMcp,
    writeCodexMcp,
    orchestratorMcpEntry,
    codexMcpTomlBlock,
    stripCodexOrchTable,
    // graph auto-commit hook helpers
    graphAutocommitHookScript,
    mergeGraphAutocommitFlag,
    parseOnboardArgs,
    dashboardUrl,
    renderClaudeInstructions,
  };
}
