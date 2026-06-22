"""bench/zonoid_bench/judge.py — Zonoid Bench SDK: Claude judge + EdgeJudge.

Reuses and canonicalises the two existing judge helpers:
  - bench/agent-memory/probe_runner.py  (_run_claude, _extract_json_objects)
  - bench/swe-bench-cl/zonoid_memory.py (_EDGE_JUDGE_RUBRIC, _parse_judge_output)

All code is stdlib-only (subprocess, shutil, json, os, re) and runs on embeddable Python 3.12.

Public surface
--------------
claude_p(prompt)          — Windows-safe single-shot ``claude -p`` via stdin; returns str | None.
parse_strict_json(text)   — brace-match scan for the first {...} that is valid JSON; returns dict | None.
EdgeJudge                 — keep/prune (context edge) + distinct/consolidate (dup) rubric.
                            DEFAULT = prune / distinct.
"""

from __future__ import annotations

import json
import os
import re
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

    Mirrors probe_runner._extract_json_objects — used internally by EdgeJudge.
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


# ---------------------------------------------------------------------------
# EdgeJudge — keep/prune + distinct/consolidate rubric
# ---------------------------------------------------------------------------

# The self-learn-edge-judge rubric (ported from zonoid_memory._EDGE_JUDGE_RUBRIC).
# DEFAULT = prune / distinct: similarity is necessary, NOT sufficient.
_EDGE_JUDGE_RUBRIC = """\
You are the Zonoid note-graph edge-judge. You adjudicate whether RAG-recalled note neighbours are
SOUND context edges, and whether near-duplicate note clusters are the SAME fact.

You are given ANCHOR note/task N and a list of CANDIDATE neighbour notes the daemon autowired to N
by cosine similarity. For EACH candidate decide:

  edge:
    "keep"  — N and the candidate are a SOUND context relation: working on one would genuinely
              benefit from seeing the other (same subsystem/file/bug-class/fix-pattern, or one is
              real prerequisite context for the other). If N is a task/question probe, keep a
              candidate that contains evidence needed to answer or complete that probe, including
              exact identifiers, run-specific codes, facts, constraints, or prior decisions.
    "prune" — the candidate is merely cosine-similar (shares vocabulary/library/framing) but is
              NOT sound context for N: different subsystem, unrelated bug, no transfer of insight.

  dup (ONLY for a candidate flagged is_dup=true):
    "consolidate" — N and the candidate are the SAME underlying fact/fix (one restates the other);
                    the candidate should be superseded/merged into N.
    "distinct"    — N and the candidate are near-duplicate in wording but DIFFERENT facts/attempts
                    (e.g. two distinct CL attempts at related-but-different problems); keep both.

DEFAULT BIAS: when unsure, "prune" the edge and "distinct" the dup. Similarity is necessary, not
sufficient. Do not keep an edge just because the cosine is high.

Respond with STRICT JSON ONLY (no prose, no markdown fence):
{"verdicts":[{"key":"<candidate key>","edge":"keep|prune","dup":"consolidate|distinct|null"}]}
"""


