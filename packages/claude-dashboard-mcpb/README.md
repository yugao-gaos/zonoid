# Zonoid Dashboard for Claude Desktop

`zonoid-dashboard.mcpb` packages the existing Zonoid MCP server as a Claude Desktop extension.
It is intentionally a small adapter, not a second daemon or dashboard implementation.

The extension requires an existing Zonoid checkout. During installation, choose the directory
that contains `mcp-graph.js`, `daemon.js`, and `package.json`. The default is
`~/.claude/orchestrator`. The bundled launcher passes stdio through to that checkout's MCP server,
which provides `show_dashboard` and the existing `ui://orchestrator/graph` MCP App resource.

Build the deterministic archive with:

```sh
npm run build:claude-dashboard
```

Claude Code does not install `.mcpb` extensions or render the Claude Desktop MCP App. Keep the
existing `.mcp.json` wiring and use `show_dashboard` or `zonoid-dashboard --open` there.
