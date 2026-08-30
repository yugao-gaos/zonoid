import { realpathSync, writeFileSync } from 'node:fs'

export const name = 'zonoid-host-contract-probe'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'tools']

export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (typeof exit !== 'function') throw new Error('probe requires the DSH CLI appExit host value')
  const receipt = {
    lifecycle: [],
    toolPipeline: [],
    identity: {},
    results: {},
    teardown: { pluginDisposed: false },
  }
  const writeReceipt = () => writeFileSync(config.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)

  ctx.on('session/created', session => receipt.lifecycle.push(`session/created:${session.id}`), { global: true })
  ctx.on('session/event', (session, event) => receipt.lifecycle.push(`session/event:${session.id}:${event.type}`), { global: true })
  ctx.on('session/disposed', session => receipt.lifecycle.push(`session/disposed:${session.id}`), { global: true })
  ctx.on('session/flush', session => receipt.lifecycle.push(`session/flush:${session.id}`), { global: true })
  ctx.on('agent/created', ({ agent }) => receipt.lifecycle.push(`agent/created:${agent.id}`), { global: true })
  ctx.on('agent/session-start', ({ agent }) => receipt.lifecycle.push(`agent/session-start:${agent.id}`), { global: true })
  ctx.on('agent/disposed', ({ agent }) => receipt.lifecycle.push(`agent/disposed:${agent.id}`), { global: true })

  ctx.on('tools/pre-execute', async (exec, next) => {
    receipt.toolPipeline.push(`pre:${exec.arguments.mode}`)
    return exec.arguments.mode === 'deny'
      ? { kind: 'deny', reason: 'contract pre-deny' }
      : next()
  })
  ctx.on('tools/execute', async (exec, next) => {
    receipt.toolPipeline.push(`execute:${exec.arguments.mode}`)
    return next()
  })
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    receipt.toolPipeline.push(`post:${exec.arguments.mode}`)
    return exec.arguments.mode === 'post-block'
      ? { kind: 'block', feedback: [{ type: 'text', text: 'contract post-block' }] }
      : next()
  })
  ctx.on('tools/result', (exec, result) => {
    receipt.toolPipeline.push(`result:${exec.arguments.mode}:${result.isError ? 'error' : 'ok'}`)
  })

  ctx.effect(() => () => {
    receipt.teardown.pluginDisposed = true
    writeReceipt()
  })

  void (async () => {
    await ctx.get('loader')?.await()
    const agents = ctx.get('agents')
    const sessions = ctx.get('sessions')
    const tools = ctx.get('tools')
    const defaultModel = ctx.get('agentDefaultModel').currentSelection()
    const sessionId = 'session-zonoid-contract'
    const handle = await agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: defaultModel.provider, model: defaultModel.model },
    })
    const { agent } = handle
    receipt.identity = {
      agentId: agent.id,
      sessionId: agent.session.id,
      cwd: agent.session.header.cwd,
      canonicalCwd: realpathSync(process.cwd()),
    }

    const execute = (mode, callId) => tools.execute({
      signal: new AbortController().signal,
      callId,
      name: 'mcp__zonoid__contract_ping',
      arguments: { mode },
      agent,
    })
    receipt.results.allow = await execute('allow', 'contract-allow')
    receipt.results.deny = await execute('deny', 'contract-deny')
    receipt.results.postBlock = await execute('post-block', 'contract-post-block')
    await sessions.flush(agent.session)
    await handle.dispose()
    writeReceipt()
    exit(0)
  })().catch(error => {
    receipt.error = error instanceof Error ? error.stack : String(error)
    writeReceipt()
    exit(1)
  })
}
