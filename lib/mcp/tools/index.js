'use strict';

const graphTools = require('./graph');
const assignmentTools = require('./assignment');
const judgeTools = require('./judge');
const agentTools = require('./agents');
const knowledgeTools = require('./knowledge');
const subconsciousTools = require('./subconscious');
const gitTools = require('./git');
const guidanceTools = require('./guidance');
const uiTools = require('./ui');
const loopTools = require('./loop');

const TOOL_ORDER = [
  "get_graph",
  "internal_lanes",
  "subconscious_assignment",
  "start_task",
  "complete_task",
  "set_status",
  "get_dependency_summaries",
  "get_task_detail",
  "get_judge_next",
  "submit_judge_verdict",
  "attach_knowledge",
  "record_decision",
  "supersede_note",
  "create_gate",
  "add_dependency",
  "mark_root",
  "remove_dependency",
  "list_agents",
  "request_agent_stop",
  "suggest_links",
  "enqueue_kb",
  "drain_kb_batch",
  "drain_kb_queue",
  "drain_kb_queue_status",
  "inject_kb",
  "get_learnings",
  "subconscious_search_context",
  "ask_subconscious",
  "subconscious_execution_permit",
  "subconscious_skill",
  "subconscious_loop",
  "subconscious_session_companion",
  "subconscious_anchor_allocator",
  "subconscious_idea_scheduler",
  "search_knowledge",
  "entity_context",
  "graph_delta",
  "resolve_context_handle",
  "next_action",
  "loop_control",
  "peek_workspace",
  "configure_task",
  "measure_task",
  "branch_task",
  "remove_worktree",
  "merge_attempt",
  "create_feature",
  "merge_feature",
  "get_attempt_diff",
  "request_guidance",
  "list_guidance",
  "ask_gate",
  "block_task",
  "unblock_task",
  "supersede_task",
  "show_dashboard"
];

const IDENTITY_PROPERTIES = {
  workspace_id: { type: 'string', description: 'Named workspace group identity.' },
  graph_repo: { type: 'string', description: 'Graph-bearing repository path for this request.' },
  target_repo: { type: 'string', description: 'Git operation repository path. Required for Git mutations unless the task has a persisted target.' },
  workspace: { type: 'string', description: 'Deprecated alias for graph_repo.' },
  repo_path: { type: 'string', description: 'Deprecated alias for target_repo.' },
};

function withRequestIdentity(tool) {
  const schema = tool.inputSchema;
  if (!schema || schema.type !== 'object') return tool;
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: { ...IDENTITY_PROPERTIES, ...(schema.properties || {}) },
    },
  };
}

function createTools(deps) {
  const grouped = [
    ...graphTools(deps),
    ...assignmentTools(deps),
    ...judgeTools(deps),
    ...agentTools(deps),
    ...knowledgeTools(deps),
    ...subconsciousTools(deps),
    ...gitTools(deps),
    ...guidanceTools(deps),
    ...uiTools(deps),
    ...loopTools(deps),
  ];
  const byName = Object.fromEntries(grouped.map((tool) => [tool.name, tool]));
  return TOOL_ORDER.map((name) => {
    if (!byName[name]) throw new Error(`missing MCP tool definition: ${name}`);
    return withRequestIdentity(byName[name]);
  });
}

module.exports = { createTools, TOOL_ORDER, withRequestIdentity };
