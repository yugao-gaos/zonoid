# ARC-AGI-3 Zonoid adapter

This directory contains a small ARC-AGI-3 benchmark adapter for the Zonoid Bench SDK. It follows the
same A/B shape as `bench/tb_zonoid`: run a **zonoid-on** arm and a **no-zonoid** baseline, then render
the standard `zonoid_bench.report` pass-rate scorecard.

The ARC SDK surface is not assumed to be installed or stable. The uncertain part is isolated in
`adapter.py`; offline commands still work without ARC credentials or packages.

## Offline checks

```bash
python3 bench/arc_agi3_zonoid/runner.py --preflight
python3 bench/arc_agi3_zonoid/runner.py --contract
python3 bench/arc_agi3_zonoid/runner.py --dry-run --max-steps 3
```

`--preflight` reports real-run blockers as JSON. `--contract` documents the exact SDK hook this
adapter will call. `--dry-run` exercises config construction, A/B record normalization, and report
generation without starting the daemon or importing ARC.

## Expected ARC SDK contract

For a real run, one likely package must import:

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

## Zonoid integration

In the zonoid-on arm, the runner can start an isolated daemon with `zonoid_bench.daemon.start`, bind it
to a per-run workspace, optionally inject a KB snapshot with `zonoid_bench.warm.load_snapshot`, and
register an ARC probe task. The config passed to the ARC SDK includes task-scoped instructions for:

- `/task/context` with `workspace` and `task_key`
- `/search` with `workspace`, `task_key`, `k`, and `gated=false`
- optional note creation if the SDK exposes a write hook

The no-zonoid baseline receives no daemon URL, no workspace, and no KB instructions.

## Real run

```bash
python3 bench/arc_agi3_zonoid/runner.py \
  --task-ids task-a,task-b \
  --max-steps 30 \
  --kb-snapshot bench/onboard/zonoid \
  --out-dir /tmp/arc-agi3-zonoid
```

Use `--no-isolated-daemon` only when an external ARC harness owns daemon lifecycle and the SDK can
accept a disabled/empty `zonoid` block. The default is isolated daemon mode.

