"""bench/zonoid_bench/run_bench.py — Zonoid Feature Bench multi-trial runner.

Connects to an existing daemon (default http://localhost:8787) whose workspace has already been
populated with the onboard KB, and runs N trials from the KB queue, writing results per-trial so
partial runs can be assembled into a final score later.

This runner does not spawn or prepopulate an isolated daemon by itself. For the canonical isolated
task/container path, start a local bench daemon with ``zonoid_bench.daemon.start(workspace=...)``
and explicitly load a snapshot/onboarding data into that workspace before running ON arms.

Partial-run workflow
--------------------
  # Run 50 trials today
  python bench/zonoid_bench/run_bench.py --trials 50 --out bench-results.jsonl

  # Append 50 more tomorrow
  python bench/zonoid_bench/run_bench.py --trials 50 --out bench-results.jsonl --append

  # Score all accumulated results
  python bench/zonoid_bench/run_bench.py --score-only bench-results.jsonl

  # Rescore with LLM judge
  python bench/zonoid_bench/run_bench.py --score-only bench-results.jsonl --use-llm-judge

Prerequisites
-------------
  The onboard KB must already be loaded into the daemon's selected workspace (batch-inject the
  onboard-queue.json entries via the standard ingest path or load a snapshot) before running this
  bench. The daemon does not start prepopulated.

Flags
-----
  --trials N         Run N trials (default: all questions from the queue).
  --out PATH         Output JSONL file (default: bench-results.jsonl).
  --append           Append to an existing output file instead of overwriting.
  --offset N         Skip the first N questions (resume without --append).
  --score-only PATH  Load PATH, score it, and exit; skip running.
  --questions PATH   Question source JSON (default: bench/onboard/zonoid/onboard-queue.json).
  --daemon URL       Daemon base URL (default: http://localhost:8787).
  --workspace PATH   Live workspace path the daemon is bound to (default: cwd).
  --data-dir PATH    Task-stub drop directory (default: ~/.claude/orchestrator).
  --use-llm-judge    Enable LLM-judge accuracy metric (slower; default: token-F1 only).
  --model MODEL      Answer model for the arms (default: SDK default).
  --category CAT     Filter questions by kind field (default: all).
  --report-dir DIR   Write report.json + report.md here (default: alongside --out).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Optional

_HERE = os.path.dirname(os.path.abspath(__file__))
_BENCH = os.path.dirname(_HERE)
if _BENCH not in sys.path:
    sys.path.insert(0, _BENCH)

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:
        pass

from zonoid_bench.client import ZonoidClient  # noqa: E402
from zonoid_bench import arms as arms_mod     # noqa: E402
from zonoid_bench import report as report_mod  # noqa: E402
from zonoid_bench import judge as judge_mod   # noqa: E402

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

_DEFAULT_DAEMON   = "http://localhost:8787"
_DEFAULT_OUT      = "bench-results.jsonl"
_DEFAULT_QUESTION_SRC = os.path.join(_BENCH, "onboard", "zonoid", "onboard-queue.json")
_DEFAULT_DATA_DIR = os.path.join(os.path.expanduser("~"), ".claude", "orchestrator")

_GEN_QUESTION_PROMPT = """\
You are generating evaluation questions for a software system's knowledge base bench.

Given a TITLE (a compact fact label) and SUMMARY (the detailed explanation), generate
a natural question that:
  1. Is answerable ONLY using specific details from the summary
  2. CANNOT be answered just from the title alone
  3. Asks for specific values, names, or conditions (not "what does X mean?")
  4. Is one sentence, ending with a question mark

Title: {title}
Summary: {summary}

