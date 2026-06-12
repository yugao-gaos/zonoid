---
name: self-learn-qa
description: Nightly QA sweep over what changed in the graph since the last run. Reads the /graph/delta change sensor, runs each touched repo's configured test command (configure_task test_cmd), diffs failures against last night's recorded run, and files only REPRODUCIBLE new failures as problem nodes wired to the delta tasks that plausibly caused them. Use when the nightly trigger (scheduler-kicked loop) hands an agent the QA task, or when the user asks for a "QA sweep since <time>". The QA agent is the intelligence; the daemon stays dumb — it only stores test commands and serves the delta, it never runs tests itself.
effort: high
---

> **DEFAULT — OBSERVE AND FILE, NEVER FIX, NEVER MERGE, ADD-ONLY.** The nightly QA run
> diagnoses and queues; humans (and day-time workers) act. Hard rules, no exceptions:
> - **ADD nodes only.** NEVER cancel, supersede, replan, or touch any existing task
>   (`in_progress`/`ready`/`not_ready`/`done`) — a planner once caused a runaway doing exactly
>   that; this is a standing rule. You create problem tasks and notes, nothing else changes.
> - **NO fixing at night.** Do not edit code, do not create attempt branches/worktrees
>   (`branch_task` is off-limits here), do not `merge_attempt`. File the problem, propose the
>   fix direction via `request_guidance`, stop. Morning review decides.
> - **Flake discipline.** A NEW failure must reproduce on one rerun before it may become a
>   problem node. Non-reproducing failures are logged in the run record only — never filed.
>   Noise in the graph poisons verdicts; an unfiled flake costs nothing.
> - **Budget discipline.** This runs under the loop's token budget. Keep test-output excerpts
>   bounded (~last 50 lines), file at most 5 problem nodes per night (fold any overflow into
>   the guidance question), rerun each suite at most once.

# Self-learn QA (nightly)

Turns "what changed today" into verified regressions on the graph plus an auditable nightly
run record. This skill is the **QA intelligence** of the nightly loop; it adds NO new daemon
behaviour — it composes existing MCP tools (`graph_delta`, `get_task_detail`,
`record_decision`/`supersede_note`, `suggest_links`, `add_dependency`, `request_guidance`).

## State convention — the QA run record note

The run's persistent state lives in ONE note node, superseded each night so exactly one is
current and the history stays auditable (same temporal-chain mechanism as `supersede_note`):

- **Title:** `Nightly QA run record` (stable, verbatim — it is the retrieval key).
- **Summary** (line-oriented, parseable by the next run):
  ```
  watermark=<ISO — the delta.now of THIS run; next run's `since`>
  repo=<abs path> result=<pass|fail> failures=[<stable test ids, comma-separated>]
  skipped=<abs paths with no test_cmd configured, or "none">
  flakes=[<failures that did NOT reproduce on rerun, with repo>]
  fixed=[<last night's failures now passing>]
  filed=[<problem task keys created tonight, or "none">]
  ```
- **Find it:** `search_knowledge("Nightly QA run record")` → the hit with that exact title and
  `current: true` (default search already hides superseded runs) → `get_task_detail(<note key>)`
  → full summary on `task.summary` (search hits truncate at 200 chars; always read the detail).
- **Write it:** `record_decision(title: "Nightly QA run record", summary: <above>,
  supersedes: <previous run note key>)` — one call retires last night's record and chains the
  timeline. First run ever: omit `supersedes`.

Why a note and not a config key: `POST /config` only accepts whitelisted fields and has no
read-back tool, and the failure diff (step 5) needs last night's results persisted anyway —
the run record carries both the watermark and the results with zero daemon surface added.

## Headless shell discipline (permission allowlist)

This skill runs unattended at night. Every Bash call must either be a built-in read-only
command (which never prompts) or deterministically match the project allowlist in
`.claude/settings.json`. **Anything else raises a permission prompt nobody is awake to answer
— the run stalls and dies.** (2026-06-12 run: first `date` call waited 2.1h; a `$()`-for-loop
killed the run outright.)

