# Zonoid Bench SDK

A reusable Python scaffold for building memory-backend benchmarks against the Zonoid
orchestrator daemon.  Replaces three divergent per-bench HTTP clients and two
near-identical judge parsers with a single source of truth.

---

## What is it?

The SDK provides:

- An **embedded isolated daemon** so each bench run gets its own graph store, never
  touching the production daemon at `:8787`.
- A **canonical HTTP client** (stdlib urllib only, no `requests`) with the 6
  load-bearing daemon findings encoded as assertions.
- The **canonical ON arm** -- the wiring pipeline ported faithfully from FeatureBench
  `claude_code._setup_zonoid_context` with two correctness fixes applied.
- **Pluggable executor modes** for different bench types (agent-driven vs QA-recall).
- **Contrast arms** (cold / RAG-control) that bracket the ON arm.
- A **pre-learnt snapshot** loader so the expensive MINE+DRAIN step runs once and
  bench runs explicitly re-inject it cheaply.
- A **results/scoring scaffold** (token-F1, optional LLM-judge, render_report).

---

## Runtime requirements

| Requirement | Notes |
|---|---|
| Python | stdlib-only; use the embeddable interpreter at `C:\Users\Imyu\AppData\Local\py312embed\python.exe` or any CPython 3.8+ on Mac/Linux. |
| Node.js | Required to spawn the daemon (`node daemon.js`). v24.x recommended. |
| `claude` CLI | Required only for arms that use `judge.claude_p` (retrieve_and_answer, cold, rag_control) and for `warm.produce_snapshot`. |

No `pip install` needed -- `bench/` is on `sys.path` via the bootstrap in each module.

---

## 7-module surface

```
bench/zonoid_bench/
  client.py     -- ZonoidClient + module-level HTTP helpers (incl. judge_drain)
  judge.py      -- claude_p, claude_p_with_usage, parse_strict_json (tool-less completion only)
  workspace.py  -- workspace_key, isolated_ws, drop_task_stub
  daemon.py     -- start(), stop(), DaemonHandle
  warm.py       -- load_snapshot(), produce_snapshot()
  arms.py       -- run_canonical_wiring, run_retrieve_and_answer,
                   run_cold, run_rag_control, run_agent_in_container
  report.py     -- write_results, score, render_report, scorecard_section
```

---

## Embedded-daemon usage

```python
from zonoid_bench import daemon as daemon_mod
from zonoid_bench.client import ZonoidClient

# Spawn an isolated local daemon on a free port (never 8787) and bind its
# live workspace to this trial's isolated workspace.
handle = daemon_mod.start(workspace="/abs/path/to/per-trial-workspace")
# handle.port      -> chosen free port
# handle.base_url  -> "http://127.0.0.1:<port>"
# handle.data_dir  -> temporary CLAUDE_PLUGIN_DATA directory

client = ZonoidClient(handle.base_url, workspace=handle.workspace)

# ... run the bench ...

daemon_mod.stop(handle)
```

### Isolation guarantees

Two environment variables fence the bench daemon away from the production instance:

| Variable | Purpose |
|---|---|
| `ORCH_PORT` | Binds the daemon to the chosen free port instead of `:8787`. |
| `CLAUDE_PLUGIN_DATA` | Relocates all graph/overlay/sessions/journal/model-cache data to an isolated temp directory. |

The daemon is local to the task/container environment: it binds `127.0.0.1:<free-port>`,
uses its own `CLAUDE_PLUGIN_DATA`, and is explicitly bound to the per-trial workspace
with `POST /workspace`.

The daemon does **not** start magically prepopulated. A trial sees KB notes only if the
bench harness loaded them into that isolated workspace first, for example via
`warm.load_snapshot()` or the onboarding injection flow below.

The model weight files (`Xenova/all-MiniLM-L6-v2`, `Xenova/ms-marco-MiniLM-L-6-v2`)
are symlinked (or copied on Windows) from `~/.claude/orchestrator/models` into the
bench data dir so the embed/rerank sidecars don't re-download them.

### Caveat: daemon background auto-drain is off by default

The bench daemon runs with `ORCH_HEADLESS_DRAINS=0`, so the daemon's background drain loop does not
fire. The ON arm does not rely on it: it drives the **production sync judge** explicitly with one
`POST /judge/drain?node=<key>&budget=<n>` call, which drains the node to idle in-process and returns
`{judged, kept, pruned, idle, rounds}`. `arms.run_canonical_wiring` does this for you via
`client.judge_drain(node, budget)`; to drive it by hand:

```bash
# Drain the node's autowire candidate edge-set to idle via the production sync judge (one call).
curl -X POST "http://localhost:<port>/judge/drain?node=<key>&budget=20" \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"/abs/path/to/per-trial-workspace"}'
```

---

## Pre-learnt snapshot/onboarding: explicit load

```python
from zonoid_bench.warm import produce_snapshot, load_snapshot

# ONCE per (repo, base_commit): mine + drain the KB (slow, LLM-intensive).
snap_dir = produce_snapshot(
    repo="/abs/path/to/repo-checkout",
    base_commit="abc123def",
    out_dir="/bench/snapshots",
)

# For every bench run: re-inject the snapshot cheaply (no LLM) into that run's
# isolated workspace before any ON arm starts.
load_snapshot(str(snap_dir), workspace="/abs/path/to/ws")
```

