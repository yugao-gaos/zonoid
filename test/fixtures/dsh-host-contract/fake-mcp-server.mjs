#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const logPath = process.env.ZONOID_DSH_MCP_LOG

function log(event) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(event)}\n`)
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (!line.trim()) continue
  const message = JSON.parse(line)
  log({ method: message.method, params: message.params })
  if (message.id === undefined) continue

  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'zonoid-contract-fixture', version: '1.0.0' },
    })
  } else if (message.method === 'tools/list') {
    reply(message.id, {
      tools: [{
        name: 'contract_ping',
        description: 'Return the requested probe mode.',
        inputSchema: {
          type: 'object',
          properties: { mode: { type: 'string' } },
          required: ['mode'],
          additionalProperties: false,
        },
      }],
    })
  } else if (message.method === 'tools/call') {
    reply(message.id, {
      content: [{ type: 'text', text: `pong:${message.params.arguments.mode}` }],
    })
  } else {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `unsupported method: ${message.method}` },
    })}\n`)
  }
}
log({ method: 'stdio/eof' })
