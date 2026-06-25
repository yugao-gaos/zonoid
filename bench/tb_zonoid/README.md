# Zonoid × Terminal-Bench adapter (`bench/tb_zonoid/`)

A Terminal-Bench (TB) **agent adapter** + **A/B runner** that measures whether Zonoid's judged
DAG memory helps a coding agent solve real terminal tasks. It plugs the **Zonoid Bench SDK**
(`bench/zonoid_bench/`) into the TB harness as a custom agent and runs each task **zonoid-on vs
no-zonoid**, scoring with the SDK's own report module — the same contrast structure as
`bench/zonoid_bench/smoke.py`.

> **Why `tb_zonoid/` and not `terminal_bench/`?** A local package literally named `terminal_bench`
> sitting next to `bench/` (which the SDK puts on `sys.path`) **shadows the PyPI `terminal_bench`
> package** — `import terminal_bench` would resolve to our own directory and the adapter could never
> import the real `BaseAgent` / `TmuxSession`. `tb_zonoid` is collision-free. This is the in-repo home
> for the Terminal-Bench integration.

---

## 1. The Terminal-Bench agent-adapter contract (what TB hands an agent)

Terminal-Bench (`pip install terminal-bench` / `uv tool install terminal-bench`; package
`terminal_bench`) runs an agent **inside a per-task Docker container** and grades it by the task's
**own hidden pytest suite**. A custom agent subclasses **`terminal_bench.agents.base_agent.BaseAgent`**
(an `ABC`) and implements exactly two members:

```python
@staticmethod
@abstractmethod
def name() -> str: ...

@abstractmethod
def perform_task(
    self,
    instruction: str,                 # the task description TB read from the task definition
    session: TmuxSession,             # a live shell INTO the task's Docker container
    logging_dir: Path | None = None,
) -> AgentResult: ...                 # token counts + FailureMode; TB decides resolved/unresolved
```

- **`instruction`** — natural-language task text. The agent never sees the gold solution or the tests.
- **`session`** (`terminal_bench.terminal.tmux_session.TmuxSession`) is how the agent acts on the
  container:
  - `session.send_keys([cmd, "Enter"], block=True, max_timeout_sec=...)` — run a shell command.
  - `session.capture_pane(capture_entire=True)` — read the terminal buffer.
  - `session.container` → the underlying `docker.models.containers.Container`; `container.exec_run(...)`
    runs one command with fully-captured stdout/stderr. **This adapter uses `exec_run`** for the solver
    loop (clean capture, no tmux pane-scroll loss) and `session.copy_to_container(...)` to push the
    AGENTS.md in. All effects share the same container the grader later tests.
- **`AgentResult`** (a `pydantic` model in `base_agent.py`): `total_input_tokens`,
  `total_output_tokens`, `failure_mode: FailureMode`, `timestamped_markers`. TB pairs that with its
  own `is_resolved: bool`.

**Registering a custom agent** (`terminal_bench/agents/agent_factory.py` → `importlib.import_module`):

```bash
tb run --agent-import-path bench.tb_zonoid.adapter:ZonoidAgent --task-id hello-world
```

or via the Python API (what `runner.py` uses):

```python
from terminal_bench.harness.harness import Harness
Harness(agent_import_path="bench.tb_zonoid.adapter:ZonoidAgent",
        task_ids=["hello-world"], output_path=..., n_concurrent_trials=1).run()
# -> BenchmarkResults{ results: list[TrialResults{ task_id, is_resolved, total_*_tokens, failure_mode }] }
```

The dotted import path resolves only with the **repo root on `sys.path`/`PYTHONPATH`** —
`runner.py` sets both (and exports `PYTHONPATH` so TB subprocesses inherit it).

### In-container → host daemon bridge
The Zonoid bench daemon runs on the **host** (`http://127.0.0.1:<port>`). A TB container reaches it
via **`host.docker.internal:<port>`** (Docker Desktop resolves it automatically; on Linux TB starts
containers with `--add-host=host.docker.internal:host-gateway`). The AGENTS.md the in-container agent
reads therefore curls `http://host.docker.internal:<port>/task/context|search|overlay/*`.

---

## 2. How the adapter drives the SDK (it does **not** hand-roll daemon calls or a judge)

`ZonoidAgent.perform_task` is a thin conductor over the SDK:

1. **`arms.run_agent_in_container(client, unit_id, task_summary, agent_url, data_dir)`** — the
   canonical ON-arm executor (a). This **single SDK call** does the entire memory pipeline:
   - mints the task as a **probe** (`workspace.drop_task_stub` + `/overlay/status`),
   - drives **autowire** (seeds weight-0 NOTE→probe candidate context edges under production's
     0-floor/top-K policy),
   - **drives the PRODUCTION sync judge** — `client.judge_drain(node)` → `POST /judge/drain` →
     `lib/headless-drain.runJudgeDrainSync`. The bench runs **no judge LLM**, holds no rubric, parses
     no verdict; the keep/prune adjudication is production's, over HTTP,
   - builds the **API-only `AGENTS.md`** (live curl instructions to `/task/context`, `/search`,
     `/overlay/note`, `/overlay/status` — **never** raw KB summaries or answers), and reads back the
     judged context provenance.
