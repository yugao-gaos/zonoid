# DSH acceptance runbook

Run the hermetic integrated acceptance from the Zonoid checkout:

```sh
node test/dsh-e2e-acceptance.test.js
```

The test creates a disposable Git repository, install root, home directory, DSH profile,
session store, and Zonoid runtime. It runs the real `zonoid init --harness dsh` path twice,
loads the installed `mcp-graph.js` over stdio, exercises the production Cordis bridge and
file-drop adapter, reconciles an append-framed zstd session, and removes the entire fixture.
Every spawned CLI/MCP child must exit and be reaped before the test passes. It never starts a
real daemon, model call, embedding server, or reranker sidecar.

By default, the official-host portion verifies the pinned live receipt for DSH
`0.1.1-rc.2` at revision `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. To repeat that
proof and load the newly managed profile in a real built host, use a compatible Node runtime
(`^22.19.0 || >=24.0.0`) and point the test at an exact checkout whose dependencies and CLI
have already been built:

```sh
ZONOID_DSH_SOURCE=/absolute/path/to/deepseek-harness \
  node test/dsh-e2e-acceptance.test.js
```

The opt-in run refuses another Git revision. It routes CLI profile installation through the
official DSH command, requires the resolved headless config to contain both the MCP client and
`@zonoid/dsh`, then reruns the no-model host-contract probe. A failure leaves no test profile;
the disposable root is removed in the test's finalizer.
