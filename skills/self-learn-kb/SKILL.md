---
name: self-learn-kb
description: Daytime KB learner that runs every 4 hours. Scans recent graph activity for knowledge worth promoting to durable [ingest-candidate] note nodes (curious pass), and checks existing [ingest] notes for staleness based on git changes to their evidence files (staleness pass). Half-curious (promote new knowledge) and half-change-minded (flag stale notes). Concurrency-gated: skips at ≥10 active agents, spawns 1 subagent at 2–4, up to 2 subagents below 2 active agents.
effort: medium
---

> **DEFAULT — ADD-ONLY, NO AUTO-INJECT, NO CODE EDITS.** The KB learner promotes and flags;
> it never modifies existing nodes, never edits source files, never merges, never replans.
> Hard rules, no exceptions:
> - **ADD nodes only.** NEVER cancel, supersede, replan, or touch any existing task or note
>   except your own `KB learner run record` (which you supersede intentionally to chain the
>   timeline). Every other node is read-only for this skill.
> - **NO code changes.** Do not edit source files, do not create worktrees or branches. This
>   skill reads the graph and git history; it writes only note nodes.
> - **No auto-inject.** A fact that is already in the KB (found via `search_knowledge`) is not
>   a candidate — no duplicates, no restating what is known.
> - **Quality cap, strictly enforced.** At most 5 `[ingest-candidate]` notes and at most 5
>   `[ingest-stale]` notes per run. Prefer zero noise over marginal coverage.
> - **Concurrency gate is mandatory.** Check `list_agents` BEFORE spawning anything.
>   Never skip this check.

# Self-learn KB (daytime, every 4 hours)

Turns recent graph activity into durable candidate KB notes and flags stale existing notes
whose evidence files have changed in git. This skill adds NO new daemon behaviour — it
composes existing MCP tools (`list_agents`, `graph_delta`, `search_knowledge`,
`get_task_detail`, `record_decision`).

## Model override

**Always spawn learner subagents with `model: claude-sonnet-4-6`.** Never use Opus for
learner work — cost discipline. The orchestrator (main agent) may run on any model; only
the spawned subagents are constrained.

## State convention — the KB learner run record

Persistent state lives in ONE note node, superseded each run so exactly one is current and
the history stays auditable:

- **Title:** `KB learner run record` (stable, verbatim — it is the retrieval key).
- **Summary** (line-oriented, parseable by the next run):
  ```
  watermark=<ISO — the delta.now of THIS run; next run's `since`>
  curious_candidates=[<note keys created, or "none">]
  stale_flags=[<note keys created, or "none">]
  skipped_reason=<"none" or why>
  ```
- **Find it:** `search_knowledge("KB learner run record")` → the hit with that exact title
  and `current: true` → `get_task_detail(<note key>)` → full summary on `task.summary`
  (search hits truncate at 200 chars; always read the detail before trusting the watermark).
- **Write it:** `record_decision(title: "KB learner run record", summary: <above>,
  supersedes: <previous run note key>)` — one call retires the last record and chains the
  timeline. First run ever: omit `supersedes`.

## Procedure

The orchestrator agent executes steps 1–3 (concurrency gate + dispatch) on the main thread.
Subagents execute the passes (steps 4–7). All graph/daemon interaction is via MCP tools —
no shell daemon endpoints.

### Orchestrator steps (main thread)

1. **Concurrency gate.** Call `list_agents` and count active agents (status `running` or
   `active`). Apply the gate:
   - **≥10 active agents** → do NOT spawn anything. Read the current run record
     (`search_knowledge("KB learner run record")` → `get_task_detail`), then write a new run
     record with `skipped_reason=high concurrency (<N> active agents)` and today's wall-clock
     as watermark (do NOT advance the delta watermark — nothing was read). Done.
   - **2–4 active agents** → spawn **1** learner subagent to run BOTH passes sequentially
     (curious then staleness). The single subagent receives both pass instructions.
   - **<2 active agents** → spawn **2** learner subagents: one for the curious pass, one for
     the staleness pass. They run in parallel and each writes its own partial results; the
     orchestrator merges them into the run record after both complete.

2. **Determine `since`.** Fetch the current run record and read its `watermark=` line.
   No current run record (first run ever) → `since` = 4 hours ago.

3. **Dispatch.** Spawn subagent(s) per the gate decision (step 1), passing `since` and the
   previous run record note key. Use `model: claude-sonnet-4-6`. After all subagents
   complete, write the consolidated run record (step 7) and close out (step 8).

