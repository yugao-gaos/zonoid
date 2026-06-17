"""bench/zonoid_bench/report.py — Zonoid Bench SDK: results writer + scorer + report renderer.

Generalises bench/agent-memory/scorer.py into a reusable scaffold that any bench in the SDK
can import.  All code is stdlib-only; runs on embeddable Python 3.12.

Public surface
--------------
write_results(records, path)
    Append or write a list of result dicts to a .jsonl file.

score(records, *, use_llm_judge, use_f1, use_pass_fail, verbose)  ->  ScoreResult
    Run the configured score hooks over a list of records and return a nested dict with
    per-arm + per-category aggregates.

    Score hooks:
      * LLM-judge accuracy   — one ``claude -p`` call per record (headline metric, comparable
                               to Mem0/Zep published bars); delegates to zonoid_bench.judge.claude_p.
      * Token-level F1       — Porter-stem + stop-word normalisation, multiset token overlap.
                               Deterministic; no LLM calls.  Secondary/diagnostic metric.
      * Pass/fail            — for coding benches where a record carries its own correctness bool
                               (field ``correct: true|false``).  Skipped if the field is absent.

render_report(scores, path_md, path_json, *, title, competitor_bar)
    Write report.json (machine-readable) + report.md (human-readable) from a ScoreResult.
    Optional ``competitor_bar`` dict is included in both outputs and surfaced in report.md.

scorecard_section(scores, *, competitor_bar, axis_label, disclaimer)  ->  str
    Return a standalone Markdown block presenting arms vs an optional competitor bar without
    overclaiming.  Uses the SOUND contrast-axis framing: internal arms are compared on a
    named axis; the competitor bar is shown in a separate table with explicit provenance.
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter, defaultdict
from typing import Any

# ---------------------------------------------------------------------------
# Type alias for a score result (what score() returns).
# ---------------------------------------------------------------------------

ScoreResult = dict[str, Any]
"""
{
    "arms": {
        "<arm>": {
            "total": int,
            "judge_correct": int,
            "judge_failed": int,
            "accuracy": float | None,       # LLM-judge accuracy (0..1)
            "f1_mean": float | None,        # mean token-level F1 (0..1)
            "pass_rate": float | None,      # pass/fail rate (coding benches)
            "by_category": {
                "<cat>": {
                    "total": int,
                    "judge_correct": int,
                    "judge_failed": int,
                    "accuracy": float | None,
                    "f1_mean": float | None,
                    "pass_rate": float | None,
                }
            }
        }
    },
    "records": [ {<original fields>, "judge_correct": bool|None, "f1": float, "pass": bool|None} ]
}
"""

# ---------------------------------------------------------------------------
# write_results
# ---------------------------------------------------------------------------

def write_results(records: list[dict[str, Any]], path: str, *, append: bool = False) -> None:
    """Write *records* to *path* as newline-delimited JSON.

    Args:
        records: List of result dicts (one per arm per probe / per task).
        path:    Destination .jsonl file.  Parent dirs are created if absent.
        append:  If True, open in append mode; else overwrite.
    """
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    mode = "a" if append else "w"
    with open(path, mode, encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------------------
# Token-level F1  (ported from agent-memory/scorer.py — deterministic, no LLM)
# ---------------------------------------------------------------------------

# Minimal Porter-stem table covering common suffixes in QA gold answers.
_STEM_TABLE: dict[str, str] = {
    "baked": "bake", "baking": "bake", "bakes": "bake",
    "made": "make", "making": "make", "makes": "make",
    "tried": "try", "trying": "try", "tries": "try",
    "learned": "learn", "learning": "learn", "learns": "learn",
    "planned": "plan", "planning": "plan", "plans": "plan",
    "improved": "improve", "improving": "improve", "improvements": "improve",
    "loves": "love", "loved": "love", "loving": "love",
    "uses": "use", "used": "use", "using": "use",
    "wants": "want", "wanted": "want", "wanting": "want",
    "started": "start", "starting": "start", "starts": "start",
    "said": "say", "says": "say", "saying": "say",
    "told": "tell", "tells": "tell", "telling": "tell",
    "went": "go", "goes": "go", "going": "go",
    "runs": "run", "ran": "run", "running": "run",
    "writes": "write", "wrote": "write", "writing": "write",
    "reads": "read", "reading": "read",
    "builds": "build", "built": "build", "building": "build",
    "tests": "test", "tested": "test", "testing": "test",
    "fixes": "fix", "fixed": "fix", "fixing": "fix",
    "adds": "add", "added": "add", "adding": "add",
    "removes": "remove", "removed": "remove", "removing": "remove",
    "returns": "return", "returned": "return", "returning": "return",
    "calls": "call", "called": "call", "calling": "call",
    "creates": "create", "created": "create", "creating": "create",
    "updates": "update", "updated": "update", "updating": "update",
    "sets": "set", "setting": "set",
    "gets": "get", "getting": "get", "got": "get",
    "shows": "show", "showed": "show", "shown": "show", "showing": "show",
    "finds": "find", "found": "find", "finding": "find",
    "checks": "check", "checked": "check", "checking": "check",
    "loads": "load", "loaded": "load", "loading": "load",
    "sends": "send", "sent": "send", "sending": "send",
}

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
    tokens = re.findall(r"[a-z0-9]+", (text or "").lower())
    result: list[str] = []
    for t in tokens:
        t = _STEM_TABLE.get(t, t)
        if t not in _STOP and len(t) > 1:
            result.append(t)
    return result


def token_f1(gold: str, predicted: str) -> dict[str, float]:
    """Compute token-level precision, recall, F1 between *gold* and *predicted*.

    Returns {"precision": float, "recall": float, "f1": float} in [0, 1].
    Deterministic; no LLM calls.
    """
    gold_toks = _tokenise(gold)
    pred_toks = _tokenise(predicted)

    if not gold_toks and not pred_toks:
        return {"precision": 1.0, "recall": 1.0, "f1": 1.0}
    if not gold_toks or not pred_toks:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0}

    gold_c = Counter(gold_toks)
    pred_c = Counter(pred_toks)
    overlap = sum((gold_c & pred_c).values())

    precision = overlap / len(pred_toks)
    recall = overlap / len(gold_toks)
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    return {"precision": precision, "recall": recall, "f1": f1}


# ---------------------------------------------------------------------------
# LLM-judge accuracy  (ported from agent-memory/scorer.py, via judge.claude_p)
# ---------------------------------------------------------------------------

# Official judge prompt (LoCoMo / LongMemEval rubric).
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
    cat = (category or "").lower()
    return "unanswerable" in cat or "adversarial" in cat


def judge_correctness(
    question: str,
    gold: str,
    predicted: str,
    category: str = "",
) -> bool | None:
    """Ask the LLM judge (via judge.claude_p) whether *predicted* is correct given *gold*.

    Returns True (correct), False (incorrect), or None (judge call failed / unavailable).

    Delegates to ``zonoid_bench.judge.claude_p``; falls back to None if that import fails
    (e.g. running in a lightweight env without the judge module).
    """
    try:
        from zonoid_bench.judge import claude_p  # noqa: PLC0415
    except ImportError:
        # Graceful degradation: no LLM judge available.
        return None

    if _is_abstention(category):
        prompt = _ABSTENTION_JUDGE_TEMPLATE.format(
            question=question,
            predicted=(predicted or "").strip(),
        )
    else:
        prompt = _JUDGE_PROMPT_TEMPLATE.format(
            question=question,
            gold=(gold or "").strip(),
            predicted=(predicted or "").strip(),
        )

    raw = claude_p(prompt)
    if raw is None:
        return None

    for line in raw.strip().splitlines():
        line = line.strip().upper().rstrip(".")
        if line in ("CORRECT", "INCORRECT"):
            return line == "CORRECT"
        if line in ("1", "YES"):
            return True
        if line in ("0", "NO"):
            return False

    head = raw[:100].upper()
    if "INCORRECT" in head:
        return False
    if "CORRECT" in head:
        return True

    print(f"[zonoid_bench.report] judge output unrecognised: {raw[:200]!r}", file=sys.stderr)
    return None


# ---------------------------------------------------------------------------
# score()  — main entry point
# ---------------------------------------------------------------------------

def score(
    records: list[dict[str, Any]],
    *,
    use_llm_judge: bool = False,
    use_f1: bool = True,
    use_pass_fail: bool = True,
    verbose: bool = False,
) -> ScoreResult:
    """Score a list of result records.

    Each record must have at minimum:
        arm (str), category (str), question (str), gold (str), predicted (str)
    Optionally:
        correct (bool) — for coding/pass-fail benches.
        qid (str)     — for verbose logging.

    Args:
        records:       Records from ``write_results`` / loaded from results.jsonl.
        use_llm_judge: If True, call the LLM judge per record (headline metric, slow).
                       Requires ``zonoid_bench.judge.claude_p`` to be importable.
        use_f1:        If True, compute token-level F1 (deterministic, fast).
        use_pass_fail: If True, collect the ``correct`` field from records that carry it
                       and aggregate a pass rate per arm.
        verbose:       Print per-record decisions to stderr.

    Returns a ScoreResult (see module docstring for the full shape).
    """
    if not records:
        return {"arms": {}, "records": []}

    # Accumulators keyed by (arm, category).
    arm_cat_correct: dict[str, dict[str, list[bool | None]]] = defaultdict(lambda: defaultdict(list))
    arm_cat_f1: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    arm_cat_pass: dict[str, dict[str, list[bool | None]]] = defaultdict(lambda: defaultdict(list))

    scored_records: list[dict[str, Any]] = []

    for rec in records:
        arm = str(rec.get("arm") or "unknown")
        category = str(rec.get("category") or "unknown")
        question = str(rec.get("question") or "")
        gold = str(rec.get("gold") or "")
        predicted = str(rec.get("predicted") or "")

        # --- Token-level F1 ---
        f1_val: float | None = None
        if use_f1:
            f1_scores = token_f1(gold, predicted)
            f1_val = f1_scores["f1"]
            arm_cat_f1[arm][category].append(f1_val)

        # --- LLM-judge accuracy ---
        judge_correct: bool | None = None
        if use_llm_judge:
            judge_correct = judge_correctness(question, gold, predicted, category)
            if verbose:
                status = "OK" if judge_correct else ("??" if judge_correct is None else "FAIL")
                print(
                    f"[scorer] [{status}] arm={arm} qid={rec.get('qid')} cat={category}"
                    f"  pred={predicted[:60]!r}  gold={gold[:40]!r}",
                    file=sys.stderr,
                )

        arm_cat_correct[arm][category].append(judge_correct)

        # --- Pass/fail (coding benches) ---
        pass_val: bool | None = None
        if use_pass_fail and "correct" in rec:
            raw_correct = rec["correct"]
            if isinstance(raw_correct, bool):
                pass_val = raw_correct
            elif isinstance(raw_correct, int):
                pass_val = bool(raw_correct)
            elif isinstance(raw_correct, str):
                pass_val = raw_correct.lower() in ("true", "1", "yes", "pass")
        arm_cat_pass[arm][category].append(pass_val)

        scored_records.append(
            {**rec, "judge_correct": judge_correct, "f1": f1_val, "pass": pass_val}
        )

    # --- Aggregate ---
    all_arms = sorted(set(arm_cat_correct.keys()) | set(arm_cat_f1.keys()) | set(arm_cat_pass.keys()))
    arms_out: dict[str, Any] = {}

    for arm in all_arms:
        by_cat: dict[str, Any] = {}
        all_correct: list[bool | None] = []
        all_f1: list[float] = []
        all_pass: list[bool | None] = []

        all_cats = set(arm_cat_correct[arm].keys()) | set(arm_cat_f1[arm].keys()) | set(arm_cat_pass[arm].keys())
        for cat in sorted(all_cats):
            corrects = arm_cat_correct[arm][cat]
            f1s = arm_cat_f1[arm][cat]
            passes = arm_cat_pass[arm][cat]

            cat_valid_j = [c for c in corrects if c is not None]
            cat_acc = (sum(cat_valid_j) / len(cat_valid_j)) if cat_valid_j else None

            cat_valid_p = [p for p in passes if p is not None]
            cat_pass_rate = (sum(cat_valid_p) / len(cat_valid_p)) if cat_valid_p else None

            by_cat[cat] = {
                "total": max(len(corrects), len(f1s), len(passes)),
                "judge_correct": sum(c for c in cat_valid_j),
                "judge_failed": sum(1 for c in corrects if c is None),
                "accuracy": cat_acc,
                "f1_mean": (sum(f1s) / len(f1s)) if f1s else None,
                "pass_rate": cat_pass_rate,
            }
            all_correct.extend(corrects)
            all_f1.extend(f1s)
            all_pass.extend(passes)

        valid_correct = [c for c in all_correct if c is not None]
        overall_acc = (sum(valid_correct) / len(valid_correct)) if valid_correct else None

        valid_pass = [p for p in all_pass if p is not None]
        overall_pass_rate = (sum(valid_pass) / len(valid_pass)) if valid_pass else None

        arms_out[arm] = {
            "total": max(len(all_correct), len(all_f1), len(all_pass)),
            "judge_correct": sum(c for c in valid_correct),
            "judge_failed": sum(1 for c in all_correct if c is None),
            "accuracy": overall_acc,
            "f1_mean": (sum(all_f1) / len(all_f1)) if all_f1 else None,
            "pass_rate": overall_pass_rate,
            "by_category": by_cat,
        }

    return {"arms": arms_out, "records": scored_records}


# ---------------------------------------------------------------------------
# score_file()  — convenience wrapper: load .jsonl then score
# ---------------------------------------------------------------------------

def score_file(
    path: str,
    *,
    use_llm_judge: bool = False,
    use_f1: bool = True,
    use_pass_fail: bool = True,
    verbose: bool = False,
) -> ScoreResult:
    """Load *path* (.jsonl) and call :func:`score`.

    Convenience wrapper; equivalent to::

        records = load_results(path)
        return score(records, ...)
    """
    return score(
        load_results(path),
        use_llm_judge=use_llm_judge,
        use_f1=use_f1,
        use_pass_fail=use_pass_fail,
        verbose=verbose,
    )


def load_results(path: str) -> list[dict[str, Any]]:
    """Load a results.jsonl file into a list of record dicts."""
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
                    f"[zonoid_bench.report] WARNING: skipping malformed line {lineno}: {exc}",
                    file=sys.stderr,
                )
    return records


# ---------------------------------------------------------------------------
# render_report()
# ---------------------------------------------------------------------------

_ARM_ORDER = ["our-way", "search", "cold"]


def _pct(v: float | None) -> str:
    if v is None:
        return "N/A"
    return f"{v * 100:.1f}%"


def render_report(
    scores: ScoreResult,
    path_md: str,
    path_json: str,
    *,
    title: str = "Zonoid Bench Report",
    competitor_bar: dict[str, Any] | None = None,
) -> tuple[str, str]:
    """Write report.json (machine) + report.md (human) from a :func:`score` result.

    Args:
        scores:         Return value of :func:`score` or :func:`score_file`.
        path_md:        Destination path for the Markdown report.
        path_json:      Destination path for the JSON report.
        title:          Report title string used in the Markdown header.
        competitor_bar: Optional dict of competitor system scores to include.
                        Shape: ``{"SystemName": {"metric_label": "value_str", ...}, ...}``
                        Example::
                            {
                                "Mem0": {"LongMemEval-S": "94.4%", "LongMemEval-Oracle": "92.5%"},
                                "Zep":  {"LongMemEval-S": "94.8%", "LongMemEval-Oracle": "91.6%"},
                            }

    Returns:
        (json_path, md_path) as absolute paths.
    """
    for p in (path_md, path_json):
        os.makedirs(os.path.dirname(os.path.abspath(p)) or ".", exist_ok=True)

    arms = scores.get("arms", {})
    # Canonical arm order: our-way, search, cold; then any extra arms alphabetically.
    present_arms = [a for a in _ARM_ORDER if a in arms] + sorted(
        a for a in arms if a not in _ARM_ORDER
    )

    # Collect all categories across arms (stable order: first seen per arm).
    all_cats: list[str] = []
    seen_cats: set[str] = set()
    for arm in present_arms:
        for cat in arms[arm].get("by_category", {}):
            if cat not in seen_cats:
                all_cats.append(cat)
                seen_cats.add(cat)

    # -- JSON report --
    report_data: dict[str, Any] = {
        "title": title,
        "arms": arms,
    }
    if competitor_bar:
        report_data["competitor_bar"] = competitor_bar

    with open(path_json, "w", encoding="utf-8") as fh:
        json.dump(report_data, fh, indent=2, ensure_ascii=False)

    # -- Markdown report --
    lines: list[str] = []
    lines.append(f"# {title}")
    lines.append("")
    lines.append(
        "_Metrics: LLM-judge accuracy (headline, comparable to published bars) "
        "+ token-level F1 (diagnostic, deterministic) + pass/fail rate (coding benches)._"
    )
    lines.append("")

    # Overall table.
    lines.append("## Overall per arm")
    lines.append("")

    # Build header columns dynamically based on what's non-None across arms.
    has_acc = any(arms[a].get("accuracy") is not None for a in present_arms)
    has_f1 = any(arms[a].get("f1_mean") is not None for a in present_arms)
    has_pass = any(arms[a].get("pass_rate") is not None for a in present_arms)

    cols = ["Arm"]
    if has_acc:
        cols.append("LLM-judge accuracy")
    if has_f1:
        cols.append("Token-F1")
    if has_pass:
        cols.append("Pass rate")
    cols.append("n probes")

    lines.append("| " + " | ".join(cols) + " |")
    lines.append("| " + " | ".join("---" for _ in cols) + " |")

    for arm in present_arms:
        d = arms[arm]
        row: list[str] = [arm]
        if has_acc:
            row.append(_pct(d.get("accuracy")))
        if has_f1:
            row.append(_pct(d.get("f1_mean")))
        if has_pass:
            row.append(_pct(d.get("pass_rate")))
        row.append(str(d.get("total", 0)))
        lines.append("| " + " | ".join(row) + " |")

    lines.append("")

    # Per-category table.
    if all_cats:
        lines.append("## Per-category breakdown")
        lines.append("")
        cat_cols = ["Category"]
        for arm in present_arms:
            if has_acc:
                cat_cols.append(f"{arm} acc")
            if has_f1:
                cat_cols.append(f"{arm} F1")
            if has_pass:
                cat_cols.append(f"{arm} pass")
        lines.append("| " + " | ".join(cat_cols) + " |")
        lines.append("| " + " | ".join("---" for _ in cat_cols) + " |")
        for cat in sorted(all_cats):
            row = [cat]
            for arm in present_arms:
                bcat = arms[arm].get("by_category", {}).get(cat, {})
                if has_acc:
                    row.append(_pct(bcat.get("accuracy")))
                if has_f1:
                    row.append(_pct(bcat.get("f1_mean")))
                if has_pass:
                    row.append(_pct(bcat.get("pass_rate")))
            lines.append("| " + " | ".join(row) + " |")
        lines.append("")

    # Competitor bar section.
    if competitor_bar:
        lines.append(scorecard_section(scores, competitor_bar=competitor_bar))

    md_content = "\n".join(lines)
    with open(path_md, "w", encoding="utf-8") as fh:
        fh.write(md_content)

    return os.path.abspath(path_json), os.path.abspath(path_md)


# ---------------------------------------------------------------------------
# scorecard_section()  — SOUND contrast-axis framing helper
# ---------------------------------------------------------------------------

def scorecard_section(
    scores: ScoreResult,
    *,
    competitor_bar: dict[str, Any] | None = None,
    axis_label: str = "LLM-judge accuracy",
    disclaimer: str | None = None,
) -> str:
    """Return a Markdown block presenting arm scores vs an optional competitor bar.

    Uses the SOUND contrast-axis framing:
    - Internal arms are compared on a single named axis (``axis_label``).
    - The competitor bar is shown in a SEPARATE table with explicit provenance headers,
      making clear the comparison is against external published numbers.
    - No overclaiming: the section explicitly notes that internal vs competitor comparisons
      are across different benchmarks / evaluation setups unless the user specifies otherwise.

    Args:
        scores:         ScoreResult from :func:`score`.
        competitor_bar: Optional dict of external system scores.
                        Shape: ``{"SystemName": {"metric_label": "value_str", ...}, ...}``
                        Pass None to omit the competitor block.
        axis_label:     Name of the primary comparison axis (default: "LLM-judge accuracy").
        disclaimer:     Optional disclaimer appended to the competitor block.
                        Defaults to a generic note about cross-benchmark comparison caveats.

    Returns a Markdown string (does not write to disk).
    """
    arms = scores.get("arms", {})
    present_arms = [a for a in _ARM_ORDER if a in arms] + sorted(
        a for a in arms if a not in _ARM_ORDER
    )

    lines: list[str] = []
    lines.append("## Scorecard")
    lines.append("")
    lines.append(f"**Contrast axis: {axis_label}**")
    lines.append("")

    # Internal arms table.
    lines.append("### Internal arms")
    lines.append("")
    lines.append(f"| Arm | {axis_label} | n probes |")
    lines.append("| --- | --- | --- |")
    for arm in present_arms:
        d = arms[arm]
        lines.append(
            f"| {arm} | {_pct(d.get('accuracy'))} | {d.get('total', 0)} |"
        )
    lines.append("")

    if competitor_bar:
        if disclaimer is None:
            disclaimer = (
                "> **Note:** competitor bars are from published papers and may be evaluated "
                "on different benchmark subsets, evaluation protocols, or model versions. "
                "Arm-vs-arm comparisons (internal table above) are directly comparable; "
                "internal vs competitor comparisons are cross-setup and should be interpreted "
                "as directional context, not apples-to-apples."
            )

        lines.append("### Competitor bars (published)")
        lines.append("")
        # Collect all metric keys across all systems.
        metric_keys: list[str] = []
        seen: set[str] = set()
        for sys_scores in competitor_bar.values():
            for k in sys_scores:
                if k not in seen:
                    metric_keys.append(k)
                    seen.add(k)

        header = "| System | " + " | ".join(metric_keys) + " | Source |"
        sep = "| --- | " + " | ".join("---" for _ in metric_keys) + " | --- |"
        lines.append(header)
        lines.append(sep)
        for sys_name, sys_scores in competitor_bar.items():
            source = sys_scores.get("source", "published")
            row_vals = [str(sys_scores.get(k, "—")) for k in metric_keys]
            lines.append(
                "| " + sys_name + " | " + " | ".join(row_vals) + f" | {source} |"
            )
        lines.append("")
        lines.append(disclaimer)
        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _cli_main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description=(
            "Score a results.jsonl and render report.json + report.md. "
            "Part of the Zonoid Bench SDK (bench/zonoid_bench/report.py)."
        )
    )
    parser.add_argument(
        "results",
        nargs="?",
        default="results.jsonl",
        help="Path to results.jsonl (default: results.jsonl in cwd).",
    )
    parser.add_argument("--title", default="Zonoid Bench Report", help="Report title.")
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory for report.json + report.md. Defaults to results.jsonl's directory.",
    )
    parser.add_argument(
        "--llm-judge",
        action="store_true",
        help="Enable LLM-judge accuracy (requires claude CLI; slow).",
    )
    parser.add_argument(
        "--no-f1",
        action="store_true",
        help="Disable token-level F1 computation.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print per-record decisions to stderr.",
    )
    args = parser.parse_args(argv)

    results_path = os.path.abspath(args.results)
    if not os.path.exists(results_path):
        print(f"ERROR: results file not found: {results_path}", file=sys.stderr)
        return 2

    output_dir = args.output_dir or os.path.dirname(results_path)
    path_json = os.path.join(output_dir, "report.json")
    path_md = os.path.join(output_dir, "report.md")

    print(f"[report] scoring {results_path} ...", file=sys.stderr)
    scored = score_file(
        results_path,
        use_llm_judge=args.llm_judge,
        use_f1=not args.no_f1,
        verbose=args.verbose,
    )

    arms = scored.get("arms", {})
    for arm, d in sorted(arms.items()):
        parts = [f"arm={arm}", f"n={d.get('total', 0)}"]
        if d.get("accuracy") is not None:
            parts.append(f"accuracy={_pct(d['accuracy'])}")
        if d.get("f1_mean") is not None:
            parts.append(f"f1={_pct(d['f1_mean'])}")
        if d.get("pass_rate") is not None:
            parts.append(f"pass_rate={_pct(d['pass_rate'])}")
        print(f"[report] " + "  ".join(parts), file=sys.stderr)

    render_report(scored, path_md, path_json, title=args.title)
    print(f"[report] report.json -> {path_json}", file=sys.stderr)
    print(f"[report] report.md   -> {path_md}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(_cli_main())
