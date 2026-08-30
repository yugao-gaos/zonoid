'use strict';

const { buildDashboardLaunch } = require('../../dashboard-launch');
const { createDashboardSnapshot, dashboardSnapshotHash } = require('../../dashboard-snapshot');

const SNAPSHOT_CACHE_LIMIT = 32;
const snapshotCache = new Map();

function rememberSnapshot(workspace, entry) {
  snapshotCache.delete(workspace);
  snapshotCache.set(workspace, entry);
  while (snapshotCache.size > SNAPSHOT_CACHE_LIMIT) snapshotCache.delete(snapshotCache.keys().next().value);
}

async function portableSnapshot(workspace, call) {
  const [state, guidanceResult] = await Promise.all([
    call('GET', '/state?scope=all'),
    call('GET', '/guidance'),
  ]);
  if (!state || state.error || !Array.isArray(state.tasks)) return null;

  const cards = state.kanban && Array.isArray(state.kanban.cards) ? state.kanban.cards : null;
  const frontierTaskIds = cards ? cards.map((card) => card && card.task_key).filter(Boolean) : undefined;
  const guidance = guidanceResult && Array.isArray(guidanceResult.user_attention)
    ? guidanceResult.user_attention
    : [];
  const candidate = createDashboardSnapshot({ tasks: state.tasks, frontierTaskIds, guidance });
  const hash = dashboardSnapshotHash(candidate.snapshot);
  const previous = snapshotCache.get(workspace);
  if (previous && previous.hash === hash) return { ...previous, changed: false };

  const entry = { hash, portable: candidate };
  rememberSnapshot(workspace, entry);
  return { ...entry, changed: true };
}

function uiTools(deps) {
  const { UI_URI, PORT, DASHBOARD_ORIGIN } = deps;
  return [
    {
      name: 'show_dashboard',
      description: 'Show the scoped orchestrator status using the best surface the client supports: MCP App enhancement, portable text/image result, or external-browser fallback.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: 'Workspace path for the scoped dashboard. Usually injected from the current session.' },
        },
        additionalProperties: false,
      },
      meta: {
        ui: {
          resourceUri: UI_URI,
          visibility: ['model', 'app'],
          csp: { connectDomains: [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, 'https://localhost:8788', 'https://127.0.0.1:8788'] },
        },
      },
      run: async (a, call) => {
        // The fixed resource URI remains the MCP App enhancement. The portable result below is
        // client-neutral; the launch contract remains the desktop/browser fallback.
        const ws = (a && a.workspace) || null;
        if (!ws) return { rendered: true, note: 'Dashboard shown inline; it polls the daemon live.' };

        const launch = buildDashboardLaunch({
          workspace: ws,
          port: PORT,
          origin: DASHBOARD_ORIGIN,
          viewer: a.viewer,
          resourceUri: UI_URI,
          capabilities: a.capabilities,
        });
        const result = {
          rendered: true,
          workspace: ws,
          launch,
          browser_url: launch.url,
          deep_link: launch.url,
          note: `Dashboard shown inline when supported. Otherwise use the portable snapshot or open it in a desktop browser: ${launch.url}`,
        };
        if (typeof call !== 'function') return result;

        const snapshot = await portableSnapshot(ws, call);
        if (!snapshot) return { ...result, snapshot_available: false };
        const { portable, hash, changed } = snapshot;
        return {
          ...result,
          snapshot_available: true,
          snapshot_hash: hash,
          snapshot_changed: changed,
          snapshot_generated_at: portable.generated_at,
          snapshot_text: portable.text,
          snapshot_summary: portable.summary_text,
          snapshot_event: changed ? { type: 'dashboard_snapshot_changed', state_hash: hash } : null,
          snapshot_delivery: {
            mime_type: portable.mime_type,
            width: portable.width,
            height: portable.height,
            interactive_resource: UI_URI,
            summary_text: portable.summary_text,
          },
          _mcp_delivery: {
            text: portable.summary_text,
            image: { type: 'image', data: portable.png_base64, mimeType: portable.mime_type },
          },
        };
      },
    },
  ];
}

uiTools._test = { snapshotCache };

module.exports = uiTools;
