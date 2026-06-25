# APPLY -- Zonoid Bench SDK runbook

This file is the quickstart runbook for operators applying the SDK to a new or
existing benchmark.  For SDK internals and design rationale see `README.md` and
`docs/bench-sdk-design.md`.

---

## Prerequisites

| Item | Check |
|---|---|
| Python (embeddable or system) | `C:\Users\Imyu\AppData\Local\py312embed\python.exe --version` |
| Node.js (>=v18, v24 recommended) | `node --version` |
| `claude` CLI | `claude --version` (required for arms that call `judge.claude_p`) |
| Repo root on disk | `daemon.js` must exist at `<repo>/daemon.js` |

The SDK uses **stdlib only** -- no `pip install` step needed.

---

## Quickstart: smoke test (verifies your install)

Run the integration smoke from the **repo root**:

```bash
# Windows embeddable Python
C:\Users\Imyu\AppData\Local\py312embed\python.exe bench/zonoid_bench/smoke.py

# Mac / Linux system Python
python3 bench/zonoid_bench/smoke.py
```

Expected output ends with:

```
OVERALL: PASS
```

The smoke spawns its own isolated daemon on a free port (printed in the output),
runs the full SDK pipeline, and asserts all three arms behave correctly.  It is
completely independent of the production daemon at `:8787`.

---

## Applying the SDK to a benchmark

### Step 1 -- start an isolated daemon

```python
from zonoid_bench import daemon as daemon_mod

handle = daemon_mod.start()
print(f"Bench daemon at {handle.base_url}")
# handle.port     -> free port (never 8787)
# handle.data_dir -> isolated temp CLAUDE_PLUGIN_DATA
```

### Step 2 -- create an isolated workspace

Each bench run uses an absolute workspace path.  The daemon stores all graph/overlay
data under `<CLAUDE_PLUGIN_DATA>/.graph/<workspace_key(workspace)>/`.

```python
import tempfile, os

workspace = os.path.abspath(tempfile.mkdtemp(prefix="mybench-ws-"))
```

### Step 3 -- build the client

```python
from zonoid_bench.client import ZonoidClient

client = ZonoidClient(handle.base_url, workspace=workspace, timeout=120)
client.warm_up()   # pre-pay embedding model cold start (~10-90 s once)
```

### Step 4 (optional) -- load a pre-learnt snapshot

Skip this step for fresh benches.  Use it when you have already run
`warm.produce_snapshot` and want to re-inject the KB cheaply:

```python
from zonoid_bench.warm import load_snapshot

load_snapshot(
    snapshot="/bench/snapshots/<repo>-<short-commit>/",
    workspace=workspace,
    daemon=handle.base_url,
)
```

### Step 5 -- ingest bench units (one note per unit)

```python
resp = client.post_note(
    title="Unit 42 -- task description",
    summary="The expected behaviour is X.  Key constraint: Y.",
    category="mybench",
    tags=["mybench", "unit-42"],
)
note_key = resp["key"]
```

### Step 6 -- run the arms

```python
from zonoid_bench import arms

# ON arm (canonical wiring + retrieve_and_answer)
on = arms.run_retrieve_and_answer(
    client,
    unit_id="mybench-42",
    question="What is X?",
    task_summary="What is X?",
    data_dir=handle.data_dir,
)

# Cold arm (no memory -- rigging guard)
cold = arms.run_cold("What is X?")

# RAG-control arm (plain search, no DAG wiring)
rag = arms.run_rag_control(client, "What is X?")
```

`retrieve_and_answer` reads the production task-scoped search result after eager judgment. For a
settled probe that result is system context plus frozen DAG context; it does not append semantic
RAG. `rag_control` remains the explicit plain-search comparison because it omits `task_key`.

### Step 7 -- collect and score results

```python
from zonoid_bench import report

records = [
    {"arm": "on",          "category": "mybench", "question": "What is X?",
     "gold": "answer text", "predicted": on.predicted},
    {"arm": "cold",        "category": "mybench", "question": "What is X?",
     "gold": "answer text", "predicted": cold.predicted},
    {"arm": "rag_control", "category": "mybench", "question": "What is X?",
     "gold": "answer text", "predicted": rag.predicted},
]

report.write_results(records, "results.jsonl")
scores = report.score(records, use_f1=True)

report.render_report(
    scores,
    path_md="report.md",
    path_json="report.json",
    title="MyBench results",
)
```

