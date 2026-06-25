"""bench/zonoid_bench/combined_bench.py — the CANONICAL combined ON-vs-OFF cost-bounded bench.

This is the single canonical Zonoid benchmark (note-mqjmq2cbdy3): for every probe in the EXISTING
featurebench problem set (``bench-questions.jsonl`` — question + gold + category + seeded note), run
two arms and produce a fused per-problem verdict plus an aggregate report.

  ON arm  — PRODUCTION-FAITHFUL memory retrieval (see "ON-ARM PRODUCTION PARITY" below). The probe
            is minted as a TASK node; relevant note(s) wire in as DAG context_deps exactly as
            production autowire + the eager judge would; the agent consults GATE-FIRST + TIERED.
            ON gets a generous token CEILING (~500k, ``--on-ceiling``) as a RUNAWAY GUARD ONLY — not
            a spend target. Solving cheaply is good. We measure ON's ACTUAL token spend X.
  OFF arm — PURE AGENTIC, clean env (no MCP / KB / .graph / ORCH_* — exactly the bench-economy.js
            cleanEnv discipline). Budget cap = ON's ACTUAL spend X for that problem; run till solved
            or cap hit. (Real-time mid-call kill is infeasible for a single non-streaming ``claude -p``
            on Windows — see "TOKEN-CAP ENFORCEMENT" — so the cap is enforced POST-HOC and
            ``OFF_solved_within_budget`` is computed correctly from the measured costs.)

Both arms' FINAL answers are graded vs gold with the validated LLM-judge
(``report.judge_correctness`` → ``judge.claude_p``, the LoCoMo / LongMemEval rubric the featurebench
already uses). Per-problem fused record::

    {
      "qid", "category", "question", "gold",
      "ON_solved":  bool,  "ON_cost":  float,   # weighted token-equivalent (bench-economy.js formula)
      "OFF_solved": bool,  "OFF_cost": float,
      "OFF_solved_within_budget": ON-cost-bounded OFF success := OFF_solved and OFF_cost <= ON_cost,
      "memory_win":              := ON_solved and not OFF_solved_within_budget,
      ... (ON/OFF token breakdowns, usd cost, predicted answers, wiring provenance)
    }

Aggregate report: ON accuracy + mean cost, OFF-within-budget rate, memory-win count, all sliced by
category — which SELF-REVEALS contamination (note-mqjmq2cbdy3): cold-solvable categories (config,
invariant) show OFF matching ON cheaply = NO memory win; decision / gotcha show OFF failing within
ON's budget = a real memory win.

================================================================================================
ON-ARM PRODUCTION PARITY  (#1 requirement — audited against the real daemon code)
================================================================================================
The ON arm does NOT hand-paste the gold note into the prompt and does NOT force an UNGATED search
(bench-economy.js's ``ON_PREAMBLE`` is explicitly NOT production-faithful — note in module docstring
of arms.py). It reuses ``arms.run_retrieve_and_answer`` → ``arms.run_canonical_wiring``, which
replicates the production memory-retrieval path call-for-call:

  1. The probe is minted as a TASK PROBE (``workspace.drop_task_stub`` + ``POST /overlay/status``
     status=not_ready, summary=question). That status write drives the SAME daemon ingest funnel a
     real task triggers: embed → setTaskVec → autowireNewTaskWholeGraph (SEED weight-0 NOTE→probe
     candidate context edges according to the daemon candidate policy) → markEagerJudge.
  2. ``POST /judge/drain?node=<probe>`` drives the PRODUCTION sync judge (P3 de-port): one call
     drains the probe's whole unjudged autowire candidate edge-set to idle by REUSING the in-process
     production judge (lib/headless-drain.runJudgeDrainSync → resolveJudgeBackend → runJudgeLoop),
     the SAME keep/prune rubric + /judge/next pull + keepEdge/pruneEdge write the eager/background
     drains use. The bench holds NO judge LLM, NO rubric, and parses NO verdict — there is exactly
     one judge, in production. ``keepEdge`` promotes a weight-0 candidate IN PLACE (it re-enters
     ranked retrieval), ``pruneEdge`` deletes it. This is exactly how production freezes a task's
     judged DAG context BEFORE the task goes ready.
  3. ``GET /search?q=<question>&task_key=<probe>`` reads the production task-scoped result. A settled
     probe returns system notes plus frozen judged DAG context; semantic RAG is omitted. If a probe
     remains provisional, an actual RAG tier is preserved exactly as the daemon returned it.

WE retrieve + inject that production result and the answerer is a tool-less ``claude -p`` completion
run in an ISOLATED EMPTY DIR (no repo access — see "ISOLATION" below). The honesty bar: gold answers
/ evidence labels are used ONLY by the grader — they NEVER enter any ON or OFF retrieve/answer step.
A note surfaces only via the production retrieval path, or is legitimately missed (judge_idle or
pruned, reported).

ISOLATION (the load-bearing honesty guard): BOTH arms' answer completions run in a FRESH EMPTY TEMP
DIR with built-in file/web tools denied — NEVER the repo/worktree cwd. This is verified-necessary:
``--allowedTools ""`` alone does NOT disable the built-in Read/Glob/Bash tools, so a cold ``claude -p``
launched in the repo cwd reads the SOURCE FILES that contain every gold answer — which would let the
OFF arm cheat and would let the ON arm bypass the retrieval seam. Running both in an empty cwd (the
scripts/bench-economy.js mkdtempSync discipline) means the ON arm's knowledge comes ONLY from the
injected retrieved context and the OFF arm's ONLY from world knowledge.

GATE-FIRST/TIERED + abstain note: after eager judgment a settled task-scoped search is DAG-only
(plus system context), so the canonical wiring does not append a separate RAG result. When autowire
seeds nothing, the answerer honestly sees only system context, if any, or otherwise empty context.

================================================================================================
TOKEN-CAP ENFORCEMENT  (real-time kill vs post-hoc — honest limitation)
================================================================================================
The task asks for a streaming token meter that KILLS the ON arm at the ceiling and the OFF arm at X.
Each arm here is a SINGLE ``claude -p`` non-streaming JSON completion (the proven Windows path —
judge.py). A single completion cannot be "killed at N tokens mid-generation" from outside without
re-architecting to ``--output-format stream-json`` + a line-parsing supervisor that SIGKILLs the
child — and on Windows ``claude`` is a ``.cmd`` shim, so killing the shim does not reliably kill the
node child (process-group kill is unreliable through cmd.exe). Rather than fake a real-time kill, we
enforce the cap POST-HOC and compute ``OFF_solved_within_budget`` CORRECTLY from the measured costs
(OFF_solved and OFF_cost <= ON_cost). This is the documented fallback the handoff permits. The ON
ceiling is likewise a post-hoc runaway flag (``ON_over_ceiling``): a single QA completion never
approaches 500k, so the ceiling is a guard for pathological inputs, not a live throttle. See
``open_risks`` in the run summary. A future ``--stream-kill`` mode is stubbed in ``_STREAM_KILL_TODO``.

================================================================================================
ON-CONFIG: raw-dag vs dag-distill
================================================================================================
``--on-config raw-dag`` (default): the standard ON arm above — retrieves from the live KB whose
notes were mined from the repo SOURCE by the production pipeline.

``--on-config dag-distill``: the DISTILLED ON arm — re-mines the SAME SOURCE the featurebench notes
came from (the ``evidence`` field of each problem, e.g. "daemon.js:206-211"), runs it through the
distill.py atomic-fact extractor (_DISTILL_PROMPT + _claude_p + _parse_facts), and seeds the
resulting atomic-fact notes into a DEDICATED distill workspace.  Then retrieves via the SAME
production gate-first path (arms.run_canonical_wiring) from that distill workspace.

Honesty bar (MANDATORY — see note-mqjpp4w7iex):
  - ONLY the SOURCE CODE (evidence field → repo lines) is the distill input.  The gold answer
    (prob["gold"]) NEVER enters any distill/seed/retrieve/answer step.
  - If a probe has no evidence field, or the source lines cannot be read, we seed NOTHING for that
    probe (honest miss) — we do NOT fall back to gold or any other grader-only field.

Workspace isolation for dag-distill (fixing the rejected prior attempt):
  The prior attempt (commit 0548213) did a per-problem global rebind of the daemon's live workspace,
  which races concurrent sessions.  The corrected design:
    1. Before the run loop, create ONE dedicated distill workspace directory.
    2. Seed ALL problems' distilled atomic facts into that workspace (ingest phase).
    3. Bind the daemon live workspace to the distill workspace ONCE at the start of the run.
    4. Run all probes against that workspace.
    5. Restore the original live workspace binding on exit.
  This is the same pattern raw-dag uses: one bind per run, not one per problem.

Runtime: stdlib ONLY (urllib/json/subprocess via client.py + judge.py + arms.py). Runs on the
embeddable Python 3.12 at C:\\Users\\Imyu\\AppData\\Local\\py312embed\\python.exe and on Mac/Linux.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, Optional

# Embeddable Python 3.12 strips cwd from sys.path; make ``zonoid_bench`` importable regardless of cwd.
_HERE = os.path.dirname(os.path.abspath(__file__))
_BENCH = os.path.dirname(_HERE)
_REPO = os.path.dirname(_BENCH)
if _BENCH not in sys.path:
    sys.path.insert(0, _BENCH)

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:
        pass

from zonoid_bench.client import ZonoidClient  # noqa: E402
from zonoid_bench import arms as arms_mod      # noqa: E402
from zonoid_bench import report as report_mod   # noqa: E402
from zonoid_bench import judge as judge_mod     # noqa: E402

# ---------------------------------------------------------------------------
# Defaults / tunables (env-overridable, same convention as the rest of the SDK)
# ---------------------------------------------------------------------------

_DEFAULT_DAEMON = os.environ.get("ZONOID_BENCH_DAEMON", "http://localhost:8787")
# The featurebench problem set. It lives untracked at the repo root; allow an override.
_DEFAULT_QUESTIONS = os.environ.get(
    "ZONOID_BENCH_QUESTIONS", os.path.join(_REPO, "bench-questions.jsonl")
)
_DEFAULT_OUT = os.environ.get("ZONOID_BENCH_COMBINED_OUT", "combined-bench-results.jsonl")
_DEFAULT_DATA_DIR = os.path.join(os.path.expanduser("~"), ".claude", "orchestrator")

# ON runaway guard (note-mqjmq2cbdy3 CORRECTION 2): a CEILING, not a target. ~500k weighted tok-eq.
_DEFAULT_ON_CEILING = float(os.environ.get("ZONOID_BENCH_ON_CEILING", "500000"))

# Cost weights — input-token-equivalents. IDENTICAL to scripts/bench-economy.js (the execution
# foundation note-mqjmq2cbdy3 says to keep). cache_read bills ~0.1x (note-mqiu8m4etal: the whole
# ON/OFF gap is cache_read on the injected payload; output tokens = the real work).
_INPUT_W = 1.0
_OUTPUT_W = 5.0
_CACHE_READ_W = 0.1
_CACHE_CREATION_W = 1.25

# OFF answer model — defaults to the SDK judge/answer model (sonnet) unless overridden.
_DEFAULT_MODEL = os.environ.get("ZONOID_BENCH_MODEL", None)

# Per-call wall-clock budget for a single ``claude -p`` answer completion (seconds). Clamped to a
# sane max so a hung child can't stall the whole run (the 9.5h-hang post-mortem in judge.py).
_ANSWER_TIMEOUT = min(600, int(os.environ.get("ZONOID_BENCH_ANSWER_TIMEOUT", "300")))

# ---------------------------------------------------------------------------
# ON-CONFIG options
# ---------------------------------------------------------------------------

_ON_CONFIG_RAW_DAG = "raw-dag"      # default: retrieve from production KB (mined notes)
_ON_CONFIG_DAG_DISTILL = "dag-distill"  # retrieve from distilled-from-source atomic-fact KB
_ON_CONFIG_CHOICES = [_ON_CONFIG_RAW_DAG, _ON_CONFIG_DAG_DISTILL]


# ---------------------------------------------------------------------------
# Cost model
# ---------------------------------------------------------------------------

def weighted_cost(usage: dict[str, Any]) -> float:
    """Input-token-equivalent weighted cost (identical formula to scripts/bench-economy.js).

    weighted = input + output*5 + cache_read*0.1 + cache_creation*1.25
    """
    return (
        float(usage.get("input_tokens") or 0) * _INPUT_W
        + float(usage.get("output_tokens") or 0) * _OUTPUT_W
        + float(usage.get("cache_read_input_tokens") or 0) * _CACHE_READ_W
        + float(usage.get("cache_creation_input_tokens") or 0) * _CACHE_CREATION_W
    )


def _extract_full_usage(usage_obj: dict[str, Any]) -> dict[str, int]:
    """Pull all four token classes from a ``claude -p --output-format json`` usage object.

    arms.claude_p_with_usage only keeps input+output; the cost-bounded bench needs cache_read +
    cache_creation too (a tool-less call still bills tens of thousands of cache tokens for the
    system prompt — verified empirically). Missing fields default to 0.
    """
    return {
        "input_tokens": int(usage_obj.get("input_tokens") or 0),
        "output_tokens": int(usage_obj.get("output_tokens") or 0),
        "cache_read_input_tokens": int(usage_obj.get("cache_read_input_tokens") or 0),
        "cache_creation_input_tokens": int(usage_obj.get("cache_creation_input_tokens") or 0),
    }


# ---------------------------------------------------------------------------
# claude -p with FULL usage + clean-env support (OFF arm needs the cleanEnv discipline)
# ---------------------------------------------------------------------------

def _resolve_claude() -> str:
    override = os.environ.get("ZONOID_BENCH_CLAUDE")
    if override:
        return override
    return shutil.which("claude") or "claude"


def _clean_env(base: dict[str, str]) -> dict[str, str]:
    """Strip ZONOID_* and ORCH_* and any MCP wiring from env for the OFF arm.

    Mirrors scripts/bench-economy.js cleanEnv: the OFF arm must run in a clean environment with no
    orchestrator/KB leakage. We also drop CLAUDE_PLUGIN_DATA (points at the orchestrator data dir)
    so the OFF child cannot discover the graph through it.
    """
    env: dict[str, str] = {}
    for k, v in base.items():
        if k.startswith("ZONOID_") or k.startswith("ORCH_"):
            continue
        if k == "CLAUDE_PLUGIN_DATA":
            continue
        env[k] = v
    return env


# Built-in tools we explicitly deny so neither arm can READ THE REPO SOURCE (which contains the gold
# answers). Belt-and-suspenders on top of the empty-cwd isolation below: verified empirically that
# `--allowedTools ""` alone does NOT disable the built-in file tools — a cold `claude -p` launched in
# the repo cwd happily listed + read the source. Both isolation layers together close the leak.
_DENY_TOOLS = "Read,Glob,Grep,Bash,Edit,Write,NotebookEdit,WebSearch,WebFetch,Task,TodoWrite"


def claude_answer_full_usage(
    prompt: str,
    *,
    model: Optional[str],
    timeout: int,
    clean: bool,
) -> tuple[str, dict[str, int], Optional[float]]:
    """Single-shot tool-less ``claude -p`` returning (text, full_usage, total_cost_usd).

    Windows-safe exactly like judge.claude_p: prompt on STDIN, ``encoding="utf-8"``, CLI resolved via
    shutil.which. MCP is disabled with mcp-off.json when present.

    ISOLATION (the honesty bar — critical):
      - The child runs in a FRESH EMPTY TEMP DIR (cwd=), NEVER the repo/worktree. This is the
        scripts/bench-economy.js discipline (OFF runs in a fresh ``mkdtempSync`` dir). Verified: a
        cold ``claude -p`` in the repo cwd reads the source files that hold the gold answers; in an
        empty cwd it sees nothing. BOTH arms run isolated so the ON arm's knowledge comes ONLY from
        the injected retrieved context (the seam under test) and the OFF arm's from world knowledge
        alone — neither can bypass retrieval by reading the repo.
      - Built-in file/web tools are denied (``--allowedTools ""`` + ``--disallowedTools <_DENY_TOOLS>``).
      - When *clean* is True the child also runs in a STRIPPED environment (OFF arm) — no
        ZONOID_*/ORCH_*/CLAUDE_PLUGIN_DATA, so no graph/MCP/KB leakage via env.

    Returns ("", {}, None) on spawn failure or non-zero exit.
    """
    cli = _resolve_claude()
    args: list[str] = [cli, "-p"]
    # mcp-off.json lives next to the bench root (bench/mcp-off.json) — disables the MCP server so no
    # graph tools are reachable. The OFF arm in particular MUST NOT see orchestrator MCP.
    mcp_off = os.path.join(_BENCH, "mcp-off.json")
    if os.path.exists(mcp_off):
        args += ["--mcp-config", mcp_off, "--strict-mcp-config"]
    args += ["--output-format", "json", "--allowedTools", "", "--disallowedTools", _DENY_TOOLS]
    if model:
        args += ["--model", model]

    env = _clean_env(dict(os.environ)) if clean else dict(os.environ)

    # Isolated empty cwd so there is no repo source to read (the load-bearing contamination guard).
    sandbox = tempfile.mkdtemp(prefix="combined-bench-arm-")
    try:
        run = subprocess.run(
            args,
            input=prompt,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout,
            env=env,
            cwd=sandbox,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[combined_bench] claude_answer spawn failed: {exc}", file=sys.stderr)
        return "", {}, None
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)

    if run.returncode != 0:
        tail = (run.stderr or run.stdout or "")[-300:]
        print(f"[combined_bench] claude_answer exit={run.returncode}; tail: {tail}", file=sys.stderr)
        return "", {}, None

    raw = run.stdout or ""
    try:
        obj = json.loads(raw)
        text = str(obj.get("result") or "")
        usage = _extract_full_usage(obj.get("usage") or {})
        cost_usd = obj.get("total_cost_usd")
        cost_usd = float(cost_usd) if isinstance(cost_usd, (int, float)) else None
        return text, usage, cost_usd
    except Exception:  # noqa: BLE001 — unexpected JSON; fall back to raw text, no usage
        return raw, {}, None


# Answer prompts: reuse arms.py templates so the ON-arm answerer and OFF-arm answerer differ ONLY in
# whether memory context is present (the variable under test). ON = context-grounded; OFF = cold.
_ANSWER_TEMPLATE = arms_mod._ANSWER_TEMPLATE  # noqa: SLF001 — deliberately reuse the canonical prompt
_COLD_TEMPLATE = arms_mod._COLD_TEMPLATE      # noqa: SLF001


# ---------------------------------------------------------------------------
# ON arm — production-faithful wiring + measured spend
# ---------------------------------------------------------------------------

def run_on_arm(
    client: ZonoidClient,
    unit_id: str,
    question: str,
    *,
    data_dir: str,
    model: Optional[str],
    on_ceiling: float,
    context_k: int = 5,
) -> dict[str, Any]:
    """Run the PRODUCTION-FAITHFUL ON arm and measure actual token spend.

    Retrieval is arms.run_canonical_wiring followed by the production task-scoped search surface
    (mint probe → autowire → eager judge → system + frozen task context for a settled probe). The
    answer is a tool-less ``claude -p`` completion over that context, measured for FULL token usage.

    Returns a dict with: predicted, cost (weighted), usage (4-class), cost_usd, ctx_chars,
    context_keys, wiring diagnostics, over_ceiling flag.
    """
    summary = question

    # --- Step A: production-faithful retrieval (the seam under test) ---
    # arms.run_canonical_wiring is the audited production path. It mints the probe TASK, drives
    # autowire (NOTE→probe candidates under daemon candidate policy), then DRIVES the production sync
    # judge via POST /judge/drain (P3 de-port — no bench judge LLM): the daemon's in-process
    # runJudgeDrainSync runs the keep/prune rubric and applies keepEdge/pruneEdge. The kept context
    # edges are then read back from the production task-scoped search response.
    wiring = arms_mod.run_canonical_wiring(client, unit_id, summary, data_dir=data_dir)

    # Production task context: settled probes return system + frozen DAG tiers and no semantic RAG fill.
    dag_keys: set[str] = set()
    context_blocks: list[str] = []
    context_keys: list[str] = []
    seen_keys: set[str] = set()
    try:
        raw_hits = arms_mod.read_task_search_context(
            client, wiring.task_key, question, k=context_k
        )
        for h in raw_hits:
            key = h.get("key") or ""
            if not key or key in seen_keys:
                continue
            text = str(h.get("summary") or "")
            if not text.strip():
                continue
            label = arms_mod.task_search_context_label(h)
            context_blocks.append(f"[{label}] {text}")
            seen_keys.add(key)
            context_keys.append(key)
            if label == "DAG":
                dag_keys.add(key)
    except Exception as exc:  # noqa: BLE001 — task-context retrieval is best-effort
        print(f"[combined_bench] task-scoped context search failed (non-fatal): {exc}", file=sys.stderr)

    # --- Step B: answer over the retrieved context, measured ---
    context = "\n\n---\n\n".join(b for b in context_blocks if b and b.strip())
    if not context.strip():
        # abstain-equivalent: no memory surfaced (autowire idle + task context empty). Answer honestly with
        # no context — exactly what a production agent does on search_knowledge decision:"abstain".
        context = "(no relevant memory was retrieved)"
    prompt = _ANSWER_TEMPLATE.format(context=context, question=question)
    ctx_chars = sum(len(b) for b in context_blocks if b and b.strip())

    predicted, usage, cost_usd = claude_answer_full_usage(
        prompt, model=model, timeout=_ANSWER_TIMEOUT, clean=False
    )
    cost = weighted_cost(usage)

    return {
        "predicted": (predicted or "").strip(),
        "cost": cost,
        "usage": usage,
        "cost_usd": cost_usd,
        "ctx_chars": ctx_chars,
        "context_keys": context_keys,
        "n_dag": len(dag_keys),
        "n_ctx": len(context_keys),
        "judge_idle": bool(wiring.judge_idle),
        "wired_edges": list(wiring.wired_edges),
        "pruned_edges": list(wiring.pruned_edges),
        "timeout_kills": wiring.timeout_kills,
        "provisional_kept": wiring.provisional_kept,
        "probe_task_key": wiring.task_key,
        "over_ceiling": cost > on_ceiling,
    }


# ---------------------------------------------------------------------------
# OFF arm — pure agentic, clean env, post-hoc budget cap
# ---------------------------------------------------------------------------

def run_off_arm(
    question: str,
    *,
    model: Optional[str],
) -> dict[str, Any]:
    """Run the PURE-AGENTIC OFF arm in a clean environment and measure actual token spend.

    No MCP, no KB, no .graph, no ORCH_*/ZONOID_* env (cleanEnv discipline). The agent answers from
    world knowledge alone — a tool-less ``claude -p`` cold completion. The budget cap = ON's actual
    spend X is applied POST-HOC by the caller (OFF_solved_within_budget); see module docstring
    "TOKEN-CAP ENFORCEMENT". Returns predicted, cost (weighted), usage, cost_usd.
    """
    prompt = _COLD_TEMPLATE.format(question=question)
    predicted, usage, cost_usd = claude_answer_full_usage(
        prompt, model=model, timeout=_ANSWER_TIMEOUT, clean=True
    )
    return {
        "predicted": (predicted or "").strip(),
        "cost": weighted_cost(usage),
        "usage": usage,
        "cost_usd": cost_usd,
    }


# Stub marker for a future real-time-kill implementation (see module docstring).
_STREAM_KILL_TODO = (
    "Real-time token-kill is NOT implemented: a single non-streaming `claude -p` JSON completion "
    "cannot be killed mid-generation by external token count, and on Windows the .cmd shim makes "
    "child-process-group SIGKILL unreliable. A --stream-kill mode would switch to "
    "`--output-format stream-json`, parse the per-event usage deltas, and SIGKILL the node child "
    "(not the .cmd shim) when the running token total crosses the cap. Cap is enforced post-hoc."
)


# ---------------------------------------------------------------------------
# Grading (validated LLM-judge — the featurebench metric)
# ---------------------------------------------------------------------------

def _grade(question: str, gold: str, predicted: str, category: str) -> Optional[bool]:
    """Grade *predicted* vs *gold* with the validated LLM-judge (report.judge_correctness).

    Returns True (correct) / False (incorrect) / None (judge call failed). Gold + question are used
    ONLY here (the grader) — never in any retrieve/answer step (honesty bar).
    """
    if not (predicted or "").strip():
        return False
    return report_mod.judge_correctness(question, gold, predicted, category)


# ---------------------------------------------------------------------------
# Problem set loading
# ---------------------------------------------------------------------------

def load_problems(path: str) -> list[dict[str, Any]]:
    """Load the featurebench problem set (question + gold + category + seeded-note metadata)."""
    problems: list[dict[str, Any]] = []
    with open(path, encoding="utf-8-sig") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"[combined_bench] skipping malformed line {lineno}: {exc}", file=sys.stderr)
                continue
            if r.get("question") and r.get("gold"):
                problems.append(r)
    return problems


# ---------------------------------------------------------------------------
# dag-distill: source-code reader + atomic-fact extractor
# ---------------------------------------------------------------------------

# Distillation prompt — adapted from distill.py's _DISTILL_PROMPT but targeting
# source CODE (not conversational turns). Extracts atomic engineering facts.
_SOURCE_DISTILL_PROMPT = """\
You are a technical fact-extraction assistant. Extract ATOMIC FACTS from the source code snippet \
below.

