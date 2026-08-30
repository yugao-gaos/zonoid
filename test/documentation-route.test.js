#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const documentation = require('../lib/project-documentation');
const documentationRoute = require('../routes/documentation');

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-docs-'));

function write(relative, content) {
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

write('README.md', '# Main project\n');
write('AGENTS.md', '# Workspace instructions\n');
write('LICENSE', 'Project license text.\n');
write('NOTICE', 'Project notice text.\n');
write('docs/guide.md', '# Guide\nInitial.\n');
write('docs/nested/design.mdx', '# Design\n');
write('packages/widget/README.md', '# Widget package\n');
write('adapters/demo/README.md', '# Demo adapter\n');
write('schemas/README.md', '# Schemas\n');
write('.github/CONTRIBUTING.md', '# GitHub contribution guide\n');
write('bench/hidden.md', '# Generated benchmark\n');
write('reports/hidden.md', '# Generated report\n');
write('skills/demo/SKILL.md', '# Agent instructions\n');
write('src/private.md', '# Not project documentation\n');
write('bench-results-report.md', '# Generated root benchmark\n');
write('docs/huge.md', 'x'.repeat(documentation.MAX_DOCUMENT_BYTES + 1));
try { fs.symlinkSync(path.join(workspace, 'README.md'), path.join(workspace, 'docs', 'linked.md')); } catch { /* platform */ }

execFileSync('git', ['init', '-q'], { cwd: workspace });
execFileSync('git', ['add', '-A'], { cwd: workspace });

const listed = documentation.listDocuments(workspace);
const paths = listed.map((item) => item.path);
for (const expected of [
  'README.md', 'AGENTS.md', 'LICENSE', 'NOTICE', 'docs/guide.md', 'docs/nested/design.mdx',
  'packages/widget/README.md', 'adapters/demo/README.md', 'schemas/README.md', '.github/CONTRIBUTING.md',
]) assert.ok(paths.includes(expected), `lists ${expected}`);
for (const excluded of [
  'bench/hidden.md', 'reports/hidden.md', 'skills/demo/SKILL.md', 'src/private.md',
  'bench-results-report.md', 'docs/huge.md', 'docs/linked.md',
]) assert.ok(!paths.includes(excluded), `excludes ${excluded}`);
assert.equal(listed[0].section, 'Project', 'root project documentation is ordered first');

const guide = documentation.readDocument(workspace, 'docs/guide.md');
assert.equal(guide.title, 'Guide');
assert.match(guide.hash, /^[a-f0-9]{64}$/);
const saved = documentation.writeDocument(workspace, guide.path, '# Guide\nUpdated.\n', guide.hash);
assert.equal(saved.content, '# Guide\nUpdated.\n');
assert.notEqual(saved.hash, guide.hash);
assert.throws(
  () => documentation.writeDocument(workspace, guide.path, 'stale overwrite', guide.hash),
  (error) => error.code === 'document_conflict' && error.status === 409,
  'stale edits are rejected instead of overwriting newer documentation',
);
for (const invalid of ['../README.md', '/etc/passwd', 'src/private.md', 'docs/untracked.md']) {
  assert.throws(() => documentation.readDocument(workspace, invalid),
    (error) => error instanceof documentation.DocumentationError,
    `rejects ${invalid}`);
}
assert.throws(() => documentation.readDocument(workspace, 'docs/huge.md'),
  (error) => error.code === 'document_too_large' && error.status === 413);

async function callRoute(method, url, body = null) {
  let response;
  const route = documentationRoute({
    send(_res, status, payload) { response = { status, payload }; },
    readBody: async () => body || {},
    targetOverlay(input, parsed) {
      return { ws: input.graph_repo || parsed.searchParams.get('workspace') || null };
    },
  });
  const parsed = new URL(url, 'http://localhost');
  const handled = await route(parsed.pathname, method, {}, {}, parsed, null);
  assert.equal(handled, true);
  return response;
}

(async () => {
  const index = await callRoute('GET', `/documentation?workspace=${encodeURIComponent(workspace)}`);
  assert.equal(index.status, 200);
  assert.ok(index.payload.documents.some((item) => item.path === 'README.md'));

  const loaded = await callRoute('GET', `/documentation/file?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent('README.md')}`);
  assert.equal(loaded.status, 200);
  const updated = await callRoute('POST', '/documentation/file', {
    graph_repo: workspace,
    path: 'README.md',
    content: '# Main project\nUpdated through route.\n',
    expected_hash: loaded.payload.document.hash,
  });
  assert.equal(updated.status, 200);
  assert.match(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8'), /Updated through route/);

  const stale = await callRoute('POST', '/documentation/file', {
    graph_repo: workspace,
    path: 'README.md',
    content: 'stale',
    expected_hash: loaded.payload.document.hash,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.payload.code, 'document_conflict');

  const traversal = await callRoute('GET', `/documentation/file?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent('../README.md')}`);
  assert.equal(traversal.status, 400);

  fs.rmSync(workspace, { recursive: true, force: true });
  console.log('PASS  project documentation discovery, confinement, and conflict-safe editing');
})().catch((error) => {
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
  console.error(error);
  process.exitCode = 1;
});
