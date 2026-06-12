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
  fix('Running npm install...');
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

function checkSettings(cwd) {
  const dest = path.join(cwd, '.claude', 'settings.json');
  if (!fs.existsSync(dest)) {
    fix('settings.json missing — writing from sample...');
    writeSettings(cwd);
    return;
  }
  let content;
  try { content = fs.readFileSync(dest, 'utf8'); } catch (e) { warn('Cannot read settings.json'); return; }

  const hasTemplate = content.includes('__INSTALL_DIR__') || content.includes('${CLAUDE_PLUGIN_ROOT}');
  // Wrong path = references a hooks/ path but not this install dir
  const hasWrongPath = /["'].*\/hooks\//.test(content) && !content.includes(INSTALL_DIR);
  if (hasTemplate || hasWrongPath) {
    warn(`settings.json has ${hasTemplate ? 'unresolved template tokens' : 'wrong hook paths'} — rewriting...`);
    writeSettings(cwd, true);
    return;
  }
  ok('settings.json looks correct');
}

function writeSettings(cwd, overwrite = false) {
  const dest = path.join(cwd, '.claude', 'settings.json');
  const src  = path.join(INSTALL_DIR, '.claude', 'settings.sample.json');
  let content;
  try {
    content = fs.readFileSync(src, 'utf8')
      .replace(/__INSTALL_DIR__/g, INSTALL_DIR)
      .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, INSTALL_DIR);
  } catch (e) { warn(`Sample not found at ${src}`); return; }
  if (overwrite && fs.existsSync(dest)) {
    fs.copyFileSync(dest, dest + '.bak');
    log(`Backed up existing settings to ${dest}.bak`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  ok(`Written: ${dest}`);
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
  await checkDaemon();
  await registerWorkspace(cwd);

  console.log('\n✓ Done. Restart Claude Code in this directory.');
  console.log('  Dashboard: http://localhost:8787/graph\n');
}

const cmd = process.argv[2];
if (cmd === 'init') {
  init().catch((err) => { console.error(err); process.exit(1); });
} else {
  console.log('Usage: npx @zonoid/cli init');
  process.exit(cmd ? 1 : 0);
}
