# DeepSeek Harness target-host contract

Zonoid targets the published `@deepseek-ai/dsh` **0.1.1-rc.2** release, tag
`dsh-v0.1.1-rc.2`, revision
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. The supported Node range is
`^22.19.0 || >=24.0.0`. A later alpha is not part of this compatibility pin.

The non-interactive host command is:

```sh
dsh --profile headless --patch /absolute/path/to/cordis.patch.yml "task"
```

`--patch` is repeatable and overlays the selected profile. Use the same flags
without the task plus `--dump-config` to inspect the resolved tree. The
headless bundle mounts no HTTP, browser, Web runtime, or Host UI.

## MCP profile row

Zonoid is a stdio MCP server mounted with the public
`@deepseek-ai/dsh-mcp-client` plugin. Deployment patches should use this
shape, with absolute paths supplied through environment-backed `!!js`
expressions rather than embedding credentials:

```yaml
- insert:
    - id: mcp-zonoid
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: zonoid
        transport: stdio
        command: node
        args: [/absolute/path/to/mcp-graph.js]
        env:
          ORCH_CLIENT: dsh
          ORCH_WORKSPACE: /absolute/workspace
        cwd: /absolute/workspace
        failOnStartupError: true
        reconnect:
          enabled: false
```

The exposed name is `mcp__zonoid__<rawName>`. `serverName` must match
`[A-Za-z0-9_-]{1,32}` and be unique in the live Cordis tree. Activation waits
for the initial connection and tool synchronization. Resources and prompts are
not bridged by this plugin.

## Lifecycle and identity

The host's stable Cordis seams are `session/created`, `agent/created`,
`agent/session-start`, `agent/disposed`, and `session/disposed`.
`session/event` is a post-commit notification and `session/flush` is the
awaited durability checkpoint.

An agent and its live session share one ID. For headless work, workspace
identity is the canonical absolute path in `agent.session.header.cwd` (created
from `process.cwd()`). A DSH `WorkspaceId` is an unrelated generated UUID and
must not be treated as a path.

## Tool interception and shutdown

Tool policy runs through `tools/pre-execute`, `tools/execute`,
`tools/post-execute`, then `tools/result`. A pre decision may allow, deny, or
ask. Deny skips the tool body; ask without an approval service becomes deny.
A post decision may accept or block an already-run result. Block returns an
error with feedback. Async policy must observe `exec.signal`; the registry
awaits policy and body quiescence rather than abandoning promises.

Owned agents are released with `handle.dispose()`, after an explicit
`sessions.flush(agent.session)` durability boundary. Cordis effects must return
their disposer. DSH's CLI coalesces shutdown, awaits the application-tree
disposal, disconnects stdio MCP children, and forces exit after 5000 ms; a
second interrupt also forces exit.

## Reproducible proof

The fixture in `test/fixtures/dsh-host-contract/` mounts a fake stdio MCP
server and a Cordis observer into the real headless profile. After installing
dependencies and running `pnpm run build:lib` in an exact checkout of the
pinned revision, run:

```sh
node scripts/probe-dsh-host-contract.js --dsh-source /path/to/deepseek-harness
```

The probe refuses a different revision/version, exercises MCP discovery and
execution, proves pre-deny and post-block behavior, checks session/workspace
identity and lifecycle events, and requires both plugin disposal and MCP stdio
EOF before succeeding. It never calls a model.
