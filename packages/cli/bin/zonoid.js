#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');
const http = require('http');

const REPO_URL = 'https://github.com/yugao-gaos/zonoid';
const INSTALL_DIR = path.join(os.homedir(), '.claude', 'orchestrator');
const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

// ── output helpers ──────────────────────────────────────────────────────────

function log(msg)       { console.log(`  ${msg}`); }
function ok(msg)        { console.log(`  ✓ ${msg}`); }
function warn(msg)      { console.log(`  ⚠ ${msg}`); }
function fix(msg)       { console.log(`  ↻ ${msg}`); }
function section(title) { console.log(`\n── ${title} ─────────────────────────────`); }

// ── individual checks & fixes ───────────────────────────────────────────────

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
    fix('Removing incomplete install and re-cloning...');
    execSync(`rm -rf ${INSTALL_DIR}`);
  } else {
    fix(`Cloning ${REPO_URL} ...`);
    fs.mkdirSync(path.dirname(INSTALL_DIR), { recursive: true });
  }
  execSync(`git clone ${REPO_URL} ${INSTALL_DIR}`, { stdio: 'inherit' });
  ok('Cloned.');
}

function checkNodeModules() {
  const nm = path.join(INSTALL_DIR, 'node_modules');
  if (fs.existsSync(nm) && fs.readdirSync(nm).length > 0) {
    ok('node_modules present');
    return;
  }
  fix('Running npm install — downloading ML model (~200 MB), takes 1–3 min...');
  execSync('npm install', { cwd: INSTALL_DIR, stdio: 'inherit' });
  ok('npm install done.');
}

function checkHooks() {
  const required = [
    'start-daemon.sh', 'classify.sh', 'orch-gate.sh', 'orch-stop.sh',
    'subagent-start.sh', 'subagent-stop.sh', 'post-agent.sh',
    'suggest-links.sh', 'statusline.sh',
  ];
  const missing = required.filter(h => !fs.existsSync(path.join(INSTALL_DIR, 'hooks', h)));
  if (missing.length === 0) { ok('All hook scripts present'); return; }
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

function checkMcp(cwd) {
  const dest = path.join(cwd, '.mcp.json');
  if (!fs.existsSync(dest)) {
    fix('.mcp.json missing — writing from sample...');
    writeMcp(cwd);
    return;
  }
  let content;
  try { content = fs.readFileSync(dest, 'utf8'); } catch (e) { warn('Cannot read .mcp.json'); return; }

  const hasTemplate = content.includes('__INSTALL_DIR__') || content.includes('${CLAUDE_PLUGIN_ROOT}');
  const hasWrongPath = content.includes('mcp-graph.js') && !content.includes(INSTALL_DIR);
  if (hasTemplate || hasWrongPath) {
    warn(`.mcp.json has ${hasTemplate ? 'unresolved template tokens' : 'wrong path'} — rewriting...`);
    writeMcp(cwd, true);
    return;
  }
  ok('.mcp.json looks correct');
}

function writeMcp(cwd, overwrite = false) {
  const dest = path.join(cwd, '.mcp.json');
  const src  = path.join(INSTALL_DIR, 'mcp.sample.json');
  let content;
  try {
    content = fs.readFileSync(src, 'utf8')
      .replace(/__INSTALL_DIR__/g, INSTALL_DIR)
      .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, INSTALL_DIR);
  } catch (e) { warn(`Sample not found at ${src}`); return; }
  if (overwrite && fs.existsSync(dest)) {
    fs.copyFileSync(dest, dest + '.bak');
    log(`Backed up existing .mcp.json to ${dest}.bak`);
  }
  fs.writeFileSync(dest, content);
  ok(`Written: ${dest}`);
}