Rules:
1. ONE claim per fact — one subject-predicate-object statement about the code's behaviour.
2. Be SPECIFIC: keep constant names, exact numeric values, function names, module names.
3. Each fact must be SELF-CONTAINED: readable with no surrounding code context.
4. Extract facts about: constants/thresholds, default values, conditions/triggers, data structures, \
and non-obvious algorithmic decisions.
5. Skip trivial observations (e.g. "this is a JavaScript file", "there is a comment").
6. If there are NO meaningful engineering facts in the snippet, return an empty list.

Return ONLY a JSON array of objects with this shape:
[
  {{
    "title": "short fact title (5-10 words)",
    "fact": "full self-contained engineering fact sentence"
  }},
  ...
]

SOURCE FILE: {filename}
LINES: {line_range}

CODE:
{source_text}

JSON array of facts:"""


def _read_source_lines(repo_root: str, filename: str, start: int, end: int) -> str:
    """Read lines [start, end] (1-indexed, inclusive) from repo_root/filename.

    Returns the text or empty string if the file/range is not accessible.
    """
    path = os.path.join(repo_root, filename.replace("/", os.sep).replace("\\", os.sep))
    if not os.path.exists(path):
        return ""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            all_lines = fh.readlines()
        # Convert to 0-indexed.  Clamp to file bounds.
        s = max(0, start - 1)
        e = min(len(all_lines), end)
        return "".join(all_lines[s:e])
    except Exception:  # noqa: BLE001
        return ""


def _parse_evidence_spec(evidence_spec: str) -> list[tuple[str, int, int]]:
    """Parse an evidence spec string into (filename, start_line, end_line) tuples.

    Supported formats (mirrors featurebench bench-questions.jsonl):
      "daemon.js:206-211"                 → [("daemon.js", 206, 211)]
      "lib/optimize.js:12-21"             → [("lib/optimize.js", 12, 21)]
      "daemon.js:1140,1196,1237"          → [("daemon.js", 1140, 1140),
                                              ("daemon.js", 1196, 1196),
                                              ("daemon.js", 1237, 1237)]
      "lib/a.js:10-20; daemon.js:5-8"    → [("lib/a.js", 10, 20), ("daemon.js", 5, 8)]
      Multiple specs separated by ";" are supported.
    """
    results: list[tuple[str, int, int]] = []
    parts = [p.strip() for p in evidence_spec.split(";") if p.strip()]
    for part in parts:
        # Expect "filename:linespec"
        m = re.match(r"^(.+?):(.+)$", part.strip())
        if not m:
            continue
        filename = m.group(1).strip()
        linespec = m.group(2).strip()

        # "206-211" — a range
        range_m = re.match(r"^(\d+)-(\d+)$", linespec)
        if range_m:
            results.append((filename, int(range_m.group(1)), int(range_m.group(2))))
            continue

        # "1140,1196,1237" — individual lines (treat each as a 3-line window for context)
        # A single line number reads ±1 around it so a statement that spans a line or two is visible.
        for tok in linespec.split(","):
            tok = tok.strip()
            if tok.isdigit():
                ln = int(tok)
                results.append((filename, max(1, ln - 1), ln + 1))
    return results


def _distill_source_text(source_text: str, filename: str, line_range: str) -> list[dict[str, str]]:
    """Extract atomic facts from *source_text* via LLM (distill.py pattern).

    Returns a list of {title, fact} dicts. Returns [] on LLM failure or no facts.
    This mirrors distill.py's _claude_p + _parse_facts but targets source CODE
    rather than conversational turns.

    NOTE: source_text is the SOURCE CODE, never the gold answer — honesty bar.
    """
    if not (source_text or "").strip():
        return []

    prompt = _SOURCE_DISTILL_PROMPT.format(
        filename=filename,
        line_range=line_range,
        source_text=source_text,
    )

    # Reuse judge_mod.claude_p (the SDK's battle-tested tool-less LLM call).
    cli = _resolve_claude()
    mcp_off = os.path.join(_BENCH, "mcp-off.json")
    args: list[str] = [cli, "-p"]
    if os.path.exists(mcp_off):
        args += ["--mcp-config", mcp_off, "--strict-mcp-config"]
    # Use text output — we parse JSON from the LLM's text response.
    args += ["--output-format", "text", "--allowedTools", ""]
    distill_timeout = int(os.environ.get("ZONOID_BENCH_DISTILL_TIMEOUT", "120"))

    sandbox = tempfile.mkdtemp(prefix="combined-bench-distill-")
    try:
        run = subprocess.run(
            args,
            input=prompt,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=distill_timeout,
            env=dict(os.environ),
            cwd=sandbox,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[combined_bench/distill] LLM call failed: {exc}", file=sys.stderr)
        return []
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)

    if run.returncode != 0:
        tail = (run.stderr or run.stdout or "")[-200:]
        print(f"[combined_bench/distill] LLM exit={run.returncode}: {tail}", file=sys.stderr)
        return []

    raw = run.stdout or ""
    return _parse_distill_facts(raw)


def _parse_distill_facts(raw: str) -> list[dict[str, str]]:
    """Parse the JSON array of facts from raw LLM output (mirrors distill.py _parse_facts)."""
    if not raw:
        return []
    raw = raw.strip()

    # Pattern 1: markdown fence
    fence_m = re.search(r"```(?:json)?\s*(\[.*?\])\s*```", raw, re.DOTALL)
    if fence_m:
        raw = fence_m.group(1)

    # Pattern 2: scan for first '[' ... matching ']'
    start = raw.find("[")
    end = raw.rfind("]")
    if start == -1 or end == -1 or end < start:
        return []
    blob = raw[start: end + 1]

    try:
        parsed = json.loads(blob)
    except json.JSONDecodeError:
        # Try stripping trailing commas (common LLM mistake)
        cleaned = re.sub(r",\s*([}\]])", r"\1", blob)
        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError:
            return []

    if not isinstance(parsed, list):
        return []

    facts: list[dict[str, str]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        fact = str(item.get("fact") or "").strip()
        if fact:
            facts.append({"title": title or fact[:60], "fact": fact})
    return facts


def distill_probe_source(
    prob: dict[str, Any],
    repo_root: str,
) -> list[dict[str, str]]:
    """Extract atomic facts from the SOURCE CODE referenced by prob["evidence"].

    This is the HONEST ingest source for dag-distill:
      - Reads the repo source lines specified in prob["evidence"] (e.g. "daemon.js:206-211").
      - Runs the atomic-fact extractor on that SOURCE CODE.
      - NEVER touches prob["gold"] (the reference answer) — that is grader-only.

    Returns a list of {title, fact} dicts for ALL evidence specs in the problem.
    Returns [] if evidence is missing, or source cannot be read, or LLM extraction fails.
    Honest miss: returning [] means the distill arm seeds NOTHING for this probe (correct).
    """
    evidence_spec = str(prob.get("evidence") or "").strip()
    if not evidence_spec:
        return []

    specs = _parse_evidence_spec(evidence_spec)
    if not specs:
        return []

    all_facts: list[dict[str, str]] = []
    for (filename, start, end) in specs:
        source_text = _read_source_lines(repo_root, filename, start, end)
        if not source_text.strip():
            print(
                f"[combined_bench/distill] evidence {filename}:{start}-{end} — "
                f"source not readable (honest miss, seeding nothing for this spec)",
                file=sys.stderr,
            )
            continue
        line_range = f"{start}-{end}"
        facts = _distill_source_text(source_text, filename, line_range)
        if facts:
            all_facts.extend(facts)
        else:
            print(
                f"[combined_bench/distill] evidence {filename}:{start}-{end} — "
                f"LLM extracted 0 facts (honest miss for this spec)",
                file=sys.stderr,
            )
    return all_facts


# ---------------------------------------------------------------------------
# dag-distill: build the distilled KB (seed ALL problems before any retrieval)
# ---------------------------------------------------------------------------

def build_distill_workspace(
    problems: list[dict[str, Any]],
    repo_root: str,
    distill_ws: str,
    daemon_url: str,
    *,
    verbose: bool = True,
) -> dict[str, list[str]]:
    """Seed atomic-fact notes from SOURCE (never gold) into *distill_ws* for all problems.

    For each problem:
      1. Parse prob["evidence"] to get repo source file+lines.
      2. Read those source lines from *repo_root*.
      3. Run LLM atomic-fact extraction on the source text.
      4. POST each fact note into *distill_ws* via POST /overlay/note.

    Returns a dict mapping prob source/idx → list of seeded note keys.
    This workspace is then bound ONCE for the entire dag-distill pass; no per-problem rebind.

    HONESTY BAR: prob["gold"] is never read or passed to any step here.
    """
    os.makedirs(distill_ws, exist_ok=True)

    # We use the module-level post_note from client.py (not zonoid_lifecycle) since we're in
    # the zonoid_bench package. Import the functional form directly.
    from zonoid_bench.client import post_note as _post_note  # noqa: PLC0415

    seeded: dict[str, list[str]] = {}

    for i, prob in enumerate(problems):
        prob_id = str(prob.get("source") or i)
        evidence_spec = str(prob.get("evidence") or "").strip()

        if not evidence_spec:
            if verbose:
                print(
                    f"[distill-kb] prob {prob_id}: no evidence field — seeding nothing (honest miss)",
                    file=sys.stderr,
                )
            seeded[prob_id] = []
            continue

        if verbose:
            print(
                f"[distill-kb] prob {prob_id}: distilling source {evidence_spec!r} ...",
                file=sys.stderr,
            )

        facts = distill_probe_source(prob, repo_root)

        if not facts:
            if verbose:
                print(
                    f"[distill-kb] prob {prob_id}: 0 facts extracted (honest miss)",
                    file=sys.stderr,
                )
            seeded[prob_id] = []
            continue

        note_keys: list[str] = []
        for fact in facts:
            try:
                resp = _post_note(
                    base_url=daemon_url,
                    workspace=distill_ws,
                    title=fact["title"],
                    summary=fact["fact"],
                    category="distilled-source-fact",
                    tags=[f"prob-{prob_id}", "dag-distill", evidence_spec[:80]],
                    timeout=60,
                )
                key = resp.get("key") or resp.get("note_key") or ""
                if key:
                    note_keys.append(key)
            except Exception as exc:  # noqa: BLE001 — one note failure must not abort the ingest
                print(
                    f"[distill-kb] prob {prob_id}: note write failed: {exc}",
                    file=sys.stderr,
                )

        seeded[prob_id] = note_keys
        if verbose:
            print(
                f"[distill-kb] prob {prob_id}: seeded {len(note_keys)}/{len(facts)} fact notes "
                f"(source: {evidence_spec!r})",
                file=sys.stderr,
            )

    return seeded


# ---------------------------------------------------------------------------
# Per-problem fused run (shared by raw-dag and dag-distill)
# ---------------------------------------------------------------------------

def run_problem(
    client: ZonoidClient,
    idx: int,
    prob: dict[str, Any],
    *,
    data_dir: str,
    model: Optional[str],
    on_ceiling: float,
    on_config: str = _ON_CONFIG_RAW_DAG,
) -> dict[str, Any]:
    """Run BOTH arms on one problem and return the fused per-problem record.

    ``on_config`` controls the ON arm's KB source:
      raw-dag     (default): standard production KB — seeded notes from the production pipeline.
      dag-distill          : distilled-from-source KB bound before this call (via client.workspace).
                             NOTE: workspace bind is done ONCE before the run loop, not per-problem.
    """
    question = str(prob["question"])
    gold = str(prob["gold"])
    category = str(prob.get("category") or "unknown")
    qid = str(prob.get("source") or idx)
    # unit_id distinguishes arms in the graph so task stubs don't collide.
    cfg_tag = "distill" if on_config == _ON_CONFIG_DAG_DISTILL else "raw"
    unit_id = f"combined-bench-{cfg_tag}-{idx}-{qid}"

    # --- ON arm (production parity, KB source controlled by client.workspace) ---
    on_err = ""
    try:
        t0 = time.monotonic()
        on = run_on_arm(
            client, unit_id, question,
            data_dir=data_dir, model=model, on_ceiling=on_ceiling,
        )
        on_elapsed = round(time.monotonic() - t0, 1)
    except Exception as exc:  # noqa: BLE001 — one arm failure must not abort the run
        on_err = str(exc)
        on = {"predicted": "", "cost": 0.0, "usage": {}, "cost_usd": None,
              "ctx_chars": 0, "context_keys": [], "n_dag": 0, "n_ctx": 0,
              "judge_idle": True, "wired_edges": [], "pruned_edges": [],
              "timeout_kills": 0, "provisional_kept": 0, "probe_task_key": "",
              "over_ceiling": False}
        on_elapsed = 0.0

    # --- OFF arm (pure agentic, clean env) ---
    off_err = ""
    try:
        t1 = time.monotonic()
        off = run_off_arm(question, model=model)
        off_elapsed = round(time.monotonic() - t1, 1)
    except Exception as exc:  # noqa: BLE001
        off_err = str(exc)
        off = {"predicted": "", "cost": 0.0, "usage": {}, "cost_usd": None}
        off_elapsed = 0.0

    # --- Grade both final answers (validated LLM-judge) ---
    # Gold is used ONLY here — never above in retrieval/seed/answer steps.
    on_solved = bool(_grade(question, gold, on["predicted"], category))
    off_solved = bool(_grade(question, gold, off["predicted"], category))

    on_cost = float(on["cost"])
    off_cost = float(off["cost"])

    # The cost-bounded comparison (note-mqjmq2cbdy3): OFF must match ON's outcome WITHIN ON's actual
    # spend. With ON cost as the cap, OFF succeeds-within-budget iff it solved AND cost it no more.
    off_within_budget = bool(off_solved and off_cost <= on_cost)
    # Memory win: ON solved where a budget-matched cold agent could not.
    memory_win = bool(on_solved and not off_within_budget)

    rec: dict[str, Any] = {
        "qid": qid,
        "idx": idx,
        "category": category,
        "question": question,
        "gold": gold,
        "on_config": on_config,
        # headline fused fields (the contract)
        "ON_solved": on_solved,
        "ON_cost": round(on_cost, 1),
        "OFF_solved": off_solved,
        "OFF_cost": round(off_cost, 1),
        "OFF_solved_within_budget": off_within_budget,
        "memory_win": memory_win,
        # ON provenance + breakdown
        "ON_predicted": on["predicted"],
        "ON_usage": on["usage"],
        "ON_cost_usd": on.get("cost_usd"),
        "ON_ctx_chars": on.get("ctx_chars", 0),
        "ON_context_keys": on.get("context_keys", []),
        "ON_n_dag": on.get("n_dag", 0),
        "ON_judge_idle": on.get("judge_idle", True),
        "ON_over_ceiling": on.get("over_ceiling", False),
        "ON_probe_task_key": on.get("probe_task_key", ""),
        "ON_elapsed_s": on_elapsed,
        # OFF breakdown
        "OFF_predicted": off["predicted"],
        "OFF_usage": off["usage"],
        "OFF_cost_usd": off.get("cost_usd"),
        "OFF_elapsed_s": off_elapsed,
        # seeded-note metadata (provenance only — NOT used in retrieval/answer)
        "evidence": prob.get("evidence", ""),
        "source": prob.get("source", ""),
        "title": prob.get("title", ""),
    }
    if on_err:
        rec["ON_error"] = on_err[:200]
    if off_err:
        rec["OFF_error"] = off_err[:200]
    return rec


# ---------------------------------------------------------------------------
# Aggregate report
# ---------------------------------------------------------------------------

def aggregate(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute the aggregate report from fused per-problem records.

    Produces overall + per-category:
      - n
      - ON accuracy (ON_solved rate) + mean ON cost
      - OFF accuracy (OFF_solved rate, unbounded) + mean OFF cost
      - OFF-within-budget rate (OFF_solved_within_budget)
      - memory-win count + rate (ON_solved and not OFF_solved_within_budget)
    """
    def _blank() -> dict[str, Any]:
        return {
            "n": 0, "on_solved": 0, "off_solved": 0, "off_within_budget": 0,
            "memory_win": 0, "on_cost_sum": 0.0, "off_cost_sum": 0.0,
            "on_over_ceiling": 0,
        }

    overall = _blank()
    by_cat: dict[str, dict[str, Any]] = {}

    for r in records:
        cat = str(r.get("category") or "unknown")
        bc = by_cat.setdefault(cat, _blank())
        for acc in (overall, bc):
            acc["n"] += 1
            acc["on_solved"] += 1 if r.get("ON_solved") else 0
            acc["off_solved"] += 1 if r.get("OFF_solved") else 0
            acc["off_within_budget"] += 1 if r.get("OFF_solved_within_budget") else 0
            acc["memory_win"] += 1 if r.get("memory_win") else 0
            acc["on_cost_sum"] += float(r.get("ON_cost") or 0)
            acc["off_cost_sum"] += float(r.get("OFF_cost") or 0)
            acc["on_over_ceiling"] += 1 if r.get("ON_over_ceiling") else 0

    def _finish(acc: dict[str, Any]) -> dict[str, Any]:
        n = acc["n"] or 1
        return {
            "n": acc["n"],
            "on_accuracy": acc["on_solved"] / n,
            "off_accuracy": acc["off_solved"] / n,
            "off_within_budget_rate": acc["off_within_budget"] / n,
            "memory_win_count": acc["memory_win"],
            "memory_win_rate": acc["memory_win"] / n,
            "on_cost_mean": acc["on_cost_sum"] / n,
            "off_cost_mean": acc["off_cost_sum"] / n,
            "on_over_ceiling_count": acc["on_over_ceiling"],
        }

    return {
        "overall": _finish(overall),
        "by_category": {c: _finish(v) for c, v in sorted(by_cat.items())},
    }