Return ONLY the question — no preamble, no explanation."""


# ---------------------------------------------------------------------------
# Question loading
# ---------------------------------------------------------------------------

def _load_questions(path: str) -> list[dict[str, Any]]:
    """Load question+gold pairs.

    Supports two formats:
    1. Pre-generated JSONL  (*.jsonl): one record per line with {question, gold, ...}
    2. KB queue JSON (*.json): { "kept": [{title, summary, ...}, ...] }
       In this case the title is used as a basic query (not a natural question).
       Use --gen-questions to produce proper questions first.
    """
    if path.endswith(".jsonl"):
        questions = []
        with open(path, encoding="utf-8-sig") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    r = json.loads(line)
                    if r.get("question") and r.get("gold"):
                        questions.append(r)
        return questions

    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    kept = data if isinstance(data, list) else (data.get("kept") or [])
    questions = []
    for item in kept:
        title   = (item.get("title") or "").strip()
        summary = (item.get("summary") or "").strip()
        if not title or not summary:
            continue
        questions.append({
            "question": title,   # raw title — use --gen-questions for proper questions
            "gold": summary,
            "category": item.get("kind") or "unknown",
            "evidence": item.get("evidence") or "",
            "source": str(item.get("source") or ""),
        })
    return questions


# ---------------------------------------------------------------------------
# Question generation (one-time LLM step)
# ---------------------------------------------------------------------------

def _gen_questions(src_path: str, out_path: str, *, model: Optional[str], limit: Optional[int]) -> int:
    """Generate proper QA questions from KB items using LLM; save to out_path as JSONL."""
    raw = _load_questions(src_path)
    if limit:
        raw = raw[:limit]
    total = len(raw)
    print(f"Generating questions for {total} items -> {out_path}")

    generated = []
    errors = 0
    for i, item in enumerate(raw):
        title   = item["question"]   # currently the raw title
        summary = item["gold"]
        prompt  = _GEN_QUESTION_PROMPT.format(title=title, summary=summary[:300])
        try:
            q = (judge_mod.claude_p(prompt, model=model) or "").strip()
            if not q.endswith("?"):
                q = q.rstrip(".") + "?"
            record = {**item, "question": q, "title": title}  # keep original title
            generated.append(record)
            if i < 5 or (i + 1) % 20 == 0:
                print(f"  [{i+1}/{total}] {q[:100]!r}")
        except Exception as exc:  # noqa: BLE001
            errors += 1
            print(f"  [ERR {i+1}] {title[:60]!r}: {exc}")
            generated.append(item)   # keep title as fallback

    with open(out_path, "w", encoding="utf-8") as fh:
        for r in generated:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"Saved {len(generated)} questions to {out_path} ({errors} errors)")
    return 0 if errors == 0 else 1


# ---------------------------------------------------------------------------
# Single trial
# ---------------------------------------------------------------------------

def _run_trial(
    client: ZonoidClient,
    trial_idx: int,
    q: dict[str, Any],
    *,
    data_dir: str,
    model: Optional[str],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Run one trial (ON + cold + rag_control) and return (records, diagnostics).

    Returns 3 records ready for report.write_results, and a diagnostics dict for
    the per-trial summary line.
    """
    unit_id  = f"bench-trial-{trial_idx}-{q['source'] or trial_idx}"
    question = q["question"]
    gold     = q["gold"]
    category = q["category"]

    diag: dict[str, Any] = {"unit_id": unit_id, "question": question[:80]}

    # --- ON arm ---
    on_error = ""
    try:
        t0 = time.monotonic()
        on = arms_mod.run_retrieve_and_answer(
            client, unit_id=unit_id, question=question,
            task_summary=question, data_dir=data_dir, model=model,
        )
        diag["on_elapsed"] = round(time.monotonic() - t0, 1)
        diag["on_ctx"]     = len(on.context_keys)
        diag["on_idle"]    = bool(on.wiring and on.wiring.judge_idle)
    except Exception as exc:  # noqa: BLE001
        on_error = str(exc)
        on = arms_mod.ArmResult(arm="on", predicted="")
        diag["on_error"] = on_error[:120]

    # --- cold arm ---
    cold_error = ""
    try:
        cold = arms_mod.run_cold(question, model=model)
    except Exception as exc:  # noqa: BLE001
        cold_error = str(exc)
        cold = arms_mod.ArmResult(arm="cold", predicted="")
        diag["cold_error"] = cold_error[:120]

    # --- rag_control arm ---
    rag_error = ""
    try:
        rag = arms_mod.run_rag_control(client, question, model=model)
    except Exception as exc:  # noqa: BLE001
        rag_error = str(exc)
        rag = arms_mod.ArmResult(arm="rag_control", predicted="")
        diag["rag_error"] = rag_error[:120]

    records = [
        {
            "arm": "on",
            "category": category,
            "question": question,
            "gold": gold,
            "predicted": on.predicted,
            "context_keys": on.context_keys,
            "ctx_chars": on.ctx_chars,
            "answer_input_tokens": on.answer_input_tokens,
            "answer_output_tokens": on.answer_output_tokens,
            "evidence": q["evidence"],
            "source": q["source"],
        },
        {
            "arm": "cold",
            "category": category,
            "question": question,
            "gold": gold,
            "predicted": cold.predicted,
            "ctx_chars": 0,
            "answer_input_tokens": cold.answer_input_tokens,
            "answer_output_tokens": cold.answer_output_tokens,
            "evidence": q["evidence"],
            "source": q["source"],
        },
        {
            "arm": "rag_control",
            "category": category,
            "question": question,
            "gold": gold,
            "predicted": rag.predicted,
            "context_keys": rag.context_keys,
            "ctx_chars": rag.ctx_chars,
            "answer_input_tokens": rag.answer_input_tokens,
            "answer_output_tokens": rag.answer_output_tokens,
            "evidence": q["evidence"],
            "source": q["source"],
        },
    ]
    return records, diag


