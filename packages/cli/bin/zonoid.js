#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const http = require('http');

const REPO_URL = 'https://github.com/yugao-gaos/zonoid';
const INSTALL_DIR = path.join(os.homedir(), '.claude', 'orchestrator');

function log(msg) {
  console.log(`  ${msg}`);
}

function step(n, msg) {
  console.log(`\n[${n}] ${msg}`);
}

// Step 1: Clone or verify install
function ensureInstalled() {
  step(1, 'Checking Zonoid install at ~/.claude/orchestrator');
  if (fs.existsSync(path.join(INSTALL_DIR, 'package.json'))) {
    log('Already installed, skipping clone.');
    return;
  }
  log(`Cloning ${REPO_URL} ...`);
  fs.mkdirSync(path.dirname(INSTALL_DIR), { recursive: true });
  execSync(`git clone ${REPO_URL} ${INSTALL_DIR}`, { stdio: 'inherit' });
  log('Cloned.');
}

// Step 2: npm install
function npmInstall() {
  step(2, 'Running npm install in install dir');
  execSync('npm install', { cwd: INSTALL_DIR, stdio: 'inherit' });
  log('Done.');
}

// Step 3: Write .claude/settings.json
function writeSettings(cwd) {
  step(3, 'Writing .claude/settings.json');
  const dest = path.join(cwd, '.claude', 'settings.json');
  if (fs.existsSync(dest)) {
    log(`${dest} already exists, skipping.`);
    return;
  }
  const src = path.join(INSTALL_DIR, '.claude', 'settings.sample.json');
  let content;
  try {
    content = fs.readFileSync(src, 'utf8').replace(/__INSTALL_DIR__/g, INSTALL_DIR);
  } catch (e) {
    log(`error: sample file not found at ${src} — is the install complete?`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  log(`Written: ${dest}`);
}

// Step 4: Write .mcp.json
function writeMcp(cwd) {
  step(4, 'Writing .mcp.json');
  const dest = path.join(cwd, '.mcp.json');
  if (fs.existsSync(dest)) {
    log(`${dest} already exists, skipping.`);
    return;
  }
  const src = path.join(INSTALL_DIR, 'mcp.sample.json');
  let content;
  try {
    content = fs.readFileSync(src, 'utf8').replace(/__INSTALL_DIR__/g, INSTALL_DIR);
  } catch (e) {
    log(`error: sample file not found at ${src} — is the install complete?`);
    process.exit(1);
  }
  fs.writeFileSync(dest, content);
  log(`Written: ${dest}`);
}

// Step 5: Merge CLAUDE.md
function mergeClaude(cwd) {
  step(5, 'Merging CLAUDE.md');
  const dest = path.join(cwd, 'CLAUDE.md');
  const src = path.join(INSTALL_DIR, 'CLAUDE.md');
  if (!fs.existsSync(src)) {
    log('Source CLAUDE.md not found in install dir, skipping.');
    return;
  }
  const srcContent = fs.readFileSync(src, 'utf8');
  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, 'utf8');
    if (existing.includes('Orchestrator dashboard')) {
      log('CLAUDE.md already contains orchestrator section, skipping.');
      return;
    }
    fs.writeFileSync(dest, existing + '\n\n' + srcContent);
    log(`Appended orchestrator section to ${dest}`);
  } else {
    fs.writeFileSync(dest, srcContent);
    log(`Created ${dest}`);
  }
}

// Step 6: POST /graph/init
function graphInit(cwd) {
  step(6, 'Registering workspace with orchestrator daemon');
  return new Promise((resolve) => {
    const body = JSON.stringify({ workspace: cwd });
    const req = http.request(
      { hostname: 'localhost', port: 8787, path: '/graph/init', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        res.resume();
        log(`Daemon responded: ${res.statusCode}`);
        resolve();
      }
    );
    req.on('error', () => {
      log('Daemon not running, skipping.');
      resolve();
    });
    req.setTimeout(3000, () => { req.destroy(); log('Daemon timeout, skipping.'); resolve(); });
    req.write(body);
    req.end();
  });
}

async function init() {
  const cwd = process.cwd();
  console.log(`\nZonoid init — workspace: ${cwd}`);

  ensureInstalled();
  npmInstall();
  writeSettings(cwd);
  writeMcp(cwd);
  mergeClaude(cwd);
  await graphInit(cwd);

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
