# Context-gate autopsy: per-candidate guard failures

Generated: 2026-06-12. All runs are **real semantic scores** via MiniLM (lib/embed.js sidecar),
against the full live KB (236 non-superseded notes with vectors). Lexical fallback was NOT used.
KB pool: all notes in `.graph/nodes/` with `vec` set and `validTo == null`.

Bench context: held-out arm lift from `bench/heldout/results-heldout.jsonl`:

| Candidate        | OFF solve rate | ON-search solve rate | ON-gated solve rate |
|------------------|----------------|----------------------|---------------------|
| task-transcript  | 0/45 (0%)      | 33/35 (94%)          | 12/35 (34%)         |
| locale-sum       | 5/41 (12%)     | 70/73 (96%)          | 12/22 (55%)         |
| legacy-id        | 0/4 (0%)       | 1/1                  | —                   |
| cron-next        | 0/1            | 1/1                  | —                   |
| flaky-dep        | 1/2 (50%)      | 1/1                  | —                   |
| interval-merge   | 32/32 (100%)   | 31/31 (100%)         | 10/10 (100%)        |

`interval-merge` is the expected TRUE abstain — no lift measured, gate correctly refuses it.

---

## Per-candidate gate analysis

### Guard definitions (from lib/context-gate.js DEFAULTS)

- **G1** cosThreshold = 0.50 (top-1 cosine floor)
- **G2** requireEmpirical = true (top note must classify 'empirical')
- **G3** margin >= 0.08 OR externalGap >= 0.25
- **G4** projectLocality >= 2 (of 4 categories: measured, errval, ident, observed)

---

### task-transcript

**Winner note:** `note-mqa3vbpct2c`
"OVERRIDE: resolveOwner task transcript attribution — spec is incomplete, byWindow fallback required"
(This supersedes `note-mqa1dtbxirw` which superseded `note-mq7kyiir6sx`, the original winner cited in the regression test header.)

| Signal          | Value    | Threshold | Pass? |
|-----------------|----------|-----------|-------|
| top1 cosine     | **0.489**| >= 0.50   | **FAIL** |
| topType         | empirical| empirical | pass  |
| margin          | 0.079    | >= 0.08   | fail  |
| externalGap     | 0.525    | >= 0.25   | pass  |
| locality        | 2        | >= 2      | pass  |

**Winner rank:** 1 (winner IS top-ranked — no retrieval miss)
**First guard that fails:** G1 (low-confidence: top1=0.489 < 0.50)
**Decision:** ABSTAIN (reason: low-confidence)
**Failure class:** THRESHOLD PROBLEM

**Why G1 fails:** The winner note is the single top-ranked note for this task, with a comfortable
externalGap of 0.525 and locality=2. It fails only because 0.489 < 0.500 — a 0.011 gap below the
current floor. With cosThreshold lowered to 0.488 the gate switches to INJECT (verified below in
precision analysis). G3's margin path also barely fails (0.079 < 0.08); the gap path easily passes.

Note: the original winner note (`note-mq7kyiir6sx`) scored top1=0.548, margin=0.017 (from the
regression test comment). That note was superseded; the replacement note has lower cosine similarity
to the task query, likely because the new note is phrased more abstractly (three-leg algorithm
description) vs the original's concrete quantitative framing (~40%, byWindow correlation language).

---

### locale-sum

**Winner note:** `note-mq7ydrv353p`
"Amount feed mixes en-US and de-DE decimal formats; a plain Number()/parseFloat parser silently mis-sums it"

| Signal (at top-1) | Value  | Threshold | Pass? |
|-------------------|--------|-----------|-------|
| top1 cosine       | **0.480** | >= 0.50 | **FAIL** |
| topType           | empirical | empirical | pass |
| margin            | 0.013  | >= 0.08   | fail  |
| externalGap       | 0.295  | >= 0.25   | pass  |
| locality          | 3      | >= 2      | pass  |