class EdgeJudge:
    """LLM-backed edge judge: keep/prune context edges + distinct/consolidate dup clusters.

    DEFAULT verdict = prune / distinct (similarity is necessary, not sufficient).

    Usage::

        judge = EdgeJudge()
        verdicts = judge.judge(
            anchor_key="note:abc123",
            anchor_summary="fixed pytest teardown ordering ...",
            candidates=[
                {"key": "note:def456", "title": "...", "summary": "...", "is_dup": False},
            ],
        )
        # verdicts: {key: {"edge": "keep"|"prune", "dup": "consolidate"|"distinct"|None}}

    On any LLM failure the judge returns the deterministic fallback (prune / distinct) so
    the eval loop never stalls.
    """

    def __init__(
        self,
        *,
        model: str | None = None,
        timeout: int | None = None,
        summary_budget: int = 1200,
    ) -> None:
        self.model = model or _JUDGE_MODEL
        self.timeout = timeout if timeout is not None else _JUDGE_TIMEOUT
        self.summary_budget = summary_budget

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def judge(
        self,
        anchor_key: str,
        anchor_summary: str,
        candidates: list[dict[str, Any]],
    ) -> dict[str, dict[str, Any]]:
        """Judge ANCHOR vs CANDIDATES; return per-key verdict dict.

        Each value: ``{"edge": "keep"|"prune", "dup": "consolidate"|"distinct"|None}``.
        Returns the deterministic fallback on LLM failure.
        """
        if not candidates:
            return {}
        result = self._llm_judge(anchor_key, anchor_summary, candidates)
        if result is None:
            result = self._deterministic_fallback(candidates)
        return result

    def to_verdict_list(
        self,
        anchor_key: str,
        candidates: list[dict[str, Any]],
        verdicts: dict[str, dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Translate per-candidate verdicts into the ``/judge/verdict`` wrapped body.

        - dup "consolidate" → consolidate (supersede the dup into N)
        - dup "distinct"    → markDistinct (clears pending_dup, note becomes retrieval-visible)
        - edge "keep"       → keepEdge (promote the autowired weight-0 candidate)
        - edge "prune"      → pruneEdge (delete the autowired candidate edge)

        Autowire direction is candidate→N, so edge verdicts use from=candidate, to=anchor_key.
        (Ported from zonoid_memory._verdicts_to_post.)
        """
        out: list[dict[str, Any]] = []
        for nb in candidates:
            key = nb["key"]
            v = verdicts.get(
                key,
                {"edge": "prune", "dup": ("distinct" if nb.get("is_dup") else None)},
            )
            if nb.get("is_dup"):
                if v.get("dup") == "consolidate":
                    out.append({"consolidate": {"keep": anchor_key, "supersede": [key]}})
                    continue  # consolidate covers the edge too
                out.append({"markDistinct": {"keys": [anchor_key, key]}})
            if v.get("edge") == "keep":
                out.append({"keepEdge": {"from": key, "to": anchor_key}})
            else:
                out.append({"pruneEdge": {"from": key, "to": anchor_key, "kind": "context"}})
        return out

    # ------------------------------------------------------------------
    # Internal: LLM judge
    # ------------------------------------------------------------------

    def _llm_judge(
        self,
        anchor_key: str,
        anchor_summary: str,
        candidates: list[dict[str, Any]],
    ) -> dict[str, dict[str, Any]] | None:
        """Run ONE ``claude_p`` call over the anchor + candidates; parse the verdict JSON.

        Returns ``{key: {"edge":..., "dup":...}}`` or None on failure.
        """
        cand_lines: list[str] = []
        for i, nb in enumerate(candidates):
            dup_flag = "  is_dup=true (near-duplicate cluster candidate)" if nb.get("is_dup") else ""
            summary_clip = (nb.get("summary") or "")[: self.summary_budget]
            cand_lines.append(
                f"[{i}] key={nb['key']}{dup_flag}\n"
                f"    title: {nb.get('title', '')}\n"
                f"    summary: {summary_clip}"
            )
        prompt = (
            _EDGE_JUDGE_RUBRIC
            + "\n\nANCHOR note/task N (key="
            + anchor_key
            + "):\n"
            + anchor_summary[:2000]
            + "\n\nCANDIDATE neighbours:\n"
            + "\n".join(cand_lines)
            + "\n\nReturn the strict-JSON verdict object now."
        )
        raw = claude_p(prompt, model=self.model, timeout=self.timeout)
        if raw is None:
            print(
                "[zonoid_bench.judge] EdgeJudge LLM call failed; using deterministic fallback.",
                file=sys.stderr,
            )
            return None
        return self._parse_verdict(raw)

    @staticmethod
    def _parse_verdict(text: str) -> dict[str, dict[str, Any]] | None:
        """Extract ``{verdicts:[...]}`` from judge output; return per-key dict or None.

        Ported from zonoid_memory._parse_judge_output.
        """
        for obj in parse_strict_json_all(text):
            vs = obj.get("verdicts")
            if not isinstance(vs, list):
                continue
            out: dict[str, dict[str, Any]] = {}
            for v in vs:
                if not isinstance(v, dict):
                    continue
                key = v.get("key")
                if not key:
                    continue
                edge = v.get("edge")
                edge = edge if edge in ("keep", "prune") else "prune"
                dup = v.get("dup")
                dup = dup if dup in ("consolidate", "distinct") else None
                out[key] = {"edge": edge, "dup": dup}
            if out:
                return out
        return None

    # ------------------------------------------------------------------
    # Internal: deterministic fallback (CL-2b policy: prune / distinct)
    # ------------------------------------------------------------------

    @staticmethod
    def _deterministic_fallback(
        candidates: list[dict[str, Any]],
    ) -> dict[str, dict[str, Any]]:
        """DEFAULT = prune every edge, mark every near-dup distinct.

        Used only when the LLM judge is unavailable so the eval loop never stalls.
        (probe_runner's blind judge uses fail-closed keep-nothing; here the context
        edge judge defaults to prune — the same DEFAULT BIAS as the rubric.)
        """
        return {
            nb["key"]: {
                "edge": "prune",
                "dup": ("distinct" if nb.get("is_dup") else None),
            }
            for nb in candidates
        }
