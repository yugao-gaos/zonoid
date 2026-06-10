# Memory/RAG for coding agents — what we actually proved

**Date:** 2026-06-10 · **Corpus:** the cloude orchestrator workload (141 native tasks, 145 notes, 14 sessions)
**Harness:** headless `claude -p` A/B (model pinned, isolated git worktrees), `scripts/bench-arm.js`, `scripts/bench-heldout.js`
**Artifacts cited:** `bench/report-v2..v7.{md,json}`, `bench/report-wincase-c.md`, `bench/heldout/results-heldout.json`, `bench/heldout/n2/locale-sum.all.jsonl`, `bench/context-gate-eval.md`, `bench/frequency-{methodology,phase0a}.md`, `bench/report-phase1.md`, memory note `orchestrator-token-cost-benchmark.md`

---

## 1. Executive summary

After eleven experiments (eight nulls, one invalidated trap class, two causal wins, one
boundary-mapping null), the standing claim is:

**Retrieved memory provably makes an agent solve cases it otherwise cannot — if and only if
the needed knowledge is (1) empirical, (2) external to the artifact, and (3) project-local.**
The proof is causal and blind-graded at n=2 task families: on held-out edge cases the agent never
saw, cold scored **0/10 and 0/8 with zero variance**, warm scored **8.8/10 and 8/8** — and warm
wrote *more* code (3.8× and 1.7×), citing the seeded note, so the win is retrieve-and-apply, not
shortcutting (`bench/heldout/results-heldout.json`, `bench/heldout/n2/locale-sum.all.jsonl`).

Equally proven, in the other direction: memory does **not** help on self-solvable tasks — eight
consecutive nulls, with forced context producing up to a **~2× over-deliberation tax** that grows
monotonically with the amount injected (`bench/report-v7.md`). And it does not help when the fact
sits in the model's pretraining prior — Phase 1 reconstructed four "winnable" general-infra tasks
and cold passed **every** held-out edge case, proxy precision **0/4** (`bench/report-phase1.md`).

A context-need gate built on these labels abstains on all 11 negatives at **regret 0** (~690k
tok-eq of injection tax avoided) and, after recalibration on the external-gap signal, fires on the
real wins (`bench/context-gate-eval.md`). The winnable slice of this corpus's note-dependent tasks
is **≈23% (12/52)** — project-local measured facts — with an explicit self-similar-corpus caveat.

---

## 2. The original question: vendor "90% token savings"

The arc began as a cost audit of agent-memory products claiming ~90% token savings. Finding:
**those claims are strawman-relative** — they compare against replaying full conversation history
every turn, a baseline nobody competent runs. Against the real baselines the savings evaporate:

- **Prompt caching:** under `claude -p`, cache reads bill at ~0.1× input. One run is ONE multi-turn
  session with a genuinely warm cache (`cache_read` climbs monotonically, e.g. 16,058 → 29,266
  across turns in v5-grounded-on-0). The harness already gives "memory-like" cost behavior to both
  arms for free (v6 analysis, spine note).
- **Window + summarization:** the standard context-management default, also ignored by the 90% framing.

Our own ON-vs-OFF cost data (graph-dependent task, opus, n=5/arm):

| version | injection | cost-weighted gross ON/OFF | output tokens ON/OFF | cache_read ON/OFF |
|---|---|---:|---:|---:|
| v2 | forced, FULL payload (~25k chars) | **1.63×** | 1.08× | 1.67× |
| v3 | forced, LEAN payload (~1–3k chars, ~96% smaller) | **1.03×** | 0.95× | 1.18× |

**Cost = payload size; work is parity.** The entire ON/OFF cost difference is `cache_read` on the
injected payload; output tokens (real work) never moved. Lean injection is cost-neutral — but in
v2/v3 there was no measured *benefit* to offset even the residual overhead (`bench/report-v2.md`,
`bench/report-v3.md`).

---

## 3. Eight nulls, and what each one taught

