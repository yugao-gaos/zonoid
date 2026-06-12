# Demo 3: Feature Build → Self-Learning Loop → Plateau Detection with Token Economy

**Beat sequence:** (1) existing repo → token map, (2) foreign repo onboard, **(3) build feature → loop → plateau → token economy**, (4) public benchmark proof.

---

## Setup

Agent has onboarded a foreign repo with a small KB. Task: implement `setDiagnostics`/`getDiagnostics` that survive process restarts. Spec is silent on how.

---

## Round 0 — Baseline

Agent cold-runs, follows the obvious JSON-config pattern, fails durability tests (3/6).

**Solve rate without KB: 50%** over 20 trials (confirmed bench data).

---

## Round 1 — Loop Starts

Judge identifies failure pattern (JSON write instead of event-log write).

Learner proposes note:

> "overlay.js two-tier storage — durable fields route through JSONL event log, not JSON config. `LOCAL_FIELDS` marks ephemeral-only."

KEEP decision passes (non-recoverable without reading source). Injection on next attempt → 6/6 pass.

**Solve rate with KB: 80% (+30pp).**

---

## Round 2 — Plateau

Actual curve from held-out eval:

| Round | Solve rate | Earned probes |
|-------|-----------|---------------|
| r0    | 86%       | 86% earned    |
| r1    | 90%       | 70% earned (+4pp on escalation-set, merge-abort, gate-fail-open) |
| r2    | 80%       | 70% earned (0 new earned probes) |

`ingest-reversible` stays FAIL all rounds — convention notes don't transfer to cold agents.

**PLATEAU SIGNAL fires:** no new earned probes in r2. Loop stops.

---

## Token Economy

*Source: bench v7 lean-context arm*

| Metric | Value |
|--------|-------|
| Work tokens ON vs OFF | ~380 tok (same) |
| Net tokens ON/OFF ratio | **0.36x** |
| Cost-equivalent ON/OFF ratio | **0.33x** |

The ON arm spends **36 cents per dollar** the OFF arm spends on the net task.

If the loop continued past r2: ~50k tokens per round, 0 expected new probes — negative economy. The plateau detector closes the loop at the right time.

---

## Competitive Position

Devin Knowledge / Windsurf Memories / Augment Context Engine all lack:

1. **Honest judge with external metrics** — they use self-reported pass/fail, not a held-out grader the agent never sees.
2. **Plateau detection** — no mechanism to stop the loop when it stops earning; tokens bleed without bound.
3. **Token economy accounting** — no ON/OFF cost comparison; no negative-economy cutoff.

Zonoid's loop is the only one that knows when to stop.

---

## Case Study Validation

Full end-to-end validation across two held-out bench candidates (overlay-save + locale-sum):

- **overlay-save:** OFF 0/2 solved (edgePass 1/3 each) → ON 4/4 solved (edgePass 3/3 each)
- **locale-sum:** OFF 0/5 solved (edgePass 0/8 each) → ON 3/3 confirmed-inject trials solved (edgePass 8/8)

Loop iterations needed: 2 per candidate. Iteration 1: vocabulary alignment (note title must mirror agent query tokens). Iteration 2: completeness (overlay-save missed null-clear rule; locale-sum missed Intl parse pattern).

**Commit:** 2bc110f
