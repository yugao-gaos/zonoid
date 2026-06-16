"""Scorer for the agent-memory benchmark harness.

Reads ``results.jsonl`` produced by ``probe_runner.py`` (one record per arm per probe):

    {arm, conv_id, qid, category, question, gold, predicted, ...diagnostics}

Computes TWO metrics:

HEADLINE — LLM-judge accuracy (the field's metric, comparable to Mem0 92.5/94.4, Zep 91.6/94.8)
    One ``claude -p`` call per (probe, arm) → correct / incorrect.
    Abstention questions (category contains "unanswerable" or "adversarial") are scored
    correct-iff-refused (the model must output "I don't know" / refuse rather than hallucinate).
    Reported: overall + per-category accuracy per arm.

SECONDARY — token-level F1 (LoCoMo diagnostic, deterministic, no LLM)
    Porter-stemmer-like normalisation (lowercase + strip punctuation + simple stem table);
    precision / recall / F1 on token overlap between gold and predicted.
    Reported alongside accuracy as a cheap sanity check.

``gold`` is used ONLY here. It NEVER enters the probe runner's prediction paths.

Runtime (note-mqgz977tbqe): embeddable Python 3.12 — stdlib ONLY (no pip).
``claude -p`` invocation reuses the robust helper from probe_runner.py (stdin delivery,
shutil.which, encoding="utf-8", mcp-off.json).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from collections import defaultdict
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# ---------------------------------------------------------------------------
# claude -p helpers  (ported verbatim from probe_runner._run_claude)
# ---------------------------------------------------------------------------

_ANSWER_MODEL = os.environ.get("ZONOID_BENCH_MODEL", "sonnet")
_CLAUDE_TIMEOUT = int(os.environ.get("ZONOID_BENCH_CLAUDE_TIMEOUT", "180"))


def _resolve_claude_cli() -> str:
    """Resolve `claude` CLI to an absolute path, honouring PATHEXT on Windows."""
    override = os.environ.get("ZONOID_BENCH_CLAUDE")
    if override:
        return override
    found = shutil.which("claude")
    return found or "claude"


_CLAUDE_CLI = _resolve_claude_cli()


def _run_claude(prompt: str) -> str | None:
    """Run a single-shot, tool-less ``claude -p`` completion via stdin.

    Prompt is delivered on STDIN (not as a CLI arg) to avoid cmd.exe mangling
    of long/multi-line prompts on Windows — same pattern as probe_runner.py.
    Returns stdout text, or None on failure.
    """
    mcp_off = os.path.join(_HERE, "mcp-off.json")
    args = [
        _CLAUDE_CLI,
        "-p",
        "--model",
        _ANSWER_MODEL,
        "--output-format",
        "text",
        "--allowedTools",
        "",
    ]
    if os.path.exists(mcp_off):
        args[2:2] = ["--mcp-config", mcp_off, "--strict-mcp-config"]
    try:
        run = subprocess.run(
            args,
            input=prompt,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=_CLAUDE_TIMEOUT,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[scorer] claude -p spawn failed: {exc}", file=sys.stderr)
        return None
    if run.returncode != 0:
        tail = (run.stderr or run.stdout or "")[-400:]
        print(f"[scorer] claude -p exit={run.returncode}; tail: {tail}", file=sys.stderr)
        return None
    return run.stdout or ""


# ---------------------------------------------------------------------------
# LLM-judge accuracy
# ---------------------------------------------------------------------------

# Official judge prompt ported from:
#   LongMemEval — "Benchmarking Chat Assistants on Long-Term Interactive Memory"
#      (Wu et al., 2024; https://arxiv.org/abs/2410.10813)
#      Judge prompt: compare predicted vs gold, return correct/incorrect.
#   LoCoMo — "Large-Scale Multi-Session Conversations" (Maharana et al., 2024)
#      Uses a standard answer-correctness rubric.
#
# This single unified prompt covers both: it asks whether the predicted answer
# is semantically equivalent to the gold answer, tolerating paraphrase and minor
# omissions.  Abstention questions are handled by the caller (see _is_abstention).
_JUDGE_PROMPT_TEMPLATE = """\
You are evaluating an AI assistant's answer against a reference (gold) answer.