### Subagent steps (learner subagent)

4. **Read the delta.** `graph_delta(since=<watermark from orchestrator>)` → `{ since, now,
   counts, status_changes, tasks_created, notes_added, merges }`. Remember `now` — it
   becomes this run's watermark.
   - **Empty delta** (all `counts` zero): nothing to process. Report back with
     `curious_candidates=none`, `stale_flags=none`, and `delta_now=<now>`. Stop early.

5. **Curious pass** (promote new knowledge):
   - Examine `notes_added` (recorded decisions), `merges` (verdicts), and recently completed
     task summaries from `status_changes` (tasks that moved to `done`/`tested` in the window).
   - For each item: `get_task_detail(<key>)` to read the full summary.
   - Ask: does this contain a **non-obvious, non-recoverable** fact — something that would be
     lost if this node were archived and cannot be rediscovered cheaply? If no, skip.
   - Ask: is it already in the KB? `search_knowledge("<key terms from the fact>", k=5)` — if
     a hit covers the same knowledge, skip (no duplicates).
   - If yes to both → `record_decision(title: "[ingest-candidate] <short descriptive title>",
     summary: "source_task=<key>\nwhy: <one sentence clearing the bar>\n<the durable fact>")`.
     The title MUST start literally with `[ingest-candidate]` — this makes it filterable.
   - **Cap: 5 candidates per run.** Once 5 are created, stop evaluating further items —
     quality over coverage.

6. **Staleness pass** (flag drifted notes):
   - `search_knowledge("ingest", k=20)` to retrieve current `[ingest]` notes.
   - For each result: `get_task_detail(<key>)` to get the full summary.
   - Extract the `evidence:` field from the summary. It should be either a file path or a
     commit SHA.
   - **If file path:** run `git log --oneline -1 -- <file_path>` in the workspace root
     (`/Users/imyu/Desktop/zonoid`) to get the most recent commit touching that file.
     Compare the commit timestamp against `note.validFrom` (or the note's creation time if
     `validFrom` is absent). If the file changed AFTER the note was created → stale.
   - **If commit SHA:** run `git log --oneline <sha>..HEAD -- <implied path if available>` to
     check for newer commits in that area. If newer commits exist → potentially stale
     (flag conservatively only if the evidence path is clearly impacted).
   - **If no `evidence:` field:** skip — cannot assess staleness without an anchor.
   - Stale note → `record_decision(title: "[ingest-stale] <original note title>",
     summary: "original_note=<key>\nevidence_file=<path>\nlast_changed=<commit oneline>\nwhy_stale: <one sentence>")`.
     Title MUST start literally with `[ingest-stale]`.
   - **Cap: 5 staleness flags per run.** Once 5 are created, stop.

### Consolidation (orchestrator, after subagents complete)

7. **Write the run record.** Collect candidate keys and stale-flag keys from subagent
   results. Call `record_decision(title: "KB learner run record", summary: <below>,
   supersedes: <previous run note key>)`:
   ```
   watermark=<delta.now from step 4 — NOT wall clock>
   curious_candidates=[<note keys, or "none">]
   stale_flags=[<note keys, or "none">]
   skipped_reason=<"none" or the skip reason from step 1>
   ```

8. **Close out.** `complete_task(<kb_task_key>, summary, agent_id)` — one line: candidates
   created (keys), stale flags created (keys), watermark advanced to `<now>`, or skipped
   reason if skipped.

## Guardrails

- **Concurrency gate is non-negotiable.** Always `list_agents` before spawning. Never assume
  the system is idle.
- **ADD-only, always.** The only note you supersede is your own run record (and that chain
  preserves history rather than destroying it). Never touch existing tasks or other notes.
- **No speculative candidates.** "This might be useful" is not a bar. The bar is:
  non-obvious + non-recoverable + not already in KB. When in doubt, skip.
- **`[ingest-candidate]` is not `[ingest]`.** This skill creates *candidates* for human
  review. Promotion from candidate to `[ingest]` is a human/planner decision — never do it
  automatically here.
- **Staleness flags are not deletions.** Creating `[ingest-stale]` means a human should
  review whether to update the `[ingest]` note. It does not mean the note is wrong — the
  evidence file might have changed in an unrelated way.
- **Bounded always.** ≤5 candidates/run, ≤5 staleness flags/run. The 4-hour budget is a
  hard cap, not a suggestion.
- **Daemon stays dumb.** All intelligence lives here in the subagent. Git commands run in
  the agent shell (Bash tool). Graph reads/writes go through MCP tools.
