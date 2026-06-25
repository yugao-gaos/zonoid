"""ARC-AGI-3 Zonoid A/B benchmark runner.

Offline inspection modes work without ARC credentials or SDK packages:

  python3 bench/arc_agi3_zonoid/runner.py --preflight
  python3 bench/arc_agi3_zonoid/runner.py --contract
  python3 bench/arc_agi3_zonoid/runner.py --dry-run --max-steps 3

Real runs are intentionally honest: if no supported ARC SDK contract is importable, the runner
prints blockers and exits non-zero instead of producing fake benchmark results.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any


_HERE = os.path.dirname(os.path.abspath(__file__))
_BENCH = os.path.dirname(_HERE)
_REPO_ROOT = os.path.dirname(_BENCH)
if _BENCH not in sys.path:
    sys.path.insert(0, _BENCH)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from zonoid_bench import daemon as daemon_mod  # noqa: E402
from zonoid_bench import report as report_mod  # noqa: E402
from zonoid_bench.client import ZonoidClient  # noqa: E402
from bench.arc_agi3_zonoid import adapter as adapter_mod  # noqa: E402


DEFAULT_TASK_IDS = ["arc-agi-3-smoke-1", "arc-agi-3-smoke-2"]


def preflight(*, require_node: bool = True) -> dict[str, Any]:
    """Return machine-readable readiness for a real ARC-AGI-3 A/B run."""

    state = adapter_mod.detect_sdk()
    node_path = shutil.which("node")
    report: dict[str, Any] = {
        "ok": True,
        "blockers": [],
        "checks": {
            "node": node_path or "MISSING",
            "arc_sdk_available": state.available,
            "arc_sdk_module": state.module_name,
            "arc_sdk_file": state.module_file,
            "arc_sdk_runner": state.runner_name,
            "arc_sdk_import_errors": state.import_errors,
        },
    }

    if require_node and not node_path:
        report["ok"] = False
        report["blockers"].append("node not on PATH (needed only for zonoid-on isolated daemon)")

    if not state.available:
        report["ok"] = False
        report["blockers"].append(
            "ARC-AGI-3 SDK not importable; install the official SDK or set PYTHONPATH so one of "
            f"{', '.join(adapter_mod.SDK_CANDIDATES)} resolves"
        )
    elif not state.runner_name:
        report["ok"] = False
        report["blockers"].append(
            f"ARC SDK package {state.module_name!r} is importable but lacks a supported runner hook "
            "(run_benchmark(config), run(config), or evaluate(config))"
        )

    return report


def dry_run(max_steps: int, task_ids: list[str], out_dir: str) -> int:
    """Exercise the report path without ARC SDK, credentials, daemon, or model calls."""

    out_root = Path(out_dir)
    out_root.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []

    for arm in ("zonoid_on", "no_zonoid"):
        cfg = adapter_mod.build_config(
            arm=arm,
            max_steps=max_steps,
            task_ids=task_ids,
            out_dir=str(out_root),
            zonoid_enabled=(arm == "zonoid_on"),
            daemon_url="http://127.0.0.1:0" if arm == "zonoid_on" else None,
            workspace="/tmp/zonoid-arc-agi-3-dry-run" if arm == "zonoid_on" else None,
            task_key="bench/arc-agi-3-dry-run" if arm == "zonoid_on" else None,
        )
        for task_id in task_ids:
            solved = arm == "zonoid_on" and max_steps >= 3 and task_id.endswith("1")
            records.append({
                "arm": "on" if arm == "zonoid_on" else "cold",
                "category": f"arc-agi-3:{task_id}",
                "question": task_id,
                "gold": "SOLVED",
                "predicted": "SOLVED" if solved else "UNSOLVED",
                "correct": solved,
                "dry_run": True,
                "config_shape": {
                    "arm": cfg["arm"],
                    "max_steps": cfg["max_steps"],
                    "zonoid_enabled": cfg["zonoid"]["enabled"],
                    "has_task_instructions": bool(cfg["zonoid"]["task_instructions"]),
                },
            })

    _write_report(records, out_root, title="ARC-AGI-3 Zonoid A/B dry run")
    print(json.dumps({
        "ok": True,
        "mode": "dry-run",
        "tasks": task_ids,
        "max_steps": max_steps,
        "out_dir": str(out_root),
    }, indent=2))
    return 0


def run_real(
    *,
    max_steps: int,
    task_ids: list[str],
    kb_snapshot: str | None,
    daemon_js: str | None,
    out_dir: str,
    no_isolated_daemon: bool,
) -> int:
    """Run zonoid-on and no-zonoid arms through a supported ARC SDK."""

    pf = preflight(require_node=not no_isolated_daemon)
    if not pf["ok"]:
        print("[arc_agi3_zonoid] PREFLIGHT FAILED - cannot run a real benchmark:")
        for blocker in pf["blockers"]:
            print(f"  - {blocker}")
        print(json.dumps(pf["checks"], indent=2))
        return 2

    out_root = Path(out_dir)
    out_root.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    handle = None

    try:
        daemon_url = None
        workspace = None
        data_dir = None
        task_key = "bench/arc-agi-3-zonoid"

        if not no_isolated_daemon:
            workspace = os.path.abspath(tempfile.mkdtemp(prefix="zonoid-arc-agi3-ws-"))
            handle = daemon_mod.start(daemon_js=daemon_js, workspace=workspace)
            daemon_url = handle.base_url
            data_dir = handle.data_dir
            client = ZonoidClient(daemon_url, workspace=workspace, timeout=180)
            client.warm_up()
            if kb_snapshot:
                from zonoid_bench import warm as warm_mod
                warm_mod.load_snapshot(kb_snapshot, workspace, daemon=daemon_url)
            client.post_status(task_key, "in_progress", "ARC-AGI-3 Zonoid benchmark probe")

        on_cfg = adapter_mod.build_config(
            arm="zonoid_on",
            max_steps=max_steps,
            task_ids=task_ids,
            out_dir=str(out_root),
            zonoid_enabled=True,
            daemon_url=daemon_url,
            workspace=workspace,
            task_key=task_key,
            kb_snapshot=kb_snapshot,
        )
        on_cfg["zonoid"]["data_dir"] = data_dir
        records.extend(adapter_mod.run_real_arm(on_cfg))

        cold_cfg = adapter_mod.build_config(
            arm="no_zonoid",
            max_steps=max_steps,
            task_ids=task_ids,
            out_dir=str(out_root),
            zonoid_enabled=False,
        )
        records.extend(adapter_mod.run_real_arm(cold_cfg))

        _write_report(records, out_root, title="ARC-AGI-3 Zonoid A/B")
        print(json.dumps({"ok": True, "mode": "real", "out_dir": str(out_root)}, indent=2))
        return 0
    except adapter_mod.ArcSdkUnavailable as exc:
        print(f"[arc_agi3_zonoid] BLOCKED: {exc}")
        return 2
    finally:
        if handle is not None:
            daemon_mod.stop(handle)


def _write_report(records: list[dict[str, Any]], out_root: Path, *, title: str) -> None:
    results_path = out_root / "arc-agi3-results.jsonl"
    report_mod.write_results(records, str(results_path))
    scores = report_mod.score(records, use_llm_judge=False, use_f1=True, use_pass_fail=True)
    json_path, md_path = report_mod.render_report(
        scores,
        path_md=str(out_root / "arc-agi3-report.md"),
        path_json=str(out_root / "arc-agi3-report.json"),
        title=title,
    )
    print(f"[arc_agi3_zonoid] results: {results_path}")
    print(f"[arc_agi3_zonoid] report json: {json_path}")
    print(f"[arc_agi3_zonoid] report md: {md_path}")


def _parse_task_ids(raw: str | None) -> list[str]:
    if not raw:
        return list(DEFAULT_TASK_IDS)
    return [part.strip() for part in raw.split(",") if part.strip()]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ARC-AGI-3 Zonoid A/B benchmark adapter.")
    parser.add_argument("--preflight", action="store_true", help="Print real-run readiness JSON.")
    parser.add_argument("--contract", action="store_true", help="Print the ARC SDK adapter contract.")
    parser.add_argument("--dry-run", action="store_true", help="Run offline smoke path and reports.")
    parser.add_argument("--max-steps", type=int, default=10, help="ARC solve step budget.")
    parser.add_argument("--task-ids", default=None, help="Comma-separated ARC task ids.")
    parser.add_argument("--kb-snapshot", default=None, help="Optional Zonoid KB snapshot to inject.")
    parser.add_argument("--daemon-js", default=None, help="Explicit daemon.js path.")
    parser.add_argument("--out-dir", default=None, help="Output directory; defaults to a temp dir.")
    parser.add_argument(
        "--no-isolated-daemon",
        action="store_true",
        help="Do not start a Zonoid daemon; pass zonoid instructions only if the SDK can use them.",
    )
    args = parser.parse_args(argv)

    task_ids = _parse_task_ids(args.task_ids)
    out_dir = args.out_dir or tempfile.mkdtemp(prefix="zonoid-arc-agi3-")

    if args.contract:
        print(adapter_mod.contract_summary())
        return 0
    if args.preflight:
        pf = preflight()
        print(json.dumps(pf, indent=2))
        return 0
    if args.dry_run:
        return dry_run(args.max_steps, task_ids, out_dir)

    return run_real(
        max_steps=args.max_steps,
        task_ids=task_ids,
        kb_snapshot=args.kb_snapshot,
        daemon_js=args.daemon_js,
        out_dir=out_dir,
        no_isolated_daemon=args.no_isolated_daemon,
    )


if __name__ == "__main__":
    raise SystemExit(main())
