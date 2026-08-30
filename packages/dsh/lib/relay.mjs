import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_PORT = 8787

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeout])
    : timeout
}

export function canonicalWorkspace(value) {
  const workspace = String(value || '').trim()
  if (!workspace) return ''
  try {
    return realpathSync.native ? realpathSync.native(workspace) : realpathSync(workspace)
  } catch {
    return path.resolve(workspace)
  }
}

export function createRelay(config = {}) {
  const fetchImpl = config.fetchImpl || globalThis.fetch
  const port = Number(config.port || process.env.ORCH_PORT || DEFAULT_PORT)
  const origin = config.origin || `http://127.0.0.1:${port}`

  async function request(method, pathname, body, signal, timeoutMs = 1500) {
    if (typeof fetchImpl !== 'function') return null
    try {
      const response = await fetchImpl(`${origin}${pathname}`, {
        method,
        ...(body === undefined ? {} : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        signal: combinedSignal(signal, timeoutMs),
      })
      if (!response.ok) return null
      return await response.json()
    } catch {
      return null
    }
  }

  return {
    get: (pathname, signal, timeoutMs) => request('GET', pathname, undefined, signal, timeoutMs),
    post: (pathname, body, signal, timeoutMs) => request('POST', pathname, body, signal, timeoutMs),
  }
}

export function workspaceFromAgent(agent) {
  return canonicalWorkspace(agent?.session?.header?.cwd)
}

export function sessionIdFromAgent(agent) {
  return String(agent?.id || agent?.session?.id || '').trim()
}

export function textFromMessages(messages) {
  if (!Array.isArray(messages)) return ''
  return messages
    .filter((message) => message?.role === 'user' && message?.source?.kind === 'user')
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function contextFromResponse(response) {
  const value = response?.additional_context ?? response?.additionalContext ?? response?.context
  return typeof value === 'string' ? value.trim() : ''
}

export function contextMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'plugin', plugin: '@zonoid/dsh', form: 'instructions' }),
  })
}

export function query(pathname, params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params || {})) {
    if (value != null && String(value)) search.set(key, String(value))
  }
  const suffix = search.toString()
  return suffix ? `${pathname}?${suffix}` : pathname
}