2. The adapter **writes that AGENTS.md into the container** (`copy_to_container`, base64-pipe
   fallback) at `/testbed/AGENTS.md`.
3. It runs a thin **ReAct-style solver loop** (`claude_p` JSON action → `exec_run` → observe), with a
   preamble telling the agent to `cat /testbed/AGENTS.md` and use the KB.

So the probe mint, the autowire seeding, **the judge**, the search tiers, and the AGENTS.md builder
are all **the SDK / the production daemon** — the adapter only moves the AGENTS.md into the container
and runs the solver. (Reuse rule from `docs/bench-sdk-design.md` §5 + the de-ported judge, P3.)

---

## 3. The A/B (zonoid-on vs no-zonoid)

`runner.py` mirrors `bench/zonoid_bench/smoke.py`'s phased contrast:

| Phase | zonoid-on (ARM A) | no-zonoid (ARM B) |
|-------|-------------------|-------------------|
| daemon | `zonoid_bench.daemon.start`, **live-bound** to a per-task workspace | — |
| KB | `zonoid_bench.warm.load_snapshot` injects the pre-learnt KB | none |
| agent | `bench.tb_zonoid.adapter:ZonoidAgent` (drives SDK, injects AGENTS.md) | `:NoZonoidAgent` (identical solver, **no** KB / wiring / AGENTS.md) |
| grade | TB's hidden tests → `is_resolved` | TB's hidden tests → `is_resolved` |

Both arms run the **same task, same solver, same container** — the only variable is whether the
Zonoid KB is present and advertised. `NoZonoidAgent` is the **rigging floor**: if it resolves a task
as often as `ZonoidAgent`, the KB added nothing there (same logic as the `run_cold` guard in the SDK
smoke). The runner builds SDK report records (`arm/category/question/gold/predicted/correct`) and
scores + renders with `zonoid_bench.report` → `ab-report.md` / `ab-report.json` / `ab-results.jsonl`.

---

## 4. Running it

**Real A/B (needs Docker engine running + the `terminal-bench` package + Node):**

```bash
# one task, with a pre-learnt KB snapshot injected into the ON arm
python bench/tb_zonoid/runner.py \
    --task-id hello-world \
    --dataset-name terminal-bench-core \
    --kb-snapshot bench/onboard/<repo> \
    --model anthropic/claude-3-5-sonnet-latest
```

**Inspect the wired adapter without Docker/TB** (the contract + the import state):

```bash
python bench/tb_zonoid/runner.py --contract
python bench/tb_zonoid/adapter.py            # same contract + whether terminal_bench imports
```

**Preflight** — print exactly what is missing to run for real (machine-readable JSON):

```bash
python bench/tb_zonoid/runner.py --preflight
```

CLI flags: `--task-id`, `--dataset-name` (default `terminal-bench-core`), `--dataset-version`,
`--dataset-path` (local tasks), `--kb-snapshot`, `--agents-md` (passthrough), `--model`,
`--daemon-js`, `--out-dir`, `--contract`, `--preflight`.

---

## 5. Status & the precise environment blocker (this Windows box)

The adapter + runner are **fully wired and import-clean** (both byte-compile; `--contract` and
`--preflight` run end-to-end through the whole SDK import chain). **A real 1-task A/B was NOT run here
because Terminal-Bench cannot execute in this environment.** `--preflight` reports the exact gaps:

| check | this box | needed |
|-------|----------|--------|
| `node` | ✅ `C:\Program Files\nodejs\node.EXE` | for the bench daemon |
| docker **binary** | ✅ present | — |
| docker **engine** | ❌ **not running** (`docker info` fails: `dockerDesktopLinuxEngine` pipe missing) | start Docker Desktop / the Linux engine |
| `terminal_bench` package | ❌ not installed | `pip install terminal-bench` |
| `docker` python SDK | ❌ not installed | (a `terminal-bench` dependency) |
| pip-capable CPython | ❌ only `py312embed` (no pip) + a WindowsApps `python` stub | a normal CPython 3.12 with pip |

**To run for real** (Linux/Mac or a Windows box with WSL2 + Docker Desktop):

```bash
# 1. a CPython with pip + the TB package (brings the docker SDK transitively)
pip install terminal-bench          # or: uv tool install terminal-bench
# 2. start the Docker engine (Docker Desktop, or dockerd on Linux)
docker info                          # must succeed
# 3. Node on PATH (already true here) for the bench daemon
# 4. run the A/B
python bench/tb_zonoid/runner.py --task-id hello-world --kb-snapshot bench/onboard/<repo>
```

`runner.py` refuses to fake a run: if the preflight fails it prints the blockers and exits non-zero
rather than emitting a green report.
