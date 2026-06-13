# Product E2E bench — design (v1)

End-to-end benchmark for the **full orchestrator product** (graph + DAG context edges + RAG + gate + workers) versus a **plain agent** with no orchestrator. This complements `scripts/bench-heldout.js`, which is a **gate unit test** on a single task with RAG only.

## Goals

| Layer | What it tests |
| --- | --- |
| **Held-out bench** (`bench-heldout.js`) | Does RAG/gate retrieval help on one isolated coding task? |
| **Product E2E bench** (`bench-e2e.js`) | Does the orchestrator **multi-task workflow** help — especially DAG context propagation? |

Primary v1 signal: **Task B fails OFF and passes ON** when the answer exists only in Task A's `complete_task` summary, delivered via a **context edge**.

Secondary (future): RAG-required scenarios where a KB note holds the fact and the gate must inject it.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  scripts/bench-e2e.js                                           │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐ │
│  │ snapshot     │   │ seed graph   │   │ run arms (OFF / ON)  │ │
│  │ daemon       │──▶│ Task A done  │──▶│ headless claude -p   │ │
│  │ (frozen .graph)   + context edge│   │ or --dry-run mock    │ │
│  └──────────────┘   └──────────────┘   └──────────┬───────────┘ │
│                                                    │             │
│                                         ┌──────────▼───────────┐ │
│                                         │ scenario grader      │ │
│                                         │ (secret in artifact) │ │
│                                         └──────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Arms

| Arm | MCP | Graph seed | Agent behavior |
| --- | --- | --- | --- |
| **OFF** | `bench/mcp-off.json` (empty) | None — agent has no graph access | Plain prompt for Task B only; cannot see Task A summary |
| **ON** | `bench/mcp-on.json` → isolated snapshot daemon | Task A `done` with secret in summary; context edge A→B; Task B native fixture | Preamble requires `get_dependency_summaries(task_key)` before writing |

Both arms receive the **same Task B coding prompt** (modulo the ON preamble). The only treatment is orchestrator availability + pre-wired DAG context.

### Metrics (v1)

| Metric | Source |
| --- | --- |
| **pass/fail** | Scenario grader: artifact contains expected secret |
| **token cost** | Parsed from Claude stream-json transcript (`inputTokens`, `outputTokens`, `totalTokens`) |
| **wall time** | Runner wall clock per arm |
| **delta** | ON pass rate − OFF pass rate; token overhead ON − OFF |

Results append to `bench/e2e/results.jsonl` (one JSON line per trial×arm).

## Scenario spec — DAG-required candidate

A scenario lives under `bench/e2e/scenarios/<name>/`:

```
scenario.json       # ids, secret, task keys, artifact path
task-a.prompt.md    # (live v2) prose for Task A — secret lands in complete_task summary
task-b.prompt.md    # Task B — requires prior summary, writes artifact
grader.js           # pass/fail on artifact vs secret
```

### `dag-chain` (v1 reference scenario)

1. **Task A** completes with summary: `Vault unlock code: ZONOID-DAG-7X9K` (secret **only** in summary — not in repo files).
2. **Context edge** A → B (`kind: context`).
3. **Task B** prompt: write `bench/e2e/output/unlock.txt` containing the code from prior task context.
4. **OFF** → grader fails (agent guesses or leaves empty).
5. **ON** → agent calls `get_dependency_summaries`, reads A's summary, grader passes.

### DAG-required vs RAG-required (future)

| Type | Fact location | Channel | Example |
| --- | --- | --- | --- |
| **DAG-required** | Prior task `complete_task` summary | Context edge → Tier-1 injection | `dag-chain` |
| **RAG-required** | KB note node | `search_knowledge` + gate inject | TBD: hand-authored note with empirical gotcha |

## Runner CLI

```bash
# Smoke / CI (no Claude, no live daemon)
node scripts/bench-e2e.js --scenario dag-chain --dry-run

# Single live trial (requires claude CLI + API)
node scripts/bench-e2e.js --scenario dag-chain --trials 1

# Refresh frozen KB snapshot before ON arm
ZONOID_BENCH_ISOLATED=1 node scripts/bench-e2e.js --scenario dag-chain --trials 3
```

Flags:

- `--scenario <name>` — scenario directory under `bench/e2e/scenarios/`
- `--trials N` — repeat OFF+ON pairs (default 1)
- `--dry-run` — mock agent outputs; validate grader + arm comparison logic
- `--model <name>` — Claude model (default `sonnet`)

Reuses `scripts/bench-snapshot-daemon.js` when `ZONOID_BENCH_ISOLATED=1` (same as held-out bench).

## Path to public-bench integration

Public benchmarks (SWE-bench style) are a **future source**, not v1 scope. See `docs/swe-bench-eval.md` for the external eval runbook. Integration plan:

1. **Adapter layer** — map a public instance → `scenario.json` shape (repo pin, issue text, hidden tests, optional prior-session KB).
2. **Sequential CL** — SWE-Bench-CL sequences become multi-task scenarios: each session N completion feeds context for N+1 via normal `complete_task` + context edges (no re-onboarding between tasks).
3. **Grader plug-in** — replace `grader.js` with harness post-hoc test runner (patch applied, tests run outside agent visibility).
4. **Metrics export** — same JSONL schema extended with `benchmark`, `instance_id`, `resolved`.

v1 validates the **harness skeleton** on one hand-authored DAG scenario before wiring external datasets.

## Files (v1)

| Path | Role |
| --- | --- |
| `docs/bench-e2e-plan.md` | This design doc |
| `scripts/bench-e2e.js` | Runner + exported helpers |
| `bench/e2e/scenarios/dag-chain/` | Reference DAG scenario |
| `test/bench-e2e.test.js` | Dry-run / smoke tests |

## Related

- `scripts/bench-heldout.js` — single-task RAG/gate A/B
- `scripts/bench-arm.js` — early single-spec A/B (acceptance test visible to agent)
- `docs/swe-bench-eval.md` — public benchmark eval runbook
