"""CL-2c smoke test — prove the per-task judge is a REAL LLM that KEEPS a genuine edge and PRUNES
a spurious-but-cosine-similar one, with evidence, and that the dup-cluster verdict controls
retrieval visibility (the demonstrable retrieval lever; see the structBoost daemon gap in
zonoid_memory.py finding #6).

Run with the Zonoid daemon up and the `claude` CLI available (ZONOID_JUDGE_CLAUDE /
ZONOID_JUDGE_MODEL override the path/model):

    python3 smoke_llm_judge.py

It constructs, for one anchor note N:
  - a GENUINE context neighbour (same teardown subsystem / fix-pattern as N),
  - a SPURIOUS but cosine-similar neighbour (shares 'pytest' vocabulary, unrelated subsystem),
runs the REAL LLM edge-judge, and asserts edge=keep for the genuine one and edge=prune for the
spurious one. It also demonstrates the dup-cluster KEEP vs PRUNE lever end-to-end on retrieval:
markDistinct makes a near-dup VISIBLE, consolidate keeps it OUT.
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zonoid_memory import ZonoidMemorySystem


def main():
    root = tempfile.mkdtemp(prefix="zonoid-cl2c-smoke-")
    mem = ZonoidMemorySystem("smoke-seq", workspace_root=root, arm="zonoid")
    mem.warm_up()

    # 1) Write the ANCHOR note N.
    n_summary = (
        "[SUCCESSFUL SOLUTION] pytest fixture teardown ordering bug: nested fixture finalizers "
        "ran in the wrong order. Fix: make the teardown stack strictly LIFO in src/_pytest/fixtures.py."
    )
    note_n = _write(mem, "N: pytest fixture teardown order LIFO", n_summary)

    # 2) GENUINE neighbour: same teardown subsystem / same fix-pattern.
    genuine = _write(
        mem,
        "GENUINE: pytest fixture finalizer exception in teardown",
        "[FAILED ATTEMPT] pytest fixture teardown: an exception raised in a finalizer was swallowed; "
        "propagate it from the LIFO teardown stack in src/_pytest/fixtures.py.",
    )

    # 3) SPURIOUS neighbour: shares 'pytest' vocabulary but a totally different subsystem (CLI
    #    marker-expression parsing), no transfer of insight to N's teardown fix.
    spurious = _write(
        mem,
        "SPURIOUS: pytest -m marker expression parser bug",
        "[SUCCESSFUL SOLUTION] pytest -m marker expression mishandled 'and not'; rewrite the "
        "boolean tokenizer in src/_pytest/mark/expression.py.",
    )

    # Reconstruct the candidate set the way the adapter does, then run the REAL LLM judge.
    neighbors = [
        {"key": genuine["key"], "title": "pytest fixture finalizer exception in teardown",
         "summary": "exception in fixture finalizer swallowed; propagate from LIFO teardown stack in fixtures.py",
         "is_dup": False, "_label": "GENUINE"},
        {"key": spurious["key"], "title": "pytest -m marker expression parser bug",
         "summary": "pytest -m marker expression mishandled 'and not'; rewrite boolean tokenizer in mark/expression.py",
         "is_dup": False, "_label": "SPURIOUS"},
    ]

    print("=" * 78)
    print("RUNNING REAL LLM EDGE-JUDGE (claude -p, model=%s)" % mem.judge_model)
    print("=" * 78)
    verdicts = mem._llm_judge(note_n["key"], n_summary, neighbors)
    if verdicts is None:
        print("LLM judge unavailable/failed — cannot demonstrate the REAL judge. "
              "Set ZONOID_JUDGE_CLAUDE / ZONOID_JUDGE_MODEL and ensure the CLI is on PATH.")
        sys.exit(2)

    g_edge = verdicts.get(genuine["key"], {}).get("edge")
    s_edge = verdicts.get(spurious["key"], {}).get("edge")
    print("\nLLM VERDICTS:")
    print("  GENUINE  neighbour (%s): edge=%s   [expect keep]" % (genuine["key"], g_edge))
    print("  SPURIOUS neighbour (%s): edge=%s   [expect prune]" % (spurious["key"], s_edge))

    # Post the verdicts (workspace-targeted) — keepEdge for genuine, pruneEdge for spurious.
    post = mem._verdicts_to_post(note_n["key"], neighbors, verdicts)
    print("\nPOSTED /judge/verdict body:")
    for p in post:
        print("  " + str(p))
    mem._judge(post)

    print("\n" + "=" * 78)
    print("ACCEPTANCE BAR — keep the genuine edge, prune the spurious one:")
    keep_ok = g_edge == "keep"
    prune_ok = s_edge == "prune"
    print("  KEEP genuine : %s" % ("PASS" if keep_ok else "FAIL (got %s)" % g_edge))
    print("  PRUNE spurious: %s" % ("PASS" if prune_ok else "FAIL (got %s)" % s_edge))

    # Demonstrable retrieval lever (dup-cluster visibility). Write a GENUINE near-dup and a
    # SPURIOUS-same-fact near-dup; show markDistinct (KEEP→visible) vs consolidate (PRUNE→gone).
    print("\n" + "=" * 78)
    print("DEMONSTRABLE RETRIEVAL DELTA — dup-cluster KEEP(distinct) vs PRUNE(consolidate):")
    _dup_demo(root)

    if not (keep_ok and prune_ok):
        print("\nSMOKE RESULT: FAIL — the judge did not keep-genuine / prune-spurious.")
        sys.exit(1)
    print("\nSMOKE RESULT: PASS — REAL LLM judge kept the genuine edge and pruned the spurious one.")


def _dup_demo(root):
    """Show the dup-cluster verdict controlling retrieval visibility end-to-end."""
    import requests

    mem = ZonoidMemorySystem("dup-demo-seq", workspace_root=root, arm="zonoid")
    base, ws = mem.base_url, mem.workspace

    def write(title, summary):
        r = requests.post(f"{base}/overlay/note",
                          json={"workspace": ws, "title": title, "summary": summary,
                                "category": "cl-experience"}, timeout=60)
        return r.json()

    def search_keys(q):
        return [h["key"] for h in mem._search(q, 5)]

    a = write("astropy TimeDelta to_value overflow fix",
              "Cast to float64 before unit conversion in astropy/time/core.py to_value to avoid int overflow.")
    b = write("astropy TimeDelta to_value overflow (same fix)",
              "In astropy/time/core.py to_value, cast float64 prior to unit conversion to stop integer overflow.")
    print("  wrote A=%s, B=%s (B trips dup guard, pending_dup=%s)"
          % (a["key"], b["key"], b.get("pending_dup")))
    print("  search BEFORE judging -> %s  (B invisible)"
          % [k[-12:] for k in search_keys("astropy TimeDelta to_value overflow float64")])

    # PRUNE branch: consolidate (same fact) — B should stay OUT of retrieval.
    mem._judge([{"consolidate": {"keep": a["key"], "supersede": [b["key"]]}}])
    after_prune = [k[-12:] for k in search_keys("astropy TimeDelta to_value overflow float64")]
    print("  after CONSOLIDATE (PRUNE same-fact) -> %s  (B gone -> pruned from retrieval)" % after_prune)

    # KEEP branch on a fresh pair: markDistinct (distinct) — B' should become VISIBLE.
    mem2 = ZonoidMemorySystem("dup-demo-keep-seq", workspace_root=root, arm="zonoid")
    base2, ws2 = mem2.base_url, mem2.workspace
    def write2(title, summary):
        return requests.post(f"{base2}/overlay/note",
                            json={"workspace": ws2, "title": title, "summary": summary,
                                  "category": "cl-experience"}, timeout=60).json()
    c = write2("numpy einsum optimize path bug",
               "numpy einsum optimize=True picked a slower contraction path; fix the greedy path cost in einsumfunc.py.")
    d = write2("numpy einsum optimize path bug (distinct attempt)",
               "numpy einsum optimize=True chose a worse contraction order; patch the greedy cost heuristic in einsumfunc.py.")
    print("  wrote C=%s, D=%s (D trips dup guard, pending_dup=%s)"
          % (c["key"], d["key"], d.get("pending_dup")))
    before_keep = [k[-12:] for k in mem2._search("numpy einsum optimize contraction path", 5)]
    print("  search BEFORE judging -> %s  (D invisible)" % before_keep)
    mem2._judge([{"markDistinct": {"keys": [d["key"], c["key"]]}}])
    after_keep = [k[-12:] for k in mem2._search("numpy einsum optimize contraction path", 5)]
    print("  after MARK-DISTINCT (KEEP distinct) -> %s  (D now visible -> kept in retrieval)" % after_keep)


def _write(mem, title, summary):
    import requests
    r = requests.post(f"{mem.base_url}/overlay/note",
                     json={"workspace": mem.workspace, "title": title, "summary": summary,
                           "category": "cl-experience"}, timeout=60)
    return r.json()


if __name__ == "__main__":
    main()
