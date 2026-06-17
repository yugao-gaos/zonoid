'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function startHookStub(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-http-stub-'));
  const configPath = path.join(dir, 'config.json');
  const readyPath = path.join(dir, 'ready.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, [path.join(__dirname, 'hook-http-stub-child.js'), configPath, readyPath], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(readyPath) && Date.now() < deadline) {
    if (child.exitCode != null) break;
    sleep(25);
  }
  if (!fs.existsSync(readyPath)) {
    try { child.kill(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('hook HTTP stub did not start');
  }
  const { port } = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
  return {
    env(extra = {}) {
      return { ORCH_PORT: String(port), ...extra };
    },
    stop() {
      try { child.kill(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function withHookStub(config, fn) {
  const stub = startHookStub(config);
  try { return fn(stub); }
  finally { stub.stop(); }
}

module.exports = { startHookStub, withHookStub };
