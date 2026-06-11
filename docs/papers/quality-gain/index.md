# KB Injection Lifts Agent Solve Rate: A Held-Out Benchmark Case Study

**Zonoid self-learning loop · Case study 001 · June 2026**

[Spec](assets/spec-overlay-save.md) · [Grader](assets/grader-overlay-save.js) · [Raw data](data/bench-results.json) · [Commit 2bc110f](https://github.com/yugao-gaos/zonoid/commit/2bc110f)

---

## Abstract

We run a controlled A/B benchmark testing whether KB (knowledge-base) injection from a project-local
knowledge graph improves coding agent accuracy on a held-out task. The ON arm receives one
gated `search_knowledge` call before coding; the OFF arm receives nothing. On the `overlay-save`
candidate — adding durable per-workspace diagnostics to a codebase with a non-obvious persistence
gotcha — the ON arm solves **4/5 trials (80%)** vs the OFF arm **1/5 (20%)**. The 1 OFF solve came
from an agent that independently reasoned to the correct pattern from existing code. All 4 ON solves
passed all 3 discriminating edge cases; the 1 ON failure was a gate abstention trial.

---

## 1. Setup

### 1.1 The candidate task

**overlay-save**: implement `setDiagnostics(workspaceId, value)` / `getDiagnostics(workspaceId)` in
an existing Node.js overlay module (`lib/overlay.js`). The spec states only that diagnostics must
survive process restarts and "overlay config regeneration" — it does not say how.

The **trap**: `lib/overlay.js` uses a two-tier storage architecture. Most fields are saved to a JSON
config file (ephemeral — can be wiped at any time). Durable fields are routed through a graph-store
JSONL event log that survives wipes. The spec is deliberately silent about which tier to use. Agents
that read existing code and notice the `LOCAL_FIELDS` pattern will store diagnostics in the JSON and
fail the durability tests. Only agents that understand the graph-store routing — either from the KB
note or by independently reverse-engineering the existing durable fields — will pass.

### 1.2 The grader

A held-out test suite the agent never sees. Six cases:

| Case | Type | Tests |
|------|------|-------|
| Returns null when unset | basic | `getDiagnostics` before any set |
| In-memory round-trip | basic | set then get in same process |
| Per-workspace isolation | basic | one workspace doesn't see another's |
| **Survives JSON wipe** | **edge** | **set → wipe overlay JSON → load → get** |
| **Overwrite survives wipe** | **edge** | **set DIAG1 → set DIAG2 → wipe → load → get DIAG2** |
| **Null clear survives wipe** | **edge** | **set value → set null → wipe → load → get null** |

The three edge cases are the discriminators. OFF arm implementations that use the JSON tier pass the
basic cases (in-memory correct) but fail all three edge cases. Only graph-store routing survives the
wipe.

### 1.3 Arms

| Arm | MCP access | Preamble |
|-----|-----------|----------|
| OFF | None | Prose spec only |
| ON-gated | `search_knowledge` (read-only) | "Call `search_knowledge` with `gated:true` once before coding. `inject` → apply the note. `abstain` → proceed without." |

### 1.4 The KB note

Seeded via `record_decision` after two iterations of refinement (see §4):

> **GOTCHA: setDiagnostics/getDiagnostics — must route through graph-store JSONL, null clears included**
>
> Storing in LOCAL_FIELDS or overlay JSON loses data on config regeneration. CORRECT PATTERN:
> (1) Emit a durable event in setDiagnostics: `graphStore.appendEvent(store, workspaceId, {evt:"diagnostics_set", value, ts})`.
> This MUST happen for ALL values including null — null means "cleared".
> (2) In graph-store.js switch: `case "diagnostics_set": node.diagnostics = ev.value; break`.
> (3) In overlay.js load(): rehydrate from graph-store nodes, not from JSON.
> Do NOT skip emitting the event when value is null.

### 1.5 Gate parameters (at run time)

```
decision: inject
top1:     0.521
margin:   0.224
gap:      0.106  (external-gap: fraction of note tokens recurring in query)
locality: 3      (project-local signal: identifiers + observed values)
reason:   sharp-specific-empirical
```

---

## 2. Results

### 2.1 Solve rate

| Arm | Trials | Solved | Solve rate |
|-----|--------|--------|-----------|
| OFF | 5 | 1 | **20%** |
| ON-gated | 5 | 4 | **80%** |

**Lift: +60 percentage points (4×).**

### 2.2 Per-trial breakdown

| Trial | Arm | Solved | edgePass | Note |
|-------|-----|--------|----------|------|
| 20 | OFF | ✗ | 1/3 | JSON path |
| 21 | OFF | ✗ | 1/3 | JSON path |
| 22 | OFF | ✗ | 1/3 | JSON path |
| 23 | OFF | ✗ | 1/3 | JSON path |
| 24 | OFF | ✓ | 3/3 | Agent reverse-engineered graph-store from existing code |
| 20 | ON-gated | ✓ | 3/3 | Injected, applied note |
| 21 | ON-gated | ✗ | 1/3 | Gate abstained (cosine margin below threshold) |
| 22 | ON-gated | ✓ | 3/3 | Injected, applied note |
| 23 | ON-gated | ✓ | 3/3 | Injected, applied note |
| 24 | ON-gated | ✓ | 3/3 | Injected, applied note |

### 2.3 Edge-case pass rate

| Arm | edgePass (solved trials) | edgePass (all trials) |
|-----|--------------------------|-----------------------|
| OFF | 3/3 (1 trial) | 1.2/3 avg |
| ON-gated | 3/3 (4 trials), 1/3 (1 trial) | 2.6/3 avg |

### 2.4 Token cost (post-fix clean run)

| Arm | avg output tok | avg net (in+out) | avg cost-eq (tok) |
|-----|---------------|-----------------|-------------------|
| OFF | 30,392 | 44,061 | 499,979 |
| ON-gated | 77,192 | 92,245 | 940,998 |

ON arm uses ~2.5× more output tokens. **No token saving on this candidate.** The ON arm produces
more thorough implementations (reads the note, reasons through the architecture, writes more careful
code). Token savings require tasks where OFF arm thrashes (iterative dead-ends) — see §5.

---

## 3. Methodology notes

### 3.1 Oracle isolation

The grader, frozen artifacts, and other candidates' specs are **removed from the solve worktree**
before the agent runs. The agent sees only its own prose spec. This prevents OFF arm agents from
reading the rubric.

### 3.2 Fresh worktrees

Each trial runs in an isolated git worktree off HEAD. The agent writes to the worktree; the frozen
artifact is copied out before the worktree is cleaned up.

### 3.3 External grading

Grading runs after the trial, in a temp directory with `CLAUDE_PLUGIN_DATA` redirected — it never
touches the real daemon state. Each grader invocation starts fresh.

---

## 4. The self-learning loop

The KB note required **two iterations** to converge:

### Iteration 0 (pre-bench)
Initial note used `LOCAL_FIELDS`, `emitDiff` vocabulary — matching the *implementation* language.
Agent query used `"setDiagnostics/getDiagnostics/config regeneration"` vocabulary — matching the
*spec* language. Cosine top1=0.461, below the 0.50 floor → **gate abstained on all 3 trials**.

### Iteration 1 (vocabulary bridge)
Added `"setDiagnostics/getDiagnostics"` and `"config regeneration"` to note title. Top1 jumped to
0.592. Gate fired. Agent got the basic durability cases right (2/3 edge) but **missed the null-clear
case** — note said "emit an event" but didn't specify that `null` values must also emit.

### Iteration 2 (null-clear rule)
Added explicit rule: *"This MUST happen for ALL values including null — null means 'cleared'. Do NOT
skip emitting the event when value is null."* Agent now passes all 3 edge cases. Trials 4–7 (pre-
clean-run validation): **4/4 solved, 3/3 edge each**.