| # | experiment | result | lesson |
|---|---|---|---|
| v1 | self-contained specs, permissive consult | neutral — ON arm never called the tools | "tools available" ≠ "tools used" |
| v2 | forced consult, full payload | 1.63× cost, work parity | payload size is the whole cost story |
| v3 | forced consult, lean payload | 1.03× — parity | lean injection is cost-neutral; still no benefit |
| v4 | hard task, but the recorded note was *general* | ON consulted, then re-derived the rule the hard way | knowledge too general can't collapse hardness |
| v5 | note precise AND retrievable, but task *easy* | ON did **1.29× MORE** work (H 2,674 vs 2,023) | unneeded precise context → over-deliberation |
| v6 | cache-stability (append-only vs re-ranked) | **structural null, not runnable** | MCP tool-results are append-only by construction; mid-session retrieval provably does NOT break the prefix cache (cache_read kept climbing 27,214 → 32,223 across a turn-5 search). Injection stability is a non-lever under this harness |
| v7 | first real semantic RAG (MiniLM embeddings) + DAG context, 4 arms × 2 tasks | NO-WIN on all 6 ON cells; **the combined DAG+RAG arm is the WORST** | more context → more floundering, monotone in amount: v4 hardness H_off 14,584 → search 16,274 (1.1×) → lean 19,969 (1.4×) → dagrag **29,027 (2.0×)**; v1 same shape (6,332 → 14,202, 2.2×). Solve rate 100% everywhere, artifact size flat — context only added deliberation (`bench/report-v7.md`) |
| wincase-c | best-effort authentic single-task trap | **rigging guard caught it**: cold solved 3/3 | see §4 — the oracle leak |

Pattern: each null missed a *different* necessary condition (unused / too-easy / hard-but-general
/ precise-but-easy / structurally-uncacheable / self-solvable). v7 also closed the retrieval-quality
alibi: semantic retrieval demonstrably worked (verified discriminating case vs lexical) and
changed nothing. The blocker was never recall.

---

## 4. The oracle leak — why every cold baseline was invalid

Wincase-c was the most favorable trap buildable for a self-contained task: strategy-silent prose,
programmatic fixture, 40% of rows solvable only by time-window correlation, seeded note verified
as the #1 semantic hit. The rigging guard (cold arm must fail before warm is run) **did not hold**:
cold solved 3/3, independently deriving the full correlation algorithm — **by reading the committed
test**, whose generator exposes the expected behavior (`bench/report-wincase-c.md`).

**The mechanism:** an in-worktree acceptance test (or dependency source — see silent-cap, §6) *is*
the oracle. The agent reverse-engineers the strategy from asserted behavior no matter how silent
the prose spec is. This is structural, not a fixable spec-writing flaw: a fully-specified committed
test for a pure function leaves no empirical gap. **Every bench v1–v8 shipped its own oracle into
the agent's worktree**, so all of them systematically overstated self-solvability — cold arms looked
smart because they were grading themselves against a visible answer key.

The flip side is the key product insight: **production is naturally held-out.** Real tasks don't
ship their own oracle; reality grades you after the fact (the user files a bug, the data feed
breaks). The benchmark had to be re-engineered to look like production.

---

## 5. The held-out protocol and the two wins

`scripts/bench-heldout.js`: the agent solves from a **prose spec only** — no test, no rubric in the
worktree. The artifact is frozen out and graded by an **external held-out suite the agent never
saw**. Only arm difference = graph access during solve. Rigging guard: cold must genuinely fail.

### Win #1 — task→transcript (`resolveOwner`), `bench/heldout/results-heldout.json`

