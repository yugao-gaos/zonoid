'use strict';

const { buildDashboardLaunch } = require('../../dashboard-launch');

function uiTools(deps) {
  const { UI_URI, PORT, DASHBOARD_ORIGIN } = deps;
  return [
  { name: 'show_dashboard', description: 'Render the orchestrator task-graph dashboard inline and return a client-neutral launch contract for the scoped full view.', inputSchema: { type: 'object', properties: { workspace: { type: 'string', description: 'Workspace path for the scoped dashboard. Omit only for the legacy inline-only response; no full-view launch URL is returned without a workspace.' } }, additionalProperties: false }, meta: { ui: { resourceUri: UI_URI, visibility: ['model', 'app'], csp: { connectDomains: [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, 'https://localhost:8788', 'https://127.0.0.1:8788'] } } }, run: (a) => {
      // The resourceUri is a fixed MCP protocol handle (ui://orchestrator/graph) — the MCP app
      // fetches it via resources/read, which serves public/inline.html. Parameterizing the URI
      // itself would require changes to both the MCP client's resource-fetch protocol and the
      // resources/read handler, which is out of scope and risks breaking existing consumers.
      // Instead, when the caller supplies a workspace, return a browser deep-link in the result
      // so the user or a consuming agent can navigate directly to the scoped view.
      const ws = (a && a.workspace) || null;
      if (ws) {
        const launch = buildDashboardLaunch({ workspace: ws, port: PORT, origin: DASHBOARD_ORIGIN, viewer: a.viewer, resourceUri: UI_URI });
        return Promise.resolve({
          rendered: true,
          workspace: ws,
          launch,
          browser_url: launch.url,
          deep_link: launch.url,
          note: `Dashboard shown inline. Use the launch contract for the best surface this client supports, or open: ${launch.url}`,
        });
      }
      return Promise.resolve({ rendered: true, note: 'Dashboard shown inline; it polls the daemon live.' });
    } }
  ];
}

module.exports = uiTools;
