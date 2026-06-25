# Headless Bench Feasibility Spike

Task `4a25f8a2-8cbb-4f2f-87d0-3c3cea2b13ac/3`. Question: can we run a fully-controlled
BARE headless `claude` agent on this host (custom MCP config, pinned transcript, distinct
session) to gate a benchmark?

## Verdict: NOT VIABLE on this host (as a host-native headless CLI)

There is **no executable `claude` CLI on this macOS machine.** The only `claude` binary
present is a **Linux ELF (aarch64)** that the desktop app runs *inside its sandbox VM*:

```
<home>/Library/Application Support/Claude/claude-code-vm/2.1.156/claude
  -> ELF 64-bit LSB executable, ARM aarch64, interpreter /lib/ld-linux-aarch64.so.1, GNU/Linux
  -> `exec format error` when run on darwin (uname: Darwin ... arm64)
```

Checked and absent:
- `which claude` / login-shell `which claude` → not found
- npm global (`/opt/homebrew/lib/node_modules`) → no `@anthropic-ai/claude-code`
- `~/.claude/local/claude` → does not exist
- `mdfind`/spotlight for a Mach-O `claude` → only the Linux VM binary
- No `colima`/`lima`/`qemu` to run the Linux binary; `docker` exists but standing up a
  Linux container with auth + this exact binary is out of scope for a benchmark runner and
  defeats the "bare host agent" goal.

Because the binary cannot execute, spike steps 2–4 (run `claude -p ...`, test `--mcp-config`,
diff orchestrator-graph vs empty mcpServers) **could not be performed**. They are blocked
on the missing host CLI, not on any flag/format problem.

## What WAS confirmed (transcript / usage plumbing is fine)

The daemon's token accounting will work against any transcript the CLI would produce — the
format is already in use by the desktop app and matches `readUsage()`:

- Transcripts live at `~/.claude/projects/<slugged-cwd>/<sessionId>.jsonl`.
  Confirmed slug convention: cwd `__WORKSPACE__` →
  `~/.claude/projects/-Users-imyu-Desktop-cloude/`. The **filename is the session id**.
- Per-message usage is under `message.usage` with exactly the keys `daemon.js:readUsage()`
  sums: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens` (verified by parsing a live transcript line). Lines also
  carry `sessionId` and `cwd`, so a run is self-identifying.

So if a runnable CLI were present, the usage-readout half of the contract is already met.

## Expected runner contract (for a host WHERE the native CLI exists — UNVERIFIED here)

Standard Claude Code headless flags (could not be `--help`-verified on this host; treat the
exact `--mcp-config` spelling as still-to-confirm on the target machine before relying on it):

```
claude -p "<prompt>" \
  --mcp-config <file.json> \      # supply custom MCP servers; VERIFY exact flag name via `claude -p --help`
  --session-id <uuid> \           # pin a distinct session -> controls transcript filename
  --output-format stream-json     # machine-readable; or plain text for trivial probes
```

- Pinning the transcript per run = set `--session-id <uuid>` and run with a known `cwd`;
  the file is then `~/.claude/projects/<slug(cwd)>/<uuid>.jsonl`. Use a throwaway cwd to
  isolate the slug dir per bench run.
- BARE agent = `--mcp-config` pointing at `{ "mcpServers": {} }` to exclude all MCP; or at a
  file loading only `orchestrator-graph`:
  `{ "mcpServers": { "orchestrator-graph": { "command": "node", "args": ["__INSTALL_DIR__/mcp-graph.js"] } } }`.
  Verification (unrun here): empty config → no `mcp__*` tools; graph config → `mcp__orchestrator-graph__*` exposed.

## Recommendation: use the in-session + ORCH_CONTROL-nudge fallback

A host-native headless runner is not available here, so the benchmark cannot shell out to
`claude -p`. Fall back to driving a **bare agent inside an orchestrator session** and nudging
it via the ORCH_CONTROL channel, reading the same per-session transcript JSONL (location +
usage shape both confirmed above) for token/cost accounting. This keeps the measurement
substrate (transcript usage) intact without depending on a CLI that isn't installed.

If a true headless runner is later required, do the spike again on a host that has the
native `@anthropic-ai/claude-code` CLI installed (npm or `~/.claude/local`), and verify the
`--mcp-config` / `--session-id` flag names there with `claude -p --help` before building.
