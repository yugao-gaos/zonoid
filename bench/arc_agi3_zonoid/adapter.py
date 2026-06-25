"""ARC-AGI-3 SDK boundary for the Zonoid benchmark runner.

The public ARC-AGI-3 Python contract is intentionally isolated here. Offline modes import this
module without ARC credentials or packages; a real run only proceeds when a supported SDK is
importable and has an explicit callable entry point.
"""

from __future__ import annotations

import importlib
import inspect
import json
import os
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SDK_CANDIDATES: tuple[str, ...] = (
    "arc_agi",
    "arc_agi_3",
    "arc_agi3",
    "arcagi3",
    "arc",
)


@dataclass(frozen=True)
class ArcSdkState:
    """Import/preflight state for likely ARC-AGI-3 SDK packages."""

    available: bool
    module_name: str | None
    module_file: str | None
    import_errors: dict[str, str]
    runner_name: str | None = None


class ArcSdkUnavailable(RuntimeError):
    """Raised when a real ARC run is requested but no supported SDK contract is present."""


def detect_sdk() -> ArcSdkState:
    """Detect likely ARC-AGI-3 packages without requiring one for offline modes."""

    errors: dict[str, str] = {}
    for name in SDK_CANDIDATES:
        try:
            module = importlib.import_module(name)
        except Exception as exc:  # noqa: BLE001
            errors[name] = repr(exc)
            continue

        runner_name = _find_runner_name(module)
        return ArcSdkState(
            available=True,
            module_name=name,
            module_file=getattr(module, "__file__", None),
            import_errors=errors,
            runner_name=runner_name,
        )

    return ArcSdkState(
        available=False,
        module_name=None,
        module_file=None,
        import_errors=errors,
    )


def _find_runner_name(module: Any) -> str | None:
    """Return the first explicit runner hook this adapter knows how to call."""

    for name in ("run_benchmark", "run", "evaluate"):
        obj = getattr(module, name, None)
        if callable(obj):
            return name
    return None


def contract_summary() -> str:
    """Human-readable adapter contract for `runner.py --contract`."""

    state = detect_sdk()
    lines = [
        "ARC-AGI-3 Zonoid adapter contract",
        "",
        "Offline modes:",
        "  --preflight, --contract, and --dry-run do not import or require ARC credentials.",
        "",
        "Supported real-run SDK contract:",
        "  Mode 0 - local authenticated CLI agent:",
        "  1. Pass --agent-command with a generic local command, such as `codex exec` or `claude -p`.",
        "  2. The adapter sends one ARC prompt on stdin per task and records stdout as the prediction.",
        "  3. If stdout is JSON, correct/solved/pass/passed/success and predicted/output/answer are honored.",
        "",
        "  Mode A - direct Python hook:",
        "  1. One likely package is importable: " + ", ".join(SDK_CANDIDATES),
        "     Official ARC Toolkit package is documented as `pip install arc-agi`, likely import `arc_agi`.",
        "  2. The package exposes one callable: run_benchmark(config), run(config), or evaluate(config).",
        "  3. The callable returns either:",
        "     - a list of per-task dicts, or",
        "     - a dict with a 'results' list.",
        "  4. Each result should include task_id/id, correct/solved/pass, predicted/output, and optional metrics.",
        "",
        "  Mode B - official arc-agi-3-benchmarking checkout:",
        "  1. Pass --benchmarking-repo /path/to/arc-agi-3-benchmarking.",
        "  2. The runner invokes `uv run main.py --game=<task_id>` for each task id, or `uv run main.py`",
        "     when no task ids are supplied. The official quickstart also advertises --list-games and",
        "     --list-configs; this adapter does not invent extra flags.",
        "  3. Zonoid context is exported via environment variables only if the checkout appears to contain",
        "     a Zonoid integration point. Otherwise the runner may run the baseline and returns a blocker",
        "     for the zonoid-on arm instead of pretending an A/B ran.",
        "",
        "Config passed to the SDK callable:",
        "  arm: 'zonoid_on' or 'no_zonoid'",
        "  max_steps: integer step budget",
        "  task_ids: optional list of task ids",
        "  zonoid: dict with enabled, daemon_url, workspace, task_instructions, kb_snapshot",
        "  metadata: runner output directory and adapter name",
        "",
        "Zonoid-on instructions are task-scoped and API-only:",
        "  - read task context from /task/context with workspace and task_key",
        "  - search with /search using workspace and task_key",
        "  - record durable findings with /overlay/note when useful",
        "",
        "Zonoid context hook surface:",
        "  - env: ZONOID_ENABLED, ZONOID_DAEMON_URL, ZONOID_WORKSPACE, ZONOID_TASK_KEY",
        "  - env: ZONOID_KB_SNAPSHOT, ZONOID_TASK_INSTRUCTIONS, ZONOID_CONTEXT_JSON",
        "  - JSON payload: enabled, daemon_url, workspace, task_key, task_instructions, kb_snapshot",
        "  The official checkout path exports these only for a visible Zonoid hook; otherwise zonoid-on",
        "  reports a blocker after the baseline instead of pretending env vars were consumed.",
        "",
        "Current SDK detection:",
        f"  available: {state.available}",
        f"  module: {state.module_name or 'none'}",
        f"  file: {state.module_file or 'none'}",
        f"  runner: {state.runner_name or 'none'}",
    ]
    return "\n".join(lines)