def _pct(v: float) -> str:
    return f"{v * 100:.1f}%"


def render_report(agg: dict[str, Any], records: list[dict[str, Any]], path_md: str, path_json: str,
                  *, title: str, on_ceiling: float, on_config: str = _ON_CONFIG_RAW_DAG) -> tuple[str, str]:
    """Write report.json (machine) + report.md (human) for the combined bench."""
    for p in (path_md, path_json):
        os.makedirs(os.path.dirname(os.path.abspath(p)) or ".", exist_ok=True)

    report_data = {
        "title": title,
        "on_config": on_config,
        "metric": "validated LLM-judge (report.judge_correctness); cost = bench-economy.js weighted "
                  "token-equivalent (input + output*5 + cache_read*0.1 + cache_creation*1.25).",
        "on_ceiling": on_ceiling,
        "cap_enforcement": "post-hoc (OFF_solved_within_budget := OFF_solved and OFF_cost <= ON_cost). "
                           "Real-time mid-call kill not implemented — see module docstring.",
        "aggregate": agg,
        "n_records": len(records),
    }
    with open(path_json, "w", encoding="utf-8") as fh:
        json.dump(report_data, fh, indent=2, ensure_ascii=False)

    ov = agg["overall"]
    lines: list[str] = []
    lines.append(f"# {title}")
    lines.append("")
    lines.append("_Combined ON-vs-OFF cost-bounded agentic bench (canonical, note-mqjmq2cbdy3)._")
    lines.append(f"_ON-config: {on_config}_")
    lines.append("")
    on_arm_desc = {
        _ON_CONFIG_RAW_DAG: (
            "production-faithful memory retrieval (mint probe TASK -> autowire "
            "NOTE->probe context_deps -> eager-judge keep/prune -> frozen "
            "task-scoped /search (system + DAG for settled probes)). "
            f"Token CEILING {on_ceiling:.0f} weighted tok-eq = runaway guard ONLY, not a target."
        ),
        _ON_CONFIG_DAG_DISTILL: (
            "DAG+distill: distilled atomic facts from SOURCE CODE (evidence field) "
            "seeded into a dedicated distill workspace ONCE, then retrieved via the same "
            "production canonical_wiring path. Gold never enters seed/retrieve/answer. "
            f"Token CEILING {on_ceiling:.0f} weighted tok-eq = runaway guard ONLY, not a target."
        ),
    }.get(on_config, on_config)
    lines.append(f"- **ON arm** ({on_config}): {on_arm_desc}")
    lines.append("- **OFF arm**: pure agentic, clean env (no MCP/KB/.graph/ORCH_*). Budget cap = "
                 "ON's ACTUAL spend on that problem, enforced post-hoc.")
    lines.append("- **Cost**: input + output*5 + cache_read*0.1 + cache_creation*1.25 "
                 "(scripts/bench-economy.js formula).")
    lines.append("- **Grader**: validated LLM-judge (LoCoMo/LongMemEval rubric). Gold answers never "
                 "enter any retrieve/answer step.")
    lines.append("")
    lines.append("## Overall")
    lines.append("")
    lines.append("| Metric | Value |")
    lines.append("| --- | --- |")
    lines.append(f"| n problems | {ov['n']} |")
    lines.append(f"| ON accuracy | {_pct(ov['on_accuracy'])} |")
    lines.append(f"| OFF accuracy (unbounded) | {_pct(ov['off_accuracy'])} |")
    lines.append(f"| OFF-within-budget rate | {_pct(ov['off_within_budget_rate'])} |")
    lines.append(f"| **Memory-win count** | **{ov['memory_win_count']}** ({_pct(ov['memory_win_rate'])}) |")
    lines.append(f"| ON mean cost (weighted tok-eq) | {ov['on_cost_mean']:.0f} |")
    lines.append(f"| OFF mean cost (weighted tok-eq) | {ov['off_cost_mean']:.0f} |")
    lines.append(f"| ON over-ceiling count | {ov['on_over_ceiling_count']} |")
    lines.append("")
    lines.append("## Per-category breakdown")
    lines.append("")
    lines.append("_Self-reveals contamination: cold-solvable categories (config, invariant) show "
                 "OFF matching ON cheaply (low memory-win); decision/gotcha show OFF failing within "
                 "ON's budget (high memory-win)._")
    lines.append("")
    lines.append("| Category | n | ON acc | OFF acc | OFF-in-budget | Memory wins | ON cost | OFF cost |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for cat, d in agg["by_category"].items():
        lines.append(
            f"| {cat} | {d['n']} | {_pct(d['on_accuracy'])} | {_pct(d['off_accuracy'])} | "
            f"{_pct(d['off_within_budget_rate'])} | {d['memory_win_count']} ({_pct(d['memory_win_rate'])}) | "
            f"{d['on_cost_mean']:.0f} | {d['off_cost_mean']:.0f} |"
        )
    lines.append("")
    md = "\n".join(lines)
    with open(path_md, "w", encoding="utf-8") as fh:
        fh.write(md)

    return os.path.abspath(path_json), os.path.abspath(path_md)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Combined ON-vs-OFF cost-bounded agentic bench (canonical Zonoid benchmark).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--questions", default=_DEFAULT_QUESTIONS,
                        help=f"Problem set JSONL (default: {_DEFAULT_QUESTIONS}).")
    parser.add_argument("--out", default=_DEFAULT_OUT,
                        help=f"Output fused-records JSONL (default: {_DEFAULT_OUT}).")
    parser.add_argument("--daemon", default=_DEFAULT_DAEMON,
                        help=f"Daemon base URL (default: {_DEFAULT_DAEMON}).")
    parser.add_argument("--workspace", default=None,
                        help="Daemon live workspace path the KB is bound to (default: repo root). "
                             "The seeded notes must live in THIS workspace for the ON arm to retrieve "
                             "them via the production path.")
    parser.add_argument("--data-dir", default=_DEFAULT_DATA_DIR,
                        help=f"Task-stub drop dir (default: {_DEFAULT_DATA_DIR}).")
    parser.add_argument("--model", default=_DEFAULT_MODEL,
                        help="Answer model for both arms (default: SDK default / sonnet).")
    parser.add_argument("--limit", type=int, default=None,
                        help="Run only the first N problems (default: all).")
    parser.add_argument("--offset", type=int, default=0,
                        help="Skip the first N problems (default: 0).")
    parser.add_argument("--category", default=None,
                        help="Run only problems in this category (decision/config/gotcha/invariant/convention).")
    parser.add_argument("--on-ceiling", type=float, default=_DEFAULT_ON_CEILING,
                        help=f"ON runaway-guard ceiling, weighted tok-eq (default: {_DEFAULT_ON_CEILING:.0f}).")
    parser.add_argument("--append", action="store_true",
                        help="Append to an existing --out instead of overwriting.")
    parser.add_argument("--report-dir", default=None,
                        help="Write report.json + report.md here (default: alongside --out).")
    parser.add_argument("--score-only", metavar="PATH", default=None,
                        help="Load a fused-records JSONL, recompute the aggregate + report, and exit.")
    parser.add_argument(
        "--on-config", default=_ON_CONFIG_RAW_DAG,
        choices=_ON_CONFIG_CHOICES,
        help=(
            "ON arm knowledge-base source. "
            f"raw-dag (default): retrieve from the production KB mined from repo source. "
            f"dag-distill: re-mine the same repo source (evidence field) through the "
            "atomic-fact distiller into a dedicated workspace, then retrieve via the same "
            "production path. Gold never enters any distill/seed/retrieve/answer step."
        ),
    )
    parser.add_argument("--distill-workspace", default=None,
                        help="dag-distill only: path for the dedicated distill workspace "
                             "(default: auto-created temp dir, persists for the run duration). "
                             "Pass an explicit path to reuse a pre-built distill KB.")
    parser.add_argument("--repo-root", default=None,
                        help="dag-distill only: repo root to read source files from "
                             "(default: inferred as parent of bench/).")
    args = parser.parse_args(argv)

    # --- score-only mode (no run; recompute aggregate from saved fused records) ---
    if args.score_only:
        recs: list[dict[str, Any]] = []
        with open(args.score_only, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    recs.append(json.loads(line))
        print(f"[combined_bench] loaded {len(recs)} fused records from {args.score_only}")
        agg = aggregate(recs)
        on_config_from_recs = recs[0].get("on_config", _ON_CONFIG_RAW_DAG) if recs else _ON_CONFIG_RAW_DAG
        report_dir = args.report_dir or os.path.dirname(os.path.abspath(args.score_only)) or "."
        jp, mp = render_report(agg, recs,
                               os.path.join(report_dir, "combined-bench-report.md"),
                               os.path.join(report_dir, "combined-bench-report.json"),
                               title="Zonoid Combined ON-vs-OFF Cost-Bounded Bench",
                               on_ceiling=args.on_ceiling,
                               on_config=on_config_from_recs)
        _print_summary(agg)
        print(f"[combined_bench] report.json -> {jp}")
        print(f"[combined_bench] report.md   -> {mp}")
        return 0

    on_config = args.on_config
    workspace = os.path.abspath(args.workspace or _REPO)
    data_dir = args.data_dir
    repo_root = os.path.abspath(args.repo_root or _REPO)

    print("=" * 72)
    print(f"Zonoid Combined ON-vs-OFF Cost-Bounded Bench ({on_config})")
    print("=" * 72)
    print(f"  daemon     : {args.daemon}")
    print(f"  on_config  : {on_config}")
    print(f"  workspace  : {workspace}  (KB source for the ON arm)")
    print(f"  data_dir   : {data_dir}")
    print(f"  questions  : {args.questions}")
    print(f"  out        : {args.out}")
    print(f"  on_ceiling : {args.on_ceiling:.0f} weighted tok-eq (runaway guard)")
    print(f"  model      : {args.model or 'SDK default'}")
    print(f"  cap        : post-hoc (OFF_solved_within_budget := OFF_solved and OFF_cost<=ON_cost)")

    if not os.path.exists(args.questions):
        print(f"\nERROR: problem set not found: {args.questions}")
        print("  Pass --questions <path> (the featurebench bench-questions.jsonl).")
        return 2

    problems = load_problems(args.questions)
    if args.category:
        problems = [p for p in problems if str(p.get("category")) == args.category]
    problems = problems[args.offset:]
    if args.limit is not None:
        problems = problems[:args.limit]
    total = len(problems)
    print(f"\n  {total} problems to run (offset={args.offset}, limit={args.limit or 'all'}, "
          f"category={args.category or 'all'})")
    if not total:
        print("  Nothing to run.")
        return 0

    # -----------------------------------------------------------------------
    # dag-distill: build the distilled KB ONCE before any retrieval
    # -----------------------------------------------------------------------
    distill_ws_tmp: Optional[str] = None  # set if we created a temp dir to clean up
    prev_workspace: Optional[str] = None  # the workspace we'll restore on exit

    if on_config == _ON_CONFIG_DAG_DISTILL:
        # Decide distill workspace (explicit path or temp dir).
        if args.distill_workspace:
            distill_ws = os.path.abspath(args.distill_workspace)
            os.makedirs(distill_ws, exist_ok=True)
            print(f"\n  [dag-distill] using explicit distill workspace: {distill_ws}")
        else:
            distill_ws = os.path.abspath(tempfile.mkdtemp(prefix="combined-bench-distill-ws-"))
            distill_ws_tmp = distill_ws
            print(f"\n  [dag-distill] created temp distill workspace: {distill_ws}")

        print(f"  [dag-distill] repo_root for source reads: {repo_root}")
        print(f"  [dag-distill] ingesting atomic facts from source (evidence fields) ...\n")

        # Connect to daemon (just for warm-up; workspace will be rebound after ingest).
        ingest_client = ZonoidClient(args.daemon, workspace=distill_ws, timeout=180)
        try:
            ingest_client.warm_up()
            print(f"  daemon warm-up OK")
        except Exception as exc:  # noqa: BLE001
            print(f"\nERROR: daemon at {args.daemon} not reachable: {exc}")
            if distill_ws_tmp:
                shutil.rmtree(distill_ws_tmp, ignore_errors=True)
            return 1

        # Seed ALL problems' distilled facts into the distill workspace.
        seeded_map = build_distill_workspace(
            problems, repo_root, distill_ws, args.daemon, verbose=True,
        )
        total_seeded = sum(len(v) for v in seeded_map.values())
        n_miss = sum(1 for v in seeded_map.values() if not v)
        print(
            f"\n  [dag-distill] ingest complete: {total_seeded} fact notes seeded, "
            f"{n_miss}/{len(problems)} honest misses (no evidence / no source / 0 facts)\n"
        )

        # Allow the daemon to embed + index the freshly posted notes before any retrieval.
        print("  [dag-distill] waiting for embedder to index distill notes ...", end="", flush=True)
        time.sleep(8)
        print(" done")

        # Bind the distill workspace ONCE for the whole pass.
        # Save the previous live workspace so we can restore it on exit.
        try:
            ingest_client.set_workspace(distill_ws, force=True)
            # Verify the bind took + check warmup hits.
            hits = ingest_client.search("distill bench warmup probe", k=1)
            print(f"  [dag-distill] live workspace bound to distill ws ({len(hits)} warmup hits)")
            prev_workspace = workspace  # remember for restore
        except Exception as exc:  # noqa: BLE001
            print(f"\nERROR: could not bind distill workspace: {exc}")
            if distill_ws_tmp:
                shutil.rmtree(distill_ws_tmp, ignore_errors=True)
            return 1

        # The client for the run loop points at the distill workspace.
        client = ZonoidClient(args.daemon, workspace=distill_ws, timeout=180)
    else:
        # raw-dag: standard bind to the main workspace.
        client = ZonoidClient(args.daemon, workspace=workspace, timeout=180)
        try:
            client.warm_up()
            client.set_workspace(workspace, force=True)
            hits = client.search("combined bench warmup probe", k=1)
            print(f"  daemon reachable + live workspace bound to {workspace} ({len(hits)} warmup hits)")
        except Exception as exc:  # noqa: BLE001
            print(f"\nERROR: daemon at {args.daemon} not reachable / could not bind workspace: {exc}")
            print("  Ensure the daemon is running and the KB (seeded notes) is loaded in --workspace.")
            return 1

    print(f"\nRunning {total} problems (ON + OFF per problem) ...\n")
    all_records: list[dict[str, Any]] = []
    run_t0 = time.monotonic()
    n_err = 0

    try:
        for i, prob in enumerate(problems):
            idx = i + args.offset
            is_first_write = (i == 0 and not args.append)
            try:
                rec = run_problem(
                    client, idx, prob,
                    data_dir=data_dir, model=args.model,
                    on_ceiling=args.on_ceiling, on_config=on_config,
                )
            except Exception as exc:  # noqa: BLE001 — never let one problem abort the run
                print(f"[{i+1}/{total}] ERROR (problem skipped): {exc}")
                n_err += 1
                continue

            report_mod.write_results([rec], args.out, append=not is_first_write)
            all_records.append(rec)

            marks = []
            if rec["memory_win"]:
                marks.append("MEM-WIN")
            if rec.get("ON_over_ceiling"):
                marks.append("ON>CEIL")
            if rec.get("ON_error") or rec.get("OFF_error"):
                marks.append("ERR")
            mark_s = ("  [" + ",".join(marks) + "]") if marks else ""
            print(f"[{i+1:3d}/{total}] {rec['category']:11s} "
                  f"ON={'OK ' if rec['ON_solved'] else 'no '}({rec['ON_cost']:.0f}) "
                  f"OFF={'OK ' if rec['OFF_solved'] else 'no '}({rec['OFF_cost']:.0f}) "
                  f"in_budget={'Y' if rec['OFF_solved_within_budget'] else 'N'}"
                  f"{mark_s}  {rec['question'][:48]!r}")

    finally:
        # dag-distill: restore the original workspace binding on exit (cleanup).
        if on_config == _ON_CONFIG_DAG_DISTILL and prev_workspace is not None:
            try:
                client.set_workspace(prev_workspace, force=True)
                print(f"\n  [dag-distill] restored live workspace to {prev_workspace}")
            except Exception as exc:  # noqa: BLE001 — best-effort restore
                print(f"\n  [dag-distill] WARNING: could not restore workspace: {exc}", file=sys.stderr)
        # Clean up auto-created temp distill workspace.
        if distill_ws_tmp is not None:
            try:
                shutil.rmtree(distill_ws_tmp, ignore_errors=True)
                print(f"  [dag-distill] cleaned up temp distill workspace: {distill_ws_tmp}")
            except Exception:  # noqa: BLE001
                pass

    elapsed = time.monotonic() - run_t0
    print(f"\nDone — {total} problems in {elapsed:.0f}s ({n_err} errors)")
    print(f"Fused records -> {args.out}")

    if all_records:
        agg = aggregate(all_records)
        report_dir = args.report_dir or os.path.dirname(os.path.abspath(args.out)) or "."
        jp, mp = render_report(agg, all_records,
                               os.path.join(report_dir, "combined-bench-report.md"),
                               os.path.join(report_dir, "combined-bench-report.json"),
                               title="Zonoid Combined ON-vs-OFF Cost-Bounded Bench",
                               on_ceiling=args.on_ceiling,
                               on_config=on_config)
        _print_summary(agg)
        print(f"  report.json -> {jp}")
        print(f"  report.md   -> {mp}")

    return 0 if n_err == 0 else 1


def _print_summary(agg: dict[str, Any]) -> None:
    ov = agg["overall"]
    print("\n--- Aggregate ---")
    print(f"  n problems              : {ov['n']}")
    print(f"  ON accuracy             : {_pct(ov['on_accuracy'])}")
    print(f"  OFF accuracy (unbounded): {_pct(ov['off_accuracy'])}")
    print(f"  OFF within ON budget    : {_pct(ov['off_within_budget_rate'])}")
    print(f"  MEMORY WINS             : {ov['memory_win_count']} ({_pct(ov['memory_win_rate'])})")
    print(f"  ON mean cost (tok-eq)   : {ov['on_cost_mean']:.0f}")
    print(f"  OFF mean cost (tok-eq)  : {ov['off_cost_mean']:.0f}")
    print("\n  by category:")
    for cat, d in agg["by_category"].items():
        print(f"    {cat:11s} n={d['n']:3d}  ON={_pct(d['on_accuracy']):>6s}  "
              f"OFF-in-budget={_pct(d['off_within_budget_rate']):>6s}  "
              f"mem-wins={d['memory_win_count']}")


if __name__ == "__main__":
    sys.exit(main())
