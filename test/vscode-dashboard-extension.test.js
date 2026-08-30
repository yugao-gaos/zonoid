#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const extension = require('../packages/vscode-dashboard/extension');
const { buildVsixBuffer, OUTPUT } = require('../packages/vscode-dashboard/package-vsix');
const {
  DASHBOARD_EXTENSION_ID,
  dashboardExtensionInstallDirs,
  installDashboardExtension,
} = require('../packages/cli/bin/zonoid');

function fakeVscode() {
  const calls = { commands: [], forwarded: [], opened: [], warnings: [], errors: [], panels: [] };
  const first = { uri: { fsPath: '/workspace/first' } };
  const active = { uri: { fsPath: '/workspace/active' } };
  const api = {
    ViewColumn: { One: 1 },
    Uri: { parse: (value) => ({ value, toString: () => value }) },
    workspace: {
      workspaceFolders: [first, active],
      getWorkspaceFolder: () => active,
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    },
    window: {
      activeTextEditor: { document: { uri: { fsPath: '/workspace/active/file.js' } } },
      createWebviewPanel: (...args) => {
        const panel = { args, webview: { html: '' } };
        calls.panels.push(panel);
        return panel;
      },
      showWarningMessage: (message) => calls.warnings.push(message),
      showErrorMessage: (message) => calls.errors.push(message),
    },
    env: {
      appName: 'Visual Studio Code',
      asExternalUri: async (uri) => {
        calls.forwarded.push(uri.value);
        const value = uri.value.replace('http://localhost:8787', 'https://forward.example/proxy/8787');
        return { value, toString: () => value };
      },
      openExternal: async (uri) => { calls.opened.push(uri.value); return true; },
    },
    commands: {
      registerCommand: (name, fn) => {
        calls.commands.push({ name, fn });
        return { dispose() {} };
      },
    },
  };
  return { api, calls };
}

(async () => {
  const { api, calls } = fakeVscode();
  assert.equal(extension.activeWorkspaceFolder(api).uri.fsPath, '/workspace/active');
  assert.equal(
    extension.localDashboardUrl(api, extension.activeWorkspaceFolder(api)),
    'http://localhost:8787/graph?workspace=%2Fworkspace%2Factive&viewer=vscode',
  );
  api.env.appName = 'Cursor';
  assert.equal(extension.dashboardViewer(api), 'cursor');
  api.env.appName = 'Visual Studio Code';

  const context = { subscriptions: [] };
  extension.activate(context, api);
  assert.deepEqual(calls.commands.map((entry) => entry.name), [
    'zonoid.openDashboard',
    'zonoid.openDashboardExternal',
  ]);
  assert.equal(context.subscriptions.length, 2);

  const panel = await extension.openDashboard(api);
  assert(panel && calls.panels.length === 1);
  assert.equal(calls.forwarded.length, 1, 'asExternalUri runs before embedding');
  assert(calls.forwarded[0].includes('workspace=%2Fworkspace%2Factive'));
  assert(panel.webview.html.includes("default-src 'none'"));
  assert(panel.webview.html.includes("base-uri 'none'"));
  assert(panel.webview.html.includes('frame-src https://forward.example'));
  assert(!panel.webview.html.includes('enableScripts'));

  const unsafe = {
    toString: () => 'https://forward.example/graph?workspace=%2Ftmp%2Fx&value=%22onload%3D%22alert(1)',
  };
  const safeHtml = extension.dashboardHtml(unsafe, 'fixed-nonce');
  assert(safeHtml.includes('&amp;value='));
  assert(!safeHtml.includes('" onload="'));
  assert.throws(() => extension.dashboardHtml({ toString: () => 'javascript:alert(1)' }));

  await extension.openExternalDashboard(api);
  assert.equal(calls.forwarded.length, 2, 'external open also resolves remote/forwarded URI');
  assert(calls.opened[0].startsWith('https://forward.example/'));

  const fallback = fakeVscode();
  fallback.api.window.createWebviewPanel = () => { throw new Error('webviews disabled'); };
  const fallbackResult = await extension.openDashboard(fallback.api);
  assert.equal(fallbackResult, false);
  assert.equal(fallback.calls.opened.length, 1, 'panel failure opens the resolved URL externally');
  assert.equal(fallback.calls.warnings.length, 1);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-vsix-install-'));
  try {
    const vsixPath = path.join(tmp, 'zonoid.vsix');
    fs.writeFileSync(vsixPath, 'fixture');
    let current = false;
    const invocations = [];
    const spawnImpl = (editor, args) => {
      invocations.push([editor, ...args]);
      if (args[0] === '--list-extensions') {
        return { status: 0, stdout: current ? `${DASHBOARD_EXTENSION_ID}@0.1.0\n` : '' };
      }
      current = true;
      fs.mkdirSync(dashboardExtensionInstallDirs(editor, '0.1.0', tmp)[0], { recursive: true });
      return { status: 0, stdout: '' };
    };
    const firstInstall = installDashboardExtension('cursor', { vsixPath, spawnImpl, homeDir: tmp });
    const firstInvocationCount = invocations.length;
    const secondInstall = installDashboardExtension('cursor', { vsixPath, spawnImpl, homeDir: tmp });
    assert(firstInstall.ok && firstInstall.installed);
    assert(secondInstall.ok && !secondInstall.installed && secondInstall.current);
    assert.equal(invocations.length, firstInvocationCount, 'idempotent check does not launch the editor CLI again');
    assert(invocations.some((args) => args[0] === 'cursor' && args[1] === '--install-extension'));

    const codeInstall = installDashboardExtension('code', {
      vsixPath,
      homeDir: path.join(tmp, 'code-home'),
      spawnImpl: (editor, args) => args[0] === '--list-extensions'
        ? { status: 0, stdout: `${DASHBOARD_EXTENSION_ID}@0.1.0\n` }
        : { status: 0, stdout: '' },
    });
    assert(codeInstall.ok && codeInstall.editor === 'code');

    const unavailable = installDashboardExtension('cursor', {
      vsixPath,
      homeDir: path.join(tmp, 'missing-home'),
      spawnImpl: () => ({ status: null, error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }),
    });
    assert.equal(unavailable.reason, 'cli_unavailable');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const a = buildVsixBuffer();
  const b = buildVsixBuffer();
  assert(a.equals(b), 'VSIX packaging is deterministic');
  assert.equal(a.readUInt32LE(0), 0x04034b50);
  assert(fs.readFileSync(OUTPUT).equals(a), 'checked-in VSIX matches deterministic builder');
  assert(require('../package.json').files.includes('packages/vscode-dashboard/'));

  console.log('ok vscode/cursor dashboard extension');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