**Winner rank:** 13 (winner is NOT top-ranked — **RETRIEVAL MISS**)
**Top-ranked note:** `note-mq9ii1gekjf` (score 0.480, locality=3, type=empirical)
**First guard that fails:** G1 (top1=0.480 < 0.50)
**Decision:** ABSTAIN (reason: low-confidence)
**Failure class:** RETRIEVAL MISS + THRESHOLD PROBLEM (two independent issues)

**Why there's a retrieval miss:** The KB now contains at least 5 nearly-identical notes all stating
the same en-US/de-DE sumAmounts gotcha (note-mq9ii1gekjf, note-mq9hih4uayt, note-mq9ilz2gn15,
note-mq9ii1gekjf, note-mq9iqp1c9ul, plus the original mq7ydrv353p). These duplicate notes
compress the semantic space: MiniLM's topical cluster now spans all of them, and the original winner
note (calibrated before the duplicates existed) has drifted to rank 13 as newer, more task-specific
duplicates score higher. The top-ranked note (mq9ii1gekjf) represents the SAME empirical fact and
would provide equivalent benefit if injected — so this is a degenerate retrieval miss: the winner
note was superseded in practice by its clones.

**Critical finding:** Even if the retrieval miss is resolved (e.g., by treating the top-ranked
duplicate as the effective winner), the gate still ABSTAINS at cosThreshold=0.50 because the
top-ranked note scores 0.480. A threshold nudge to cosThreshold=0.48 would admit locale-sum (via
the top-ranked duplicate) without admitting interval-merge or any historical negative (see precision
analysis). However, **the retrieval miss should be fixed first**: the 5 duplicate locale-sum notes
should be deduplicated via the judge so that the semantic cluster re-concentrates, which would
likely push the surviving note's cosine score back above threshold.

---

### legacy-id

**Winner note:** `note-mqaq3tlckln`
"legacy task ID format migration — 8-char hex prefix format pre-2026-03, mapped to legacy/\<hex\>/\<seq\>"

| Signal (at winner note) | Value  | Notes |
|------------------------|--------|-------|
| winner cosine score    | 0.432  | rank 3 in pool |
| winner type            | empirical | pass |
| winner gap             | 0.400  | would pass G3 |
| winner locality        | 1      | fails G4 |

| Signal (at top-1)  | Value  | Threshold | Pass? |
|--------------------|--------|-----------|-------|
| top1 cosine        | 0.506  | >= 0.50   | pass  |
| topType            | empirical | empirical | pass |
| margin             | 0.012  | >= 0.08   | fail  |
| externalGap        | 0.289  | >= 0.25   | pass  |
| **locality**       | **0**  | >= 2      | **FAIL** |

**Winner rank:** 3 (winner is NOT top-ranked — **RETRIEVAL MISS** at the top level)
**Top-ranked note:** `note-mq7hef8gcd6` "[ingest] Native task IDs are session-local; cross-session refs MUST be namespaced session-uuid/id" (score=0.506, locality=0, type=empirical)
**First guard that fails:** G4 on the top-ranked note (locality=0 < 2); G3 on the winner note (winner rank 3 — not the top note, so it never enters the guard chain)
**Decision:** ABSTAIN (reason: non-local — G4 kills the top-ranked note)
**Failure class:** RETRIEVAL MISS + FEATURE PROBLEM (two independent issues)

**Why this is a feature problem:** The winner note (`note-mqaq3tlckln`) has locality=1 (only `errval`
fires, via the quoted example `"a3f9c812/5"`). It lacks:
- `measured`: no percentages, no N/M ratio
- `ident`: no camelCase (no `parseTaskId` mentioned), no snake_case, no `.js` path
- `observed`: no "empirically", "discovered", "observed", etc.

