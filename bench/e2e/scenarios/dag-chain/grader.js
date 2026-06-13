'use strict';
// E2E scenario grader for dag-chain.
// Usage: node grader.js <artifact-path> <expected-secret>
// Prints JSON: { ok, secretFound, artifact, expected, content }
const fs = require('fs');

const artifact = process.argv[2];
const expected = process.argv[3] || '';

if (!artifact) {
  console.log(JSON.stringify({ ok: false, error: 'usage: grader.js <artifact> [expected-secret]' }));
  process.exit(0);
}

let content = '';
let readErr = null;
if (fs.existsSync(artifact)) {
  try { content = fs.readFileSync(artifact, 'utf8').trim(); }
  catch (e) { readErr = e.message; }
} else {
  readErr = 'artifact missing';
}

const secretFound = expected ? content.includes(expected) : false;
console.log(JSON.stringify({
  ok: secretFound && !readErr,
  secretFound,
  artifact,
  expected,
  content: content.slice(0, 200),
  error: readErr,
}));