**The only shell you run:**
- `npm test` — the repo's canonical suite.
- `./scripts/qa-suite.sh` — full per-file sweep over `test/*.test.js` (per-file exit codes,
  bounded failure excerpts). This committed script replaces every ad-hoc loop you might be
  tempted to write.
- `./scripts/qa-suite.sh test/<name>.test.js` — single-suite rerun (the step-6 flake check).
- `date -u <+format>` — timestamps.
- Built-in read-only commands (`ls`, `cat`, `grep`, `head`, `tail`, `jq`, `sed -n`) — these
  are auto-approved, including as pipe filters (`npm test 2>&1 | tail -40` is fine).

**Never, in any Bash call:** command substitution `$(...)`, `for`/`while` loops, heredocs,
`cd`-prefixed compounds, env-var prefixes (`VAR=x cmd`), or redirection to files (`>`/`>>`).
The headless classifier cannot statically verify these and will stall or block. If a sweep
seems to need one, `qa-suite.sh` already does it — otherwise it is out of scope for the night.

**Foreign repos:** a `test_cmd` may only be run if the allowlist covers it. Not covered ⇒
treat the repo exactly like one with no `test_cmd`: skip it, report
`skipped=<repo> (test_cmd not allowlisted)`, and let the morning reader add the settings
entry alongside the `test_cmd`. Never improvise an alternative invocation to dodge a prompt.

## Procedure

You are the nightly QA subagent. Operate via MCP tools for ALL graph/daemon interaction —
never shell daemon endpoints. The ONE thing you do shell is the repos' test commands: that is
the design (the daemon stores `test_cmd` but never executes it; the QA agent runs it).

1. **Claim it.** `start_task(<qa_task_key>, agent_id)`.

2. **Determine `since`.** Fetch the current run record (see State convention) and read its
   `watermark=` line. No current run record (first run) → `since` = 24 hours ago.

3. **Read the delta.** `graph_delta(since)` → `{ since, now, counts, status_changes,
   tasks_created, notes_added, merges }`. Remember `now` — it becomes tonight's watermark.
   (Caveat: `merges` only includes verdicts that carry a timestamp; it is best-effort.)
   - **Empty delta** (all `counts` zero): nothing to QA. Write a minimal run record
     (`watermark=<now>`, `skipped=none`, everything else empty, supersedes the old record),
     `complete_task` with "empty delta — no QA run", and STOP. Do not run any suite.