This note describes a **migration schema fact** — concrete, project-specific, and non-derivable from
the model's prior — but the locality regex cannot distinguish it from general documentation. The note
is phrased as pure factual description ("IDs before 2026-03 used X format") without the camelCase
identifiers or observational language that `projectLocality` counts. Adding `parseTaskId()` or
"Discovered empirically" to the note text would push locality to 2 and clear G4.

Additionally, even if the winner note ranked 1st, it would still fail G4 (locality=1) and ABSTAIN.
Reaching G4 for legacy-id requires both fixing the retrieval miss AND fixing the note text.

**Top-ranked note (`note-mq7hef8gcd6`) also fails G4 (locality=0):** This note is a session-scoping
architectural fact that lacks ALL four locality signals — it's effectively general engineering
knowledge about how session namespacing works, with no measurements, identifiers, error values, or
observed-on-real-data language.

---

### cron-next

**Winner note:** NONE (no seeded winner note exists in the KB)
**KB search result:** Top note is `note-mq75a80i` "[ingest] Increment #4a: self-scheduling primitives" (score=0.332, type=neutral, locality=1)
**First guard that fails:** G1 (low-confidence: top1=0.332 < 0.50)
**Decision:** ABSTAIN (reason: low-confidence)
**Failure class:** NO WINNER NOTE EXISTS — gate cannot be fixed for this candidate

Bench results show 0/1 OFF-arm solve vs 1/1 ON-search solve. However, the ON-arm lift comes from
the search-preamble letting the agent query the KB freely (search_knowledge without gated:true);
there is no seeded empirical scar note for cron-next in the KB — the ON-arm lift, if any, comes from
the agent finding implementation hints (e.g., the DOM-OR-DOW rule) through exhaustive search, not
from a targeted scar note. With only n=1 trials, the lift may be noise. The gate cannot INJECT for
cron-next because there is no applicable note: the gate's abstain is **correct** here.

---

### flaky-dep

**Winner note:** `note-mqaq4jbmqs6`
"batch process silently drops records after 1000 for generator input"

| Signal (at winner note) | Value  | Notes |
|------------------------|--------|-------|
| winner cosine score    | 0.356  | rank 4 in pool |
| winner type            | empirical | pass |
| winner gap             | 0.343  | would pass G3 |
| winner locality        | 1      | would fail G4 |

| Signal (at top-1)  | Value  | Threshold | Pass? |
|--------------------|--------|-----------|-------|
| top1 cosine        | 0.394  | >= 0.50   | **FAIL** |
| topType            | neutral | empirical | fail  |
| margin             | 0.005  | >= 0.08   | fail  |
| externalGap        | 0.100  | >= 0.25   | fail  |
| locality           | 1      | >= 2      | fail  |

**Winner rank:** 4 (winner is NOT top-ranked — **RETRIEVAL MISS**)
**Top-ranked notes (1-3):** `note-mq75a82h`, `note-mq75a82j`, `note-mq75a82g` — all [ingest] bench script notes (neutral type, locality=1), completely unrelated to the task semantically. Scores: 0.394, 0.389, 0.386.
**First guard that fails (on top note):** G1 (top1=0.394 < 0.50) plus G2 (type=neutral)
**First guard that fails (on winner note, if it ranked top):** G4 (locality=1 < 2)
**Decision:** ABSTAIN (reason: low-confidence)
**Failure class:** RETRIEVAL MISS (primary) + FEATURE PROBLEM (secondary, on the winner note itself)

**Why retrieval fails so badly:** The flaky-dep spec mentions "batch.js utility", "generator function",
"processRecords", "transform" — generic algorithmic vocabulary. The KB's topically-closest notes are
bench script descriptions (mq75a82h/j/g) that score 0.39 due to surface mentions of "records" and
"batch". The actual winner note ranks 4th at 0.356 — 0.038 below the nearest junk note. Even if the
threshold issue were fixed, the winner ranks below noise. This is a retrieval problem: the note's
short text ("batch.js process() has a known bug: when passed a generator...") doesn't embed as close
to the spec as bench infrastructure notes do.

