// Harness-scoped MCP tools — NOT part of the default lib/mcp-core.js TOOLS surface.
// The stdio server (mcp-graph.js) merges these via handleRpc ctx.extraTools when
// ZONOID_HARNESS selects a harness that needs adapter-specific minting helpers.
'use strict';
const fs = require('fs');
const path = require('path');

// Codex minting: write a stub JSON into the designated file-drop folder, then pull via /sync.
function createTaskTool(workspace, harness) {
  return {
    name: 'create_task',
    description: 'Mint a new task in the orchestrator graph by writing a file-drop stub and calling POST /sync (Codex harness). Returns { ok, task_key, adopted, suggestions }.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id within the harness namespace (becomes codex/<id>).' },
        subject: { type: 'string', description: 'Short imperative label for the task.' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        blockedBy: { type: 'array', items: { type: 'string' }, description: 'Prerequisite task keys (<harness>/<id> or bare id namespaced to this harness).' },
        agent_id: { type: 'string', description: 'Provenance: which agent minted the task.' },
      },
      required: ['id', 'subject'],
      additionalProperties: false,
    },
    run: async (a, call) => {
      const filedrop = require('./filedrop-tasks');
      const id = String(a.id || '').trim();
      const subject = String(a.subject || '').trim();
      if (!id || !subject) return { error: 'id and subject are required' };
      const stub = {
        id,
        subject,
        description: a.description || '',
        status: a.status || 'pending',
        created_by: { harness, agent_id: a.agent_id || null },
      };
      if (Array.isArray(a.blockedBy) && a.blockedBy.length) stub.blockedBy = a.blockedBy;
      const dir = path.join(filedrop.dirFor(workspace), harness);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${id}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(stub, null, 2));
      fs.renameSync(tmp, file);
      const sync = await call('POST', '/sync', {});
      if (sync && sync.error) return sync;
      const task_key = `${harness}/${id}`;
      return { ok: true, task_key, adopted: sync.adopted, suggestions: sync.suggestions };
    },
  };
}

function extraToolsForHarness(harness, workspace) {
  if (harness === 'codex') return [createTaskTool(workspace, 'codex')];
  return [];
}

module.exports = { createTaskTool, extraToolsForHarness };