# ---------------------------------------------------------------------------
# Scoring helper
# ---------------------------------------------------------------------------

def _score_and_render(
    records: list[dict[str, Any]],
    out_path: str,
    report_dir: str,
    title: str,
    use_llm_judge: bool,
) -> None:
    scores = report_mod.score(records, use_llm_judge=use_llm_judge, use_f1=True)
    arms_scores = scores.get("arms", {})
    print("\n--- Score summary ---")
    for arm_name in sorted(arms_scores):
        arm = arms_scores[arm_name]
        f1  = arm.get("f1_mean")
        acc = arm.get("accuracy")
        n   = arm.get("total", 0)
        f1_s  = f"{f1:.3f}"  if f1  is not None else "N/A"
        acc_s = f"{acc:.3f}" if acc is not None else "N/A"
        print(f"  {arm_name:14s}  F1={f1_s}  LLM-acc={acc_s}  n={n}")

    # Token economy — per-arm averages (only shown when at least one record carries tokens)
    arm_econ: dict[str, dict[str, list[int]]] = {}
    for rec in records:
        a = str(rec.get("arm") or "?")
        if a not in arm_econ:
            arm_econ[a] = {"ctx": [], "in": [], "out": []}
        if rec.get("answer_input_tokens"):
            arm_econ[a]["ctx"].append(int(rec.get("ctx_chars") or 0))
            arm_econ[a]["in"].append(int(rec["answer_input_tokens"]))
            arm_econ[a]["out"].append(int(rec.get("answer_output_tokens") or 0))
    has_tokens = any(arm_econ[a]["in"] for a in arm_econ)
    if has_tokens:
        print("\n--- Token economy (avg per trial) ---")
        for arm_name in sorted(arm_econ):
            ct = arm_econ[arm_name]
            n = len(ct["in"])
            if not n:
                print(f"  {arm_name:14s}  (no token data)")
                continue
            avg_ctx  = sum(ct["ctx"]) / n
            avg_in   = sum(ct["in"])  / n
            avg_out  = sum(ct["out"]) / n
            print(f"  {arm_name:14s}  ctx_chars={avg_ctx:7.0f}  in_tok={avg_in:6.0f}  out_tok={avg_out:5.0f}  n={n}")

    os.makedirs(report_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(out_path))[0]
    json_path, md_path = report_mod.render_report(
        scores,
        path_md=os.path.join(report_dir, f"{stem}-report.md"),
        path_json=os.path.join(report_dir, f"{stem}-report.json"),
        title=title,
    )
    print(f"  report.json -> {json_path}")
    print(f"  report.md   -> {md_path}")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Zonoid Feature Bench — multi-trial runner with partial-run support.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--trials",      type=int, default=None,
                        help="Number of trials to run (default: all questions).")
    parser.add_argument("--out",         default=_DEFAULT_OUT,
                        help=f"Output JSONL file (default: {_DEFAULT_OUT}).")
    parser.add_argument("--append",      action="store_true",
                        help="Append to an existing output file instead of overwriting.")
    parser.add_argument("--offset",      type=int, default=0,
                        help="Skip the first N questions (default: 0).")
    parser.add_argument("--score-only",  metavar="PATH", default=None,
                        help="Score an existing JSONL file and exit; skip running.")
    parser.add_argument("--questions",   default=_DEFAULT_QUESTION_SRC,
                        help="Path to question source JSON (default: onboard-queue.json).")
    parser.add_argument("--daemon",      default=_DEFAULT_DAEMON,
                        help=f"Daemon base URL (default: {_DEFAULT_DAEMON}).")
    parser.add_argument("--workspace",   default=None,
                        help="Daemon live workspace path (default: cwd).")
    parser.add_argument("--data-dir",    default=_DEFAULT_DATA_DIR,
                        help=f"Task-stub drop dir (default: {_DEFAULT_DATA_DIR}).")
    parser.add_argument("--use-llm-judge", action="store_true",
                        help="Enable LLM-judge accuracy metric (slower).")
    parser.add_argument("--model",       default=None,
                        help="Answer model for all arms (default: SDK default).")
    parser.add_argument("--category",    default=None,
                        help="Filter questions by kind field.")
    parser.add_argument("--gen-questions", metavar="PATH", default=None,
                        help="Generate proper QA questions from --questions source via LLM; "
                             "save to PATH as JSONL and exit.")
    parser.add_argument("--report-dir",  default=None,
                        help="Write report files here (default: alongside --out).")
    args = parser.parse_args()

    # --- gen-questions mode ---
    if args.gen_questions:
        return _gen_questions(
            args.questions, args.gen_questions,
            model=args.model, limit=args.trials,
        )

    # --- score-only mode ---
    if args.score_only:
        print(f"Scoring {args.score_only} ...")
        recs: list[dict[str, Any]] = []
        with open(args.score_only, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    recs.append(json.loads(line))
        print(f"  loaded {len(recs)} records ({len(recs)//3} trials)")
        report_dir = args.report_dir or os.path.dirname(os.path.abspath(args.score_only))
        _score_and_render(recs, args.score_only, report_dir,
                          "Zonoid Feature Bench", args.use_llm_judge)
        return 0

    # --- running mode ---
    workspace = args.workspace or os.getcwd()
    data_dir  = args.data_dir

    print("=" * 70)
    print("Zonoid Feature Bench — multi-trial runner")
    print("=" * 70)
    print(f"  daemon    : {args.daemon}")
    print(f"  workspace : {workspace}")
    print(f"  data_dir  : {data_dir}")
    print(f"  out       : {args.out}")
    print(f"  append    : {args.append}")
    print(f"  offset    : {args.offset}")
    print(f"  trials    : {args.trials or 'all'}")
    print(f"  category  : {args.category or 'all'}")
    print(f"  llm_judge : {args.use_llm_judge}")

    # Load questions
    print(f"\nLoading questions from {args.questions} ...")
    all_questions = _load_questions(args.questions)
    if args.category:
        all_questions = [q for q in all_questions if q["category"] == args.category]
    all_questions = all_questions[args.offset:]
    if args.trials is not None:
        all_questions = all_questions[:args.trials]
    total = len(all_questions)
    print(f"  {total} questions to run (offset={args.offset}, trials={args.trials or 'all'})")
    if not total:
        print("  Nothing to run.")
        return 0

    # Connect to daemon
    client = ZonoidClient(args.daemon, workspace=workspace, timeout=120)
    try:
        hits = client.search("bench runner warmup probe", k=1)
        print(f"\nDaemon reachable — /search round-tripped ({len(hits)} hits)")
    except Exception as exc:
        print(f"\nERROR: daemon at {args.daemon} is not reachable: {exc}")
        print("  Make sure the daemon is running and the KB is loaded before running the bench.")
        return 1

    # Run trials
    print(f"\nRunning {total} trials ...\n")
    all_records: list[dict[str, Any]] = []
    n_errors = 0
    run_t0 = time.monotonic()

    for i, q in enumerate(all_questions):
        trial_t0 = time.monotonic()
        is_first_write = (i == 0 and not args.append)
        try:
            records, diag = _run_trial(
                client, i + args.offset, q,
                data_dir=data_dir, model=args.model,
            )
        except Exception as exc:  # noqa: BLE001 — don't let one bad trial abort the run
            print(f"[{i+1}/{total}] ERROR (trial skipped): {exc}")
            n_errors += 1
            continue

        report_mod.write_results(records, args.out, append=not is_first_write)
        all_records.extend(records)

        elapsed = time.monotonic() - trial_t0
        ctx     = diag.get("on_ctx", "?")
        idle    = diag.get("on_idle", "?")
        err_s   = "  ERR: " + "; ".join(
            f"{k}={diag[k]}" for k in ("on_error", "cold_error", "rag_error") if k in diag
        ) if any(k in diag for k in ("on_error", "cold_error", "rag_error")) else ""
        print(f"[{i+1:4d}/{total}] {elapsed:5.1f}s  ctx={ctx}  idle={idle}  "
              f"{q['question'][:60]!r}{err_s}")

    total_elapsed = time.monotonic() - run_t0
    print(f"\nDone — {total} trials in {total_elapsed:.1f}s  ({n_errors} errors)")
    print(f"Results written to: {args.out}")

    # Score
    if all_records:
        report_dir = args.report_dir or os.path.dirname(os.path.abspath(args.out)) or "."
        _score_and_render(all_records, args.out, report_dir,
                          "Zonoid Feature Bench", args.use_llm_judge)

    return 0 if n_errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
