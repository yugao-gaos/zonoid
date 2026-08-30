#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-doc-daemon-data-'));
const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-doc-daemon-a-'));
const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-doc-daemon-b-'));
const port = 20100 + Math.floor(Math.random() * 200);
// The production embed client eagerly checks this pidfile before spawning its detached sidecar.
// Point it at this live test process so the route test cannot leak a model process after teardown.
fs.writeFileSync(path.join(dataDir, 'embed.pid'), String(process.pid));

function seed(repo, name) {
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  fs.writeFileSync(path.join(repo, 'docs', 'guide.md'), `# ${name} guide\n`);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
}
seed(repoA, 'Alpha');
seed(repoB, 'Beta');

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: route, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await request('GET', '/health');
      if (response.status === 200 && response.body.phase === 'ready') return;
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('daemon did not become ready');
}

const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env,
    CLAUDE_PLUGIN_DATA: dataDir,
    ORCH_PORT: String(port),
    ORCH_TOKEN: '',
    ZONOID_SKIP_LIVE: '1',
  },
  stdio: 'ignore',
});

(async () => {
  await waitForHealth();
  const scope = (repo) => `workspace=${encodeURIComponent(repo)}`;
  const indexA = await request('GET', `/documentation?${scope(repoA)}`);
  const indexB = await request('GET', `/documentation?${scope(repoB)}`);
  assert.equal(indexA.status, 200);
  assert.equal(indexB.status, 200);
  assert.ok(indexA.body.documents.some((item) => item.title === 'Alpha'));
  assert.ok(indexB.body.documents.some((item) => item.title === 'Beta'));
  assert.ok(!indexA.body.documents.some((item) => item.title === 'Beta'), 'workspace A cannot see workspace B documentation');

  const readA = await request('GET', `/documentation/file?${scope(repoA)}&path=README.md`);
  assert.equal(readA.status, 200);
  const saveA = await request('POST', '/documentation/file', {
    workspace: repoA,
    path: 'README.md',
    content: '# Alpha updated\n',
    expected_hash: readA.body.document.hash,
  });
  assert.equal(saveA.status, 200);
  assert.equal(fs.readFileSync(path.join(repoA, 'README.md'), 'utf8'), '# Alpha updated\n');
  assert.equal(fs.readFileSync(path.join(repoB, 'README.md'), 'utf8'), '# Beta\n');

  const missingScope = await request('GET', '/documentation');
  assert.equal(missingScope.status, 400);
  const traversal = await request('GET', `/documentation/file?${scope(repoA)}&path=${encodeURIComponent('../README.md')}`);
  assert.equal(traversal.status, 400);

  console.log('PASS  live daemon documentation routes stay workspace-scoped');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  child.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(repoA, { recursive: true, force: true });
  fs.rmSync(repoB, { recursive: true, force: true });
});
