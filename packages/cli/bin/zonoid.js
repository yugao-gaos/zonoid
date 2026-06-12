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

const PLIST_LABEL = 'com.zonoid.daemon';
const PLIST_PATH  = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

function checkLaunchd() {
  if (process.platform !== 'darwin') { log('Launchd auto-start: macOS only, skipping'); return; }

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

  // Write plist (always refresh so node path stays current after node upgrades)
  try {
    fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
    fs.writeFileSync(PLIST_PATH, plist);
  } catch (e) { warn(`Could not write plist: ${e.message}`); return; }

  // Unload stale registration, load fresh
  spawnSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' });
  const load = spawnSync('launchctl', ['load', '-w', PLIST_PATH], { encoding: 'utf8' });
  if (load.status === 0) ok(`Daemon registered as launchd service — starts on login, restarts on crash`);
  else warn(`launchctl load failed: ${(load.stderr || '').trim()}`);
}

async function init() {
  const cwd = process.cwd();
  console.log(`\nZonoid init — workspace: ${cwd}`);
  console.log(`Install dir:  ${INSTALL_DIR}\n`);

  section('1. Core install');
  checkInstallDir();
  checkNodeModules();
  checkHooks();

  section('2. Workspace config');
  checkSettings(cwd);
  checkMcp(cwd);
  checkClaude(cwd);

  section('3. Git identity');
  await checkGitIdentity();

  section('4. Skills');
  checkSkills();

  section('5. Daemon');
  checkLaunchd();
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
  console.log('    1. Restart Claude Code in this directory');
  console.log('    2. Open the dashboard: http://localhost:8787/graph');
  console.log('    3. Ask Claude to start working — it will create tasks automatically');
  console.log('');
  console.log('  Tip: if Claude says "no task claimed", that\'s the gate working.');
  console.log('  Just ask it to create a task first, then continue.\n');
}

const cmd = process.argv[2];
if (cmd === 'init') {
  init().catch((err) => { console.error(err); process.exit(1); });
} else {
  console.log('Usage: npx @zonoid/cli init');
  process.exit(cmd ? 1 : 0);
}
