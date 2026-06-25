# ARC-AGI-3 Zonoid adapter

This directory contains a small ARC-AGI-3 benchmark adapter for the Zonoid Bench SDK. It follows the
same A/B shape as `bench/tb_zonoid`: run a **zonoid-on** arm and a **no-zonoid** baseline, then render
the standard `zonoid_bench.report` pass-rate scorecard.

The ARC surfaces are not assumed to be installed or stable. The uncertain parts are isolated in
`adapter.py` and the official-repo CLI path; offline commands still work without ARC credentials or
packages.

## Offline checks

```bash
python3 bench/arc_agi3_zonoid/runner.py --preflight
python3 bench/arc_agi3_zonoid/runner.py --contract
python3 bench/arc_agi3_zonoid/runner.py --dry-run --max-steps 3
```

`--preflight` reports real-run blockers as JSON. `--contract` documents the exact SDK hook this
adapter will call. `--dry-run` exercises config construction, A/B record normalization, and report
generation without starting the daemon or importing ARC.

## ARC Toolkit vs benchmarking harness

The official ARC Toolkit install documented by ARC is:

```bash
pip install arc-agi
```

That package is likely imported as `arc_agi`, so `arc_agi` is the first import candidate.

The ARC-AGI-3 benchmarking harness is separate. The public quickstart for the
`arc-agi-3-benchmarking` checkout uses commands shaped like:

```bash
uv run main.py --game=ls20
uv run main.py --list-games
uv run main.py --list-configs
```

This adapter supports both shapes, but keeps them separate.

## Mode A: direct Python hook

For a direct real run, one likely package must import:

- `arc_agi` (from `pip install arc-agi`)
- `arc_agi_3`
- `arc_agi3`
- `arcagi3`
- `arc`

The package must expose one callable hook:

- `run_benchmark(config)`
- `run(config)`
- `evaluate(config)`

The adapter passes a single config dict with `arm`, `max_steps`, `task_ids`, and a `zonoid` block. The
result must be either a list of per-task dicts or a dict containing `results: [...]`. Each per-task
dict should include a task id, a pass/fail boolean (`correct`, `solved`, `pass`, `passed`, or
`success`), and an output field (`predicted`, `output`, or `answer`).

If the installed SDK does not match that contract, the runner exits with a blocker instead of
guessing private API calls.

## Mode 0: local CLI agent

Use `--agent-command` when the solving agent is already authenticated in a local CLI and the runner
should not require provider API keys:

```bash
python3 bench/arc_agi3_zonoid/runner.py \
  --agent-command "codex exec" \
  --task-ids task-a,task-b \
  --max-steps 30
```

The command is generic; examples include `codex exec` and `claude -p`. The adapter sends one prompt on
stdin per task and records stdout as the prediction. If stdout is JSON, the adapter honors
`task_id`, `predicted`/`output`/`answer`, and `correct`/`solved`/`pass`/`passed`/`success` fields.
Otherwise stdout is treated as the prediction and correctness remains false unless the CLI returned a
recognized JSON field.

## Mode B: official benchmarking checkout

Pass a checkout path:

```bash
python3 bench/arc_agi3_zonoid/runner.py \
  --benchmarking-repo /path/to/arc-agi-3-benchmarking \
  --task-ids ls20
```

The runner invokes the official CLI:

- with task ids: `uv run main.py --game=<task_id>`
- with no task ids: `uv run main.py` (all/default games according to the checkout)

For a local CLI-backed run, first apply the compatibility patch to the official checkout:

```bash
cd /path/to/arc-agi-3-benchmarking
git apply /Users/imyu/Desktop/zonoid/patches/arc-agi3-local-cli.patch
```

That patch adds a `zonoid-local-cli` config and a `local-cli` runtime that reads
`ARC_AGENT_COMMAND`, so the official harness can call an already-authenticated CLI such as
`codex exec` or `claude -p`.

Zonoid context is exported through environment variables only when the checkout appears to contain a
Zonoid integration point (`ZONOID`/`zonoid` tokens in Python files). The variables are:

- `ZONOID_ENABLED`
- `ZONOID_DAEMON_URL`
- `ZONOID_WORKSPACE`
- `ZONOID_TASK_KEY`
- `ZONOID_KB_SNAPSHOT`
- `ZONOID_TASK_INSTRUCTIONS`
- `ZONOID_CONTEXT_JSON`
- `ARC_AGENT_COMMAND` / `ZONOID_ARC_AGENT_COMMAND` when `--agent-command` is supplied

If the checkout has no visible Zonoid hook, the runner may run the official no-zonoid baseline and
then exits with a blocker for the zonoid-on arm. That is deliberate: environment variables that the
harness never reads are not a real Zonoid integration.

`ZONOID_CONTEXT_JSON` points at a small JSON payload with `enabled`, `daemon_url`, `workspace`,
`task_key`, `task_instructions`, and `kb_snapshot`. A patched official harness can consume that file
instead of parsing long environment values. The official CLI invocation remains the documented
`uv run main.py --game=<task_id>` shape; the adapter exports the agent command through environment
variables instead of inventing official checkout flags.

## Zonoid integration

In the zonoid-on arm, the runner can start an isolated daemon with `zonoid_bench.daemon.start`, bind it
to a per-run workspace, optionally inject a KB snapshot with `zonoid_bench.warm.load_snapshot`, and
register an ARC probe task. The config passed to the ARC SDK includes task-scoped instructions for:

- `/task/context` with `workspace` and `task_key`
- `/search` with `workspace`, `task_key`, `k`, and `gated=false`
- optional note creation if the SDK exposes a write hook

The no-zonoid baseline receives no daemon URL, no workspace, and no KB instructions. In official
benchmarking-repo mode, a full A/B requires the checkout to actually consume the Zonoid environment
variables above.

## Real run

```bash
python3 bench/arc_agi3_zonoid/runner.py \
  --task-ids task-a,task-b \
  --max-steps 30 \
  --kb-snapshot bench/onboard/zonoid \
  --out-dir /tmp/arc-agi3-zonoid
```

Official benchmarking repo path:

```bash
python3 bench/arc_agi3_zonoid/runner.py \
  --benchmarking-repo /path/to/arc-agi-3-benchmarking \
  --task-ids ls20 \
  --kb-snapshot bench/onboard/zonoid \
  --out-dir /tmp/arc-agi3-zonoid
```

Official benchmarking repo path with a local CLI agent exported for a patched harness:

```bash
ARC_AGENT_COMMAND="claude -p" \
python3 bench/arc_agi3_zonoid/runner.py \
  --benchmarking-repo /path/to/arc-agi-3-benchmarking \
  --agent-command "claude -p" \
  --task-ids ls20 \
  --out-dir /tmp/arc-agi3-zonoid
```

Use `--no-isolated-daemon` only when an external ARC harness owns daemon lifecycle and the SDK can
accept a disabled/empty `zonoid` block. The default is isolated daemon mode.
