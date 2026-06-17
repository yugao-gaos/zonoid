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
  bench runs re-inject it cheaply.
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
  client.py     -- ZonoidClient + module-level HTTP helpers
  judge.py      -- claude_p, parse_strict_json, EdgeJudge
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

# Spawn an isolated daemon on a free port (never 8787).
handle = daemon_mod.start()
# handle.port      -> chosen free port
# handle.base_url  -> "http://127.0.0.1:<port>"
# handle.data_dir  -> temporary CLAUDE_PLUGIN_DATA directory

client = ZonoidClient(handle.base_url, workspace="/abs/path/to/workspace")

# ... run the bench ...

daemon_mod.stop(handle)
```

### Isolation guarantees

Two environment variables fence the bench daemon away from the production instance:

| Variable | Purpose |
|---|---|
| `ORCH_PORT` | Binds the daemon to the chosen free port instead of `:8787`. |
| `CLAUDE_PLUGIN_DATA` | Relocates all graph/overlay/sessions/journal/model-cache data to an isolated temp directory. |

The model weight files (`Xenova/all-MiniLM-L6-v2`, `Xenova/ms-marco-MiniLM-L-6-v2`)
are symlinked (or copied on Windows) from `~/.claude/orchestrator/models` into the
bench data dir so the embed/rerank sidecars don't re-download them.

### Caveat: daemon auto-drain is off by default

The eager-judge quarantine runs node-scoped.  If a node is in quarantine
(`idle:false` on `GET /judge/next?node=<key>`), drain it manually before reading
its context:

```bash
# Pull candidates and post verdicts until idle:true (typically <=3 rounds).
curl http://localhost:<port>/judge/next?node=<key>&budget=20
curl -X POST http://localhost:<port>/judge/verdict \
  -H 'Content-Type: application/json' \
  -d '{"verdicts":[{"keepEdge":{"from":"<from>","to":"<to>","kind":"context"}}]}'
```

---

## Pre-learnt snapshot: produce and load

```python
from zonoid_bench.warm import produce_snapshot, load_snapshot

# ONCE per (repo, base_commit): mine + drain the KB (slow, LLM-intensive).
snap_dir = produce_snapshot(
    repo="/abs/path/to/repo-checkout",
    base_commit="abc123def",
    out_dir="/bench/snapshots",
)

# For every bench run: re-inject the snapshot cheaply (no LLM).
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
construction.

```python
result = arms.run_agent_in_container(client, unit_id, task_summary)
# result.agents_md  -> AGENTS.md text for the container
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

The five-step pipeline ported from FeatureBench `claude_code._setup_zonoid_context`:

1. **Register** the bench unit as a note (`POST /overlay/note`, no `force`).
2. **Search** for relevant KB notes (`GET /search?q=<task_summary>`).
3. **Suggest** context candidates (`GET /task/suggest?key=<node_key>`).
4. **Wire** verified edges: for each candidate with `ceScore > 0.2` and not a
   duplicate -> `POST /overlay/edge` with the correct kind and direction.
5. **Read** the frozen DAG context (`GET /task/context`) for the retrieve_and_answer
   executor, or inject the pre-loaded context bullets into `AGENTS.md` for
   `agent_in_container`.

### Two FeatureBench bug fixes (note-mqheiw4iv5t)

Both fixes are encoded in `arms.run_canonical_wiring` and must be preserved:

**Fix 1 -- `kind`:**
FeatureBench (`claude_code._setup_zonoid_context`) POSTs `/overlay/edge` with
`{"type": "context"}`.  The daemon (`routes/overlay.js:43,51`) reads `b.kind`, not
`b.type`, so `type:"context"` is silently ignored and the edge is created as the
back-compat default **blocking** kind.  The SDK always passes `kind="context"` via
`client.overlay_edge`.

**Fix 2 -- edge direction:**
FeatureBench wires `from=note, to=candidate` (note consumes the KB note).  But
`/task/context` collects a task's `context_deps` as edges where `e.to === task`
(daemon.js:1599-1600), so the KB note must be the **provider** (`from=candidate,
to=unit`).  The SDK orients every edge `from=candidate(KB note), to=unit(probe)`.

---

## How to plug in a new bench

1. Start the daemon with `daemon.start()`.
2. Optionally load a snapshot with `warm.load_snapshot()`.
3. For each unit:
   - Call `arms.run_canonical_wiring(client, unit_id, task_summary)` (ON arm).
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

Spawns its own isolated daemon (never touches `:8787`), ingests a toy unit with a
planted fact + distractor, runs all three arms, scores them, and asserts:

- **A1** ON answer contains the planted fact.
- **A2** Canonical wiring surfaced >= 1 context edge.
- **A3** Cold answer does NOT contain the planted fact (rigging guard).

All assertions must PASS for the feature branch to be merge-eligible.
