/**
 * Zonoid orchestrator bridge for OpenCode.
 * @see packages/opencode-plugin/README.md
 */
import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import { createRequire } from 'node:module';
import { writeTaskStub } from './lib/stub-writer.js';
import { gateWriteTool, orchPost } from './lib/gate.js';
import { injectClassifiedContext, postWorkspace } from './lib/prompt-context.js';

const require = createRequire(import.meta.url);
const scheduleWakeup = require('./lib/schedule-wakeup.js');

const sessionAgents = new Map();

export const ZonoidPlugin: Plugin = async ({ directory, worktree }) => {
  const workspace = worktree || directory;
  await postWorkspace(workspace, orchPost);

  return {
    event: async ({ event }) => {
      const ev = event;
      const type = ev?.type || '';
      const props = ev?.properties || {};
      const sessionID = String(props.sessionID ?? props.sessionId ?? props.id ?? '');

      if (type === 'session.created') {
        await postWorkspace(workspace, orchPost);
        if (sessionID) {
          const agentId = String(props.agentID ?? props.agent_id ?? `opencode-${sessionID.slice(0, 8)}`);
          sessionAgents.set(sessionID, agentId);
          await orchPost('/agent/start', {
            agent_id: agentId,
            agent_type: 'opencode',
            session: sessionID,
            workspace,
          }).catch(() => {});
        }
        return;
      }

      if ((type === 'session.idle' || type === 'session.deleted') && sessionID) {
        const agentId = sessionAgents.get(sessionID) || `opencode-${sessionID.slice(0, 8)}`;
        sessionAgents.delete(sessionID);
        await orchPost('/agent/done', { agent_id: agentId, workspace }).catch(() => {});
      }
    },

    'chat.message': async (input, output) => {
      await injectClassifiedContext(input, output, { workspace, post: orchPost });
    },

    'tool.execute.before': async (input, output) => {
      const args = (output.args && typeof output.args === 'object') ? output.args : {};
      await gateWriteTool(input.sessionID, input.tool, args);
    },

    tool: {
      task_create: tool({
        description: 'Mint a Zonoid orchestrator task (file-drop stub + POST /sync).',
        args: {
          id: tool.schema.string().describe('Task id -> opencode/<id>; use letters, numbers, dot, underscore, or dash only'),
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

      schedule_wakeup: tool({
        description:
          'ScheduleWakeup: cancel any prior wake for this session, then arm a delayed re-prompt (Claude-compatible).',
        args: {
          delaySeconds: tool.schema.number().describe('Seconds until the wake fires'),
          reason: tool.schema.string().optional().describe('Why this wake was scheduled'),
          prompt: tool.schema.string().describe('Prompt injected when the wake fires'),
        },
        async execute(args, ctx) {
          const session = ctx.sessionID;
          if (!session) {
            return JSON.stringify({ ok: false, error: 'session required' }, null, 2);
          }
          const delaySeconds = Math.max(0, Math.floor(Number(args.delaySeconds) || 0));
          const reason = args.reason != null ? String(args.reason) : '';
          const prompt = String(args.prompt ?? '');
          const result = scheduleWakeup.armWakeup({ session, delaySeconds, reason, prompt });
          if (!result.ok) {
            return JSON.stringify(result, null, 2);
          }
          const payload = { delaySeconds, reason, prompt };
          return JSON.stringify({
            ok: true,
            pid: result.pid,
            delaySeconds: result.delaySeconds,
            session: result.session,
            command: `ORCH_SCHEDULED_TASK ${JSON.stringify(payload)}`,
            notify_pattern: 'ORCH_SCHEDULED_TASK',
          }, null, 2);
        },
      }),
    },
  };
};

export default ZonoidPlugin;