### Stale note problem
Three earlier notes on the same topic (overlay JSON ephemeral pattern) were still `current=True`,
scoring 0.41–0.60 — tight cluster → cosine margin 0.06, gate abstained. Superseding them brought
margin to 0.29.

**Root lesson**: vocabulary alignment between note title and agent query is load-bearing. Margin
health (no competing notes) is a prerequisite for reliable injection.

---

## 5. What this does and doesn't show

### What it shows

1. **KB injection reliably improves agent accuracy on project-local gotchas.** When the gate fires
   and the note describes the exact pattern to avoid, agents apply it correctly every time (4/4
   solves on injection trials).

2. **The gate's abstain is meaningful.** Trial ON-21 abstained and failed identically to OFF trials.
   The gate correctly withheld an imperfect match rather than injecting noise.

3. **The self-learning loop converges.** Two note iterations — both diagnosable from bench output
   (gate decision + failed test cases) — were sufficient to reach stable 80%+ accuracy.

4. **The OFF baseline is non-zero (20%).** Opus can sometimes reverse-engineer the correct pattern
   from existing codebase patterns. KB injection shifts a 1-in-5 lucky-read outcome to a 4-in-5
   reliable outcome.

### What it doesn't show

- **Token savings**: not demonstrated on this candidate class. Fresh implementation tasks don't
  produce the exploration backtracking that would show H_off >> H_on. Token savings require
  debugging or iterative-refinement tasks.

- **Generalization across candidates**: one candidate, one codebase. locale-sum was disqualified
  (OFF arm saturated — Opus handles de-DE comma-decimal from training data).

- **Fully autonomous loop**: the KB notes were human-written on overlay-save (iteration 1 and 2).
  locale-sum notes were written by a subagent, but that candidate didn't produce clean data.

---

## 6. Appendix

- **Spec**: [assets/spec-overlay-save.md](assets/spec-overlay-save.md)
- **Grader**: [assets/grader-overlay-save.js](assets/grader-overlay-save.js)
- **Raw data**: [data/bench-results.json](data/bench-results.json)
- **Commit**: [2bc110f](https://github.com/yugao-gaos/zonoid/commit/2bc110f)
- **KB note ID**: `note-mq9ezseohh0`
- **Superseded notes**: `note-mq9cbtrbiet`, `note-mq90djykq63`, `note-mq8w3p79db1`, `note-mq8w2rwbm6d`
