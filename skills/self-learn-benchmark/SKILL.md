---
name: self-learn-benchmark
description: Research a credible competitor/industry-average value for a task's metric and record it on the node as a benchmark, so the judge can compare the winning attempt against the outside world — not just our own baseline. Use when a problem task carries an inline metric spec (configure_task metric) and you want an EXTERNAL reference for it. The agent is the intelligence; the daemon stays dumb and only exposes the benchmark field of configure_task.
effort: medium
---

# Self-learn benchmark

Finds an industry-average / competitor value for a metric and records it on the task as a
**benchmark** — the external axis the judge weighs the winning attempt against (beyond our own
baseline). This skill is the **research intelligence**; it adds NO new daemon behaviour — it composes
existing MCP tools, exactly like `self-learn-judge` / `self-learn-planner`.

## When to run

A problem task `P` carries an inline metric spec (`metric`, `direction`). Before (or alongside) the
measure→judge step, you want to know what "good" looks like in the wider world for that metric. If `P`
has no metric spec, there's nothing to benchmark — stop.

## Procedure

You are the benchmark research subagent. Operate ONLY via MCP tools — never shell the daemon directly.

1. **Read the objective.** `get_task_detail(P)` → read `metric.metric` (the objective name/label) and
   `metric.direction` (`min` = lower-is-better, `max` = higher-is-better). These are your search target.

2. **Run BOUNDED research.** Find a credible industry-average or representative competitor value for
   that metric. Keep it tight — this is a sub-step, not a survey:
   - Prefer the **`deep-research`** skill if available, with a tight question
     (e.g. "typical / industry-average <metric> for <this kind of system> in 2026").
   - Otherwise a **handful** of `WebSearch` / `WebFetch` calls — cap it (≤ ~4–5 queries). Stop as soon
     as you have one credible figure with a real source; don't keep digging.
   - Favor primary/reputable sources (benchmark reports, vendor docs, published studies) over forum
     hearsay. Note the source URL and how confident the figure is.

3. **Record the finding.** Call
   `configure_task(P, benchmark={ metric, value, unit?, source, confidence })`:
   - `metric` MUST name the same objective as the spec's `metric`.
   - `value` is the researched number; `unit` if it has one (e.g. `"ms"`).
   - `source` is the URL/citation the figure came from (required — provenance, not a guess).
   - `confidence` ∈ {`"low"`,`"med"`,`"high"`} — how solid the figure is. A single secondary source ⇒
     `"low"`/`"med"`; corroborated across reputable sources ⇒ `"high"`.

4. **Degrade gracefully — NEVER fabricate.** If no credible benchmark exists for this metric (too
   niche, no comparable public data, only unreliable hearsay):
   - Record **nothing** — leave the benchmark unset — OR record a `confidence:"low"` entry **with a
     `note`** explaining the caveat ONLY if you have a real (if weak) sourced figure. Never invent a
     number to fill the field.
   - Explicitly **signal "no benchmark"** in your `complete_task` summary (e.g. "no credible benchmark
     found — judge falls back to baseline-only") so the judge knows to ignore the external axis. With
     no `benchmark` on the node, the judge already degrades to baseline-only (back-compat) — your job
     is just to say so clearly.

5. **Close out.** `complete_task(<benchmark_task_key>, summary, agent_id)` — one line: the metric, the
   value + source + confidence you recorded, OR "no benchmark — baseline-only".

## Guardrails

- **Never fabricate a number.** A wrong benchmark is worse than none — it would mislead the judge. No
  credible source ⇒ record nothing and say so.
- **Bound the research.** A handful of queries, then stop. This is a sub-step feeding the judge, not a
  standalone report.
- **Provenance is required.** Every recorded benchmark carries a real `source`. The daemon rejects a
  record with no `source`.
- **Daemon stays dumb.** All research judgement lives here. If you want a new endpoint, you're
  overreaching this skill's scope.
- **Idempotent.** `configure_task` (benchmark) overwrites; re-running with a better figure (or clearing
  with an empty benchmark) is safe.
