"""bench/zonoid_bench/judge.py — Zonoid Bench SDK: tool-less Claude completion helpers.

The bench runs NO judge LLM of its own: the canonical ON arm drives the PRODUCTION sync judge
(``POST /judge/drain`` → ``lib/headless-drain.runJudgeDrainSync``) over HTTP. This module is now only
the tool-less ``claude -p`` completion surface the ANSWER step (and cold/rag arms) use to answer a
probe from retrieved context — the edge-judge twin (the hand-copied keep/prune rubric + EdgeJudge
class) has been DELETED so there is one judge implementation, in production.

Important production-rubric constraint for bench reconciliation: the deleted EdgeJudge twin must not
be reintroduced here, but the production judge it drives treats the anchor as a note or task anchor.
For task/question probes, candidates that contain evidence needed to answer or complete the probe
must be kept: exact identifiers, run-specific tokens, facts, constraints, and prior decisions are
valid context even when the candidate is not a conventional same-note neighbour.

Reuses and canonicalises the existing completion helper:
  - bench/agent-memory/probe_runner.py  (_run_claude, _extract_json_objects)

All code is stdlib-only (subprocess, shutil, json, os, re) and runs on embeddable Python 3.12.

Public surface
--------------
claude_p(prompt)          — Windows-safe single-shot ``claude -p`` via stdin; returns str | None.
claude_p_with_usage(p)    — like claude_p but returns (text, {input_tokens, output_tokens}).
parse_strict_json(text)   — brace-match scan for the first {...} that is valid JSON; returns dict | None.
parse_strict_json_all(t)  — return ALL top-level {...} blocks that parse as JSON dicts.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from typing import Any

# ---------------------------------------------------------------------------
# Runtime constants
# ---------------------------------------------------------------------------

# Model alias used for every judge call; override with ZONOID_BENCH_MODEL.
_JUDGE_MODEL: str = os.environ.get("ZONOID_BENCH_MODEL", "sonnet")

# Per-call wall-clock budget (seconds). Hard cap ≤ 120 s per call to prevent
# hung bench processes (the 9.5-hour hang post-mortem: no timeout on claude_p).
# Override with ZONOID_BENCH_CLAUDE_TIMEOUT; the default is clamped to 120 so
# an accidental large value does not re-introduce the hang class.
_JUDGE_TIMEOUT: int = min(120, int(os.environ.get("ZONOID_BENCH_CLAUDE_TIMEOUT", "120")))

# Resolved claude CLI path (computed once at import time).
# Windows: `claude` is a .cmd shim; shutil.which honours PATHEXT and returns it.
# Override with ZONOID_BENCH_CLAUDE.
def _resolve_claude() -> str:
    override = os.environ.get("ZONOID_BENCH_CLAUDE")
    if override:
        return override
    found = shutil.which("claude")
    return found or "claude"


_CLAUDE_CLI: str = _resolve_claude()

# mcp-off.json is co-located next to THIS file's bench/ root (bench/mcp-off.json).
# Probe_runner.py keeps its own copy alongside the agent-memory folder;
# here we look for one next to the bench/ root and fall back to alongside this file.
_HERE = os.path.dirname(os.path.abspath(__file__))
_BENCH_ROOT = os.path.dirname(_HERE)
_MCP_OFF = (
    os.path.join(_BENCH_ROOT, "mcp-off.json")
    if os.path.exists(os.path.join(_BENCH_ROOT, "mcp-off.json"))
    else os.path.join(_HERE, "mcp-off.json")
)


# ---------------------------------------------------------------------------
# claude_p — Windows-safe single-shot ``claude -p`` via stdin
# ---------------------------------------------------------------------------

def claude_p(
    prompt: str,
    *,
    model: str | None = None,
    timeout: int | None = None,
) -> str | None:
    """Run a single-shot, tool-less ``claude -p`` completion.

    Design points (from probe_runner.py):
    - Prompt delivered on STDIN (NOT as a positional CLI arg).  On Windows the
      ``claude.cmd`` shim mangles long/multi-line positional prompts via cmd.exe
      arg parsing — STDIN is byte-clean regardless of length or special characters.
    - MCP disabled: ``--mcp-config mcp-off.json --strict-mcp-config`` when the
      config file exists, so no graph server is required.
    - Tools forbidden: ``--allowedTools ""`` — pure text completion only.
    - Encoding: ``encoding="utf-8"`` to avoid Windows cp1252 mojibake.
    - CLI resolved via ``shutil.which`` (honours PATHEXT on Windows).

    Returns the raw stdout text on success, None on spawn failure or non-zero exit.
    """
    cli = _CLAUDE_CLI
    mdl = model or _JUDGE_MODEL
    tmo = timeout if timeout is not None else _JUDGE_TIMEOUT

    args: list[str] = [cli, "-p"]
    if os.path.exists(_MCP_OFF):
        args += ["--mcp-config", _MCP_OFF, "--strict-mcp-config"]
    args += ["--model", mdl, "--output-format", "text", "--allowedTools", ""]

    try:
        run = subprocess.run(
            args,
            input=prompt,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=tmo,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[zonoid_bench.judge] claude_p spawn failed: {exc}", file=sys.stderr)
        return None

    if run.returncode != 0:
        tail = (run.stderr or run.stdout or "")[-400:]
        print(
            f"[zonoid_bench.judge] claude_p exit={run.returncode}; tail: {tail}",
            file=sys.stderr,
        )
        return None
    return run.stdout or ""


def claude_p_with_usage(
    prompt: str,
    *,
    model: str | None = None,
    timeout: int | None = None,
) -> tuple[str | None, dict[str, int]]:
    """Like claude_p but uses --output-format json to capture token usage.

    Returns (text, {"input_tokens": N, "output_tokens": N}).
    Falls back to (text, {}) if the JSON output cannot be parsed.
    Returns (None, {}) on spawn failure or non-zero exit.
    """
    cli = _CLAUDE_CLI
    mdl = model or _JUDGE_MODEL
    tmo = timeout if timeout is not None else _JUDGE_TIMEOUT

    args: list[str] = [cli, "-p"]
    if os.path.exists(_MCP_OFF):
        args += ["--mcp-config", _MCP_OFF, "--strict-mcp-config"]
    args += ["--model", mdl, "--output-format", "json", "--allowedTools", ""]

    try:
        run = subprocess.run(
            args,
            input=prompt,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=tmo,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[zonoid_bench.judge] claude_p_with_usage spawn failed: {exc}", file=sys.stderr)
        return None, {}

    if run.returncode != 0:
        tail = (run.stderr or run.stdout or "")[-400:]
        print(
            f"[zonoid_bench.judge] claude_p_with_usage exit={run.returncode}; tail: {tail}",
            file=sys.stderr,
        )
        return None, {}

    raw_out = run.stdout or ""
    try:
        obj = json.loads(raw_out)
        text = str(obj.get("result") or "")
        raw_usage = obj.get("usage") or {}
        usage: dict[str, int] = {
            "input_tokens": int(raw_usage.get("input_tokens") or 0),
            "output_tokens": int(raw_usage.get("output_tokens") or 0),
        }
        return text, usage
    except Exception:  # noqa: BLE001 — unexpected JSON shape; fall back to raw text, no usage
        return raw_out, {}


# ---------------------------------------------------------------------------
# parse_strict_json — brace-match scan for the first parseable {...}
# ---------------------------------------------------------------------------

def parse_strict_json(text: str) -> dict[str, Any] | None:
    """Extract the first top-level ``{...}`` block in *text* that parses as JSON.

    Brace-matching scan (ported from probe_runner._extract_json_objects and
    zonoid_memory._parse_judge_output). Returns the first dict found, or None.

    The judge's free-text response often wraps the JSON in markdown fences or
    prose; this scanner is robust to that.
    """
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    blob = text[start : i + 1]
                    try:
                        obj = json.loads(blob)
                        if isinstance(obj, dict):
                            return obj
                    except Exception:  # noqa: BLE001
                        pass
                    start = -1
    return None


def parse_strict_json_all(text: str) -> list[dict[str, Any]]:
    """Return ALL top-level ``{...}`` blocks in *text* that parse as JSON dicts.

    Mirrors probe_runner._extract_json_objects — a general strict-JSON extractor for any
    free-text LLM response that may wrap one or more JSON objects in prose/markdown.
    """
    out: list[dict[str, Any]] = []
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    blob = text[start : i + 1]
                    try:
                        obj = json.loads(blob)
                        if isinstance(obj, dict):
                            out.append(obj)
                    except Exception:  # noqa: BLE001
                        pass
                    start = -1
    return out