Spec describes only direct + session resolution. The held-out grader contains 10 edge rows
recoverable only via time-window-overlap correlation against `byWindow` — a fact recorded in
pre-existing note `note-mq7kyiir6sx` (~40% of this registry's agent records lack a session).

| arm | n | solved | held-out edge cases (per trial) | mean W (artifact tokens) |
|---|---:|---:|---|---:|
| cold (off) | 5 | 0/5 | **0/10, 0/10, 0/10, 0/10, 0/10** | 707 |
| warm (`--consult=search`) | 8 | 7/8 | **10/10 ×7, 0/10 ×1** (mean 8.75) | 2,677 |

Cold is genuinely blind: zero variance, no artifact even references `byWindow`. The one warm miss
*retrieved* the note (fact present in a tool_result) but failed to *apply* it — application
variance, not retrieval failure. Corroboration: warm writes **~3.8× more** artifact (implementing
the correlation logic), so the win is added capability, not economy.

### Win #2 — locale-sum (n=2 replication), `bench/heldout/n2/locale-sum.all.jsonl`

Independent external-gap flavor: a de-DE locale-decimal mix hidden in the data feed; `deps: []`,
so there is *nothing* in-worktree to audit — externality airtight.

| arm | n | solved | edge | full suite | mean W |
|---|---:|---:|---|---|---:|
| cold | 3 | 0/3 | **0/8 every trial** | 7/15 every trial | 373 |
| warm | 5 | 5/5 | **8/8 every trial** | 15/15 every trial | 641 |

**Zero variance in both arms — cleaner than n=1.** Warm cites the seeded note verbatim and writes
~1.7× more code (locale normalization). Verdict `note-mq7yx05gyl6`, commit `fdc1c5d`.

This is the first (and now replicated) causal, blind-graded demonstration that retrieved context
is **load-bearing**: it flips outcomes the agent cannot flip alone.

---

## 6. The boundary: three necessary conditions

Memory is load-bearing **iff** the knowledge is:

1. **Empirical** — discovered by running something, not derivable from the spec.
   *Counterexample class:* v4 (a general verdict didn't help even when consulted).
2. **External to the artifact** — nothing in-worktree reveals it.
   *Counterexamples:* wincase-c (committed test = oracle); **silent-cap** (held-out candidate where
   a dependency silently processed only 50 items/call — cold read `batch.js`, saw the deferral in
   source, and submitted one item per call, defeating the cap without ever learning the constant.
   Dependency source = oracle; self-contained-dependency tasks are structurally un-trappable).
3. **Project-local** — absent from the model's pretraining prior.
   *Counterexample:* Phase 1 (§ below) — mkcert issuer-trust, don't-clobber-native-files, GC
   retention, stale-claim hygiene are general engineering knowledge; the model needs no note for
   facts it already knows. The wins used facts no pretraining covers: *this* registry's 40%
   missing-session rate, *this* feed's de-DE locale mix.

Conditions 1–2 came from the win/null contrast (n=2); condition 3 came from Phase 1's
across-the-board null on "transfer-robust" facts (`bench/report-phase1.md`: 4 reconstructed traps +
3 controls, 34 runs, **cold passed every edge case on every task, zero variance**, proxy precision
0/4, controls 3/3 correct).

---

## 7. The context-need gate

Built offline from the labeled v1–v7 outcomes (`bench/context-gate-eval.md`). **Default = ABSTAIN.**

- **On all 11 negative labels (v2–v7): abstain, regret = 0**, avoiding **~690,510 tok-eq** of
  the over-deliberation tax the always-inject arms paid.
- **Recalibration on the first positive:** the load-bearing note scored top1 cosine **0.548,
  margin 0.017** — the old rule (cos ≥ 0.55 ∧ margin ≥ 0.12) would have MISSED the win. Root
  cause: MiniLM packs topically-adjacent notes into a tight **0.50–0.55 band**; cosine and margin
  cannot separate a load-bearing note from topical noise there, ever. The discriminating signal is
  **external-gap token recurrence** (fraction of the note's content tokens recurring in the task):
  **0.337** for the on-task scar vs **≤ 0.178** for every plain negative.
- **New rule:** INJECT iff `top1 ≥ 0.50` ∧ note is empirical ∧ (`margin ≥ 0.12` ∨ `gap ≥ 0.25`).
  Scoped confusion matrix: **TP=1, FN=0, FP=0, TN=5; regret 0.** 21/21 unit tests.
- **Honest limits:** calibrated on n=1–2 positives — thresholds are provisional. And a structural
  one: same-micro-domain controls retrieving the *same* note also fire the gate (excluded from
  regret only on temporal grounds). **Held-out-ness is a property of the environment, not the
  note** — no note↔task threshold can detect it. Mostly a bench artifact, since real tasks don't
  ship their own oracle.

---

## 8. Frequency: how often does the winnable regime occur?

**Phase 0a** (`bench/frequency-phase0a.md`): LLM-judge classification with quoted evidence over the
52 completed note-dependent tasks (no runs).

| metric | count | rate |
|---|---|---|
| external-gap (base rate / payoff ceiling) | 24/52 | **46%** |
| empirical | 26/52 | 50% |
| load-bearing | 34/52 | 65% |
| winnable (all three) | 18/52 | **35%** |

Phase 0a's own caveat split the 18 winnable into 12 "benchmark-meta" (their external fact is a
prior *measured verdict* of this project) and 6 "transfer-robust general-infra," and guessed the
customer rate at ~10–15% by betting on the general-infra slice.

**Phase 1 inverted that reading.** The general-infra slice is exactly what pretraining already
covers (0/4 traps survived); the "meta" slice — **project-local measured facts** — is exactly where
the real wins live (both n=1 and n=2 wins are project-local). The honest frequency claim is
therefore **≈23% (12/52)** of note-dependent completed tasks on this corpus, resting on the
project-local slice.

**Standing caveat:** this corpus is maximally self-similar (the orchestrator instrumenting its own
memory system, one operator). What transfers to a customer project is the **category** — every
project accumulates its own local empirical facts (their flaky test, their API quirk, their data
feed) — not the notes themselves, and not necessarily the 23% point estimate.

---

## 9. Implications for agent-memory products

What this data supports selling, and what it doesn't:

- **The honest pitch:** memory as **project-local scar tissue** behind a **need-gate**. Capture
  empirical, locally-discovered facts (measured rates, data quirks, runtime gotchas); inject only
  when the gate's empirical + external-gap signals fire. On that slice the effect is not a
  discount — it is **solving cases the agent otherwise cannot** (0/10 → 8.8/10; 0/8 → 8/8).
- **The dishonest pitch (measured):** blind always-inject plus a token-ratio vs full-history
  replay. Blind injection cost us 1.63× at full payload and up to a 2× hardness tax (v7); the
  ratio baseline is a strawman (§2). Both halves of that pitch are contradicted by data.
- **Don't bother:** injecting general engineering knowledge (pretraining covers it — Phase 1);
  injecting on self-solvable tasks (eight nulls; the gate exists to refuse this); cache-layout
  cleverness under a harness that owns prompt layout (v6 — append-only injection can't break, or
  fix, anything).
- **Open questions:** (1) the frequency on a non-self-similar workload — the 23% needs re-measuring
  on a project that isn't benchmarking itself; (2) application variance — 1/8 warm runs retrieved
  the fact and still failed to apply it; (3) gate calibration is n=2-positives provisional, and
  held-out-ness remains environmentally determined, not note-detectable.

---

## 10. Methodology lessons (paid for in lost runs)

1. **The metric trap.** `net = gross − plumbing` was confounded: `attributionMcpServer` tagging is
   sticky across post-call messages, bucketing most of ON's cache_read into "plumbing" and making
   ON look like 0.35× ("65% less work") — a pure artifact, retracted. **Use output_tokens (or
   fresh input+output) as the work measure; headline on cost-weighted gross** (cache_read at ~0.1×).
2. **Three driver deaths.** (a) macOS has no `timeout` coreutil — scripts assuming it die
   silently. (b) Detached/background drivers get orphaned and killed (v7 lost a trial plus ~9 runs
   to repeated detached-driver deaths; Phase 1's babysitter died after the matrix completed).
   (c) Watching for output files gives FS read-cache false positives. **The only reliable wait is
   foreground `kill -0` polling on the child PID.**
3. **The workspace gremlin.** Semantic retrieval silently reads the wrong workspace if the path
   isn't pinned; every seeded-note experiment needs an explicit retrievability check against the
   real workspace before running arms (wincase-c instituted this check).
4. **Rigging guards are the honesty mechanism.** "Cold must fail before warm runs" killed
   wincase-c, silent-cap, and all four Phase 1 traps before a phantom win could be claimed. Eight
   nulls plus guard discipline is *why* the two wins are believable. The failure modes are not
   embarrassments to be buried; they are the part of the result that makes the rest trustworthy.

---

*Every number above traces to a named artifact under `bench/` or the memory note
`orchestrator-token-cost-benchmark.md`. Nothing in this report was re-run for its writing.*