### Step 8 -- stop the daemon

```python
daemon_mod.stop(handle)
```

---

## Pre-learnt snapshot: produce once, reuse forever

```python
from zonoid_bench.warm import produce_snapshot

snap_dir = produce_snapshot(
    repo="/abs/path/to/repo",
    base_commit="abc123def456",
    out_dir="/bench/snapshots",
    daemon="http://localhost:8787",   # can use the production daemon for this step
    model="sonnet",
)
# snap_dir is a pathlib.Path, e.g. /bench/snapshots/<repo>-abc123de/
```

The snapshot directory contains `onboard-notes.json` (the drained KB batches).
Re-inject it on every bench run with `warm.load_snapshot(snap_dir, workspace)` --
this calls `scripts/onboard-learn.js --inject` which is cheap (no LLM re-run).

---

## Embedded-daemon isolation details

| Env var | Set to | Effect |
|---|---|---|
| `ORCH_PORT` | free port | daemon.js binds to this port (not 8787) |
| `CLAUDE_PLUGIN_DATA` | temp dir | all graph/overlay/sessions/journal data goes here |

Model weights (`Xenova/all-MiniLM-L6-v2`, `Xenova/ms-marco-MiniLM-L-6-v2`) are
symlinked from `~/.claude/orchestrator/models` into the temp dir so they are not
re-downloaded.  On Windows, if the symlink privilege is absent, the files are copied
(once per temp dir; subsequent runs reuse the copy).

The `/health` endpoint is whitelisted through the daemon's 503 boot gate and returns
`{"phase":"ready"}` when the daemon is fully initialised.  `daemon.start()` polls
this endpoint and raises `RuntimeError` if the daemon does not reach `phase:ready`
within the configurable timeout (default 120 s).

---

## Daemon auto-drain caveat

The eager-judge runs node-scoped drain.  When a node is in quarantine (`idle:false`),
auto-drain will not clear it automatically.  To clear manually:

```bash
# 1. Pull candidates (repeat until idle:true -- typically <=3 rounds).
curl "http://localhost:<port>/judge/next?node=<key>&budget=20"

# 2. Post verdicts.
curl -X POST "http://localhost:<port>/judge/verdict" \
  -H "Content-Type: application/json" \
  -d '{"verdicts":[{"keepEdge":{"from":"<from>","to":"<to>","kind":"context"}}]}'
```

---

## Canonical ON-arm wiring -- the two FeatureBench bug fixes

Both fixes are encoded in `arms.run_canonical_wiring` and must be preserved when
porting to new benches or upgrading the FeatureBench adapter:

**Fix 1 -- edge `kind`:**
FeatureBench POSTs `/overlay/edge` with `{"type":"context"}`.  The daemon reads
`b.kind` (not `b.type`), so `type:"context"` is silently ignored and the edge is
created as a **blocking** edge instead of a context edge.  Always pass
`kind="context"` to `client.overlay_edge`.

**Fix 2 -- edge direction:**
FeatureBench wires `from=note, to=candidate`.  But `/task/context` collects
`context_deps` as edges where `e.to === task`, so the KB note must be the
**provider** (`from=note, to=unit`).  The SDK always orients the edge
`from=candidate(KB note), to=unit(probe)`.

See the docstring at the top of `arms.py` for the full analysis including daemon
source references.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `FileNotFoundError: daemon.js not found` | Not running from repo root | Pass `daemon_js=<path>` explicitly |
| `RuntimeError: Daemon did not reach phase:ready` | Node not on PATH | `node --version`; install Node.js |
| `ValueError: workspace must be an absolute path` | Relative workspace | Use `os.path.abspath(...)` |
| `/task/context` returns empty `dependencySummaries` | Wiring race | Sleep 3-6 s after `post_note` before `task_suggest` |
| Smoke A2 fails with `KEPT (keepEdge): []` and non-empty `context_keys` | RAG answer succeeded, but eager-judge did not post a verified `keepEdge` | Inspect candidate verdicts and `claude -p` health; do not rescue the miss with `overlay_edge` |
| cold arm scores as well as ON arm | Fact is world-knowledge | Choose a more obscure planted fact |
| A2 fails with no candidates and no context | Autowire did not seed candidates, or the embedder was not warm yet | Check embedder warm-up/indexing and the planted fact wording; do not rescue the miss with `overlay_edge` |