4. **Map the delta to repos.** Collect the task keys from `status_changes` (care about
   `done`/`tested` — work that landed), `tasks_created`, and `merges`. For each key,
   `get_task_detail(key)` → `repo` (the task's target repo via `configure_task`) and
   `test_cmd` (the repo's configured command) in one call. Dedup by repo. Then:
   - Repo with a `test_cmd` → QA it (step 5).
   - Repo with NO `test_cmd` → do NOT guess a command. Add the repo to `skipped=` in the run
     record and move on (the morning reader can set it via `configure_task` with
     `repo_path` + `test_cmd`).
   - Task with no repo set → not repo-targeted; skip it silently.

5. **Run each suite and diff.** For each QA-able repo, run its `test_cmd` (shell, cwd =
   the repo path; capture exit code + output, keep only the failing-test identifiers and the
   last ~50 lines of output). Headless rule: the command must satisfy the shell discipline
   above — for this workspace that means `npm test` and `./scripts/qa-suite.sh`; a foreign
   `test_cmd` the allowlist doesn't cover goes to `skipped=` instead of being run. Diff
   against last night's `failures=[...]` for that repo from the run record:
   - **NEW** — failing tonight, not recorded last night → flake-check (step 6).
   - **STILL-FAILING** — recorded last night, still failing → do NOT re-file (its problem
     node already exists); mention in the run record.
   - **FIXED** — recorded last night, passing tonight → list under `fixed=`.

6. **Flake discipline (hard rule).** For each repo with NEW failures, rerun the same
   `test_cmd` ONCE (in this workspace, rerun just the failing suite:
   `./scripts/qa-suite.sh test/<name>.test.js`). A NEW failure is **reproducible** only if
   it appears in BOTH runs.
   Non-reproducing failures go under `flakes=` in the run record and nowhere else — never a
   problem node, never a guidance question.

7. **File each reproducible failure as a problem node** (cap 5/night; group failures sharing
   one evident root cause into one node):
   1. Dedup first: `search_knowledge("<repo basename> <test name> failure")` and check the
      open graph — if an open problem node already covers it, skip filing.
   2. `TaskCreate` — label `QA: <repo basename> — <test id> fails`, description = the repro
      command (`cd <repo> && <test_cmd>`), the bounded failure excerpt, and the suspect delta
      tasks by key.
   3. `configure_task(<problem_key>, repo_path=<repo abs path>)` so future attempts target the right repo.
   4. `suggest_links(<problem_key>)`, then `add_dependency(from=<delta task key>,
      to=<problem_key>, kind="context")` for each delta task that plausibly caused the failure
      (it landed in that repo in the window and touches the failing area). Never leave the
      problem node a disconnected root; if no delta task is plausible, wire `context` from
      tonight's run record note instead.
   5. Do NOT create attempts, worktrees, or a judge subtree — that is the day loop's job.

8. **Update the per-repo test-plan note (only on a real observation).** When the delta shows
   a genuine coverage gap — work landed in an area tonight's suite clearly doesn't exercise, a
   reproducible failure no test would have caught earlier — update that repo's test-plan note:
   - Title convention: `Test plan — <abs repo path>`. Find the current one via
     `search_knowledge("Test plan <abs repo path>")`.
   - Exists → `record_decision(title: "Test plan — <abs repo path>", summary: <revised plan>,
     supersedes: <old note key>)` so revisions stay auditable (same chain as `supersede_note`).
   - Doesn't exist → `record_decision` without `supersedes` to create it.
   - **No new observation → leave the existing note untouched.** Churning the plan nightly is
     note-node noise.

9. **Write tonight's run record.** `record_decision` per the State convention,
   `watermark=<delta.now from step 3>` (NOT the wall clock after the run — anything that
   changed while suites ran lands in tomorrow's delta), `supersedes` last night's record.

10. **Propose fixes, then stop.** If any problem nodes were filed: ONE consolidated
    `request_guidance({ question: "Nightly QA filed <N> reproducible regression(s): <keys +
    one-liners>. Proposed fix directions: <one line each>. Approve which to attempt?",
    context: "<repos run, suspect delta tasks, flakes/skips count>",
    trigger: "repeated_failure" })`. This halts the loop until morning review — intended.
    No failures filed → no guidance call.

11. **Close out.** `complete_task(<qa_task_key>, summary, agent_id)` — one line: repos run
    (pass/fail), new problems filed (keys), flakes logged, repos skipped for missing
    `test_cmd`, watermark advanced to `<now>`.

## Guardrails

- **ADD-only, always.** No cancel, no supersede of tasks, no replanning, no status changes on
  anything but your own QA task. (Notes are the one supersede you perform — your own run
  record and test-plan notes — and that chain preserves history rather than destroying it.)
- **Never guess a test command.** No `test_cmd` configured for a repo ⇒ skip and report. A
  wrong guessed command produces fake failures, which is worse than no coverage.
- **Reproducible or it didn't happen.** One rerun, both runs failing, or it stays a flake in
  the run record. Never file a flake.
- **Don't re-file known failures.** STILL-FAILING items already have their problem node;
  duplicate problems bloat the graph and split the verdict history.
- **Daemon stays dumb.** Tests run HERE, in the agent, via the stored `test_cmd`. If you find
  yourself wanting the daemon to execute or schedule anything, you're overreaching this
  skill's scope.
- **Bounded everything.** ≤5 problem nodes/night, ≤1 rerun/suite, ~50-line output excerpts,
  ONE guidance question. The nightly loop's token budget is a hard cap, not a suggestion.
- **Allowlisted shell or no shell.** Every Bash call must pass headless (see Headless shell
  discipline). A permission prompt at 2am is a dead run — never improvise loops, `$()`, or
  env prefixes to "just check something".
- **Escalate, don't fix.** Even an "obvious" one-line fix waits for morning. The night shift
  files and proposes; it never ships.
