'use strict';

function uiTools(deps) {
  const { q, UI_URI, PORT, runSubconsciousAssignment } = deps;
  return [
  { name: 'show_dashboard', description: 'Render the orchestrator task-graph dashboard INLINE in the conversation (interactive, live-updating). Use when the user wants to SEE the graph without a browser.', inputSchema: { type: 'object', properties: { workspace: { type: 'string', description: 'Optional workspace path to scope the dashboard view. When omitted the inline widget uses the daemon-global workspace.' } }, additionalProperties: false }, meta: { ui: { resourceUri: UI_URI, visibility: ['model', 'app'], csp: { connectDomains: [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, 'https://localhost:8788', 'https://127.0.0.1:8788'] } } }, run: (a) => {
      // The resourceUri is a fixed MCP protocol handle (ui://orchestrator/graph) — the MCP app
      // fetches it via resources/read, which serves public/inline.html. Parameterizing the URI
      // itself would require changes to both the MCP client's resource-fetch protocol and the
      // resources/read handler, which is out of scope and risks breaking existing consumers.
      // Instead, when the caller supplies a workspace, return a browser deep-link in the result
      // so the user or a consuming agent can navigate directly to the scoped view.
      const ws = (a && a.workspace) || null;
      if (ws) {
        const deepLink = `http://localhost:${PORT}/graph?workspace=${encodeURIComponent(ws)}`;
        return Promise.resolve({ rendered: true, workspace: ws, deep_link: deepLink, note: `Dashboard shown inline. To view only workspace '${ws}', open: ${deepLink}` });
      }
      return Promise.resolve({ rendered: true, note: 'Dashboard shown inline; it polls the daemon live.' });
    } }
  ];
}

module.exports = uiTools;