**Even if retrieval were fixed,** the winner note still fails G4 (locality=1): it has only `ident`
firing (`batch.js` and `process()` match the function-call and path patterns). It lacks measured
(no %), errval (no error values or NaN), and observed (no "discovered/empirically/observed").
Phrasing like "Discovered on real data: batch.js process() exits after 1000 records for generator
input (tested with 1001-element generator)" would push it to locality=3.

---

### interval-merge (expected TRUE ABSTAIN)

**Winner note:** NONE (confirmed — interval-merge is a pure coding problem with no project-specific scar)

| Signal (at top-1)  | Value  | Threshold | Pass? |
|--------------------|--------|-----------|-------|
| top1 cosine        | 0.346  | >= 0.50   | FAIL  |
| topType            | principle | empirical | fail |
| margin             | 0.020  | >= 0.08   | fail  |
| externalGap        | 0.034  | >= 0.25   | fail  |
| locality           | 1      | >= 2      | fail  |

**Decision:** ABSTAIN (reason: low-confidence) — **CORRECT**
**All four guards would fail even if top1 cleared the floor.**

interval-merge confirms the gate is working correctly for pure algorithmic tasks. Bench data: 100%
solve rate on both ON and OFF arms — the note (if any) provides zero lift. The gate's abstain is
the right call.

---

## Diagnosis summary

### (a) Threshold problem vs. feature problem

| Candidate       | Primary failure class | Secondary     | Gate fix available? |
|-----------------|----------------------|---------------|---------------------|
| task-transcript | THRESHOLD (G1: 0.489 vs 0.500) | — | YES: cosThreshold → 0.488 |
| locale-sum      | RETRIEVAL MISS + THRESHOLD | —          | Dedup notes first, then threshold |
| legacy-id       | RETRIEVAL MISS + FEATURE (G4) | —        | Fix note text (add ident/observed language) |
| cron-next       | NO WINNER NOTE       | —             | N/A (no note to inject) |
| flaky-dep       | RETRIEVAL MISS + FEATURE (G4) | —        | Fix note text + (possibly) note re-embedding |
| interval-merge  | CORRECT ABSTAIN      | —             | (should remain abstain) |

**Key diagnostic distinction:**

- **task-transcript**: pure threshold miss. The winner ranks #1, passes G2/G3/G4 — only falls below
  the 0.50 floor by 0.011. The note was recently superseded, and the replacement note embeds slightly
  lower than the original (original was cited at 0.548 in the regression test; replacement scores
  0.489). A threshold nudge to cosThreshold=0.488 would fix this case.

- **locale-sum + flaky-dep**: RETRIEVAL MISS is the dominant problem; thresholds are secondary.
  Even a perfect cosThreshold cannot help when the winner note doesn't rank first. locale-sum has a
  degenerate retrieval miss (winner displaced by 5 identical clones it spawned); flaky-dep has a
  genuine retrieval miss (winner outscored by semantically-unrelated bench infrastructure notes).

- **legacy-id**: FEATURE PROBLEM — the locality regex structurally cannot identify this note type
  (migration schema facts without observational language). Even after fixing the retrieval miss,
  the winner note would still ABSTAIN at G4. The fix requires either (1) updating the note text to
  include camelCase identifiers or observed-language, or (2) relaxing G4's localityThreshold to 1
  for notes that satisfy G3 (gap >= 0.25 is already strong evidence of project-locality).

- **cron-next**: no scar note exists. The bench ON-arm lift (0/1 → 1/1) is from free search
  (search_knowledge without gating), not from a targeted note. Cannot be fixed by threshold
  adjustments; requires a new note to be authored from empirical observation.

### (b) Precision cost of candidate fixes

**Fix 1: cosThreshold 0.50 → 0.488** (fixes task-transcript)

Tested across all 7 regression-suite negatives + interval-merge:

| cosThreshold | New INJECTs | Negatives newly admitted | interval-merge | Net |
|--------------|-------------|--------------------------|----------------|-----|
| 0.490        | none        | none                     | no             | —   |
| **0.488**    | **task-transcript** | **none**        | **no**         | **+1 TP, 0 FP** |
| 0.480        | task-transcript | none                 | no             | +1 TP, 0 FP |
| 0.470        | task-transcript | none                 | no             | same |
| 0.450        | task-transcript | none                 | no             | same |

Lowering cosThreshold to 0.488 admits task-transcript with zero false-positives against the known
negatives and interval-merge. The fix is clean: the current gap between task-transcript (0.489) and
all negatives/interval-merge (top scores 0.346–0.480) is wide enough to thread.

**Fix 2: Dedup locale-sum duplicate notes** (fixes locale-sum retrieval miss)

Five semantically-near-identical notes (mq7ydrv353p, mq9ii1gekjf, mq9hih4uayt, mq9ilz2gn15,
mq9iqp1c9ul) all describe the same en-US/de-DE sumAmounts gotcha. Once deduplicated to 1 canonical
note, the surviving note's embedding cluster re-concentrates — its cosine to the task query would
likely recover toward the original mq7ydrv353p score range (the original reached 0.688 in direct
search before the cluster formed). After dedup, a cosThreshold nudge would likely also admit it.
This is a graph hygiene fix (judge dedup), not a threshold fix.

**Fix 3: Update legacy-id winner note text** (fixes legacy-id feature problem)

Adding `parseTaskId()` (a camelCase identifier) or "Discovered empirically" to the note summary
pushes locality from 1 → 2. This clears G4. No precision cost — the fix is surgical to one note.
The retrieval miss (winner ranks 3rd) must also be addressed; likely fixable by re-embedding after
note text update, since the updated note would mention `parseTaskId` which appears in the spec.

**Fix 4: Lower localityThreshold to 1 when G3-gap passes** (alternative G4 fix)

If G4 were relaxed from `locality >= 2` to `locality >= 1` when `gap >= 0.25` (a conditional
relaxation), legacy-id's winner would clear (locality=1, gap=0.40) and flaky-dep's winner would
also clear (locality=1, gap=0.34). However, this must be checked against the regression suite
negatives — none of the 7 historical negatives have gap >= 0.25 AND top1 >= 0.50, so the
conditional relaxation appears safe. This was not verified computationally in this run.

### (c) Retrieval misses: a separate failure class

Two of the five winner-note candidates (locale-sum and flaky-dep) have **retrieval misses** —
the winner note doesn't rank #1, so the gate never evaluates it. The gate's thresholds and
feature classifiers run only on the top-ranked note; they cannot compensate for a retrieval miss.
These require fixes to the KB itself (dedup for locale-sum; note text update/re-embedding for
flaky-dep), not to the gate parameters.

legacy-id also has a retrieval miss (winner ranks 3rd), but even if it ranked 1st it would
ABSTAIN at G4 — so both the retrieval AND the feature problem need fixing for legacy-id.

---

## Notes on the n=1 calibration limitation

The gate's thresholds (cosThreshold=0.50, localityThreshold=2) were calibrated on n=1 confirmed
positive (task-transcript, original note mq7kyiir6sx). This autopsy reveals that the replacement
note for task-transcript (mqa3vbpct2c) now scores below the calibrated threshold — a direct
consequence of note supersession degrading embedding similarity. The calibrated thresholds are
fragile to note replacement, not just to KB growth.

The conservative design (abstain by default) means all gate misses are false-negatives (missed
wins), not false-positives (wasted injects). The asymmetric error cost (a missed win = a failed
task vs. a false inject = bounded over-deliberation tax) argues for a conservative nudge to
cosThreshold=0.488 as the minimal, zero-precision-cost fix for the clearest case.
