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
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
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
from zonoid_bench import workspace as workspace_mod  # noqa: E402
from zonoid_bench.client import ZonoidClient  # noqa: E402
from bench.arc_agi3_zonoid import adapter as adapter_mod  # noqa: E402


DRY_RUN_TASK_IDS = ["arc-agi-3-smoke-1", "arc-agi-3-smoke-2"]
_TASK_ADOPT_TIMEOUT_S = 10.0
_TASK_ADOPT_POLL_S = 0.25


def preflight(
    *,
    require_node: bool = True,
    benchmarking_repo: str | None = None,
    agent_command: str | None = None,
) -> dict[str, Any]:
    """Return machine-readable readiness for a real ARC-AGI-3 A/B run."""

    state = adapter_mod.detect_sdk()
    node_path = shutil.which("node")
    uv_path = shutil.which("uv")
    repo_state = _inspect_benchmarking_repo(benchmarking_repo) if benchmarking_repo else None
    report: dict[str, Any] = {
        "ok": True,
        "blockers": [],
        "checks": {
            "node": node_path or "MISSING",
            "uv": uv_path or "MISSING",
            "arc_sdk_available": state.available,
            "arc_sdk_module": state.module_name,
            "arc_sdk_file": state.module_file,
            "arc_sdk_runner": state.runner_name,
            "arc_sdk_import_errors": state.import_errors,
            "arc_toolkit_pip_package": "arc-agi",
            "arc_toolkit_likely_import": "arc_agi",
            "benchmarking_repo": repo_state,
            "agent_command": agent_command,
            "agent_command_program": _agent_command_program(agent_command),
        },
    }

    if require_node and not node_path:
        report["ok"] = False
        report["blockers"].append("node not on PATH (needed only for zonoid-on isolated daemon)")

    if benchmarking_repo:
        if agent_command and not report["checks"]["agent_command_program"]:
            report["ok"] = False
            report["blockers"].append(
                f"--agent-command program not on PATH: {_agent_command_name(agent_command)!r}"
            )
        if not uv_path:
            report["ok"] = False
            report["blockers"].append("uv not on PATH (official benchmarking quickstart uses `uv run main.py`)")
        if not repo_state or not repo_state["ok"]:
            report["ok"] = False
            report["blockers"].append(
                "benchmarking repo must be a checkout containing main.py "
                "(for example arc-agi-3-benchmarking)"
            )
        return report

    if agent_command:
        if not report["checks"]["agent_command_program"]:
            report["ok"] = False
            report["blockers"].append(
                f"--agent-command program not on PATH: {_agent_command_name(agent_command)!r}"
            )
        return report

    if not state.available:
        report["ok"] = False
        report["blockers"].append(
            "ARC-AGI-3 SDK not importable; install the official toolkit (`pip install arc-agi`) "
            "or set PYTHONPATH so one of "
            f"{', '.join(adapter_mod.SDK_CANDIDATES)} resolves"
        )
    elif not state.runner_name:
        report["ok"] = False
        report["blockers"].append(
            f"ARC SDK package {state.module_name!r} is importable but lacks a supported runner hook "
            "(run_benchmark(config), run(config), or evaluate(config))"
        )

    return report


