"""bench/tb_zonoid/runner.py — Zonoid × Terminal-Bench A/B runner.

(Package is ``bench/tb_zonoid/`` — NOT ``bench/terminal_bench/`` — deliberately: a local package
literally named ``terminal_bench`` next to ``bench/`` on sys.path SHADOWS the PyPI ``terminal_bench``
package, so the adapter could never import the real harness. ``tb_zonoid`` is collision-free; the
in-repo home for the Terminal-Bench integration is this directory.)

Drives ONE (or N) Terminal-Bench task end-to-end in BOTH arms and emits a contrast scorecard,
mirroring the A/B structure of ``bench/zonoid_bench/smoke.py``:

  ARM A (zonoid-on)  : a per-task isolated bench daemon is stood up (``zonoid_bench.daemon.start``,
                       LIVE-bound to a per-task workspace), the pre-learnt KB is injected
                       (``zonoid_bench.warm.load_snapshot``), and the TB harness runs the task with
                       ``adapter:ZonoidAgent`` — which DRIVES THE SDK
                       (``arms.run_agent_in_container``: probe mint → autowire → PRODUCTION
                       ``/judge/drain`` judge → API-only AGENTS.md) and injects that AGENTS.md into
                       the task container before solving.
  ARM B (no-zonoid)  : the SAME task runs with ``adapter:NoZonoidAgent`` — identical solver, NO KB,
                       NO daemon wiring. The contrast / rigging floor.

TB grades each arm by the task's OWN hidden tests (``is_resolved``); the runner reads TB's
``results.json``, builds Zonoid-SDK report records (``arm/category/question/gold/predicted/correct``),
and scores + renders with ``zonoid_bench.report`` so the output is the same scorecard shape as every
other Zonoid bench.

REUSE: the runner hand-rolls NOTHING. Daemon = ``zonoid_bench.daemon``; KB inject = ``zonoid_bench.warm``;
ON-arm wiring + judge = ``zonoid_bench.arms`` (inside the agent); scoring/report = ``zonoid_bench.report``;
TB execution = the ``terminal_bench`` harness. The runner is the conductor.

Usage
-----
  # Full A/B on one task (requires Docker + the terminal-bench package):
  python bench/tb_zonoid/runner.py --task-id hello-world --kb-snapshot <dir>

  # Inspect the adapter contract WITHOUT Docker/TB (the documented Windows blocker):
  python bench/tb_zonoid/runner.py --contract

  # Preflight only — report exactly what is missing to run for real:
  python bench/tb_zonoid/runner.py --preflight

Runtime: stdlib + the Zonoid SDK (stdlib-only) + (for a real run) the ``terminal_bench`` package and
a running Docker engine. Node is required to spawn the bench daemon.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

# ── path bootstrap ─────────────────────────────────────────────────────────────
# Two paths matter:
#   - bench/      on sys.path → the SDK imports as ``zonoid_bench.*`` (existing convention).
#   - repo root   on sys.path AND PYTHONPATH → TB resolves the agent via its dotted
#                 ``--agent-import-path bench.tb_zonoid.adapter:ZonoidAgent``
#                 (importlib.import_module("bench.tb_zonoid.adapter")); PYTHONPATH so any
#                 TB-spawned subprocess inherits the resolution too.
_HERE = os.path.dirname(os.path.abspath(__file__))   # bench/tb_zonoid/
_BENCH = os.path.dirname(_HERE)                        # bench/
_REPO_ROOT = os.path.dirname(_BENCH)                  # repo root
if _BENCH not in sys.path:
    sys.path.insert(0, _BENCH)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)
# Propagate repo root onto PYTHONPATH for any child process the TB harness spawns.
_existing_pp = os.environ.get("PYTHONPATH", "")
if _REPO_ROOT not in _existing_pp.split(os.pathsep):
    os.environ["PYTHONPATH"] = (
        _REPO_ROOT + (os.pathsep + _existing_pp if _existing_pp else "")
    )

# Force UTF-8 output (embeddable Python console is cp1252).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:
        pass

from zonoid_bench import daemon as daemon_mod          # noqa: E402
from zonoid_bench.client import ZonoidClient           # noqa: E402
from zonoid_bench import report as report_mod          # noqa: E402

# adapter.contract_summary works without TB; the agent classes are imported by TB itself
# via --agent-import-path, not here.
from bench.tb_zonoid import adapter as adapter_mod  # type: ignore  # noqa: E402


# ---------------------------------------------------------------------------
# Preflight — detect the exact environment blockers (honest, no faked run)
# ---------------------------------------------------------------------------

def preflight() -> dict[str, Any]:
    """Return a structured report of whether a REAL TB A/B run is possible here.

    Checks (each independently fatal):
      - node on PATH (bench daemon spawn)
      - the ``terminal_bench`` package importable
      - the ``docker`` python SDK importable (TB dependency)
      - a reachable Docker engine (``docker info``)
    """
    report: dict[str, Any] = {"ok": True, "blockers": [], "checks": {}}

    # node
    node = shutil.which("node") or shutil.which("node.exe")
    report["checks"]["node"] = node or "MISSING"
    if not node:
        report["ok"] = False
        report["blockers"].append("node not on PATH (needed to spawn the bench daemon)")

    # terminal_bench package
    try:
        import terminal_bench  # noqa: F401
        report["checks"]["terminal_bench"] = getattr(terminal_bench, "__file__", "imported")
    except Exception as exc:  # noqa: BLE001
        report["checks"]["terminal_bench"] = f"MISSING: {exc!r}"
        report["ok"] = False
        report["blockers"].append(
            "terminal-bench not installed (pip install terminal-bench / uv tool install terminal-bench)"
        )

    # docker python SDK
    try:
        import docker  # noqa: F401
        report["checks"]["docker_sdk"] = "imported"
    except Exception as exc:  # noqa: BLE001
        report["checks"]["docker_sdk"] = f"MISSING: {exc!r}"
        report["ok"] = False
        report["blockers"].append("docker python SDK not installed (a terminal-bench dependency)")

    # docker engine reachable
    docker_bin = shutil.which("docker") or shutil.which("docker.exe")
    report["checks"]["docker_bin"] = docker_bin or "MISSING"
    engine_ok = False
    if docker_bin:
        import subprocess
        try:
            res = subprocess.run(
                [docker_bin, "info", "--format", "{{.ServerVersion}}"],
                capture_output=True, text=True, timeout=25,
            )
            engine_ok = res.returncode == 0 and bool(res.stdout.strip())
            report["checks"]["docker_engine"] = (
                res.stdout.strip() if engine_ok else f"UNREACHABLE: {(res.stderr or '').strip()[:200]}"
            )
        except Exception as exc:  # noqa: BLE001
            report["checks"]["docker_engine"] = f"UNREACHABLE: {exc!r}"
    else:
        report["checks"]["docker_engine"] = "MISSING (no docker binary)"
    if not engine_ok:
        report["ok"] = False
        report["blockers"].append(
            "Docker engine not reachable (start Docker Desktop / the Linux engine; "
            "`docker info` must succeed)"
        )

    return report


# ---------------------------------------------------------------------------
# host.docker.internal port (the in-container agent → host daemon bridge)
# ---------------------------------------------------------------------------

def _agent_url_for(port: int) -> str:
    """The base URL the in-container TB agent uses to reach the host bench daemon.

    Docker Desktop (Win/Mac) resolves ``host.docker.internal`` to the host automatically. On Linux,
    TB must start the container with ``--add-host=host.docker.internal:host-gateway`` (current TB
    images do; if a custom task image does not, the agent falls back to model-only behaviour and the
    ON arm degrades gracefully — it never crashes the task).
    """
    return f"http://host.docker.internal:{port}"


# ---------------------------------------------------------------------------
# One TB arm run via the Python harness API
# ---------------------------------------------------------------------------

def _run_tb_arm(
    *,
    arm_label: str,
    agent_import_path: str,
    task_id: str,
    dataset_name: str,
    dataset_version: Optional[str],
    dataset_path: Optional[str],
    output_root: Path,
    model_name: Optional[str],
    extra_env: dict[str, str],
) -> dict[str, Any]:
    """Run ONE TB arm on ONE task; return {task_id, is_resolved, in_tokens, out_tokens, failure_mode}.

    Uses the TB Python API (``terminal_bench.harness.harness.Harness``) so the whole A/B is one
    process — no shelling out to ``tb run`` and re-parsing stdout. The agent is selected by
    ``agent_import_path`` (``bench.tb_zonoid.adapter:ZonoidAgent`` | ``:NoZonoidAgent``).
    """
    from terminal_bench.harness.harness import Harness  # local import (TB required only for a real run)

    # Per-arm env (the ZonoidAgent reads daemon URL / workspace / data_dir from here).
    saved = {k: os.environ.get(k) for k in extra_env}
    os.environ.update(extra_env)
    try:
        out_path = output_root / arm_label
        out_path.mkdir(parents=True, exist_ok=True)

        kwargs: dict[str, Any] = dict(
            agent_import_path=agent_import_path,
            task_ids=[task_id],
            output_path=out_path,
            n_concurrent_trials=1,
            model_name=model_name,
        )
        if dataset_path:
            kwargs["dataset_path"] = Path(dataset_path)
        else:
            kwargs["dataset_name"] = dataset_name
            if dataset_version:
                kwargs["dataset_version"] = dataset_version

        harness = Harness(**kwargs)
        results = harness.run()

        # Pull the single trial result for this task.
        trial = None
        for r in getattr(results, "results", []) or []:
            if getattr(r, "task_id", None) == task_id:
                trial = r
                break
        if trial is None and (getattr(results, "results", None)):
            trial = results.results[0]

        return {
            "arm": arm_label,
            "task_id": task_id,
            "is_resolved": bool(getattr(trial, "is_resolved", False)) if trial else False,
            "in_tokens": int(getattr(trial, "total_input_tokens", 0) or 0) if trial else 0,
            "out_tokens": int(getattr(trial, "total_output_tokens", 0) or 0) if trial else 0,
            "failure_mode": str(getattr(trial, "failure_mode", "")) if trial else "no_trial",
            "results_json": str(out_path),
        }
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


# ---------------------------------------------------------------------------
# Full A/B
# ---------------------------------------------------------------------------

def run_ab(
    *,
    task_id: str,
    dataset_name: str = "terminal-bench-core",
    dataset_version: Optional[str] = None,
    dataset_path: Optional[str] = None,
    kb_snapshot: Optional[str] = None,
    agents_md: Optional[str] = None,
    model_name: Optional[str] = None,
    daemon_js: Optional[str] = None,
    out_dir: Optional[str] = None,
) -> int:
    """Stand up the bench daemon + KB, run BOTH TB arms on *task_id*, score, and render the report.

    Returns 0 if the A/B completed (regardless of which arm won — TB pass/fail is data, not a gate),
    1 on a fatal harness/daemon error.
    """
    pf = preflight()
    if not pf["ok"]:
        print("[runner] PREFLIGHT FAILED — cannot run a real A/B here:")
        for b in pf["blockers"]:
            print(f"  - {b}")
        print("\n[runner] checks:")
        for k, v in pf["checks"].items():
            print(f"    {k:16s}: {v}")
        print("\nRun `--contract` to inspect the wired adapter without Docker/TB.")
        return 1

    out_root = Path(out_dir or tempfile.mkdtemp(prefix="zonoid-tb-ab-"))
    out_root.mkdir(parents=True, exist_ok=True)
    print(f"[runner] output root: {out_root}")

    # ── PHASE 0: bench daemon, LIVE-bound to a per-task workspace ──────────────
    workspace = os.path.abspath(tempfile.mkdtemp(prefix="zonoid-tb-ws-"))
    print(f"[runner] starting isolated bench daemon (live ws={workspace}) ...")
    if daemon_js is None:
        try:
            from zonoid_bench.smoke import _find_daemon_js
            daemon_js = _find_daemon_js()
        except Exception:
            daemon_js = os.path.join(_REPO_ROOT, "daemon.js")
    print(f"[runner] daemon.js: {daemon_js}")
    handle = daemon_mod.start(daemon_js=daemon_js, workspace=workspace)
    port = handle.port
    base_url = handle.base_url
    data_dir = handle.data_dir
    print(f"[runner] daemon ready: {base_url}  data_dir={data_dir!r}  port={port}")

    try:
        client = ZonoidClient(base_url, workspace=workspace, timeout=180)
        client.warm_up()
        client.search("warmup", k=1)

        # ── PHASE 1: inject the pre-learnt KB into the live workspace ──────────
        if kb_snapshot:
            print(f"[runner] injecting KB snapshot: {kb_snapshot} -> {workspace}")
            from zonoid_bench import warm as warm_mod
            warm_mod.load_snapshot(
                kb_snapshot, workspace, daemon=base_url, agents_md=agents_md
            )
        else:
            print("[runner] no --kb-snapshot given; ON arm relies on whatever KB the workspace holds "
                  "(autowire may be judge-idle — reported honestly).")

        # The in-container agent reaches the daemon via host.docker.internal:<port>.
        agent_url = _agent_url_for(port)
        common_env = {
            adapter_mod.DAEMON_URL_ENV: base_url,      # host-side SDK wiring call
            adapter_mod.AGENT_URL_ENV: agent_url,      # in-container curl target
            adapter_mod.WORKSPACE_ENV: workspace,
            adapter_mod.DATA_DIR_ENV: data_dir,
        }
        if model_name:
            common_env["ZONOID_TB_MODEL"] = model_name

        # ── PHASE 2: ARM A — zonoid-on ─────────────────────────────────────────
        print("\n[runner] === ARM A: zonoid-on ===")
        arm_a = _run_tb_arm(
            arm_label="zonoid_on",
            agent_import_path="bench.tb_zonoid.adapter:ZonoidAgent",
            task_id=task_id,
            dataset_name=dataset_name,
            dataset_version=dataset_version,
            dataset_path=dataset_path,
            output_root=out_root,
            model_name=model_name,
            extra_env=common_env,
        )
        print(f"[runner] ARM A result: {arm_a}")

        # ── PHASE 3: ARM B — no-zonoid baseline ────────────────────────────────
        print("\n[runner] === ARM B: no-zonoid ===")
        arm_b = _run_tb_arm(
            arm_label="no_zonoid",
            agent_import_path="bench.tb_zonoid.adapter:NoZonoidAgent",
            task_id=task_id,
            dataset_name=dataset_name,
            dataset_version=dataset_version,
            dataset_path=dataset_path,
            output_root=out_root,
            model_name=model_name,
            extra_env={},  # baseline gets NO zonoid env
        )
        print(f"[runner] ARM B result: {arm_b}")

        # ── PHASE 4: score + report via the Zonoid SDK report module ───────────
        # TB is pass/fail, so we build records carrying ``correct`` (is_resolved). The report's
        # pass-rate aggregation gives the A/B contrast in the same scorecard shape as every Zonoid
        # bench. gold/predicted are filled with a resolved/unresolved token so token-F1 is defined
        # too (the headline for TB is the pass rate, not F1).
        records = []
        for res in (arm_a, arm_b):
            resolved = bool(res["is_resolved"])
            records.append({
                "arm": "on" if res["arm"] == "zonoid_on" else "cold",
                "category": f"terminal-bench:{task_id}",
                "question": task_id,
                "gold": "RESOLVED",
                "predicted": "RESOLVED" if resolved else "UNRESOLVED",
                "correct": resolved,
                "input_tokens": res["in_tokens"],
                "output_tokens": res["out_tokens"],
                "failure_mode": res["failure_mode"],
            })

        results_path = out_root / "ab-results.jsonl"
        report_mod.write_results(records, str(results_path))
        scores = report_mod.score(records, use_llm_judge=False, use_f1=True, use_pass_fail=True)
        json_path, md_path = report_mod.render_report(
            scores,
            path_md=str(out_root / "ab-report.md"),
            path_json=str(out_root / "ab-report.json"),
            title=f"Zonoid × Terminal-Bench A/B — task {task_id}",
        )

        print("\n" + "=" * 70)
        print(f"A/B COMPLETE — task {task_id}")
        print("=" * 70)
        print(f"  zonoid-on  : {'RESOLVED' if arm_a['is_resolved'] else 'unresolved'}  "
              f"(in={arm_a['in_tokens']} out={arm_a['out_tokens']} fail={arm_a['failure_mode']})")
        print(f"  no-zonoid  : {'RESOLVED' if arm_b['is_resolved'] else 'unresolved'}  "
              f"(in={arm_b['in_tokens']} out={arm_b['out_tokens']} fail={arm_b['failure_mode']})")
        print(f"  report.json -> {json_path}")
        print(f"  report.md   -> {md_path}")
        print(f"  results     -> {results_path}")
        return 0
    finally:
        print(f"\n[runner] stopping daemon (port={port}) ...")
        rc = daemon_mod.stop(handle)
        print(f"[runner] daemon exited code={rc}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(
        description="Zonoid × Terminal-Bench A/B runner (zonoid-on vs no-zonoid)."
    )
    p.add_argument("--task-id", default="hello-world",
                   help="Terminal-Bench task id to run in both arms (default: hello-world).")
    p.add_argument("--dataset-name", default="terminal-bench-core",
                   help="TB dataset name (default: terminal-bench-core).")
    p.add_argument("--dataset-version", default=None, help="TB dataset version (optional).")
    p.add_argument("--dataset-path", default=None,
                   help="Local TB dataset/tasks path (overrides --dataset-name).")
    p.add_argument("--kb-snapshot", default=None,
                   help="Pre-learnt KB snapshot dir (zonoid_bench.warm.load_snapshot) to inject "
                        "into the ON-arm workspace. Without it the ON arm uses an empty KB.")
    p.add_argument("--agents-md", default=None,
                   help="Optional pre-exported AGENTS.md to passthrough via warm.load_snapshot.")
    p.add_argument("--model", default=None, dest="model_name",
                   help="Model for the in-container solver + TB harness (e.g. anthropic/claude-...).")
    p.add_argument("--daemon-js", default=None, help="Explicit daemon.js path (else auto-resolved).")
    p.add_argument("--out-dir", default=None, help="Output dir for results/reports (else temp).")
    p.add_argument("--contract", action="store_true",
                   help="Print the TB agent-adapter contract this adapter implements, then exit.")
    p.add_argument("--preflight", action="store_true",
                   help="Print the environment preflight (what's missing to run for real), then exit.")
    args = p.parse_args(argv)

    if args.contract:
        print(adapter_mod.contract_summary())
        print(f"terminal_bench importable: {adapter_mod._TB_AVAILABLE}")
        if not adapter_mod._TB_AVAILABLE:
            print(f"  import error: {adapter_mod._TB_IMPORT_ERROR!r}")
        return 0

    if args.preflight:
        pf = preflight()
        print(json.dumps(pf, indent=2))
        return 0 if pf["ok"] else 2

    return run_ab(
        task_id=args.task_id,
        dataset_name=args.dataset_name,
        dataset_version=args.dataset_version,
        dataset_path=args.dataset_path,
        kb_snapshot=args.kb_snapshot,
        agents_md=args.agents_md,
        model_name=args.model_name,
        daemon_js=args.daemon_js,
        out_dir=args.out_dir,
    )


if __name__ == "__main__":
    sys.exit(main())