def zonoid_task_instructions(*, daemon_url: str, workspace: str, task_key: str) -> str:
    """Instructions a capable ARC SDK/agent can inject into a task solve loop."""

    return (
        "Zonoid is enabled for this ARC-AGI-3 trial. Use the task-scoped memory APIs; do not "
        "treat prior knowledge as ground truth without checking the task.\n\n"
        f"- task_key: {task_key}\n"
        f"- workspace: {workspace}\n"
        f"- daemon: {daemon_url}\n"
        "- Before proposing a grid transformation, request context:\n"
        f"  GET {daemon_url}/task/context?key={task_key}&workspace=<urlencoded workspace>\n"
        "- Search for related evidence with:\n"
        f"  GET {daemon_url}/search?q=<query>&k=5&workspace=<urlencoded workspace>&task_key={task_key}&gated=false\n"
        "- Prefer task evidence over generic ARC priors. Record non-obvious reusable findings as notes "
        "only if the SDK exposes a note/write hook.\n"
    )


def zonoid_context_payload(
    *,
    enabled: bool,
    daemon_url: str | None,
    workspace: str | None,
    task_key: str | None,
    kb_snapshot: str | None = None,
) -> dict[str, Any]:
    """Reusable payload for patched ARC harnesses and local CLI agents."""

    instructions = None
    if enabled and daemon_url and workspace and task_key:
        instructions = zonoid_task_instructions(
            daemon_url=daemon_url, workspace=workspace, task_key=task_key
        )
    return {
        "enabled": enabled,
        "daemon_url": daemon_url,
        "workspace": workspace,
        "task_key": task_key,
        "task_instructions": instructions,
        "kb_snapshot": kb_snapshot,
    }


def write_zonoid_context_file(payload: dict[str, Any], out_dir: str, *, arm: str) -> str:
    """Write a small JSON context file and return its absolute path."""

    path = Path(out_dir).resolve() / f"{arm}-zonoid-context.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return str(path)


def zonoid_context_env(payload: dict[str, Any], *, context_json: str | None = None) -> dict[str, str]:
    """Environment variables a patched official harness or CLI wrapper can consume."""

    env = {
        "ZONOID_ENABLED": "1" if payload.get("enabled") else "0",
        "ZONOID_DAEMON_URL": str(payload.get("daemon_url") or ""),
        "ZONOID_WORKSPACE": str(payload.get("workspace") or ""),
        "ZONOID_TASK_KEY": str(payload.get("task_key") or ""),
        "ZONOID_KB_SNAPSHOT": str(payload.get("kb_snapshot") or ""),
        "ZONOID_TASK_INSTRUCTIONS": str(payload.get("task_instructions") or ""),
    }
    if context_json:
        env["ZONOID_CONTEXT_JSON"] = context_json
    return env


def run_agent_arm(config: dict[str, Any], *, agent_command: str) -> list[dict[str, Any]]:
    """Run one arm through a local authenticated CLI agent command."""

    task_ids = list(config.get("task_ids") or ["all-games"])
    command = shlex.split(agent_command)
    if not command:
        raise ArcSdkUnavailable("--agent-command must not be empty.")

    records: list[dict[str, Any]] = []
    env = os.environ.copy()
    zonoid = config.get("zonoid") if isinstance(config.get("zonoid"), dict) else {}
    if zonoid:
        context_path = zonoid.get("context_json")
        env.update(zonoid_context_env(zonoid, context_json=context_path))
    env["ZONOID_ARC_ARM"] = str(config.get("arm") or "unknown")

    for task_id in task_ids:
        prompt = _agent_prompt(task_id=task_id, config=config)
        res = subprocess.run(command, input=prompt, env=env, text=True, capture_output=True)
        item = _parse_agent_stdout(res.stdout)
        if "task_id" not in item:
            item["task_id"] = task_id
        if "predicted" not in item and "output" not in item and "answer" not in item:
            item["predicted"] = res.stdout.strip()
        item["exit_code"] = res.returncode
        item["stderr"] = res.stderr.strip()
        records.extend(normalize_results([item], arm=str(config.get("arm") or "unknown")))
    return records


