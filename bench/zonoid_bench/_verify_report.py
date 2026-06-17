"""Verification script for bench/zonoid_bench/report.py.

Scores a small synthetic results.jsonl across three arms (our-way / search / cold)
with known gold+predicted values, then checks:
  1. Token-level F1 computes correctly on a deterministic example.
  2. Pass/fail aggregation works on coding-bench records.
  3. render_report() produces report.md and report.json without error.
  4. scorecard_section() returns a non-empty Markdown string.

Does NOT call the LLM judge (no claude -p required for CI).
Prints PASS or FAIL + details.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile

# Make sure the package root is on sys.path.
_HERE = os.path.dirname(os.path.abspath(__file__))
_BENCH = os.path.dirname(_HERE)
_BENCH_ROOT = os.path.dirname(_BENCH)
for p in (_HERE, _BENCH, _BENCH_ROOT):
    if p not in sys.path:
        sys.path.insert(0, p)

from zonoid_bench.report import (
    load_results,
    render_report,
    score,
    scorecard_section,
    token_f1,
    write_results,
)

# ---------------------------------------------------------------------------
# Synthetic dataset
# ---------------------------------------------------------------------------

RECORDS = [
    # our-way arm — factual categories
    {"arm": "our-way", "qid": "q1", "category": "factual",
     "question": "What is the capital of France?",
     "gold": "Paris", "predicted": "Paris"},
    {"arm": "our-way", "qid": "q2", "category": "factual",
     "question": "What language is Python?",
     "gold": "programming language", "predicted": "a high-level programming language"},
    {"arm": "our-way", "qid": "q3", "category": "temporal",
     "question": "When was Python first released?",
     "gold": "1991", "predicted": "1991"},
    {"arm": "our-way", "qid": "q4", "category": "temporal",
     "question": "When did the French Revolution start?",
     "gold": "1789", "predicted": "1790"},
    # search arm
    {"arm": "search", "qid": "q1", "category": "factual",
     "question": "What is the capital of France?",
     "gold": "Paris", "predicted": "Lyon"},
    {"arm": "search", "qid": "q2", "category": "factual",
     "question": "What language is Python?",
     "gold": "programming language", "predicted": "scripting language"},
    {"arm": "search", "qid": "q3", "category": "temporal",
     "question": "When was Python first released?",
     "gold": "1991", "predicted": "1991"},
    {"arm": "search", "qid": "q4", "category": "temporal",
     "question": "When did the French Revolution start?",
     "gold": "1789", "predicted": "1789"},
    # cold arm — with pass/fail for coding subtest
    {"arm": "cold", "qid": "q1", "category": "factual",
     "question": "What is the capital of France?",
     "gold": "Paris", "predicted": "I don't know"},
    {"arm": "cold", "qid": "q2", "category": "factual",
     "question": "What language is Python?",
     "gold": "programming language", "predicted": ""},
    {"arm": "cold", "qid": "q3", "category": "coding",
     "question": "Write a function that adds two numbers.",
     "gold": "def add(a, b): return a + b", "predicted": "def add(a, b):\n    return a + b",
     "correct": True},
    {"arm": "cold", "qid": "q4", "category": "coding",
     "question": "Write a function to reverse a string.",
     "gold": "def rev(s): return s[::-1]", "predicted": "def rev(s): return list(s)",
     "correct": False},
    # our-way arm — coding too
    {"arm": "our-way", "qid": "q5", "category": "coding",
     "question": "Write a function that adds two numbers.",
     "gold": "def add(a, b): return a + b", "predicted": "def add(a, b): return a + b",
     "correct": True},
    {"arm": "our-way", "qid": "q6", "category": "coding",
     "question": "Write a function to reverse a string.",
     "gold": "def rev(s): return s[::-1]", "predicted": "def rev(s): return s[::-1]",
     "correct": True},
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

failures: list[str] = []

def check(cond: bool, label: str, detail: str = "") -> None:
    if cond:
        print(f"  OK  {label}")
    else:
        print(f"  FAIL {label}" + (f": {detail}" if detail else ""))
        failures.append(label)


# ---------------------------------------------------------------------------
# Test 1: write_results + load_results round-trip
# ---------------------------------------------------------------------------

print("\n[1] write_results / load_results round-trip")
with tempfile.TemporaryDirectory() as tmp:
    rpath = os.path.join(tmp, "results.jsonl")
    write_results(RECORDS, rpath)
    loaded = load_results(rpath)
    check(len(loaded) == len(RECORDS), "record count", f"got {len(loaded)}, want {len(RECORDS)}")
    check(loaded[0]["arm"] == RECORDS[0]["arm"], "first record arm")
    check(loaded[-1]["qid"] == RECORDS[-1]["qid"], "last record qid")


# ---------------------------------------------------------------------------
# Test 2: token_f1 on known examples
# ---------------------------------------------------------------------------

print("\n[2] token_f1 deterministic checks")

# Identical strings -> F1 = 1.0.
f = token_f1("Paris", "Paris")
check(abs(f["f1"] - 1.0) < 1e-9, "identical strings -> F1=1.0", str(f["f1"]))

# Completely different -> F1 = 0.0.
f = token_f1("Paris", "Tokyo")
check(abs(f["f1"]) < 1e-9, "no overlap -> F1=0.0", str(f["f1"]))

# Both empty -> F1 = 1.0 (edge case).
f = token_f1("", "")
check(abs(f["f1"] - 1.0) < 1e-9, "both empty -> F1=1.0", str(f["f1"]))

# Partial overlap.
f = token_f1("the quick brown fox", "quick brown dog")
# gold tokens (after stop removal + dedup): quick, brown, fox
# pred tokens: quick, brown, dog
# overlap = 2; precision = 2/3; recall = 2/3; F1 = 2/3
expected_f1 = 2 / 3
check(abs(f["f1"] - expected_f1) < 0.01, f"partial overlap F1~{expected_f1:.2f}", str(f["f1"]))


# ---------------------------------------------------------------------------
# Test 3: score() without LLM judge
# ---------------------------------------------------------------------------

print("\n[3] score() — F1 + pass/fail only (no LLM judge)")

scored = score(RECORDS, use_llm_judge=False, use_f1=True, use_pass_fail=True)
arms = scored["arms"]

check("our-way" in arms, "our-way arm present")
check("search" in arms, "search arm present")
check("cold" in arms, "cold arm present")

# our-way arm: 6 records; accuracy should be None (no LLM judge).
ow = arms["our-way"]
check(ow["accuracy"] is None, "our-way accuracy=None (no LLM judge)")
check(ow["total"] == 6, f"our-way total=6", str(ow["total"]))

# our-way pass_rate: 2 coding records, both correct=True -> 100%.
check(ow["pass_rate"] is not None, "our-way has pass_rate")
if ow["pass_rate"] is not None:
    check(abs(ow["pass_rate"] - 1.0) < 1e-9, "our-way pass_rate=1.0", str(ow["pass_rate"]))

# cold arm: 4 records, 2 coding (1 pass, 1 fail) -> pass_rate = 0.5.
cold = arms["cold"]
check(cold["pass_rate"] is not None, "cold has pass_rate")
if cold["pass_rate"] is not None:
    check(abs(cold["pass_rate"] - 0.5) < 1e-9, "cold pass_rate=0.5", str(cold["pass_rate"]))

# our-way f1_mean: Paris/Paris = 1.0, programming language ~ 0.8+, 1991/1991 = 1.0,
# 1789/1790 = 0.0, code/code ~1.0, code/code ~1.0 — should be high.
check(ow["f1_mean"] is not None and ow["f1_mean"] > 0.5, "our-way f1_mean > 0.5", str(ow["f1_mean"]))

# search arm: f1_mean should be lower than our-way (Paris/Lyon = 0, etc.)
search = arms["search"]
if ow["f1_mean"] is not None and search["f1_mean"] is not None:
    check(ow["f1_mean"] >= search["f1_mean"], "our-way f1 >= search f1",
          f"our-way={ow['f1_mean']:.3f} search={search['f1_mean']:.3f}")

# Per-category: our-way should have "coding" category.
by_cat = ow.get("by_category", {})
check("coding" in by_cat, "our-way has coding category")
if "coding" in by_cat:
    check(by_cat["coding"]["pass_rate"] == 1.0, "our-way coding pass_rate=1.0",
          str(by_cat["coding"].get("pass_rate")))

# scored records should have f1 field.
check(all("f1" in r for r in scored["records"]), "all records have f1 field")
check(all("pass" in r for r in scored["records"]), "all records have pass field")


# ---------------------------------------------------------------------------
# Test 4: render_report() produces report.md and report.json
# ---------------------------------------------------------------------------

print("\n[4] render_report()")

competitor_bar = {
    "Mem0": {
        "LongMemEval-S": "94.4%",
        "LongMemEval-Oracle": "92.5%",
        "source": "Wu et al., 2024 Table 2",
    },
    "Zep": {
        "LongMemEval-S": "94.8%",
        "LongMemEval-Oracle": "91.6%",
        "source": "Wu et al., 2024 Table 2",
    },
}

with tempfile.TemporaryDirectory() as tmp:
    path_json = os.path.join(tmp, "report.json")
    path_md = os.path.join(tmp, "report.md")
    returned_json, returned_md = render_report(
        scored,
        path_md,
        path_json,
        title="Verify Report",
        competitor_bar=competitor_bar,
    )

    check(os.path.exists(path_json), "report.json written")
    check(os.path.exists(path_md), "report.md written")
    check(os.path.abspath(path_json) == returned_json, "returned json path matches")
    check(os.path.abspath(path_md) == returned_md, "returned md path matches")

    # Validate JSON is parseable and has expected keys.
    with open(path_json, encoding="utf-8") as fh:
        rdata = json.load(fh)
    check("arms" in rdata, "report.json has arms key")
    check("competitor_bar" in rdata, "report.json has competitor_bar key")
    check("our-way" in rdata["arms"], "report.json arms has our-way")

    # Validate Markdown has expected sections.
    with open(path_md, encoding="utf-8") as fh:
        md = fh.read()
    check("# Verify Report" in md, "report.md has title")
    check("## Overall per arm" in md, "report.md has overall section")
    check("our-way" in md, "report.md mentions our-way arm")
    check("Mem0" in md, "report.md mentions competitor Mem0")
    check("## Per-category" in md, "report.md has per-category section")
    check("## Scorecard" in md, "report.md has scorecard section")
    print("  report.md preview (first 600 chars):")
    for line in md[:600].splitlines():
        print(f"    {line}")


# ---------------------------------------------------------------------------
# Test 5: scorecard_section() standalone
# ---------------------------------------------------------------------------

print("\n[5] scorecard_section()")

section = scorecard_section(
    scored,
    competitor_bar=competitor_bar,
    axis_label="LLM-judge accuracy",
)
check(isinstance(section, str) and len(section) > 50, "returns non-trivial string")
check("## Scorecard" in section, "has Scorecard header")
check("Internal arms" in section, "has Internal arms section")
check("Competitor bars" in section, "has Competitor bars section")
check("Note:" in section, "has disclaimer note")
print("  scorecard_section preview (first 400 chars):")
for line in section[:400].splitlines():
    print(f"    {line}")


# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

print()
if failures:
    print(f"FAIL — {len(failures)} check(s) failed: {failures}")
    sys.exit(1)
else:
    print("PASS — all checks passed")
    sys.exit(0)
