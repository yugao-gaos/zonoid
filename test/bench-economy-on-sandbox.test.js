#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { seedOnSandbox } = require('../scripts/bench-economy');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-economy-on-sandbox-'));
try {
  const minimalSource = path.join(tmp, 'minimal-source');
  const sandbox = path.join(tmp, 'worktree', 'bench', 'sandbox');
  fs.mkdirSync(minimalSource, { recursive: true });
  fs.writeFileSync(path.join(minimalSource, 'input.js'), 'module.exports = 42;\n');
  fs.writeFileSync(path.join(minimalSource, 'tests.js'), 'require("./input");\n');

  seedOnSandbox(minimalSource, sandbox);

  assert.strictEqual(
    fs.readFileSync(path.join(sandbox, 'input.js'), 'utf8'),
    'module.exports = 42;\n'
  );
  assert.strictEqual(
    fs.readFileSync(path.join(sandbox, 'tests.js'), 'utf8'),
    'require("./input");\n'
  );
  console.log('bench-economy ON sandbox seeding test passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