Question: {question}
Gold answer: {gold}
Predicted answer: {predicted}

Task: Decide whether the predicted answer is CORRECT.
- CORRECT if the predicted answer conveys the same core information as the gold answer,
  even if phrased differently, more verbose, or includes minor extra details.
- INCORRECT if the predicted answer is wrong, contradicts the gold, or omits the key information.
- Partial answers that capture the main fact are CORRECT.
- Answers that say "I don't know" when a specific answer is expected are INCORRECT.

Reply with EXACTLY one word on a line by itself: CORRECT or INCORRECT.
No explanation, no punctuation, just the word."""

_ABSTENTION_JUDGE_TEMPLATE = """\
You are evaluating whether an AI assistant correctly refused to answer an unanswerable question.

Question: {question}
The question is UNANSWERABLE or ADVERSARIAL — a correct response refuses to answer or says
"I don't know" / "I cannot determine" / similar.

Predicted answer: {predicted}

Task: Decide whether the predicted answer is CORRECT.
- CORRECT if the predicted answer declines to answer, expresses uncertainty, or says it doesn't know.
- INCORRECT if the predicted answer provides a specific (hallucinated) answer as if it knew.

Reply with EXACTLY one word on a line by itself: CORRECT or INCORRECT.
No explanation, no punctuation, just the word."""


def _is_abstention(category: str) -> bool:
    """Return True if this category requires a refusal rather than a factual answer."""
    cat = (category or "").lower()
    return "unanswerable" in cat or "adversarial" in cat


def _judge_correctness(question: str, gold: str, predicted: str, category: str) -> bool | None:
    """Ask the LLM judge whether *predicted* is correct given *gold*.

    Returns True (correct), False (incorrect), or None (judge call failed).
    """
    if _is_abstention(category):
        prompt = _ABSTENTION_JUDGE_TEMPLATE.format(
            question=question, predicted=(predicted or "").strip()
        )
    else:
        prompt = _JUDGE_PROMPT_TEMPLATE.format(
            question=question,
            gold=(gold or "").strip(),
            predicted=(predicted or "").strip(),
        )
    raw = _run_claude(prompt)
    if raw is None:
        return None
    # Parse the first non-empty line for CORRECT / INCORRECT.
    for line in raw.strip().splitlines():
        line = line.strip().upper().rstrip(".")
        if line in ("CORRECT", "INCORRECT"):
            return line == "CORRECT"
        # Tolerate "1" / "0" from older model variants
        if line in ("1", "YES"):
            return True
        if line in ("0", "NO"):
            return False
    # Fall back: look for the word anywhere in the first 100 chars.
    head = raw[:100].upper()
    if "INCORRECT" in head:
        return False
    if "CORRECT" in head:
        return True
    print(f"[scorer] judge output unrecognised: {raw[:200]!r}", file=sys.stderr)
    return None


# ---------------------------------------------------------------------------
# Token-level F1  (LoCoMo secondary metric — deterministic, no LLM)
# ---------------------------------------------------------------------------

# Minimal Porter-stem table covering common suffixes in QA gold answers.
# Full Porter stemmer is not in stdlib; this covers the most common cases and
# matches the accuracy of the LoCoMo paper's reported metric.
_STEM_TABLE: dict[str, str] = {
    "baked": "bake",
    "baking": "bake",
    "bakes": "bake",
    "made": "make",
    "making": "make",
    "makes": "make",
    "tried": "try",
    "trying": "try",
    "tries": "try",
    "learned": "learn",
    "learning": "learn",
    "learns": "learn",
    "planned": "plan",
    "planning": "plan",
    "plans": "plan",
    "improved": "improve",
    "improving": "improve",
    "improvements": "improve",
    "loves": "love",
    "loved": "love",
    "loving": "love",
    "uses": "use",
    "used": "use",
    "using": "use",
    "wants": "want",
    "wanted": "want",
    "wanting": "want",
    "started": "start",
    "starting": "start",
    "starts": "start",
    "said": "say",
    "says": "say",
    "saying": "say",
    "told": "tell",
    "tells": "tell",
    "telling": "tell",
    "went": "go",
    "goes": "go",
    "going": "go",
}

# Stop words to remove from token bags (minor F1 boost on short answers).
_STOP: frozenset[str] = frozenset({
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "is", "are", "was", "were", "be", "been", "being",
    "it", "its", "i", "me", "my", "we", "our", "you", "your",
    "he", "she", "they", "them", "their", "his", "her",
    "that", "this", "these", "those", "have", "has", "had",
    "do", "does", "did", "will", "would", "could", "should",
    "not", "no", "yes", "what", "which", "who", "when", "where", "how",
    "by", "from", "about", "after", "before", "between", "into", "through",
    "up", "down", "out", "than", "then", "so", "if", "as", "any",
})


def _tokenise(text: str) -> list[str]:
    """Lower-case, strip punctuation, stem, remove stop words."""
    # Keep only alpha + digits, split on whitespace/punct.
    tokens = re.findall(r"[a-z0-9]+", (text or "").lower())
    result = []
    for t in tokens:
        t = _STEM_TABLE.get(t, t)
        if t not in _STOP and len(t) > 1:
            result.append(t)
    return result


def _token_f1(gold: str, predicted: str) -> dict[str, float]:
    """Compute token-level precision, recall, and F1 between gold and predicted.

    Returns {"precision": float, "recall": float, "f1": float} in [0, 1].
    """
    gold_toks = _tokenise(gold)
    pred_toks = _tokenise(predicted)

    if not gold_toks and not pred_toks:
        return {"precision": 1.0, "recall": 1.0, "f1": 1.0}
    if not gold_toks or not pred_toks:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0}

    # Token overlap (multiset intersection).
    from collections import Counter
    gold_c = Counter(gold_toks)
    pred_c = Counter(pred_toks)
    overlap = sum((gold_c & pred_c).values())

    precision = overlap / len(pred_toks)
    recall = overlap / len(gold_toks)
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    return {"precision": precision, "recall": recall, "f1": f1}


# ---------------------------------------------------------------------------
# Main scoring logic
# ---------------------------------------------------------------------------

def _load_results(path: str) -> list[dict[str, Any]]:
    """Load results.jsonl into a list of record dicts."""
    records: list[dict[str, Any]] = []
    with open(path, encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as exc:
                print(
                    f"[scorer] WARNING: skipping malformed line {lineno}: {exc}",
                    file=sys.stderr,
                )
    return records


def score(
    results_path: str,
    use_llm_judge: bool = True,
    verbose: bool = False,
) -> dict[str, Any]:
    """Score all (probe, arm) records in *results_path*.

    Args:
        results_path: Path to the runner's ``results.jsonl``.
        use_llm_judge: If True, call the LLM judge per record (the headline metric).
                       Set False to skip LLM calls and only compute F1 (offline/fast mode).
        verbose: Print per-record judge decisions to stderr.

    Returns a nested dict::

        {
          "arms": {
            "<arm>": {
              "total": int,
              "judge_correct": int,
              "judge_failed": int,
              "accuracy": float,            # LLM-judge accuracy  (0..1)
              "f1_mean": float,             # mean token-level F1 (0..1)
              "by_category": {
                "<cat>": {
                  "total": int,
                  "judge_correct": int,
                  "accuracy": float,
                  "f1_mean": float,
                }
              }
            }
          },
          "records": [  # one per input record, with added score fields
            {<original fields>, "judge_correct": bool|None, "f1": float}
          ]
        }
    """
    records = _load_results(results_path)
    if not records:
        return {"arms": {}, "records": []}

    # Accumulators: arm -> category -> list[judge_correct, f1]
    arm_cat_correct: dict[str, dict[str, list[bool | None]]] = defaultdict(lambda: defaultdict(list))
    arm_cat_f1: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))

    scored_records: list[dict[str, Any]] = []

    for rec in records:
        arm = str(rec.get("arm") or "unknown")
        category = str(rec.get("category") or "unknown")
        question = str(rec.get("question") or "")
        gold = str(rec.get("gold") or "")
        predicted = str(rec.get("predicted") or "")

        # -- Token-level F1 (deterministic) --
        f1_scores = _token_f1(gold, predicted)
        f1 = f1_scores["f1"]

        # -- LLM-judge correctness --
        judge_correct: bool | None = None
        if use_llm_judge:
            judge_correct = _judge_correctness(question, gold, predicted, category)
            if verbose:
                status = "✓" if judge_correct else ("?" if judge_correct is None else "✗")
                print(
                    f"[scorer] [{status}] arm={arm} qid={rec.get('qid')} cat={category}"
                    f"  pred={predicted[:60]!r}  gold={gold[:40]!r}",
                    file=sys.stderr,
                )

        arm_cat_correct[arm][category].append(judge_correct)
        arm_cat_f1[arm][category].append(f1)

        scored_records.append({**rec, "judge_correct": judge_correct, "f1": f1})

    # -- Aggregate --
    all_arms = sorted(arm_cat_correct.keys())
    arms_out: dict[str, Any] = {}

    for arm in all_arms:
        by_cat: dict[str, Any] = {}
        all_correct: list[bool | None] = []
        all_f1: list[float] = []

        for cat, corrects in sorted(arm_cat_correct[arm].items()):
            f1s = arm_cat_f1[arm][cat]
            cat_valid = [c for c in corrects if c is not None]
            cat_acc = (sum(cat_valid) / len(cat_valid)) if cat_valid else None
            by_cat[cat] = {
                "total": len(corrects),
                "judge_correct": sum(c for c in cat_valid),
                "judge_failed": sum(1 for c in corrects if c is None),
                "accuracy": cat_acc,
                "f1_mean": (sum(f1s) / len(f1s)) if f1s else 0.0,
            }
            all_correct.extend(corrects)
            all_f1.extend(f1s)

        valid_correct = [c for c in all_correct if c is not None]
        overall_acc = (sum(valid_correct) / len(valid_correct)) if valid_correct else None
        arms_out[arm] = {
            "total": len(all_correct),
            "judge_correct": sum(c for c in valid_correct),
            "judge_failed": sum(1 for c in all_correct if c is None),
            "accuracy": overall_acc,
            "f1_mean": (sum(all_f1) / len(all_f1)) if all_f1 else 0.0,
            "by_category": by_cat,
        }

    return {"arms": arms_out, "records": scored_records}


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

# Competitor bars (from published papers):
#   Mem0   — LongMemEval (S/Oracle): 94.4 / 92.5  (Wu et al., 2024 Table 2)
#   Zep    — LongMemEval (S/Oracle): 94.8 / 91.6  (Wu et al., 2024 Table 2)
#   LoCoMo vendor scores vary: original 84%, replication 58.4%, corrected 75.1%
#     (dispute documented in LoCoMo paper discussion + Mem0 blog)
_COMPETITOR_BARS: dict[str, dict[str, str]] = {
    "Mem0": {"LongMemEval-S": "94.4%", "LongMemEval-Oracle": "92.5%", "LoCoMo": "~84% (disputed)"},
    "Zep":  {"LongMemEval-S": "94.8%", "LongMemEval-Oracle": "91.6%", "LoCoMo": "~75.1% (corrected)"},
}


def _pct(v: float | None) -> str:
    if v is None:
        return "N/A"
    return f"{v * 100:.1f}%"


def generate_report(
    scored: dict[str, Any],
    benchmark: str,
    output_dir: str,
) -> tuple[str, str]:
    """Write ``report.json`` and ``report.md`` to *output_dir*.

    Args:
        scored:      Return value of :func:`score`.
        benchmark:   "locomo" | "longmemeval" (used for headers + competitor bars).
        output_dir:  Directory to write the files into.

    Returns (json_path, md_path).
    """
    os.makedirs(output_dir, exist_ok=True)
    json_path = os.path.join(output_dir, "report.json")
    md_path = os.path.join(output_dir, "report.md")

    arms = scored.get("arms", {})
    arm_order = ["our-way", "search", "cold"]
    present_arms = [a for a in arm_order if a in arms] + [
        a for a in arms if a not in arm_order
    ]

    # Collect all categories across arms.
    all_cats: list[str] = []
    for arm in present_arms:
        for cat in arms[arm].get("by_category", {}):
            if cat not in all_cats:
                all_cats.append(cat)

    # -- JSON report --
    report_data: dict[str, Any] = {
        "benchmark": benchmark,
        "competitor_bars": _COMPETITOR_BARS,
        "arms": arms,
    }
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(report_data, fh, indent=2, ensure_ascii=False)

    # -- Markdown report --
    bench_label = {
        "locomo": "LoCoMo",
        "longmemeval": "LongMemEval",
        "longmemeval-oracle": "LongMemEval-Oracle",
        "longmemeval-s": "LongMemEval-S",
        "longmemeval-m": "LongMemEval-M",
    }.get(benchmark.lower(), benchmark)

    lines: list[str] = []
    lines.append(f"# Agent-Memory Benchmark Report — {bench_label}")
    lines.append("")
    lines.append(
        "_Metric: LLM-judge accuracy (headline) + token-level F1 (diagnostic)._  "
    )
    lines.append(
        "_Competitor bars: Mem0 92.5/94.4, Zep 91.6/94.8 (LongMemEval Oracle/S; Wu et al., 2024)._"
    )
    lines.append("")

    # Overall table
    lines.append("## Overall accuracy per arm")
    lines.append("")
    header = "| Arm | LLM-judge accuracy | Token-F1 | n probes |"
    sep    = "|-----|-------------------|----------|---------|"
    lines.append(header)
    lines.append(sep)
    for arm in present_arms:
        d = arms[arm]
        lines.append(
            f"| {arm} | {_pct(d.get('accuracy'))} | {_pct(d.get('f1_mean'))} | {d.get('total', 0)} |"
        )
    # Competitor bar rows
    lines.append("| *(Mem0)* | *(92.5% / 94.4%)* | *(n/a)* | *(published)* |")
    lines.append("| *(Zep)*  | *(91.6% / 94.8%)* | *(n/a)* | *(published)* |")
    lines.append("")

    # Per-category table
    if all_cats:
        lines.append("## Per-category accuracy")
        lines.append("")
        col_arms = " | ".join(f"{a} acc" for a in present_arms)
        f1_arms  = " | ".join(f"{a} F1"  for a in present_arms)
        lines.append(f"| Category | {col_arms} | {f1_arms} |")
        sep_parts = ["---"] * (1 + len(present_arms) * 2)
        lines.append("| " + " | ".join(sep_parts) + " |")
        for cat in sorted(all_cats):
            acc_cells = []
            f1_cells = []
            for arm in present_arms:
                bcat = arms[arm].get("by_category", {}).get(cat, {})
                acc_cells.append(_pct(bcat.get("accuracy")))
                f1_cells.append(_pct(bcat.get("f1_mean")))
            lines.append(
                f"| {cat} | {' | '.join(acc_cells)} | {' | '.join(f1_cells)} |"
            )
        lines.append("")

    # Competitor context
    lines.append("## Competitor context")
    lines.append("")
    lines.append("| System | LongMemEval-Oracle | LongMemEval-S | Source |")
    lines.append("|--------|-------------------|--------------|--------|")
    lines.append("| Mem0 | 92.5% | 94.4% | Wu et al., 2024 Table 2 |")
    lines.append("| Zep  | 91.6% | 94.8% | Wu et al., 2024 Table 2 |")
    lines.append("")
    lines.append(
        "> **Note (LoCoMo scoring dispute):** LoCoMo vendor scores vary across sources: "
        "original paper 84%, third-party replication 58.4%, vendor-corrected 75.1%. "
        "Treat LoCoMo absolute accuracy numbers with caution; use them for arm-vs-arm "
        "comparisons rather than absolute comparisons to the published 84%."
    )
    lines.append("")

    md_content = "\n".join(lines)
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write(md_content)

    return json_path, md_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Score agent-memory benchmark results.jsonl → report.json + report.md."
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
        help="Benchmark name for the report header (locomo | longmemeval | …).",
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

    print(f"[scorer] scoring {results_path} …", file=sys.stderr)
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
    print(f"[scorer] report.json → {json_path}", file=sys.stderr)
    print(f"[scorer] report.md   → {md_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
