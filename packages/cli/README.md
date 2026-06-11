# @zonoid/cli

One-command installer for the [Zonoid](https://github.com/yugao-gaos/zonoid) orchestrator. Run it in any repo to wire up the task-graph daemon, hooks, and MCP server for Claude Code.

## Usage

```sh
npx @zonoid/cli init
```

This will: clone Zonoid to `~/.claude/orchestrator` (if not already installed), run `npm install`, write `.claude/settings.json` and `.mcp.json` into the current directory, merge the orchestrator's routing rules into your `CLAUDE.md`, and register the workspace with the running daemon. Then restart Claude Code — the dashboard will be at `http://localhost:8787/graph`.