def _agent_prompt(*, task_id: str, config: dict[str, Any]) -> str:
    zonoid = config.get("zonoid") if isinstance(config.get("zonoid"), dict) else {}
    lines = [
        "Solve the ARC-AGI-3 task requested by this benchmark adapter.",
        f"Task id: {task_id}",
        f"Max steps: {config.get('max_steps')}",
        "",
        "Return a concise final answer. If possible, return JSON with keys task_id, predicted, and correct.",
    ]
    instructions = zonoid.get("task_instructions")
    if instructions:
        lines.extend(["", instructions])
    context_json = zonoid.get("context_json")
    if context_json:
        lines.extend(["", f"Zonoid context JSON file: {context_json}"])
    return "\n".join(lines) + "\n"


def _parse_agent_stdout(stdout: str) -> dict[str, Any]:
    text = stdout.strip()
    if not text:
        return {"predicted": ""}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {"predicted": text}
    if isinstance(parsed, dict):
        return parsed
    return {"predicted": text}


def run_real_arm(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Run one real ARC arm through a detected SDK.

    This function is intentionally conservative. If the installed package does not expose one of
    the documented runner hooks, it raises a blocker instead of guessing private APIs.
    """

    state = detect_sdk()
    if not state.available or not state.module_name:
        raise ArcSdkUnavailable(
            "No likely ARC-AGI-3 SDK package is importable. Tried: "
            + ", ".join(SDK_CANDIDATES)
        )
    if not state.runner_name:
        raise ArcSdkUnavailable(
            f"Imported {state.module_name!r}, but it does not expose run_benchmark(config), "
            "run(config), or evaluate(config)."
        )

    module = importlib.import_module(state.module_name)
    runner = getattr(module, state.runner_name)

    try:
        raw = runner(config)
    except TypeError as exc:
        sig = _signature(runner)
        raise ArcSdkUnavailable(
            f"{state.module_name}.{state.runner_name} rejected the adapter config. "
            f"Signature: {sig}. Error: {exc}"
        ) from exc

    return normalize_results(raw, arm=str(config.get("arm") or "unknown"))


def normalize_results(raw: Any, *, arm: str) -> list[dict[str, Any]]:
    """Normalize SDK result shapes into Zonoid report records."""

    if isinstance(raw, dict):
        items = raw.get("results", [])
    else:
        items = raw
    if not isinstance(items, list):
        raise ArcSdkUnavailable("ARC SDK result must be a list or a dict with a 'results' list.")

    records: list[dict[str, Any]] = []
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            item = {"predicted": str(item)}
        task_id = str(item.get("task_id") or item.get("id") or f"task-{idx}")
        correct = _boolish(item, "correct", "solved", "pass", "passed", "success")
        predicted = item.get("predicted", item.get("output", item.get("answer", "")))
        gold = item.get("gold", item.get("expected", "SOLVED"))
        records.append({
            "arm": "on" if arm == "zonoid_on" else "cold",
            "category": f"arc-agi-3:{task_id}",
            "question": task_id,
            "gold": str(gold),
            "predicted": str(predicted),
            "correct": bool(correct),
            "raw": item,
        })
    return records


def build_config(
    *,
    arm: str,
    max_steps: int,
    task_ids: list[str],
    out_dir: str,
    zonoid_enabled: bool,
    daemon_url: str | None = None,
    workspace: str | None = None,
    task_key: str | None = None,
    kb_snapshot: str | None = None,
) -> dict[str, Any]:
    """Build the small config object passed to a real ARC SDK runner hook."""

    payload = zonoid_context_payload(
        enabled=zonoid_enabled,
        daemon_url=daemon_url,
        workspace=workspace,
        task_key=task_key,
        kb_snapshot=kb_snapshot,
    )

    return {
        "arm": arm,
        "max_steps": max_steps,
        "task_ids": task_ids,
        "zonoid": {
            **payload,
        },
        "metadata": {
            "adapter": "bench.arc_agi3_zonoid",
            "out_dir": os.path.abspath(out_dir),
        },
    }


def _boolish(item: dict[str, Any], *keys: str) -> bool:
    for key in keys:
        if key in item:
            return bool(item[key])
    return False


def _signature(fn: Any) -> str:
    try:
        return str(inspect.signature(fn))
    except Exception:  # noqa: BLE001
        return "(signature unavailable)"
