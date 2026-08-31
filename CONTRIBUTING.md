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

`npx @zonoid/cli init` installs a local `.git/hooks/pre-push` guard for Node repos with a test
script. The guard runs `npm run test:all` when present, otherwise `npm test`, and blocks pushes on
failure. Local hooks can be bypassed with `--no-verify`, so CI and branch protection remain the
server-side backstop.

**Sandboxed-daemon convention:** tests that need a daemon spawn a private one on a private port
with a tmp-dir `CLAUDE_PLUGIN_DATA` (see `test/app-restart.test.js` for the pattern) — NEVER the
live `:8787` daemon. Tests must not read or mutate real graph state.

CI (`.github/workflows/test.yml`) runs `npm run test:all` on every push and PR, with
`npm ci --omit=optional` (skips the large `@xenova/transformers` optional dependency, which is
unnecessary under `ZONOID_SKIP_LIVE=1`).

## `.graph` repository and checkpoints

`.graph/` is a Git submodule. The daemon continuously commits and pushes live graph state in that
companion repository, while normal source commits leave the superproject gitlink alone. A deliberate
`zonoid graph checkpoint` (including the feature-merge path) stages the pushed graph commit in the
superproject. Before a feature graph advances, all untracked paths—including ignored files—that
collide with the pushed target commit are inspected without mutation. Only claim JSON whose target
record is proven terminal/newer is moved into an exact, retained recovery stash; malformed,
non-claim, or non-dominated blockers refuse the checkpoint. Unrelated ignored and ordinary
untracked graph files stay in place, and successful feature checkpoint results report the retained
stash identity and claim evidence.

`zonoid graph sync` initializes and updates the submodule after clone, checkout, or merge. Setup also
enables `push.recurseSubmodules=on-demand`, so a superproject push cannot publish a gitlink whose graph
commit is missing remotely. The graph repository carries its own JSONL/checkpoint merge policy in
`.graph/.gitattributes`.

If a graph rebase is interrupted, start with `zonoid graph recover-rebase --dry-run`. Recovery is
fail-closed: it only resolves claim JSON toward the terminal/newer record and unions valid JSONL
events; every other conflict class is reported for manual inspection without mutation. Persist
`drain_max_iterations=-1`, verify that value is effective, then rerun with
`--confirm-drains-paused`; the flag alone cannot bypass the persisted pause check. The command first
proves the signed daemon identity and PID-file owner, writes `.orch-off` in the trusted Zonoid
install/source root used by SessionStart, and verifies graceful shutdown before changing the target
graph state. It can resume either an active rebase or a recognized retained Zonoid recovery stash
whose known conflict markers are proven present in `HEAD`; working-tree-only markers and unrelated
non-rebase unmerged state are refused before quiescing. Recovered state is committed and pushed
before the lock is removed and the same install-root daemon build is restarted; the lock and
recovery stash remain available whenever an unsafe or failed step prevents that sequence from completing.
If the push finished but the daemon restart did not, rerun the same confirmed command. It resumes
only when the trusted operator-root lock, a conflict-free graph clean except `daemon.port`, and a
remote-contained `HEAD` all match. New locks persist the exact retained-stash binding—including a
null binding that requires zero recognized recovery stashes—and also require the installed daemon
build to match. A legacy recovery lock is accepted only when the missing bindings can be
reconstructed from a ready signed
same-build daemon with PID-file ownership; if the source checkout has advanced, that daemon is
reuse-only and no new build may be spawned. Ambiguous legacy state leaves both lock and stash untouched.

Workspace graphs tracked in the superproject (`zonoid/.graph/**`) are covered by the root
`.gitattributes` instead, which marks them `merge=ours`. Git ships no built-in `ours` merge driver,
so enable it once per clone or the attribute silently falls back to a conflicting text merge:

```bash
git config merge.ours.driver true
```

## Pull request process

1. Fork the repo and create a branch from `main`.
2. Keep changes focused — one logical change per PR.
3. Match existing code style (no formatter enforced; 2-space indent, single quotes).
4. Open a PR against `main` with a short description of what and why.

There is no formal review SLA. Small, well-scoped PRs merge fastest.

## Contributor License Agreement

All contributors must sign the [Contributor License Agreement](CLA.md) before their first contribution can be accepted. You retain copyright of your contribution, but grant the project owner a perpetual, royalty-free license to use, distribute, and — critically — relicense or sublicense your contribution under different terms, including commercial or proprietary terms, so the project can offer dual-licensed editions. Signing is a one-time action recorded by the CLA bot when it comments on your first PR.
