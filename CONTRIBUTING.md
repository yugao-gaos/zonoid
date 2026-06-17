# Contributing to Zonoid

Apache-2.0 licensed. Contributions require signing the [Contributor License Agreement](CLA.md) — the CLA bot prompts you automatically on your first PR. PRs welcome.

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

Open http://localhost:8787/graph?workspace=<url-encoded absolute workspace path> to see the dashboard.

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

## Testing

```bash
ZONOID_SKIP_LIVE=1 node test/<file>   # run a single test file
npm test                              # fast regression (test/context-gate-regression.test.js)
npm run test:all                      # full suite via scripts/run-tests.js
```

`scripts/run-tests.js` discovers every `test/*.test.js`, runs each as a child process with
`ZONOID_SKIP_LIVE=1`, and fails if any file fails.

**Sandboxed-daemon convention:** tests that need a daemon spawn a private one on a private port
with a tmp-dir `CLAUDE_PLUGIN_DATA` (see `test/app-restart.test.js` for the pattern) — NEVER the
live `:8787` daemon. Tests must not read or mutate real graph state.

CI (`.github/workflows/test.yml`) runs `npm run test:all` on every push and PR, with
`npm ci --omit=optional` (skips the large `@xenova/transformers` optional dependency, which is
unnecessary under `ZONOID_SKIP_LIVE=1`).

## `.graph` merge strategy

`.graph/` is intentionally git-versioned, but attempt-branch worktrees (`branch_task`) can
diverge it — merging an attempt back would hit delete/modify and `checkpoint.json` conflicts.
`.gitattributes` therefore assigns `.graph/** merge=ours`: the daemon is the source of truth for
graph state, so on any merge the **current branch's `.graph` wins wholesale** — graph files are
never content-merged.

Merge drivers are not portable across clones, so each clone needs a one-time:

```bash
git config merge.ours.driver true
```

Without it, git falls back to the default merge driver for `.graph` paths and you may see
spurious conflicts.

## Pull request process

1. Fork the repo and create a branch from `main`.
2. Keep changes focused — one logical change per PR.
3. Match existing code style (no formatter enforced; 2-space indent, single quotes).
4. Open a PR against `main` with a short description of what and why.

There is no formal review SLA. Small, well-scoped PRs merge fastest.

## Contributor License Agreement

All contributors must sign the [Contributor License Agreement](CLA.md) before their first contribution can be accepted. You retain copyright of your contribution, but grant the project owner a perpetual, royalty-free license to use, distribute, and — critically — relicense or sublicense your contribution under different terms, including commercial or proprietary terms, so the project can offer dual-licensed editions. Signing is a one-time action recorded by the CLA bot when it comments on your first PR.
