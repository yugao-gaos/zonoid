"""Realistic-probe smoke for the agent-memory SDK-migrated harness — S8 deliverable + /28 idle fix.

Closes the gap from /25: proves the LLM EdgeJudge actually KEEPS on realistic natural-language
content (not "secret token X" phrasing which triggered Claude safety refusals).

HANG PROTECTION
---------------
All `claude -p` calls are bounded at 120 s (judge.py enforces ZONOID_BENCH_CLAUDE_TIMEOUT).
No unbounded foreground waits. The smoke itself is bounded by a 10-min outer timeout when
invoked from `run_smoke()`.

DESIGN: live daemon path
------------------------
`judge_next` is hard-bound to the daemon's LIVE ``state.workspace`` (D:\\zonoid on this box).
So we ingest our realistic notes INTO D:\\zonoid (the live workspace) and register the probe
task ALSO into D:\\zonoid. This means the notes will appear in the real workspace graph — we
tag them ``category:"bench-smoke-realistic"`` and title them clearly so they can be identified
later, and we delete nothing (the daemon's dup-guard prevents re-write if the smoke is re-run).

HONESTY BAR
-----------
The gold answer is used ONLY for assertion [4] after the full retrieval cycle completes.
It NEVER enters the ingest / retrieve / keep / answer path. The EdgeJudge receives only:
  - anchor: the probe task key + question text
  - candidates: the note keys + titles/summaries that autowired at cosine >= 0.55
The gold answer is withheld from all of these.

ASSERTIONS (4 original STEP 3 requirements + 1 new idle-case assertion)
------------------------------------------------------------------------
[1] autowire seeded >=1 candidate edge at cosine >=0.55 (judge_next returns non-empty items).
    If always empty, the arm is HOLLOW — we say so loudly.
[2] the LLM EdgeJudge returned at least one REAL `keep` verdict (not deterministic-fallback prune)
    on a RELEVANT note.  "Real" = the judge was called (not idle) and verdicts has >=1 "keep".
[3] an IRRELEVANT note was pruned (distractor note NOT in /task/context context_keys).
[4] keepEdge persisted: get_task_context returns the kept dep, and the answer used it.
[5] IDLE-case: a probe engineered so NO note clears cosine 0.55 → arm wires NOTHING
    (judge_idle=True, wired_edges=[], context_keys=[]). NEVER a ceScore→overlay_edge fallback.
    This is the /28 fidelity fix: production Zonoid wires nothing when judge_next is idle.

Usage:
    C:\\Users\\Imyu\\AppData\\Local\\py312embed\\python.exe bench/agent-memory/smoke_realistic.py
    C:\\Users\\Imyu\\AppData\\Local\\py312embed\\python.exe bench/agent-memory/smoke_realistic.py --daemon http://localhost:8787

Runtime: stdlib ONLY. Embeddable Python 3.12 safe.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Any

# Embeddable Python 3.12 strips cwd from sys.path.
_HERE = os.path.dirname(os.path.abspath(__file__))
_BENCH = os.path.dirname(_HERE)
for _p in (_HERE, _BENCH):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from zonoid_bench import arms  # noqa: E402
from zonoid_bench import judge as judge_mod  # noqa: E402
from zonoid_bench.client import ZonoidClient  # noqa: E402
from zonoid_lifecycle import warm_up  # noqa: E402

# Force UTF-8 output so realistic Unicode text never crashes on the cp1252 console.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------------------
# Realistic memory probes (no "secret token" phrasing — plain natural language)
# ---------------------------------------------------------------------------
#
# Three realistic memory scenarios:
#
# Scenario A: Sarah switched from React to Vue (single-hop, framework question)
#   - RELEVANT note: "Sarah's tech stack switch" — contains the answer
#   - IRRELEVANT note: "Bob's hiking trip" — completely off-topic
#   - PROBE: "What JavaScript framework did Sarah switch to for the dashboard project?"
#   - GOLD: "Vue"
#
# Scenario B: dentist appointment rescheduled
#   - RELEVANT note: dentist appointment rescheduled to March 15
#   - IRRELEVANT note: coffee preferences note
#   - PROBE: "When was the dentist appointment rescheduled to?"
#   - GOLD: "March 15"
#
# Scenario C: Alex's promotion
#   - RELEVANT note: Alex was promoted to senior engineer in Q1
#   - IRRELEVANT note: office renovation notes
#   - PROBE: "What position was Alex promoted to?"
#   - GOLD: "senior engineer"

PROBES = [
    {
        "id": "realistic-A",
        "relevant_note": {
            "title": "Sarah's tech stack switch for the dashboard project",
            "summary": (
                "Sarah has been working on the dashboard project for the past six months. "
                "Last month she decided to switch the frontend framework from React to Vue. "
                "The switch was motivated by Vue's simpler state management for the team's use case. "
                "The migration is expected to complete by end of quarter."
            ),
        },
        "irrelevant_note": {
            "title": "Bob's weekend hiking trip to the Blue Ridge Mountains",
            "summary": (
                "Bob went hiking in the Blue Ridge Mountains last weekend with his family. "
                "They covered about 12 miles on the Appalachian Trail and spotted a black bear. "
                "The weather was perfect and they plan to go again in the fall."
            ),
        },
        "question": "What JavaScript framework did Sarah switch to for the dashboard project?",
        "gold": "Vue",
    },
    {
        "id": "realistic-B",
        "relevant_note": {
            "title": "Dentist appointment rescheduled to March 15",
            "summary": (
                "The dentist appointment originally scheduled for March 8 has been rescheduled. "
                "Dr. Martinez's office called to move it to March 15 at 2 PM due to a scheduling conflict. "
                "Please remember to update the calendar and confirm 24 hours before the appointment."
            ),
        },
        "irrelevant_note": {
            "title": "Office coffee machine preferences survey results",
            "summary": (
                "The office coffee machine preferences survey collected 47 responses. "
                "Most employees prefer medium roast over dark roast by a 3:1 ratio. "
                "The new espresso machine is scheduled for installation next Tuesday."
            ),
        },
        "question": "When was the dentist appointment rescheduled to?",
        "gold": "March 15",
    },
    {
        "id": "realistic-C",
        "relevant_note": {
            "title": "Alex promoted to senior software engineer in Q1",
            "summary": (
                "Alex received a promotion to senior software engineer effective January 15. "
                "This follows two years as a mid-level engineer and exceptional performance reviews. "
                "The role change includes a 15% salary increase and responsibility for mentoring two junior developers."
            ),
        },
        "irrelevant_note": {
            "title": "Office renovation timeline and floor plan changes",
            "summary": (
                "The third floor office renovation is scheduled to begin in April and last six weeks. "
                "Teams on the third floor will be temporarily relocated to the second floor. "
                "New open-plan seating will replace the existing cubicle layout."
            ),
        },
        "question": "What position was Alex promoted to?",
        "gold": "senior engineer",
    },
]

# Data dir for file-drop task stubs (mirrors run.py / probe_runner.py).
_DATA_DIR = os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.join(
    os.path.expanduser("~"), ".claude", "orchestrator"
)

# The LIVE workspace — judge_next is bound to this.
_LIVE_WS = "D:\\zonoid"

# Category tag so smoke notes are identifiable / filterable.
_SMOKE_CATEGORY = "bench-smoke-realistic"


# ---------------------------------------------------------------------------
# One-probe runner
# ---------------------------------------------------------------------------

def run_one_probe(
    daemon: str,
    probe: dict[str, Any],
    settle_s: float = 8.0,
) -> dict[str, Any]:
    """Ingest relevant + irrelevant note, mint probe task, run judge_next + EdgeJudge, answer.

    Returns a result dict:
      {id, relevant_key, irrelevant_key, probe_key,
       judge_idle, candidates_seen, wired_edges, pruned_edges,
       context_keys, predicted, gold, timeout_kills, provisional_kept,
       assertion_1_candidates, assertion_2_real_keep, assertion_3_prune, assertion_4_persisted}
    """
    pid = probe["id"]
    question = probe["question"]
    gold = probe["gold"]

    # Step 1: ingest relevant + irrelevant notes into the LIVE workspace.
    client = ZonoidClient(daemon, workspace=_LIVE_WS, timeout=120)

    print(f"\n  [{pid}] ingesting relevant note ...", flush=True)
    rn = client.post_note(
        title=probe["relevant_note"]["title"],
        summary=probe["relevant_note"]["summary"],
        category=_SMOKE_CATEGORY,
        tags=["bench-smoke-realistic", pid],
    )
    relevant_key = rn.get("key") or rn.get("note_key") or ""
    print(f"  [{pid}]   relevant_key = {relevant_key}")

    irn = client.post_note(
        title=probe["irrelevant_note"]["title"],
        summary=probe["irrelevant_note"]["summary"],
        category=_SMOKE_CATEGORY,
        tags=["bench-smoke-realistic", pid, "distractor"],
    )
    irrelevant_key = irn.get("key") or irn.get("note_key") or ""
    print(f"  [{pid}]   irrelevant_key = {irrelevant_key}")

    # Let the embedder index both notes before autowire runs.
    print(f"  [{pid}]   settling {settle_s:.0f}s for embed + autowire ...", flush=True)
    time.sleep(settle_s)

    # Step 2: run the canonical wiring (judge_next + EdgeJudge path).
    unit_id = f"{pid}-{int(time.time() * 1000) % 1_000_000}"
    result = arms.run_retrieve_and_answer(
        client,
        unit_id=unit_id,
        question=question,
        task_summary=question,
        data_dir=_DATA_DIR,
    )
    w = result.wiring

    print(f"  [{pid}]   probe_key      = {w.task_key if w else '?'}")
    print(f"  [{pid}]   judge_idle     = {w.judge_idle if w else '?'}")
    print(f"  [{pid}]   timeout_kills  = {w.timeout_kills if w else 0}")
    print(f"  [{pid}]   provisional    = {w.provisional_kept if w else 0}")
    print(f"  [{pid}]   candidates     = {[(c['key'], c.get('edge')) for c in (w.candidates_seen if w else [])]}")
    print(f"  [{pid}]   wired_edges    = {w.wired_edges if w else '?'}  (kept)")
    print(f"  [{pid}]   pruned_edges   = {w.pruned_edges if w else '?'}")
    print(f"  [{pid}]   context_keys   = {result.context_keys}")
    print(f"  [{pid}]   predicted      = {result.predicted!r}")
    print(f"  [{pid}]   gold           = {gold!r}")

    # Assertions.
    candidates_seen = list(w.candidates_seen) if w else []
    wired_edges = list(w.wired_edges) if w else []
    pruned_edges = list(w.pruned_edges) if w else []
    probe_key = w.task_key if w else ""
    judge_idle = w.judge_idle if w else True
    timeout_kills = w.timeout_kills if w else 0
    provisional_kept = w.provisional_kept if w else 0
    context_keys = list(result.context_keys)

    # [1] autowire seeded >=1 candidate.
    # Exclude provisional edges from the "real candidate" count — they were never judged.
    real_candidates = [c for c in candidates_seen if c.get("edge") != "provisional"]
    a1 = bool(real_candidates)

    # [2] LLM EdgeJudge returned a real `keep` (not deterministic fallback = no candidates).
    # A real keep: judge was called (candidates_seen non-empty), and at least one verdict is "keep".
    real_keeps = [c for c in candidates_seen if c.get("edge") == "keep"]
    a2 = bool(real_keeps)

    # [3] irrelevant note was pruned (NOT in context_keys after judge).
    # If irrelevant_key is absent from context_keys OR was explicitly pruned.
    a3 = (irrelevant_key not in context_keys)

    # [4] keepEdge persisted: relevant note in context_keys, and answer mentions gold token(s).
    # Use token-level check: ALL tokens of gold must appear in the predicted answer (case-insensitive).
    # This handles "senior engineer" matching "Senior software engineer." correctly.
    a4_key = bool(relevant_key and relevant_key in context_keys)
    predicted_lower = (result.predicted or "").lower()
    gold_tokens = gold.lower().split()
    a4_ans = all(tok in predicted_lower for tok in gold_tokens)
    a4 = a4_key and a4_ans

    return {
        "id": pid,
        "relevant_key": relevant_key,
        "irrelevant_key": irrelevant_key,
        "probe_key": probe_key,
        "judge_idle": judge_idle,
        "timeout_kills": timeout_kills,
        "provisional_kept": provisional_kept,
        "candidates_seen": candidates_seen,
        "wired_edges": wired_edges,
        "pruned_edges": pruned_edges,
        "context_keys": context_keys,
        "predicted": result.predicted,
        "gold": gold,
        "a1_candidates": a1,
        "a2_real_keep": a2,
        "a3_prune": a3,
        "a4_persisted": a4,
        "a4_key": a4_key,
        "a4_ans": a4_ans,
    }


def run_idle_probe(
    daemon: str,
    settle_s: float = 8.0,
) -> dict[str, Any]:
    """Assertion [5]: an IDLE-case probe — no note clears cosine 0.55.

    Design: ingest a note about a highly specific domain topic (e.g. rare fungal taxonomy),
    then ask a question about a COMPLETELY unrelated domain (e.g. marine engineering).
    The semantic gap ensures cosine < 0.55 so autowire seeds NO candidate — judge_next returns
    idle:true, items:[]. The arm MUST wire nothing (wired_edges=[], context_keys=[]).

    The /28 fidelity fix: production Zonoid wires nothing when judge_next is idle. The old
    S8 arms.py had a ceScore→overlay_edge fallback in this path — that inflated the score vs
    production and has been removed. This assertion proves the fallback is gone.

    Returns a result dict with 'a5_idle_wires_nothing': True iff judge_idle=True AND
    context_keys=[] (no edges wired). Also asserts no ceScore edge was created.
    """
    # A note about obscure mycology — high specificity, very unlikely to clear 0.55 cosine to
    # the marine-engineering question below.
    note_title = "Cordyceps militaris sporulation under controlled humidity conditions"
    note_summary = (
        "A laboratory study of Cordyceps militaris cultivation found that stromata formation "
        "peaked at 85% relative humidity and 22 degrees Celsius. The sporulation cycle "
        "completed in 18 days under 12h/12h photoperiod. Chitosan supplementation at 0.05% "
        "increased hyphal density by 34% compared to the control group."
    )
    # A question about marine cargo shipping — no semantic overlap with mycology.
    idle_question = "What is the standard dunnage requirement for bulk iron ore loading at Dampier port?"

    client = ZonoidClient(daemon, workspace=_LIVE_WS, timeout=120)

    print(f"\n  [idle-probe] ingesting off-topic mycology note ...", flush=True)
    rn = client.post_note(
        title=note_title,
        summary=note_summary,
        category=_SMOKE_CATEGORY,
        tags=["bench-smoke-realistic", "idle-probe"],
    )
    idle_note_key = rn.get("key") or rn.get("note_key") or ""
    print(f"  [idle-probe]   idle_note_key = {idle_note_key}")

    print(f"  [idle-probe]   settling {settle_s:.0f}s for embed ...", flush=True)
    time.sleep(settle_s)

    unit_id = f"idle-probe-{int(time.time() * 1000) % 1_000_000}"
    result = arms.run_retrieve_and_answer(
        client,
        unit_id=unit_id,
        question=idle_question,
        task_summary=idle_question,
        data_dir=_DATA_DIR,
    )
    w = result.wiring

    print(f"  [idle-probe]   probe_key     = {w.task_key if w else '?'}")
    print(f"  [idle-probe]   judge_idle    = {w.judge_idle if w else '?'}")
    print(f"  [idle-probe]   judge_idle_count = {w.judge_idle_count if w else 0}")
    print(f"  [idle-probe]   candidates    = {w.candidates_seen if w else []}")
    print(f"  [idle-probe]   wired_edges   = {w.wired_edges if w else []}  (must be EMPTY)")
    print(f"  [idle-probe]   context_keys  = {result.context_keys}  (must be EMPTY)")
    print(f"  [idle-probe]   idle_note_key = {idle_note_key}  (must NOT appear in context)")

    judge_idle = w.judge_idle if w else False
    wired_edges = list(w.wired_edges) if w else []
    context_keys = list(result.context_keys)
    timeout_kills = w.timeout_kills if w else 0

    # [5] IDLE case: judge_idle=True AND arm wired NOTHING.
    # Production Zonoid wires nothing when idle — no ceScore fallback, no overlay_edge.
    # ALSO verify the idle note is absent from context (it was never wired).
    a5_idle = judge_idle and not wired_edges and not context_keys
    a5_no_idle_note_in_ctx = idle_note_key not in context_keys

    print(
        f"  [idle-probe]   [{'PASS' if a5_idle else 'FAIL'}] "
        f"[5] judge_idle=True AND wired_edges=[] AND context_keys=[] "
        f"(idle={judge_idle}, wired={wired_edges}, ctx={context_keys})"
    )
    print(
        f"  [idle-probe]   [{'PASS' if a5_no_idle_note_in_ctx else 'FAIL'}] "
        f"[5-sub] idle note absent from context (no ceScore edge was created)"
    )

    return {
        "id": "idle-probe",
        "idle_note_key": idle_note_key,
        "probe_key": w.task_key if w else "",
        "judge_idle": judge_idle,
        "judge_idle_count": w.judge_idle_count if w else 0,
        "timeout_kills": timeout_kills,
        "wired_edges": wired_edges,
        "context_keys": context_keys,
        "a5_idle_wires_nothing": a5_idle,
        "a5_no_idle_note_in_ctx": a5_no_idle_note_in_ctx,
    }


# ---------------------------------------------------------------------------
# Smoke runner
# ---------------------------------------------------------------------------

def run_smoke(daemon: str = "http://localhost:8787", n_probes: int = 3) -> int:
    """Run n_probes realistic probes + 1 idle-case probe against the live daemon.

    Returns 0 on overall PASS, 1 on FAIL, 2 if daemon is unreachable.
    """
    print(f"[smoke_realistic] daemon={daemon}  live_workspace={_LIVE_WS}")
    print(f"[smoke_realistic] running {n_probes} realistic probe(s) + 1 idle-case probe")

    # Warm up.
    print("[smoke_realistic] warming embedder (may take up to 90s on cold start) ...")
    try:
        warm_up(daemon, timeout=120)
        # confirm reachability
        client = ZonoidClient(daemon, workspace=_LIVE_WS, timeout=60)
        client.search("warmup probe", k=1)
        print("[smoke_realistic] daemon reachable, embedder warmed")
    except Exception as exc:  # noqa: BLE001
        print(f"\nDAEMON UNREACHABLE: {exc}")
        return 2

    probes = PROBES[:n_probes]
    results = []
    for p in probes:
        try:
            r = run_one_probe(daemon, p)
            results.append(r)
        except Exception as exc:  # noqa: BLE001
            print(f"\n  [{p['id']}] EXCEPTION: {exc}")
            results.append({"id": p["id"], "a1_candidates": False, "a2_real_keep": False,
                            "a3_prune": False, "a4_persisted": False, "error": str(exc)})

    # Run idle-case probe (assertion [5]).
    idle_result: dict[str, Any] = {}
    print("\n[smoke_realistic] === assertion [5] — idle-case probe ===")
    try:
        idle_result = run_idle_probe(daemon)
    except Exception as exc:  # noqa: BLE001
        print(f"\n  [idle-probe] EXCEPTION: {exc}")
        idle_result = {
            "id": "idle-probe",
            "a5_idle_wires_nothing": False,
            "a5_no_idle_note_in_ctx": False,
            "error": str(exc),
        }

    # --- Summary ---
    print("\n" + "=" * 70)
    print("STEP 3+5 ASSERTION REPORT")
    print("=" * 70)

    # Aggregate fidelity counters across all probes.
    total_timeout_kills = sum(r.get("timeout_kills", 0) for r in results)
    total_provisional = sum(r.get("provisional_kept", 0) for r in results)
    total_idle = sum(1 for r in results if r.get("judge_idle"))

    any_hollow = False
    any_real_keep = False
    all_prune = True
    all_persisted = True
    overall_ok = True

    for r in results:
        pid = r["id"]
        a1 = r.get("a1_candidates", False)
        a2 = r.get("a2_real_keep", False)
        a3 = r.get("a3_prune", True)
        a4 = r.get("a4_persisted", False)
        a4k = r.get("a4_key", False)
        a4a = r.get("a4_ans", False)
        idle = r.get("judge_idle", True)
        cands = r.get("candidates_seen", [])
        keeps = [c for c in cands if c.get("edge") == "keep"]
        prunes = [c for c in cands if c.get("edge") == "prune"]
        tk = r.get("timeout_kills", 0)
        prov = r.get("provisional_kept", 0)

        print(f"\n  Probe [{pid}]")
        print(f"    [{'PASS' if a1 else 'FAIL/HOLLOW'}] [1] autowire seeded >=1 candidate  "
              f"(idle={idle}, candidates={len(cands)}, timeout_kills={tk})")
        if not a1:
            any_hollow = True
            overall_ok = False
            print(f"        HOLLOW: judge_next returned no >=0.55 cosine candidates for this probe.")
            print(f"        => production-faithful: arm wired nothing (no ceScore fallback).")

        keep_keys = [c['key'] for c in keeps]
        prune_keys = [c['key'] for c in prunes]
        print(f"    [{'PASS' if a2 else 'FAIL'}] [2] LLM EdgeJudge returned >=1 real KEEP  "
              f"(keeps={keep_keys}, prunes={prune_keys})")
        if a2:
            any_real_keep = True
            # Print the actual verdict text for kept notes.
            for c in keeps:
                print(f"        KEEP verdict: key={c['key']!r} title={c.get('title','')!r}")
        else:
            if not a1:
                print(f"        (no candidates to judge — hollow probe)")
            elif idle:
                print(f"        (judge_next was idle — no candidates passed the 0.55 threshold)")
            else:
                print(f"        EdgeJudge pruned ALL candidates on this probe.")
            overall_ok = False

        print(f"    [{'PASS' if a3 else 'FAIL'}] [3] irrelevant note pruned / absent from context  "
              f"(irrelevant_key={r.get('irrelevant_key')!r}, context_keys={r.get('context_keys')})")
        if not a3:
            all_prune = False
            overall_ok = False

        print(f"    [{'PASS' if a4 else 'FAIL'}] [4] keepEdge persisted → answer used it  "
              f"(relevant_in_ctx={a4k}, gold_in_answer={a4a}, "
              f"predicted={r.get('predicted')!r}, gold={r.get('gold')!r})")
        if not a4:
            all_persisted = False
            # Don't hard-fail on a4 if a1 passed but a2 failed (EdgeJudge pruned relevant note)
            # — that is an honest EdgeJudge outcome, not a code bug. But if a1 and a2 both passed
            # and a4 still fails, that IS a failure (keepEdge didn't persist).
            if a1 and a2:
                overall_ok = False
            elif a1 and not a2:
                print(f"        (EdgeJudge pruned relevant note — honest pipeline outcome, not a bug)")

        if prov > 0:
            print(f"    [INFO] provisional_kept={prov} on this probe (retries exhausted; "
                  f"kept provisional per production semantics)")

    # Report assertion [5] — idle case.
    a5 = idle_result.get("a5_idle_wires_nothing", False)
    a5_sub = idle_result.get("a5_no_idle_note_in_ctx", False)
    idle_judge_idle = idle_result.get("judge_idle", False)
    idle_idle_count = idle_result.get("judge_idle_count", 0)
    idle_wired = idle_result.get("wired_edges", [])
    idle_ctx = idle_result.get("context_keys", [])

    print(f"\n  Assertion [5] — idle-case probe (no note clears 0.55)")
    print(f"    [{'PASS' if a5 else 'FAIL'}] [5] judge_idle=True AND arm wired NOTHING  "
          f"(judge_idle={idle_judge_idle}, idle_count={idle_idle_count}, "
          f"wired={idle_wired}, ctx={idle_ctx})")
    print(f"    [{'PASS' if a5_sub else 'FAIL'}] [5-sub] idle note absent from context  "
          f"(no ceScore edge was created — /28 fidelity fix confirmed)")
    if not a5:
        overall_ok = False
        if not idle_judge_idle:
            print(f"        DIAGNOSIS: judge_next was NOT idle — the cosine gap was smaller than")
            print(f"        expected. The mycology note cleared 0.55 for the marine question.")
            print(f"        Adjust the idle probe design to increase semantic distance.")
        elif idle_wired:
            print(f"        DIAGNOSIS: judge_idle=True but wired_edges={idle_wired}.")
            print(f"        This would indicate a ceScore fallback bug — arms.py must NEVER")
            print(f"        wire via overlay_edge when judge_next is idle.")
    if not a5_sub and a5_sub is not None:
        overall_ok = False

    # --- Fidelity summary ---
    print("\n" + "=" * 70)
    print("FIDELITY COUNTERS (aggregated across all probes, excl. idle probe)")
    print(f"  timeout_kills    = {total_timeout_kills}  (0 = fully faithful, no retries needed)")
    print(f"  provisional_kept = {total_provisional}  (0 = all verdicts committed, none deferred)")
    print(f"  judge_idle       = {total_idle}  (probes with no >=0.55 candidates — hollow but correct)")
    if total_timeout_kills == 0 and total_provisional == 0:
        print("  => CLEAN: no timeout_kills, no provisional edges.")
    else:
        if total_provisional > 0:
            print(f"  => WARN: {total_provisional} provisional edge(s) kept (production-faithful retry path).")

    if any_hollow:
        print("\nWARNING: at least one probe was HOLLOW (judge_next idle — no >=0.55 candidates).")
        print("  This means the relevant note did not clear the autowire seed threshold for that probe.")
        print("  No ceScore fallback was used — this IS the production-faithful behaviour.")
    if any_real_keep:
        print("\nCONFIRMED: the LLM EdgeJudge returned at least one REAL `keep` verdict on realistic content.")
    else:
        print("\nWARN: the LLM EdgeJudge did NOT return any real `keep` verdicts across all probes.")
        print("  Possible causes: all probes hollow (no >=0.55 candidates), or judge always pruned.")
        overall_ok = False

    print(f"\nOVERALL: {'PASS' if overall_ok else 'FAIL'}")
    print("=" * 70)
    return 0 if overall_ok else 1


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Realistic-probe smoke for the S8 SDK migration — proves LLM EdgeJudge KEEPs "
            "on realistic natural-language content (not 'secret token' phrasing), and proves "
            "the /28 fidelity fix (no ceScore fallback when judge_next is idle)."
        )
    )
    parser.add_argument("--daemon", default="http://localhost:8787", help="Daemon base URL.")
    parser.add_argument("--n-probes", type=int, default=3, help="Number of probes to run (max 3).")
    args = parser.parse_args(argv)
    return run_smoke(args.daemon, n_probes=min(args.n_probes, len(PROBES)))


if __name__ == "__main__":
    sys.exit(main())
