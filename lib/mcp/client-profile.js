'use strict';

// DSH runs the orchestrator over a profile-owned stdio child. Keep that model-facing
// surface deliberately small: routine assignment, context, guidance, and dashboard
// operations are enough for a worker without exposing graph surgery or Git integration.
const DSH_TOOL_NAMES = Object.freeze([
  'subconscious_assignment',
  'get_dependency_summaries',
  'get_task_detail',
  'record_decision',
  'subconscious_search_context',
  'ask_subconscious',
  'search_knowledge',
  'resolve_context_handle',
  'request_guidance',
  'list_guidance',
  'show_dashboard',
]);

const DSH_TOOL_SET = new Set(DSH_TOOL_NAMES);

function clientName(ctx) {
  return String((ctx && ctx.client) || process.env.ORCH_CLIENT || '').trim().toLowerCase();
}

function toolsForClient(tools, client) {
  if (String(client || '').trim().toLowerCase() !== 'dsh') return tools;
  return tools.filter((tool) => DSH_TOOL_SET.has(tool.name));
}

module.exports = { DSH_TOOL_NAMES, clientName, toolsForClient };
