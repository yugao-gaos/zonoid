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

Install the bridge and MCP bundle additively into DSH's `headless` profile, then launch
the profile normally:

```sh
npx @zonoid/cli init --harness dsh
dsh --profile headless "task"
```

The installer copies this package to `$DSH_HOME/zonoid/packages/dsh`, pins the copied
stdio MCP row to the absolute installed `mcp-graph.js`, and invokes DSH's public
`plugin --profile headless add` command. It never edits user `cordis.patch.yml`, other
patches, plugins, or MCP servers. Existing DSH profile metadata is backed up as
`*.zonoid.bak` before a change and restored if DSH rejects the installation; repeated
init calls are no-ops once the same bundle is active.

For a one-off manual run, set `ZONOID_ROOT` to the installed Zonoid root and
`ORCH_GRAPH_REPO` to the canonical workspace, then use the checked-in patch directly:

```sh
dsh --profile headless --patch "$ZONOID_ROOT/packages/dsh/zonoid.cordis.patch.yml" "task"
```

The MCP row is fail-closed at activation (`failOnStartupError: true`) and does not
reconnect behind an active Cordis tree. The bridge itself follows the shared adapter
contract: daemon unavailability is fail-open for live tool gates, explicit stop or a
definitive missing/invalid write claim returns a DSH `deny` decision, and plugin disposal
awaits `/agent/done` for every still-active session.
