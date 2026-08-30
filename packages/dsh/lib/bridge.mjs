import {
  contextFromResponse,
  contextMessage,
  query,
  sessionIdFromAgent,
  textFromMessages,
  workspaceFromAgent,
} from './relay.mjs'
import { gateExecution } from './gate.mjs'

export function createBridge({ relay, port } = {}) {
  if (!relay) throw new Error('DSH bridge requires a relay')
  const active = new Map()
  const starts = new Map()
  const identified = new Set()

  async function ensureStarted(agent, signal) {
    const sessionId = sessionIdFromAgent(agent)
    const workspace = workspaceFromAgent(agent)
    if (!sessionId || !workspace) return null
    if (active.has(sessionId)) return active.get(sessionId)
    if (starts.has(sessionId)) return starts.get(sessionId)
    const start = (async () => {
      await relay.post('/workspace', { path: workspace }, signal)
      const started = await relay.post('/agent/start', {
        agent_id: sessionId,
        agent_type: 'dsh',
        session: sessionId,
        workspace,
      }, signal)
      const identity = { sessionId, workspace }
      if (started) active.set(sessionId, identity)
      return identity
    })().finally(() => starts.delete(sessionId))
    starts.set(sessionId, start)
    return start
  }

  async function finish(sessionId, workspace, signal) {
    const id = String(sessionId || '').trim()
    if (!id) return null
    await starts.get(id)
    const identity = active.get(id) || { sessionId: id, workspace }
    active.delete(id)
    return relay.post('/agent/done', {
      agent_id: id,
      workspace: identity.workspace || workspace,
    }, signal)
  }

  return {
    async sessionCreated(session, signal) {
      const workspace = workspaceFromAgent({ session })
      if (!workspace) return null
      return relay.post('/workspace', { path: workspace }, signal)
    },

    ensureStarted,

    async sessionStart(agent, signal) {
      const sessionId = sessionIdFromAgent(agent)
      if (sessionId && !identified.has(sessionId) && typeof agent?.inject === 'function') {
        identified.add(sessionId)
        agent.inject(contextMessage(
          `[Zonoid bridge] For orchestrator MCP calls, use session_id "${sessionId}". `
          + `Use agent_id "${sessionId}" only when a prepared assignment does not provide a different agent_id.`,
        ))
      }
      return ensureStarted(agent, signal)
    },

    async preStep(payload, next) {
      const identity = await ensureStarted(payload.agent, payload.signal)
      const prompt = textFromMessages(payload.messages)
      const classified = prompt && identity
        ? await relay.post('/classify', {
            prompt,
            session_id: identity.sessionId,
            workspace: identity.workspace,
          }, payload.signal)
        : null
      const decision = await next()
      const context = contextFromResponse(classified)
      if (!context || decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      return { ...decision, messages: [...decision.messages, contextMessage(context)] }
    },

    async preTool(exec, next) {
      const identity = await ensureStarted(exec.agent, exec.signal)
      if (!identity) return next()
      const stop = await relay.get(query('/should-stop', {
        session: identity.sessionId,
        agent: identity.sessionId,
        workspace: identity.workspace,
      }), exec.signal, 600)
      if (stop?.stop === true) {
        return { kind: 'deny', reason: `orch-stop: ${stop.reason || 'orchestrator requested stop'}` }
      }
      const gate = await gateExecution(exec, {
        relay,
        port,
        signal: exec.signal,
        sessionId: identity.sessionId,
        agentId: identity.sessionId,
        workspace: identity.workspace,
      })
      if (!gate.allow) return { kind: 'deny', reason: gate.reason }
      return next()
    },

    async agentDisposed(agent, signal) {
      identified.delete(sessionIdFromAgent(agent))
      return finish(sessionIdFromAgent(agent), workspaceFromAgent(agent), signal)
    },

    async sessionDisposed(session, signal) {
      const sessionId = String(session?.id || '').trim()
      const workspace = workspaceFromAgent({ session })
      identified.delete(sessionId)
      if (!active.has(sessionId) && !starts.has(sessionId)) return null
      return finish(sessionId, workspace, signal)
    },

    async nudge(agent, signal) {
      const identity = agent ? await ensureStarted(agent, signal) : null
      if (!identity) return null
      return relay.get(query('/ready', {
        session: identity.sessionId,
        workspace: identity.workspace,
      }), signal, 600)
    },

    async close() {
      await Promise.allSettled([...active.values()].map((identity) => finish(identity.sessionId, identity.workspace)))
    },

    active,
  }
}