function checkClaude(cwd) {
  const dest = path.join(cwd, 'CLAUDE.md');
  const src  = path.join(INSTALL_DIR, 'CLAUDE.md');
  if (!fs.existsSync(src)) { warn('Source CLAUDE.md not found in install dir'); return; }
  const srcContent = fs.readFileSync(src, 'utf8');
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

    // Install as symlink so updates to the repo are picked up automatically
    fs.symlinkSync(src, dest);
    installed++;
    ok(`Skill installed: ${skill}`);
  }

  if (skipped > 0)  ok(`${skipped} skill(s) already up to date`);
  if (repaired > 0) ok(`${repaired} skill(s) repaired`);
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
      spawnSync('node', [path.join(INSTALL_DIR, 'daemon.js')], { detached: true, stdio: 'ignore' });
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
  const gitName  = (() => { try { return execSync('git config user.name',  { encoding: 'utf8' }).trim(); } catch { return ''; } })();
  const gitEmail = (() => { try { return execSync('git config user.email', { encoding: 'utf8' }).trim(); } catch { return ''; } })();

  const nameMissing  = !gitName  || PLACEHOLDER_NAMES.has(gitName.toLowerCase());
  const emailMissing = !gitEmail || gitEmail.endsWith('@localhost');

  if (!nameMissing && !emailMissing) {
    ok(`git identity: ${gitName} <${gitEmail}>`);
    return;
  }

  warn('git user.name / user.email not set (commits will be anonymous)');
  const name  = nameMissing  ? await ask(`  Your name  [${gitName  || 'e.g. Jane Smith'}]: `) : gitName;
  const email = emailMissing ? await ask(`  Your email [${gitEmail || 'e.g. you@example.com'}]: `) : gitEmail;

  if (name)  { execSync(`git config --global user.name  "${name.replace(/"/g, '\\"')}"`);  ok(`set user.name  = ${name}`); }
  if (email) { execSync(`git config --global user.email "${email.replace(/"/g, '\\"')}"`); ok(`set user.email = ${email}`); }
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

  spawnSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' });
  const load = spawnSync('launchctl', ['load', '-w', PLIST_PATH], { encoding: 'utf8' });
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

  const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
  if (reload.status !== 0) {
    warn(`systemctl daemon-reload failed: ${(reload.stderr || reload.stdout || '').trim()}`);
    log(`Unit written to ${SYSTEMD_PATH} — run: systemctl --user enable --now ${SYSTEMD_UNIT}`);
    return;
  }
  const enable = spawnSync('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT], { encoding: 'utf8' });
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

function parseInitArgs(argv) {
  const rest = argv.slice(3);
  const harnessIdx = rest.indexOf('--harness');
  const harness = harnessIdx >= 0 && rest[harnessIdx + 1] ? rest[harnessIdx + 1] : 'claude';
  return { service: rest.includes('--service'), harness };
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
  const gateMarker = `${INSTALL_DIR}/adapters/cursor/orch-gate.sh`;
  const todoMarker = `${INSTALL_DIR}/adapters/cursor/post-todo-adopt.sh`;
  const extras = [{ event: 'postToolUse', entries: cursorTodoMintEntry() }];

  if (fs.existsSync(dest)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(dest, 'utf8')); }
    catch (e) { warn('Cannot parse .cursor/hooks.json — leaving as-is'); return; }
    const content = JSON.stringify(existing);
    if (content.includes(gateMarker) && content.includes(todoMarker)) {
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

function checkCodexHooks() {
  const sample = path.join(INSTALL_DIR, 'adapters', 'codex', 'hooks.json.sample');
  const dest = path.join(os.homedir(), '.codex', 'hooks.json');
  if (!fs.existsSync(sample)) { warn(`Codex hook sample missing at ${sample}`); return; }
  let content = fs.readFileSync(sample, 'utf8').replace(/__INSTALL_DIR__/g, INSTALL_DIR);
  chmodScripts(path.join(INSTALL_DIR, 'adapters', 'codex', 'hooks'));
  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, 'utf8');
    if (existing.includes(INSTALL_DIR) && existing.includes('adapters/codex/hooks/')) {
      ok('~/.codex/hooks.json already references this install');
      return;
    }
    fix('Merging Codex hooks into ~/.codex/hooks.json...');
    fs.copyFileSync(dest, dest + '.bak');
    log('Backed up existing hooks.json to hooks.json.bak');
  } else {
    fix('Writing ~/.codex/hooks.json from sample...');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
  }
  fs.writeFileSync(dest, content);
  ok(`Written: ${dest}`);
  log('Open /hooks in Codex CLI to review and trust hook definitions.');
}

function writeCodexMcp(cwd, overwrite = false) {
  const dest = path.join(cwd, '.mcp.json');
  const src = path.join(INSTALL_DIR, 'adapters', 'codex', 'mcp.sample.json');
  if (!fs.existsSync(src)) { warn(`Codex MCP sample missing at ${src}`); return; }
  const content = fs.readFileSync(src, 'utf8').replace(/__INSTALL_DIR__/g, INSTALL_DIR);
  if (overwrite && fs.existsSync(dest)) {
    fs.copyFileSync(dest, dest + '.bak');
    log(`Backed up existing .mcp.json to ${dest}.bak`);
  }
  fs.writeFileSync(dest, content);
  ok(`Written Codex MCP config: ${dest} (ZONOID_HARNESS=codex)`);
}