`load_snapshot` Level A calls `scripts/onboard-learn.js --inject --confirm --workspace`
with `ORCH_GATE_OFF=1`.  Level B (`copy_graph=True`) additionally copies a
materialised `.graph` tarball into the workspace before injection.

---

## The two executor modes

### (a) `agent_in_container`

Builds an `AGENTS.md` for a **real Claude Code agent** that the bench will spawn and
grade by the repo's tests.  No LLM call here -- only DAG wiring + AGENTS.md
construction. The generated `AGENTS.md` does not embed raw KB summaries or answer
material; it tells the agent to read `/task/context` and `/search` through the isolated
bench daemon with both `workspace` and `task_key`.

```python
result = arms.run_agent_in_container(client, unit_id, task_summary, data_dir=handle.data_dir)
# result.agents_md  -> API-only AGENTS.md text for the container
# result.wiring     -> WiringResult with wired_edges, context_deps
```

### (b) `retrieve_and_answer`

Registers the unit as a task node, wires the DAG, reads the frozen context off
`/task/context`, then answers via `claude -p` -- no real agent spawned.  Used for
large QA benches (500+ probes) where spawning an agent per probe is impractical.

```python
result = arms.run_retrieve_and_answer(
    client, unit_id, question, task_summary=question, data_dir=data_dir
)
# result.predicted  -> the answer string
# result.context_keys -> node keys whose summaries fed the answer
```

---

## Canonical ON-arm wiring

The bench runs **no judge LLM of its own** — it **drives the production sync judge**. The active
four-step pipeline in `arms.run_canonical_wiring`:

1. **Register** the bench unit as a task probe using `workspace.drop_task_stub`, then
   `POST /overlay/status` with the task summary. This drives embed -> autowire ->
   `markEagerJudge`.
2. **Collect diagnostic search provenance** using workspace-scoped `/search`. These hits
   are retained in `WiringResult.context_deps` for reporting only; they are not injected
   into `AGENTS.md` and they do not choose DAG edges.
3. **Drive the production judge** with a single `POST /judge/drain?node=<probe>&budget=<n>`
   (P1). The daemon's in-process judge
   (`lib/headless-drain.runJudgeDrainSync` -> `resolveJudgeBackend` -> `provider.runJudgeLoop`)
   pulls the probe's unjudged autowire candidate edge-set via `/judge/next?node=`, applies the
   **same** keep/prune rubric production uses (`buildJudgePrompt`), and posts `keepEdge`/`pruneEdge`
   itself. The bench holds **no rubric**, parses **no verdict**, and makes **no** `/judge/verdict`
   call — there is one judge implementation, in production. `/judge/drain` returns
   `{judged, kept, pruned, idle, rounds}`. There is no `ceScore` threshold and no
   `POST /overlay/edge` rescue path.
4. **Read** the frozen judged DAG context with `GET /task/context`: the candidate edges the
   production judge **kept** surface as weight>0 context deps (the bench reads them back; it does
   not author them). `retrieve_and_answer` injects that context into its answer prompt;
   `agent_in_container` exposes only API instructions so the spawned agent must use the
   daemon/bench APIs.

The canonical embedded daemon **inherits production's autowire defaults** — the 0 cosine floor
(P2: `SEMANTIC_AUTOWIRE_THRESHOLD` defaults to 0, top-per-kind candidates seeded unconditionally for
the eager-judge to arbitrate) and an uncapped top-K (cost bounded by `TASK_CREATE_FANOUT=5` per
kind). The bench no longer sets `ORCH_AUTOWIRE_THRESHOLD`/`ORCH_AUTOWIRE_K`, so it measures the real
production policy, not a bench-special one.

---

## How to plug in a new bench

1. Create an isolated workspace for the unit/trial and start the daemon with
   `daemon.start(workspace=<isolated workspace>)`.
2. Load any required KB explicitly with `warm.load_snapshot()` or onboarding injection.
3. For each unit:
   - Call `arms.run_canonical_wiring(client, unit_id, task_summary, data_dir=handle.data_dir)`
     (ON arm).
   - Call `arms.run_cold(question)` (cold contrast arm).
   - Call `arms.run_rag_control(client, question)` (RAG-control arm).
4. Collect results as dicts with at minimum `{arm, category, question, gold, predicted}`.
5. Call `report.write_results(records, path)` to persist.
6. Call `report.score(records)` + `report.render_report(scores, ...)` to generate
   `report.json` + `report.md`.
7. Stop the daemon with `daemon.stop(handle)`.

See `smoke.py` for a full runnable example.

---

## Integration smoke test

```bash
C:\Users\Imyu\AppData\Local\py312embed\python.exe bench/zonoid_bench/smoke.py
```

Spawns its own isolated local daemon (never touches `:8787`), ingests a toy unit with a
planted fact + distractor, runs all three arms, scores them, and asserts:

- **A1** ON answer contains the planted fact.
- **A2** The production judge (driven via `/judge/drain`) persisted a real `keepEdge` — the planted
  note surfaces in `/task/context` and the kept edge came from a keepEdge promotion (not idle).
- **A3** Cold answer does NOT contain the planted fact (rigging guard).

All assertions must PASS for the feature branch to be merge-eligible.
