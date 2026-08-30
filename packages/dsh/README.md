# @zonoid/dsh

Native Cordis bridge for the pinned `@deepseek-ai/dsh` `0.1.1-rc.2` host. It keeps
DSH as the execution host while relaying lifecycle, prompt classification, cooperative
stop, write authorization, and completion signals to the Zonoid daemon.

The bundled `zonoid.cordis.patch.yml` mounts `mcp-graph.js` over stdio with
`ORCH_CLIENT=dsh`. That identity exposes only the routine worker surface:
assignment lifecycle, dependency/task context, Subconscious search, durable decisions,
guidance, and the dashboard. Graph surgery, Git integration, judge drains, and loop
administration are not advertised to the DSH model.

## Profile

Set `ZONOID_ROOT` to the installed Zonoid root and `ORCH_GRAPH_REPO` to the canonical
workspace, then apply the patch to the headless profile. An installer may instead set
`ZONOID_DSH_MCP_ENTRY` to the absolute `mcp-graph.js` path.

```sh
dsh --profile headless --patch "$ZONOID_ROOT/packages/dsh/zonoid.cordis.patch.yml" "task"
```

The MCP row is fail-closed at activation (`failOnStartupError: true`) and does not
reconnect behind an active Cordis tree. The bridge itself follows the shared adapter
contract: daemon unavailability is fail-open for live tool gates, explicit stop or a
definitive missing/invalid write claim returns a DSH `deny` decision, and plugin disposal
awaits `/agent/done` for every still-active session.
