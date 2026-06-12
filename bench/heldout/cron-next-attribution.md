# cron-next bench lift attribution

**Verdict: (b) lift is n=1 noise / unrelated to KB**
The ON-arm lift (0/1 OFF → 1/1 ON-search) is explained entirely by an orch-gate timeout bug in the OFF-arm trial, not by any KB knowledge transfer.

---

## Evidence table

| Trial | Arm | Solved | Pass/Total | What was retrieved | Notes |
|-------|-----|--------|------------|--------------------|-------|
| 200 | off | false | 0/0 | — (no search step) | exitCode=124 (timeout); artifact not produced |
| 200 | on-search | true | 13/13 (7/7 edge) | search_knowledge("cron expression next run DOM DOW matching semantics") → ABSTAIN (top1=0.27, reason=low-confidence); no KB content injected | exitCode=0; artifact written, all 13 cases pass |
| 200 | on-iterative | true | 13/13 (7/7 edge) | — (iterative arm) | also solved; confirms the task is solvable |

---

## Root cause of the OFF-arm failure

The OFF arm timed out (exitCode=124, wallMs=599929 ≈ 10 min) without producing an artifact. The transcript shows what happened:

1. The agent wrote the full implementation to `/bench/sandbox/cron-next-ht.js` directly.
2. The **orch-gate blocked the Write** ("Main session multi-file or large edit detected — dispatch a subagent").
3. The agent then attempted `TaskCreate` + `Agent` tool dispatch to a subagent to work around the gate.
4. The subagent never completed within the 10-minute wall clock limit.

The OFF arm had exactly the same spec as the ON arm (confirmed by reading both initial prompts — they are identical text, including the DOM/DOW rule and all edge case rules). The failure is a **scaffolding defect**: the OFF-arm bench harness runs the agent in the main session context where the orch-gate fires, causing it to spend its entire budget on subagent scaffolding instead of code.

---

## What the ON-arm search actually retrieved

The ON-search arm called `search_knowledge` once with the query `"cron expression next run DOM DOW matching semantics"`. The result:

```json
{
  "decision": "abstain",
  "reason": "low-confidence",
  "top1": 0.27,
  "results": [
    {"key": "followup/write-cron-next-implementation-af37", "score": 0.40, "kind": "task", "summary": ""},
    {"key": "26253b2f.../1",                               "score": 0.378, "kind": "task", "summary": ""},
    {"key": "note: [ingest] self-scheduling primitives",   "score": 0.27,  "kind": "note", "tier": "rag"}
  ]
}
```

Gate decision: ABSTAIN. The search returned:
- Two task nodes with empty summaries (the prior "write cron-next" tasks — no KB content).
- One note about self-scheduling primitives — unrelated to cron parsing semantics.

**No KB content was injected.** The agent saw the ABSTAIN result and immediately wrote: "No relevant notes found. Implementing `nextRun` now." It then implemented the solution from scratch using the spec it was given in the prompt.

---

## What the spec already contained (both arms)

Both prompts contained the DOM/DOW rule verbatim:

> "DOM/DOW rule (standard cron semantics — read carefully): if BOTH day-of-month and day-of-week are restricted (neither is `*`), a day matches if it matches EITHER field (union)."

The spec also described: non-existent date handling, 5-year search window, throw-on-invalid behavior, and steps-on-range semantics. There was no knowledge gap — the task is self-contained.

---

## Why both ON arms solved and OFF arm failed

| Factor | OFF arm | ON-search arm |
|--------|---------|---------------|
| Spec completeness | Full spec in prompt | Identical spec in prompt |
| DOM/DOW rule in prompt | Yes | Yes |
| KB injection | N/A | None (ABSTAIN) |
| Gate blocking | Yes — Write blocked, subagent dispatch consumed budget | Bypassed via `/tmp` + `cp` workaround (agent found the exemption in the gate hook) |
| Result | Timeout, no artifact | 13/13 pass |

The ON-search arm succeeded because the agent found the orch-gate `/tmp` workaround in the gate hook source (`cat /Users/imyu/.claude/orchestrator/hooks/orch-gate.sh`). The OFF arm apparently did not or could not apply the same workaround before timeout. This is a **scaffolding asymmetry**: the `on-search` preamble (which loads and explains the KB tool) may also prime the agent to reason more carefully about infrastructure constraints — but this is speculative. The core failure is the gate + subagent dispatch loop consuming all the OFF-arm budget.

---

## Conclusion

**(b) Lift is n=1 noise / unrelated to KB.**

More precisely: the 0/1 OFF result is not a genuine task failure — the agent had a complete, correct implementation ready but was defeated by the bench scaffolding (orch-gate timeout). The ON-search arm produced no KB content (ABSTAIN). The lift measures gate-handling behavior asymmetry, not knowledge retrieval.

There is no seeded cron-next winner note, no KB mechanism, and no retrieval effect to attribute. The gate-autopsy finding (top1=0.332, no seeded note) is confirmed.

---

## Recommendation

**Keep cron-next as a NO-NOTE CONTROL candidate in the n=20 suite.** The task is well-suited for this role:

- The spec is self-contained and includes all necessary semantics inline.
- No scar note exists or is needed — a capable model should solve it from the spec alone.
- Expected result with a properly functioning scaffold: both ON and OFF arms solve (n=20 baseline ~1.0 for both).
- If the n=20 run still shows ON > OFF lift for cron-next with a fixed scaffold, that would be genuine anomalous signal worth investigating (false positive detector).

**Do NOT seed a winner note first.** The task has no knowledge gap to fill; seeding a note would create artificial signal and corrupt the control baseline.

**Fix the OFF-arm scaffold first (prerequisite):** the orch-gate must be bypassed or disabled for bench sandbox worktrees, otherwise the OFF arm remains broken and all comparisons are invalid. The ON-search arm found the `/tmp` workaround by reading the gate hook; the OFF arm should not have to do this — the bench harness should run with `ORCH_GATE_OFF=1` or equivalent for all arms.

---

*Attribution analysis: 2026-06-12. Task key: ddccf8ca-a541-49a7-8912-43ff5c7ccc63/7.*