def _bootstrap_zonoid_requirements_task(
    *,
    client: ZonoidClient,
    data_dir: str,
    task_ids: list[str],
    max_steps: int,
    source: str,
) -> str:
    """Create the bench-owned requirements task and return its graph key."""

    label = "suite" if not task_ids else "-".join(task_ids[:3])
    if len(task_ids) > 3:
        label += f"-plus-{len(task_ids) - 3}"
    label = re.sub(r"[^A-Za-z0-9._-]+", "-", label).strip("-") or "suite"
    task_id = f"arc-agi-3-{label}-requirements"
    games = ", ".join(task_ids) if task_ids else "all available ARC-AGI-3 games"
    subject = f"ARC-AGI-3 requirements for {games}"
    summary = (
        f"Run ARC-AGI-3 via {source} for {games}. The playing agent should solve the game within "
        f"the configured action budget ({max_steps}), use task-scoped Zonoid context before each "
        "decision, and record concise observations after each parsed action."
    )
    task_key = workspace_mod.drop_task_stub(
        data_dir,
        client.workspace or "",
        task_id,
        subject,
        description=summary,
        harness="bench",
        agent_id="arc_agi3_zonoid",
    )
    client.sync()
    deadline = time.time() + _TASK_ADOPT_TIMEOUT_S
    while time.time() < deadline:
        try:
            client.get_task_context(task_key, timeout=30)
            break
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
        time.sleep(_TASK_ADOPT_POLL_S)
    else:
        raise RuntimeError(f"Zonoid bench daemon did not adopt requirements task {task_key!r}")
    client.post_status(task_key, "not_ready", summary=summary, agent_id="arc_agi3_zonoid")
    return task_key


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
    benchmarking_repo: str | None,
    agent_command: str | None,
) -> int:
    """Run zonoid-on and no-zonoid arms through a supported ARC SDK."""

    if benchmarking_repo:
        return run_benchmarking_repo(
            benchmarking_repo=benchmarking_repo,
            task_ids=task_ids,
            max_steps=max_steps,
            kb_snapshot=kb_snapshot,
            daemon_js=daemon_js,
            out_dir=out_dir,
            no_isolated_daemon=no_isolated_daemon,
            agent_command=agent_command,
        )

    pf = preflight(require_node=not no_isolated_daemon, agent_command=agent_command)
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
        task_key = "bench/arc-agi-3-suite-requirements"

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
            task_key = _bootstrap_zonoid_requirements_task(
                client=client,
                data_dir=data_dir,
                task_ids=task_ids,
                max_steps=max_steps,
                source="direct SDK/local agent",
            )

        on_cfg = adapter_mod.build_config(
            arm="zonoid_on",
            max_steps=max_steps,
            task_ids=task_ids,
            out_dir=str(out_root),
            zonoid_enabled=bool(daemon_url and workspace),
            daemon_url=daemon_url,
            workspace=workspace,
            task_key=task_key,
            kb_snapshot=kb_snapshot,
        )
        on_cfg["zonoid"]["data_dir"] = data_dir
        if on_cfg["zonoid"]["enabled"]:
            on_cfg["zonoid"]["context_json"] = adapter_mod.write_zonoid_context_file(
                on_cfg["zonoid"], str(out_root), arm="zonoid_on"
            )
        if agent_command:
            records.extend(adapter_mod.run_agent_arm(on_cfg, agent_command=agent_command))
        else:
            records.extend(adapter_mod.run_real_arm(on_cfg))

        cold_cfg = adapter_mod.build_config(
            arm="no_zonoid",
            max_steps=max_steps,
            task_ids=task_ids,
            out_dir=str(out_root),
            zonoid_enabled=False,
        )
        cold_cfg["zonoid"]["context_json"] = adapter_mod.write_zonoid_context_file(
            cold_cfg["zonoid"], str(out_root), arm="no_zonoid"
        )
        if agent_command:
            records.extend(adapter_mod.run_agent_arm(cold_cfg, agent_command=agent_command))
        else:
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


