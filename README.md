# ZONOID

> OpenTelemetry for AI agents — with a learning loop.

Uber burned through its entire 2026 AI budget in four months, then capped per-engineer spend at $1,500/month. Microsoft revoked Claude Code licenses fleet-wide the same month. Uber's COO named the problem plainly: *"That link is not there yet"* — the one between dollars spent on AI and results delivered to users.

The problem isn't the models. **Nobody can see where the tokens went.**

ZONOID traces every token your agents spend to the task it served, scores whether the result earned its cost, and closes the loop — so your fleet gets measurably cheaper as it runs.

```sh
npx @zonoid/cli init
```

---

## What it does

| Layer | What you get |
|---|---|
| **Trace** | Every token linked to the task it served — full chain from conversation to result |
| **Score** | Metric/judge loop evaluates whether each outcome was worth the spend |
| **Optimize** | Rival strategies compete automatically; winners propagate across the fleet |
| **Audit** | Bi-temporal knowledge graph — every decision is time-stamped, reversible, never deleted |

---

## The receipts model

Every token your agents spend produces a receipt:

- **What was it spent on?** Task, subtask, and agent are linked at execution time — not reconstructed from logs
- **Was it worth it?** An automated judge scores the output against the task's success metric
- **What did the agent learn?** Losing strategies are retired; winning ones compound

Because receipts live in a graph, your agents learn to spend less.

---

## Quick start

**Claude Code plugin (recommended):**

```sh
npx @zonoid/cli init
```

Then from any Claude Code session:

```
/zonoid          # open the live dashboard
/orch-loop       # start the optimization heartbeat
```

**MCP server (any MCP client):**

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "zonoid": {
      "command": "node",
      "args": ["${HOME}/.zonoid/mcp-graph.js"]
    }
  }
}
```

---

## Key capabilities

**Execution-coupled memory** — the task graph *is* the memory layer. No separate database, no log pipeline. When an agent completes work, the graph captures what it did, what context it consumed, and what it produced — automatically.

**Self-learning loop** — a metric/judge/optimize cycle runs continuously. Strategies compete in Elo-style tournaments; the orchestrator routes future work toward the winners. This is automated measurement, not prompt engineering.

**Bi-temporal knowledge graph** — every node carries two timestamps: when the fact was valid, and when it was recorded. Query any past state without losing the present. Decisions are never deleted, only superseded.

**Context gate** — before spending tokens on retrieval, the gate estimates whether the context will actually help. Calibrated on your own task history. Regret is measured and reported.

---

## How it compares

Tools like Langfuse and Helicone observe from *outside* the execution boundary — they see token counts and latency, not task structure. ZONOID is coupled to execution: the graph is built *by* the agents as they run, not reconstructed from API logs. The difference matters when you want to close the loop. You can't optimize what you can't attribute.

---

## Status

| Capability | State |
|---|---|
| Task graph + cross-session edges | live |
| Context gate (gated retrieval) | live |
| Metric/judge/optimize loop | live |
| Bi-temporal knowledge graph | live |
| Local embeddings (MiniLM 384-dim) | live — cold-boot ~90s on first run |
| Context gate recalibration | in progress |

---

## License

Apache 2.0. Contributions via DCO sign-off (`git commit -s`).

Built on [Claude Code](https://claude.ai/code).
