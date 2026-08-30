'use strict';

const DEFAULT_PORT = 8787;
const DEFAULT_RESOURCE_URI = 'ui://orchestrator/graph';
const DEFAULT_CAPABILITIES = Object.freeze({
  mcp_apps: true,
  embedded_webview: true,
  desktop_browser: true,
});

function dashboardOrigin({ origin, port = DEFAULT_PORT } = {}) {
  const raw = origin || `http://localhost:${Number(port)}`;
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw new Error('dashboard origin must be a valid absolute URL'); }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('dashboard origin must use http or https');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('dashboard origin must not contain credentials, query parameters, or a fragment');
  }
  if (parsed.pathname && parsed.pathname !== '/') {
    throw new Error('dashboard origin must not contain a path');
  }
  if (!origin) {
    const numericPort = Number(port);
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
      throw new Error('dashboard port must be an integer between 1 and 65535');
    }
  }
  return parsed.origin;
}

function dashboardViewer(viewer) {
  if (viewer == null || String(viewer).trim() === '') return null;
  const normalized = String(viewer).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(normalized)) {
    throw new Error('dashboard viewer must be a simple host id');
  }
  return normalized;
}

function dashboardUrl({ workspace, origin, port, viewer } = {}) {
  if (typeof workspace !== 'string' || !workspace.trim()) {
    throw new Error('dashboard workspace is required');
  }
  const normalizedViewer = dashboardViewer(viewer);
  const viewerQuery = normalizedViewer ? `&viewer=${encodeURIComponent(normalizedViewer)}` : '';
  return `${dashboardOrigin({ origin, port })}/graph?workspace=${encodeURIComponent(workspace)}${viewerQuery}`;
}

function dashboardCapabilities(capabilities = {}) {
  if (!capabilities || typeof capabilities !== 'object') return { ...DEFAULT_CAPABILITIES };
  const normalized = { ...DEFAULT_CAPABILITIES };
  if (capabilities.mcp_apps != null) normalized.mcp_apps = !!capabilities.mcp_apps;
  if (capabilities.embedded_webview != null) normalized.embedded_webview = !!capabilities.embedded_webview;
  if (capabilities.desktop_browser != null) normalized.desktop_browser = !!capabilities.desktop_browser;
  return normalized;
}

function buildDashboardLaunch({ workspace, origin, port, viewer, resourceUri = DEFAULT_RESOURCE_URI, capabilities } = {}) {
  const normalizedViewer = dashboardViewer(viewer);
  const url = dashboardUrl({ workspace, origin, port, viewer: normalizedViewer });
  const caps = dashboardCapabilities(capabilities);
  const surfaces = [];
  if (caps.mcp_apps) {
    surfaces.push({ id: 'mcp_app', type: 'mcp_resource', resource_uri: resourceUri, requires: 'mcp_apps' });
  }
  if (caps.embedded_webview) {
    surfaces.push({ id: 'embedded_web', type: 'url', url, requires: 'embedded_webview' });
  }
  if (caps.desktop_browser) {
    surfaces.push({ id: 'external_browser', type: 'url', url, requires: 'desktop_browser' });
  }
  return {
    version: 1,
    workspace,
    ...(normalizedViewer ? { viewer: normalizedViewer } : {}),
    url,
    resource_uri: resourceUri,
    preferred_surface: surfaces[0] ? surfaces[0].id : null,
    fallback_surface: surfaces.length ? surfaces[surfaces.length - 1].id : null,
    surfaces,
  };
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_RESOURCE_URI,
  dashboardOrigin,
  dashboardViewer,
  dashboardUrl,
  dashboardCapabilities,
  buildDashboardLaunch,
};
