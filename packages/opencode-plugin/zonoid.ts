/**
 * Zonoid orchestrator bridge for OpenCode.
 * @see packages/opencode-plugin/README.md
 */
import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import { writeTaskStub } from './lib/stub-writer.js';
import { gateWriteTool, orchPost } from './lib/gate.js';

const sessionAgents = new Map();

export const ZonoidPlugin: Plugin = async ({ directory, worktree }) => {
  const workspace = worktree || directory;

  return {
    event: async ({ event }) => {
      const ev = event;
      const type = ev?.type || '';
      const props = ev?.properties || {};
      const sessionID = String(props.sessionID ?? props.sessionId ?? props.id ?? '');

      if (type === 'session.created' && sessionID) {
        const agentId = String(props.agentID ?? props.agent_id ?? `opencode-${sessionID.slice(0, 8)}`);
        sessionAgents.set(sessionID, agentId);
        await orchPost('/agent/start', {
          agent_id: agentId,
          agent_type: 'opencode',
          session: sessionID,
          workspace,
        }).catch(() => {});
        return;
      }

      if ((type === 'session.idle' || type === 'session.deleted') && sessionID) {
        const agentId = sessionAgents.get(sessionID) || `opencode-${sessionID.slice(0, 8)}`;
        sessionAgents.delete(sessionID);
        await orchPost('/agent/done', { agent_id: agentId, workspace }).catch(() => {});
      }
    },

    'tool.execute.before': async (input, output) => {
      const args = (output.args && typeof output.args === 'object') ? output.args : {};
      await gateWriteTool(input.sessionID, input.tool, args);
    },

    tool: {
      task_create: tool({
        description: 'Mint a Zonoid orchestrator task (file-drop stub + POST /sync).',
        args: {
          id: tool.schema.string().describe('Task id → opencode/<id>'),
          subject: tool.schema.string().describe('Short title'),
          description: tool.schema.string().optional(),
          blockedBy: tool.schema.array(tool.schema.string()).optional(),
        },
        async execute(args, ctx) {
          const agentId = ctx.sessionID ? `opencode-${ctx.sessionID.slice(0, 8)}` : 'opencode-agent';
          const ws = ctx.worktree || ctx.directory || workspace;
          const { key, file } = writeTaskStub(ws, {
            id: args.id,
            subject: args.subject,
            description: args.description,
            blockedBy: args.blockedBy,
            agent_id: agentId,
          });

          try {
            const sync = await orchPost('/sync', { workspace: ws });
            if (sync) {
              return JSON.stringify({
                ok: true, task_key: key, file,
                adopted: sync.adopted ?? [],
                suggestions: sync.suggestions ?? {},
              }, null, 2);
            }
          } catch { /* stub durable on disk */ }

          return JSON.stringify({ ok: true, task_key: key, file, warning: 'daemon unreachable' }, null, 2);
        },
      }),
    },
  };
};

export default ZonoidPlugin;
