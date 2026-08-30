import { createBridge } from './lib/bridge.mjs'
import { createRelay } from './lib/relay.mjs'

export const name = '@zonoid/dsh'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const bridge = createBridge({ relay: createRelay(config), port: config.port })
  const global = { global: true }

  ctx.on('session/created', (session) => bridge.sessionCreated(session), global)
  ctx.on('agent/created', ({ agent }) => bridge.ensureStarted(agent), global)
  ctx.on('agent/session-start', ({ agent }) => bridge.sessionStart(agent), global)
  ctx.on('agent/pre-step', (payload, next) => bridge.preStep(payload, next), global)
  ctx.on('tools/pre-execute', (exec, next) => bridge.preTool(exec, next))
  ctx.on('tools/result', (exec) => bridge.nudge(exec.agent, exec.signal))
  ctx.on('session/flush', (session) => bridge.nudge({ id: session.id, session }), global)
  ctx.on('agent/disposed', ({ agent }) => bridge.agentDisposed(agent), global)
  ctx.on('session/disposed', (session) => bridge.sessionDisposed(session), global)
  ctx.effect(() => () => bridge.close())
}

export default { name, inject, apply }