def run_benchmarking_repo(
    *,
    benchmarking_repo: str,
    task_ids: list[str],
    max_steps: int,
    kb_snapshot: str | None,
    daemon_js: str | None,
    out_dir: str,
    no_isolated_daemon: bool,
    agent_command: str | None,
) -> int:
    """Run the official arc-agi-3-benchmarking CLI path when supplied.

    The official quickstart documents `uv run main.py --game=ls20`, `--list-games`, and
    `--list-configs`. This adapter does not know a stable in-process API for that repo, so it shells
    out to that CLI. Zonoid env injection is used only if the checkout appears to have a Zonoid hook.
    """

    pf = preflight(
        require_node=not no_isolated_daemon,
        benchmarking_repo=benchmarking_repo,
        agent_command=agent_command,
    )
    if not pf["ok"]:
        print("[arc_agi3_zonoid] PREFLIGHT FAILED - cannot run official benchmarking repo:")
        for blocker in pf["blockers"]:
            print(f"  - {blocker}")
        print(json.dumps(pf["checks"], indent=2))
        return 2

    repo = Path(benchmarking_repo).resolve()
    out_root = Path(out_dir)
    out_root.mkdir(parents=True, exist_ok=True)
    repo_state = _inspect_benchmarking_repo(str(repo))
    supports_zonoid = bool(repo_state and repo_state.get("zonoid_integration_hint"))
    handle = None
    blocker: str | None = None
    records: list[dict[str, Any]] = []

    try:
        zonoid_env: dict[str, str] = {}
        if supports_zonoid and not no_isolated_daemon:
            workspace = os.path.abspath(tempfile.mkdtemp(prefix="zonoid-arc-agi3-ws-"))
            handle = daemon_mod.start(daemon_js=daemon_js, workspace=workspace)
            client = ZonoidClient(handle.base_url, workspace=workspace, timeout=180)
            client.warm_up()
            if kb_snapshot:
                from zonoid_bench import warm as warm_mod
                warm_mod.load_snapshot(kb_snapshot, workspace, daemon=handle.base_url)
            task_key = _bootstrap_zonoid_requirements_task(
                client=client,
                data_dir=handle.data_dir,
                task_ids=task_ids,
                max_steps=max_steps,
                source="official arc-agi-3-benchmarking harness",
            )
            payload = adapter_mod.zonoid_context_payload(
                enabled=True,
                daemon_url=handle.base_url,
                workspace=workspace,
                task_key=task_key,
                kb_snapshot=kb_snapshot,
            )
            context_json = adapter_mod.write_zonoid_context_file(
                payload, str(out_root), arm="zonoid_on"
            )
            zonoid_env = adapter_mod.zonoid_context_env(payload, context_json=context_json)
        elif supports_zonoid and no_isolated_daemon:
            blocker = "benchmarking repo hints at Zonoid support, but --no-isolated-daemon was set; no daemon URL was provided."
        else:
            blocker = (
                "benchmarking repo does not appear to contain a Zonoid integration point "
                "(no ZONOID/zonoid tokens found in Python files), so only the official baseline was run."
            )

        baseline_results = _run_official_cli_arm(
            repo=repo,
            task_ids=task_ids,
            arm="no_zonoid",
            out_root=out_root,
            max_steps=max_steps,
            extra_env={},
            agent_command=agent_command,
        )
        records.extend(baseline_results)

        if supports_zonoid and zonoid_env:
            records.extend(_run_official_cli_arm(
                repo=repo,
                task_ids=task_ids,
                arm="zonoid_on",
                out_root=out_root,
                max_steps=max_steps,
                extra_env=zonoid_env,
                agent_command=agent_command,
            ))
            _write_report(records, out_root, title="ARC-AGI-3 official harness Zonoid A/B")
            print(json.dumps({"ok": True, "mode": "benchmarking-repo", "out_dir": str(out_root)}, indent=2))
            return 0

        _write_report(records, out_root, title="ARC-AGI-3 official harness baseline")
        blocker_path = out_root / "zonoid-on-blocker.json"
        blocker_path.write_text(json.dumps({
            "ok": False,
            "blocker": blocker,
            "baseline_ran": True,
            "repo": str(repo),
        }, indent=2), encoding="utf-8")
        print(f"[arc_agi3_zonoid] BLOCKED: {blocker}")
        print(f"[arc_agi3_zonoid] blocker json: {blocker_path}")
        return 2
    finally:
        if handle is not None:
            daemon_mod.stop(handle)


def _run_official_cli_arm(
    *,
    repo: Path,
    task_ids: list[str],
    arm: str,
    out_root: Path,
    max_steps: int,
    extra_env: dict[str, str],
    agent_command: str | None,
) -> list[dict[str, Any]]:
    env = os.environ.copy()
    env.update(extra_env)
    env["ZONOID_ARC_ARM"] = arm
    env["ARC_MAX_ACTIONS"] = str(max_steps)
    if agent_command:
        env["ARC_AGENT_COMMAND"] = agent_command
        env["ZONOID_ARC_AGENT_COMMAND"] = agent_command
    commands = _official_commands(task_ids, local_cli=bool(agent_command))
    records: list[dict[str, Any]] = []
    arm_dir = out_root / arm
    arm_dir.mkdir(parents=True, exist_ok=True)

    for idx, cmd in enumerate(commands):
        label = task_ids[idx] if task_ids else "all-games"
        print(f"[arc_agi3_zonoid] {arm}: {' '.join(cmd)}")
        res = subprocess.run(cmd, cwd=repo, env=env, text=True, capture_output=True)
        (arm_dir / f"{label}.stdout.txt").write_text(res.stdout or "", encoding="utf-8")
        (arm_dir / f"{label}.stderr.txt").write_text(res.stderr or "", encoding="utf-8")
        combined_output = f"{res.stdout or ''}\n{res.stderr or ''}"
        harness_blocked = (
            "No games available to play" in combined_output
            or "API request failed with status 401" in combined_output
        )
        predicted = "BLOCKED" if harness_blocked else (
            "EXIT_0" if res.returncode == 0 else f"EXIT_{res.returncode}"
        )
        records.append({
            "arm": "on" if arm == "zonoid_on" else "cold",
            "category": f"arc-agi-3:{label}",
            "question": label,
            "gold": "EXIT_0",
            "predicted": predicted,
            "correct": res.returncode == 0 and not harness_blocked,
            "command": cmd,
            "stdout_path": str(arm_dir / f"{label}.stdout.txt"),
            "stderr_path": str(arm_dir / f"{label}.stderr.txt"),
        })
    return records


