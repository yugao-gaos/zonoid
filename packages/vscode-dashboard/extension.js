'use strict';

const crypto = require('crypto');

const DEFAULT_ORIGIN = 'http://localhost:8787';

function activeWorkspaceFolder(vscode) {
  const editorUri = vscode.window.activeTextEditor
    && vscode.window.activeTextEditor.document
    && vscode.window.activeTextEditor.document.uri;
  const active = editorUri && vscode.workspace.getWorkspaceFolder
    ? vscode.workspace.getWorkspaceFolder(editorUri)
    : null;
  return active || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]) || null;
}

function normalizedOrigin(raw) {
  const parsed = new URL(raw || DEFAULT_ORIGIN);
  if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error('zonoid.dashboardOrigin must be an http(s) origin without credentials, path, query, or fragment');
  }
  return parsed.origin;
}

function localDashboardUrl(vscode, folder) {
  const configured = vscode.workspace.getConfiguration
    ? vscode.workspace.getConfiguration('zonoid').get('dashboardOrigin', DEFAULT_ORIGIN)
    : DEFAULT_ORIGIN;
  const workspace = folder && folder.uri && folder.uri.fsPath;
  if (!workspace) throw new Error('Open a workspace folder before opening the Zonoid dashboard.');
  return `${normalizedOrigin(configured)}/graph?workspace=${encodeURIComponent(workspace)}`;
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function dashboardHtml(uri, nonce = crypto.randomBytes(16).toString('base64')) {
  const href = typeof uri.toString === 'function' ? uri.toString(true) : String(uri);
  const parsed = new URL(href);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('The forwarded dashboard URI must use http or https.');
  }
  const src = escapeHtmlAttribute(parsed.href);
  const frameOrigin = escapeHtmlAttribute(parsed.origin);
  const safeNonce = escapeHtmlAttribute(nonce);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; frame-src ${frameOrigin}; style-src 'nonce-${safeNonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Zonoid Dashboard</title>
  <style nonce="${safeNonce}">html,body,iframe{width:100%;height:100%;margin:0;padding:0;border:0;overflow:hidden}</style>
</head>
<body><iframe src="${src}" title="Zonoid Dashboard"></iframe></body>
</html>`;
}

function showWorkspaceError(vscode, error) {
  const message = error && error.message ? error.message : String(error);
  return vscode.window.showErrorMessage(message);
}

async function resolveDashboardUri(vscode, folder) {
  const local = vscode.Uri.parse(localDashboardUrl(vscode, folder));
  return vscode.env.asExternalUri(local);
}

async function openExternalDashboard(vscode, folder = activeWorkspaceFolder(vscode), resolvedUri) {
  try {
    const uri = resolvedUri || await resolveDashboardUri(vscode, folder);
    return await vscode.env.openExternal(uri);
  } catch (error) {
    showWorkspaceError(vscode, error);
    return false;
  }
}

async function openDashboard(vscode, folder = activeWorkspaceFolder(vscode)) {
  let uri;
  try {
    uri = await resolveDashboardUri(vscode, folder);
    const panel = vscode.window.createWebviewPanel(
      'zonoidDashboard',
      'Zonoid Dashboard',
      vscode.ViewColumn.One,
      { enableScripts: false, retainContextWhenHidden: true },
    );
    panel.webview.html = dashboardHtml(uri);
    return panel;
  } catch (error) {
    if (uri) {
      vscode.window.showWarningMessage(`Could not embed the Zonoid dashboard: ${error.message}. Opening it in your browser.`);
      await vscode.env.openExternal(uri);
      return false;
    }
    showWorkspaceError(vscode, error);
    return false;
  }
}

function activate(context, api) {
  const vscode = api || require('vscode');
  const embedded = vscode.commands.registerCommand('zonoid.openDashboard', () => openDashboard(vscode));
  const external = vscode.commands.registerCommand('zonoid.openDashboardExternal', () => openExternalDashboard(vscode));
  context.subscriptions.push(embedded, external);
}

function deactivate() {}

module.exports = {
  DEFAULT_ORIGIN,
  activeWorkspaceFolder,
  normalizedOrigin,
  localDashboardUrl,
  escapeHtmlAttribute,
  dashboardHtml,
  resolveDashboardUri,
  openExternalDashboard,
  openDashboard,
  activate,
  deactivate,
};
