"""Scorer for the agent-memory benchmark harness — now a thin wrapper over the SDK report.

The scoring machinery (token-level F1 + LLM-judge accuracy + the LoCoMo/LongMemEval
judge rubric) used to live HERE as a duplicated copy. It now lives in ONE place —
``bench/zonoid_bench/report.py`` — and this module routes through it so existing
importers (run.py: ``from scorer import generate_report, score``) keep working unchanged.

What this wrapper preserves over the raw SDK surface:
  - ``score(results_path, use_llm_judge=True, ...)``  takes a PATH and defaults the
    LLM judge ON (the agent-memory headline metric). The SDK ``report.score`` takes a
    list of records and defaults the judge OFF; this wrapper loads the file and flips
    the default, so run.py's call shape and semantics are identical to before.
  - ``generate_report(scored, benchmark, output_dir)`` returns ``(json_path, md_path)``
    and injects the agent-memory competitor bar (Mem0 / Zep) + the LoCoMo scoring-dispute
    disclaimer via the SDK's ``render_report`` / ``scorecard_section``.

Reads ``results.jsonl`` produced by ``probe_runner.py`` (one record per arm per probe):
    {arm, conv_id, qid, category, question, gold, predicted, ...diagnostics}

``gold`` is used ONLY here. It NEVER enters the probe runner's prediction paths.

Runtime: stdlib ONLY (no pip); the LLM judge reuses ``zonoid_bench.judge.claude_p``
(stdin delivery, shutil.which, encoding="utf-8", mcp-off.json).
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
_BENCH = os.path.dirname(_HERE)
for _p in (_HERE, _BENCH):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Single source of truth for scoring + reporting.
from zonoid_bench import report as _report  # noqa: E402
from zonoid_bench.report import _pct, token_f1  # noqa: E402,F401  (re-exported for callers)


# ---------------------------------------------------------------------------
# Competitor bars (from published papers) — agent-memory specific framing.
# Shaped for report.render_report / scorecard_section: {System: {metric_label: value, ...}}.
# scorecard_section renders one column per metric key PLUS a dedicated Source column that
# reads the per-system "source" key (defaulting to "published"). To avoid a duplicated
# Source column we deliberately OMIT "source" from the metric dict; the citation
# (Wu et al., 2024 Table 2) is carried by the appended LoCoMo disclaimer instead.
# ---------------------------------------------------------------------------

_COMPETITOR_BAR: dict[str, dict[str, str]] = {
    "Mem0": {
        "LongMemEval-Oracle": "92.5%",
        "LongMemEval-S": "94.4%",
        "LoCoMo": "~84% (disputed)",
    },
    "Zep": {
        "LongMemEval-Oracle": "91.6%",
        "LongMemEval-S": "94.8%",
        "LoCoMo": "~75.1% (corrected)",
    },
}

_LOCOMO_DISCLAIMER = (
    "> **Note (LoCoMo scoring dispute):** LoCoMo vendor scores vary across sources: "
    "original paper 84%, third-party replication 58.4%, vendor-corrected 75.1%. "
    "Treat LoCoMo absolute accuracy numbers with caution; use the arm-vs-arm contrast "
    "(our-way vs search vs cold) as the primary comparison within this harness, not the "
    "absolute comparison to the published 84%. Competitor bars are published numbers on "
    "possibly different subsets/protocols — directional context, not apples-to-apples."
)

_BENCH_LABEL = {
    "locomo": "LoCoMo",
    "longmemeval": "LongMemEval",
    "longmemeval-oracle": "LongMemEval-Oracle",
    "longmemeval-s": "LongMemEval-S",
    "longmemeval-m": "LongMemEval-M",
}


# ---------------------------------------------------------------------------
# Public API (kept stable for run.py + the CLI)
# ---------------------------------------------------------------------------

def score(
    results_path: str,
    use_llm_judge: bool = True,
    verbose: bool = False,
) -> dict[str, Any]:
    """Score all (probe, arm) records in *results_path* via the SDK report scorer.

    Args:
        results_path: Path to the runner's ``results.jsonl``.
        use_llm_judge: If True (default), call the LLM judge per record (headline metric).
                       Set False to skip LLM calls and only compute token-F1.
        verbose: Print per-record judge decisions to stderr.

    Returns the SDK ScoreResult dict (``{"arms": {...}, "records": [...]}``); see
    ``zonoid_bench.report.score`` for the full shape. ``f1_mean`` is always populated
    (token-F1 is on); ``accuracy`` is populated iff ``use_llm_judge``.
    """
    records = _report.load_results(results_path)
    return _report.score(
        records,
        use_llm_judge=use_llm_judge,
        use_f1=True,
        use_pass_fail=False,  # QA bench: no per-record `correct` field.
        verbose=verbose,
    )


def generate_report(
    scored: dict[str, Any],
    benchmark: str,
    output_dir: str,
) -> tuple[str, str]:
    """Write ``report.json`` + ``report.md`` to *output_dir* via the SDK renderer.

    Injects the agent-memory competitor bar (Mem0 / Zep) and the LoCoMo scoring-dispute
    disclaimer. Returns ``(json_path, md_path)`` — same contract as the old scorer.
    """
    os.makedirs(output_dir, exist_ok=True)
    json_path = os.path.join(output_dir, "report.json")
    md_path = os.path.join(output_dir, "report.md")

    bench_label = _BENCH_LABEL.get(benchmark.lower(), benchmark)
    title = f"Agent-Memory Benchmark Report — {bench_label}"

    # render_report writes both files; it appends a scorecard_section when a competitor
    # bar is supplied. We pre-seed the disclaimer onto the bar's framing by passing it
    # through scorecard_section indirectly: render_report uses the default disclaimer, so
    # we instead append our LoCoMo-specific note after rendering.
    out_json, out_md = _report.render_report(
        scored,
        md_path,
        json_path,
        title=title,
        competitor_bar=_COMPETITOR_BAR,
    )

    # Append the LoCoMo scoring-dispute disclaimer (agent-memory specific; the SDK's
    # generic disclaimer covers cross-setup caveats but not the LoCoMo vendor dispute).
    try:
        with open(out_md, "a", encoding="utf-8") as fh:
            fh.write("\n" + _LOCOMO_DISCLAIMER + "\n")
    except Exception:  # noqa: BLE001 — disclaimer is best-effort polish
        pass

    return out_json, out_md


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Score agent-memory benchmark results.jsonl → report.json + report.md "
        "(thin wrapper over zonoid_bench.report)."
    )
    parser.add_argument(
        "results",
        nargs="?",
        default="results.jsonl",
        help="Path to results.jsonl (default: results.jsonl in cwd).",
    )
    parser.add_argument(
        "--benchmark",
        default="locomo",
        help="Benchmark name for the report header (locomo | longmemeval | ...).",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory for report.json + report.md. Defaults to the directory of results.jsonl.",
    )
    parser.add_argument(
        "--no-llm-judge",
        action="store_true",
        help="Skip LLM judge calls — compute token-F1 only (fast / offline mode).",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print per-record judge decisions to stderr.",
    )
    args = parser.parse_args(argv)

    results_path = os.path.abspath(args.results)
    if not os.path.exists(results_path):
        print(f"ERROR: results file not found: {results_path}", file=sys.stderr)
        return 2

    output_dir = args.output_dir
    if output_dir is None:
        output_dir = os.path.dirname(results_path)

    print(f"[scorer] scoring {results_path} ...", file=sys.stderr)
    use_judge = not args.no_llm_judge
    scored = score(results_path, use_llm_judge=use_judge, verbose=args.verbose)

    arms = scored.get("arms", {})
    for arm, d in sorted(arms.items()):
        print(
            f"[scorer] arm={arm}  accuracy={_pct(d.get('accuracy'))}  "
            f"f1={_pct(d.get('f1_mean'))}  n={d.get('total', 0)}",
            file=sys.stderr,
        )

    json_path, md_path = generate_report(scored, args.benchmark, output_dir)
    print(f"[scorer] report.json -> {json_path}", file=sys.stderr)
    print(f"[scorer] report.md   -> {md_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