def _official_commands(task_ids: list[str], *, local_cli: bool = False) -> list[list[str]]:
    config_args = ["--config=zonoid-local-cli"] if local_cli else []
    if not task_ids:
        return [["uv", "run", "main.py", *config_args]]
    return [["uv", "run", "main.py", f"--game={task_id}", *config_args] for task_id in task_ids]


def _agent_command_program(agent_command: str | None) -> str | None:
    name = _agent_command_name(agent_command)
    if not name:
        return None
    return shutil.which(name)


def _agent_command_name(agent_command: str | None) -> str | None:
    if not agent_command:
        return None
    try:
        parts = shlex.split(agent_command)
    except ValueError:
        return None
    if not parts:
        return None
    return parts[0]


def _inspect_benchmarking_repo(path: str | None) -> dict[str, Any] | None:
    if not path:
        return None
    repo = Path(path)
    main_py = repo / "main.py"
    state: dict[str, Any] = {
        "path": str(repo),
        "ok": repo.is_dir() and main_py.is_file(),
        "main_py": str(main_py),
        "zonoid_integration_hint": False,
    }
    if state["ok"]:
        try:
            for py_file in repo.rglob("*.py"):
                if ".venv" in py_file.parts:
                    continue
                text = py_file.read_text(encoding="utf-8", errors="ignore")
                if "ZONOID" in text or "zonoid" in text:
                    state["zonoid_integration_hint"] = True
                    state["zonoid_integration_file"] = str(py_file)
                    break
        except OSError as exc:
            state["zonoid_scan_error"] = repr(exc)
    return state


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
        return []
    return [part.strip() for part in raw.split(",") if part.strip()]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ARC-AGI-3 Zonoid A/B benchmark adapter.")
    parser.add_argument("--preflight", action="store_true", help="Print real-run readiness JSON.")
    parser.add_argument("--contract", action="store_true", help="Print the ARC SDK adapter contract.")
    parser.add_argument("--dry-run", action="store_true", help="Run offline smoke path and reports.")
    parser.add_argument("--max-steps", type=int, default=10, help="ARC solve step budget.")
    parser.add_argument("--task-ids", default=None, help="Comma-separated ARC task ids.")
    parser.add_argument(
        "--benchmarking-repo",
        default=None,
        help="Path to an official arc-agi-3-benchmarking checkout; invokes `uv run main.py`.",
    )
    parser.add_argument(
        "--agent-command",
        default=None,
        help="Generic local authenticated CLI agent command, for example `codex exec` or `claude -p`.",
    )
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
        pf = preflight(benchmarking_repo=args.benchmarking_repo, agent_command=args.agent_command)
        print(json.dumps(pf, indent=2))
        return 0
    if args.dry_run:
        return dry_run(args.max_steps, task_ids or list(DRY_RUN_TASK_IDS), out_dir)

    return run_real(
        max_steps=args.max_steps,
        task_ids=task_ids,
        kb_snapshot=args.kb_snapshot,
        daemon_js=args.daemon_js,
        out_dir=out_dir,
        no_isolated_daemon=args.no_isolated_daemon,
        benchmarking_repo=args.benchmarking_repo,
        agent_command=args.agent_command,
    )


if __name__ == "__main__":
    raise SystemExit(main())
