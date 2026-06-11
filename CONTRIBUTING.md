# Contributing to Zonoid

MIT licensed. No CLA. PRs welcome.

## Prerequisites

- Node.js >= 18
- Claude Code (the daemon integrates with it via MCP and hooks)

## Running locally

```bash
git clone https://github.com/yugao-gaos/zonoid
cd zonoid
npm install
node daemon.js          # starts on :8787 by default
# or: ORCH_PORT=9000 node daemon.js
```

Open http://localhost:8787/graph to see the dashboard.

## Architecture

The **daemon** (`daemon.js`) is an HTTP server that manages a per-workspace task graph layered on top of Claude Code's native task files. The **overlay** (`lib/overlay.js`) stores cross-session edges, richer statuses, and decision notes that survive beyond native task retention. The **MCP layer** (`lib/mcp-core.js`, `mcp-graph.js`) exposes the graph as Claude tools — both via stdio (for Claude Code) and via the daemon's `/mcp` endpoint (for custom connectors). A **knowledge base** (`lib/embed.js`, `lib/judge.js`) records scored verdicts from every task completion and surfaces them as context for future related work, forming a self-learning loop.

## Adding a new MCP tool

All tools live in the `TOOLS` array in `lib/mcp-core.js`. Each entry is a plain object:

```js
{
  name: 'my_tool',
  description: 'What it does and when to call it.',
  inputSchema: {
    type: 'object',
    properties: { arg: { type: 'string' } },
    required: ['arg'],
    additionalProperties: false
  },
  run: (args, call) => call('POST', '/some/endpoint', { key: args.arg })
}
```

`call(method, path, body)` is an HTTP client pre-bound to the daemon port. The daemon's corresponding route lives in `daemon.js`. Add your route there, add your tool entry to `TOOLS`, and both transports (stdio + HTTP) pick it up automatically.

## Pull request process

1. Fork the repo and create a branch from `main`.
2. Keep changes focused — one logical change per PR.
3. Match existing code style (no formatter enforced; 2-space indent, single quotes).
4. Open a PR against `main` with a short description of what and why.

There is no formal review SLA. Small, well-scoped PRs merge fastest.
