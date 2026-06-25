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
  let ready = null;
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    if (fs.existsSync(readyPath)) {
      try {
        ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
        if (ready && Number.isFinite(Number(ready.port))) break;
      } catch {
        ready = null;
      }
    }
    sleep(25);
  }
  if (!ready || !Number.isFinite(Number(ready.port))) {
    try { child.kill(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('hook HTTP stub did not start');
  }
  const { port } = ready;
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
  try {
    const result = fn(stub);
    if (result && typeof result.then === 'function') {
      return result.finally(() => stub.stop());
    }
    stub.stop();
    return result;
  } catch (e) {
    stub.stop();
    throw e;
  }
}

module.exports = { startHookStub, withHookStub };