async function init(opts = {}) {
  const cwd = process.cwd();
  const harness = opts.harness || 'claude';
  if (!VALID_HARNESSES.has(harness)) {
    console.error(`Unknown --harness "${harness}" — use claude|cursor|codex|opencode`);
    process.exit(1);
  }
  console.log(`\nZonoid init — workspace: ${cwd}`);
  console.log(`Install dir:  ${INSTALL_DIR}`);
  console.log(`Harness:      ${harness}\n`);

  section('1. Core install');
  checkInstallDir();
  checkNodeModules();
  checkHooks();

  section('2. Workspace config');
  if (harness === 'claude') {
    checkSettings(cwd);
    checkMcp(cwd);
    checkClaude(cwd);
  } else if (harness === 'cursor') {
    checkCursorHooks(cwd);
    checkMcp(cwd);
    warn('Cursor init uses native .cursor/hooks.json — do not also wire adapters/cursor/settings.sample.json (double execution)');
  } else if (harness === 'codex') {
    checkCodexHooks();
    writeCodexMcp(cwd, fs.existsSync(path.join(cwd, '.mcp.json')));
    warn('Codex init skips Claude settings.json / CLAUDE.md — wire hooks via ~/.codex/hooks.json');
  } else if (harness === 'opencode') {
    checkOpencodePlugin(cwd);
    checkMcp(cwd);
    warn('OpenCode init skips Claude hooks — wire orchestrator MCP in opencode.json for start_task / complete_task');
  }


  if (harness !== 'claude') {
    section('2b. ScheduleWakeup');
    checkScheduleWakeupShim(harness);
    if (harness === 'opencode') verifyOpencodeScheduleWakeup();
  }

  section('3. Git identity');
  await checkGitIdentity();

  section('4. Skills');
  checkSkills();

  section('5. Daemon');
  if (opts.service) installService();
  await checkDaemon();
  await registerWorkspace(cwd);

  section('6. Warmup');
  const warmupScript = path.join(INSTALL_DIR, 'scripts', 'warmup-embeddings.js');
  if (fs.existsSync(warmupScript)) {
    fix('Warming up embedding model (first search_knowledge will be instant)...');
    const r = spawnSync('node', [warmupScript], { encoding: 'utf8', timeout: 130000 });
    if (r.status === 0) ok('Embedding model ready.');
    else warn('Warmup timed out — first search_knowledge may be slow.');
  }

  console.log('\n✓ Done.\n');
  console.log('  Next steps:');
  if (harness === 'codex') {
    console.log('    1. Open /hooks in Codex CLI and trust the Zonoid hook definitions');
    console.log('    2. Restart Codex in this directory');
    console.log('    3. Open the dashboard: http://localhost:8787/graph');
    console.log('    4. Mint tasks with MCP create_task, then start_task before editing');
    console.log('    5. Heartbeat: MCP ScheduleWakeup(delaySeconds, reason, prompt) — run the returned');
    console.log('       tail command on the session .fire file; on ORCH_SCHEDULED_TASK, re-inject the prompt');
    console.log('    6. orch-loop skill (installed under ~/.claude/skills) documents the full loop pattern');
  } else if (harness === 'cursor') {
    console.log('    1. Trust the workspace in Cursor so project hooks run');
    console.log('    2. Restart Cursor in this directory');
    console.log('    3. Open the dashboard: http://localhost:8787/graph');
    console.log('    4. Mint tasks via todo adoption or MCP, then start_task before editing');
    console.log('    5. Heartbeat: MCP ScheduleWakeup(delaySeconds, reason, prompt) — monitor stdout with');
    console.log('       the returned tail command (notify_pattern ORCH_SCHEDULED_TASK) and re-inject the prompt');
    console.log('    6. orch-loop skill (installed under ~/.claude/skills) documents the full loop pattern');
  } else if (harness === 'opencode') {
    console.log('    1. Wire orchestrator MCP in opencode.json (stdio transport)');
    console.log('    2. Restart OpenCode in this directory');
    console.log('    3. Open the dashboard: http://localhost:8787/graph');
    console.log('    4. Use task_create to mint, then start_task before editing');
    console.log('    5. Heartbeat: schedule_wakeup(delaySeconds, reason, prompt) — monitor ORCH_SCHEDULED_TASK on the session .fire file');
  } else {
    console.log('    1. Restart Claude Code in this directory');
    console.log('    2. Open the dashboard: http://localhost:8787/graph');
    console.log('    3. Ask Claude to start working — it will create tasks automatically');
    console.log('');
    console.log('  Tip: if Claude says "no task claimed", that\'s the gate working —');
    console.log('  Claude will create a task automatically before editing.');
  }
  console.log('');
}

const cmd = process.argv[2];
if (require.main === module) {
  if (cmd === 'init') {
    init(parseInitArgs(process.argv)).catch((err) => { console.error(err); process.exit(1); });
  } else {
    console.log('Usage: npx @zonoid/cli init [--harness claude|cursor|codex|opencode] [--service]');
    console.log('');
    console.log('  --harness  claude (default) | cursor | codex | opencode — adapter wiring');
    console.log('  --service  Install user-level launchd (macOS) or systemd (Linux) service');
    console.log('             so the daemon starts on login and survives IDE restarts.');
    process.exit(cmd ? 1 : 0);
  }
} else {
  module.exports = {
    parseInitArgs,
    mergeCursorHooks,
    VALID_HARNESSES,
    scheduleWakeupScriptPath,
    opencodePluginHasScheduleWakeup,
    INSTALL_DIR,
  };
}
