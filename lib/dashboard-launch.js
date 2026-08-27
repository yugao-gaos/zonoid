'use strict';

const DEFAULT_PORT = 8787;
const DEFAULT_RESOURCE_URI = 'ui://orchestrator/graph';

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

function dashboardUrl({ workspace, origin, port } = {}) {
  if (typeof workspace !== 'string' || !workspace.trim()) {
    throw new Error('dashboard workspace is required');
  }
  return `${dashboardOrigin({ origin, port })}/graph?workspace=${encodeURIComponent(workspace)}`;
}

function buildDashboardLaunch({ workspace, origin, port, resourceUri = DEFAULT_RESOURCE_URI } = {}) {
  const url = dashboardUrl({ workspace, origin, port });
  return {
    version: 1,
    workspace,
    url,
    resource_uri: resourceUri,
    preferred_surface: 'mcp_app',
    fallback_surface: 'external_browser',
    surfaces: [
      { id: 'mcp_app', type: 'mcp_resource', resource_uri: resourceUri, requires: 'mcp_apps' },
      { id: 'embedded_web', type: 'url', url, requires: 'embedded_webview' },
      { id: 'external_browser', type: 'url', url },
    ],
  };
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_RESOURCE_URI,
  dashboardOrigin,
  dashboardUrl,
  buildDashboardLaunch,
};
