# Workspace instructions

## Orchestrator dashboard

This workspace uses the Orchestrator (task-graph daemon on `http://localhost:8787`).

**Always surface the dashboard link in your replies** when doing orchestrator/multi-task work,
so the user can open it whenever the panel isn't already up:

> 📊 Dashboard: http://localhost:8787/graph?workspace=%2FUsers%2Fimyu%2FDesktop%2Fzonoid

The link is cheap to include and harmless if the dashboard is already open — prefer including it
over guessing whether it's open (the agent can't reliably detect the panel state). Drop it only
in purely conversational turns with no task-graph activity.

## Default to background-subagent dispatch

For any **substantive multi-step work** (a feature build, refactor, migration, audit, or
multi-file change), the main agent should **not implement inline**. Instead:

1. Decompose into native tasks (`TaskCreate`) and register them in the orchestrator graph.
2. After creating a task, call `suggest_links` and add `context`/`blocking` edges so it wires
   into existing/completed work instead of becoming an orphan root node.
3. Ask Subconscious for the routine assignment surface (`subconscious_assignment prepare`), then
   **dispatch the actual work to a background subagent** (`Agent` tool, `run_in_background: true`)
   that accepts the assignment (`subconscious_assignment accept`) and reports back
   (`subconscious_assignment complete`).
4. Keep the **main thread free** to orchestrate and talk to the user — never block it on a build.

**Wiring is the dispatcher's duty, not the worker's.** Whoever creates a task wires it
(`suggest_links` + `add_dependency`) **before** dispatching — do not delegate wiring to worker
subagents: it is unenforced (unlike the write gate), so smaller worker models reliably drop it,
and workers lack the structural context (e.g. which sibling tasks collide on the same files).

**Review is state on the implementation task, not a visible judge task.** For substantive impl
tasks, the dispatcher requests same-node review when preparing the implementation assignment; it
does **not** create a separate user-visible judge node or a blocking judge edge. On the same-node
path, pass `create_judge:false` and a review request flag such as `judge_requested:true`; compatibility
inputs like `judge_task_key` are audit aliases only and should resolve to `judge_task_key:null`,
`review_task_key:<impl-key>`, and review fields on the implementation task. The implementation node
carries `review_state`, `review_requested_at/by`, `review_verdict`, `review_agent`, and `merge_state`
alongside its attempt branch/worktree.

Daemon-owned headless drains own review queue execution. They may launch internal audit/review jobs,
but normal `/ready`, `/state`, and dashboard frontier views hide those internal drains and show compact
review/merge cues on the implementation node instead. The review still uses the code-review rubric
(correctness, scope discipline, dead/redundant code, test presence/quality, style) and reports the
verdict through `subconscious_assignment submit_verdict`: APPROVE updates same-node review state and
attempt merge state; KICK_BACK marks the implementation task failed/blocked for rework. Review jobs
**NEVER force-merge**: merge is `git merge --no-ff` and auto-aborts on conflict, escalating rather
than forcing. **Complexity gate:** same-node review applies to substantive multi-file work only —
genuinely trivial edits (a one-liner, a doc tweak, a config change) skip it, the same triviality
carve-out as the inline-edit rule below.

**Substantial work gets a two-tier feature branch; the dispatcher stays on main.** This is a
dispatcher-decides call, on the same complexity axis as the review gate above. When the dispatcher
classifies a unit of work as **substantial** (a multi-task feature, not a lone edit), it groups the tasks
under a **feature branch** instead of letting each attempt fork off main:

1. `create_feature(key)` opens `orch/feature/<slug>` + a feature worktree (overlay records
   `features[key]={feature_branch, feature_worktree, base}`).
2. The decomposed tasks are grouped under the feature: `configure_task repo_path=<feature worktree>`,
   and workers are dispatched with `branch_task base=orch/feature/<slug>` so each attempt forks off
   the **stable feature branch**, not main.
3. **Tier-1 (cheap, automatic):** same-node review **auto-merges** each approved
   attempt into the feature branch — same review path as above, but under a feature the merge target is
   the stable feature branch, making the merge cheap and reversible.
4. **Tier-2 (consequential, gated):** when the feature is complete and reviewed, the **dispatcher**
   makes the deliberate `merge_feature(key)` call (feature→main). This step is **never automatic** —
   it is the dispatcher-only gated decision, the way feature→main is never the review worker's call.

**Why two tiers:** forking attempts off a stable feature branch sidesteps the conflict class where
**main drifts under concurrent agents mid-feature** — attempts integrate against a base that holds
still while the feature is in flight, and **main only ever sees one reviewed, atomic feature merge.**

**The dispatcher stays on main — it does NOT relocate into a feature worktree.** A single session
has one cwd and cannot live in N feature worktrees at once, so it coordinates **N features
concurrently** from main; the feature worktrees are pure **integration surfaces** targeted via
`base` + `repo_path`, never the dispatcher's working directory. (`EnterWorktree` relocation is an
OPTIONAL convenience for a focused **single-feature interactive** session — not the default
coordinating posture.)

**An interactive session that EDITS code directly (not just dispatching) MUST `EnterWorktree` first.**
The shared main checkout is where the daemon lives and constantly writes + commits `.graph` (it runs
`git add -A && commit`) and where attempt branches merge. Editing code there means concurrent sessions
collide on one working tree: another session's `git stash` — or the daemon's own `git add -A` — silently
sweeps up or clobbers your uncommitted edits (observed live: `<<<<<<< Updated upstream` markers injected
mid-edit, and a session's edits absorbed into a daemon commit). A per-session worktree removes that
collision class entirely (worktrees share `.git` but have **separate working trees**, so one tree's
`git stash` can't touch another's). **The graph stays unified:** the orchestrator pins the canonical
workspace in `~/.Codex/orchestrator/workspace`, which `mcp-graph.js` reads independent of `cwd`, so a
worktree session's graph ops still resolve to the same canonical graph — only code/git is isolated,
never coordination. Carve-out (same triviality bar as elsewhere): a purely conversational, read-only, or
one-liner session can stay on main; and the **dispatcher** posture above is unchanged (it doesn't edit
code — it stays on main to coordinate N features).

For **trivial / single-task** work, skip the feature tier entirely and use today's flat
attempt→main flow — the same triviality carve-out as the inline-edit and review rules.

**Hand the worker a typed `handoff_envelope`, not prose duties.** Instead of restating the
worker's duties verbatim in English, the dispatcher builds the slotted `handoff_envelope` defined
in [`schemas/handoff.v1.schema.json`](./schemas/handoff.v1.schema.json) and embeds it in the
Agent-tool prompt (it plugs into the Agent-tool `schema` option). The worker **copies** the slotted
fields — `task_key`, `agent_id`, `branch` (`orch/attempt/<key>`), `target_repo` — into its graph
calls rather than parsing them back out of a paragraph, and reads `context_deps[]` (pre-resolved
Tier-1 `{task_key, summary}` pairs the dispatcher already fetched via `get_dependency_summaries` +
note summaries) as inline base context. `files_in_scope[]` is the advisory file-scope hint;
`return_contract` is a `$ref` to `task_result` so the worker knows the exact shape to return.
Building the envelope (including resolving `context_deps`) is the dispatcher's job — same rationale
as wiring: workers lack the structural context. The worker still owns exactly three graph duties —
`subconscious_assignment accept` before any write, `git add -A && git commit` all changes onto the
`orch/attempt/<key>` branch BEFORE completing the assignment (an uncommitted worktree leaves the
attempt tip == base, making a later merge a silent no-op), and `subconscious_assignment complete`
with a tight summary at the end — but now reads them off the envelope's slots, not prose.
(Workers still pass `wires_to=[task_key]` on any
`record_decision` they make mid-task — note provenance is the one wiring only the worker knows.)

**Worker registration rides the assignment claim, not the start hook.** The `SubagentStart` hook does NOT
fire for `run_in_background` Agent-tool spawns, so a background worker never carries
`agent_tool_spawn:true`. No extra registration field is needed in the envelope:
`subconscious_assignment accept` routes to the same `/overlay/status` in_progress path as raw
`start_task` and **self-registers the worker on claim**. The `/overlay/status` in_progress handler treats a claim
that bears an `agent_id` AND is backed by a registered worktree (proof `subconscious_assignment prepare`
allocated the worktree) as a legitimate hook-less worker, registers it, and allows the claim.
The registered worktree is the security boundary: a claim with no worktree is still refused. So the
`prepare` → `accept` order IS the registration — nothing else to carry. When the daemon
accepts a registered worker claim, it also mints or renews the scoped Subconscious execution
permit for that claim; normal workers must not add a separate manual permit step before writing.

Do the work inline only for genuinely trivial edits (a one-liner, a doc tweak, a config change).
Where the hooks are installed (`node bin/install.js`), a PreToolUse exit-2 gate hard-blocks **both**
`Edit`/`Write` tools and `Bash` file-write commands — agents must claim a task before editing. For
Codex the gate runs as Node (`hooks/orch-gate.js` + `hooks/orch-gate-bash.js`, invoked via
`node` so it works on Windows/macOS/Linux); the Cursor/Codex adapters and the test suite drive the
shell core (`hooks/orch-gate.sh` + `hooks/orch-gate-bash.sh`) — keep the two in sync. This gate fires
in ANY harness that runs settings.json hooks — confirmed in both the Codex CLI **and** the
desktop app — so it is instruction-level only where the hooks are not wired.
Users opt out per-conversation with `orch off`.

**Gate contract for subagents:** normal workers receive a prepared assignment from
`mcp__orchestrator-graph__subconscious_assignment(action:"prepare")`, then call
`mcp__orchestrator-graph__subconscious_assignment(action:"accept", task_key, agent_id, session_id)`.
The prepare action allocates the isolated worktree (`orch/attempt/<key>`) and the accept action
claims through the existing `/overlay/status` path, so the same permit minting and write gate remain
the source of truth. Raw `branch_task` + `start_task` remain available only as backcompat/internal
escape hatches. All file writes must happen inside the worktree; the gate hard-blocks subagent
writes on any other branch.
`ORCH_GATE_OFF=1` as an inline env prefix does **not** work from subagents — the hook runs as a
separate process. Never bypass via workarounds (rsync, fabricated claims, etc.); claim properly.

## Predict by default — request_guidance is a last resort

When you hit a decision the user might own, **predict the answer from the KB first**; only call
`request_guidance` on a genuine gate miss. You do not have to police this by hand — the seam enforces
it: every `request_guidance` call is run through the ask-vs-predict gate (`lib/ask-gate.js`) over
recalled `category:"preference"` notes BEFORE it reaches the user. A confident, specific,
project-local preference match auto-resolves the question (the tool returns `predicted:true` with the
answer + provenance) without pausing the loop or queuing anything. Only when no confident preference
matches does the call actually escalate. Irreversible / outward-facing / high-impact /
scope-expansion / repeated-failure decisions ALWAYS escalate (the gate hard-overrides prediction) —
pass the matching flag (`irreversible`, `outward`, `highImpact`, `scopeExpansion`, `repeatedFailure`)
or rely on keyword detection. So: capture user preferences as `category:"preference"` notes (above),
then just call `request_guidance` when unsure — the seam predicts when it safely can and asks when it
must.

## Capture durable decisions as note nodes

Most conversation is throwaway, but some solo turns produce **durable knowledge** — a decision,
a rationale, a non-obvious finding. That should live in the graph, not evaporate when the session
ends. Use `record_decision(title, summary, knowledge?)` to capture it as a **note node** (a context
provider that shows in the graph but NOT in the native todo list; future related tasks inherit its
summary via context edges + `suggest_links`).

When to record:
- A real decision with a reason ("chose X over Y because …").
- A non-obvious finding or constraint worth keeping ("self-signed certs fail on issuer-trust, not locality").
- Anytime the user says "remember this" / "record this" (explicit — always capture).

Do NOT record chatter, restatements, or transient status. Keep summaries tight. On a borderline
case, lean toward NOT recording — note-node noise is worse than a missed minor point.

**Tag USER preferences with `category:"preference"`.** When the decision is a standing user
preference — a choice about HOW the user wants things done that should hold for future similar
decisions ("always squash orch/attempt branches", "prefer X library over Y", "never auto-deploy on
Fridays") — pass `category:"preference"` to `record_decision`. This is the corpus the ask-gate
recalls at the `request_guidance` seam: a confident, specific, project-local preference note lets
the orchestrator PREDICT the answer to a pending question instead of escalating to the user. Write
the summary empirically and project-locally (the reason + the observation it rests on), the same way
a strong KB note reads — a vague topical note will not clear the gate. General decisions/findings
stay un-categorized (they still join the recall pool as generic decision notes).

## Durable spec (system nodes)

Notes created with `category:"system"` are **always injected** into every `search_knowledge`
call at tier `"system"` (score 1.0, before DAG and RAG results) — every agent sees them
regardless of query. Use `record_decision(category:"system")` to write workspace-level anchors:
standing goals, hard constraints, interfaces, invariants, and known bugs.

The `/spec` skill manages the canonical workspace spec note. To read the current spec:
`search_knowledge(q:"SPEC: zonoid", k:1)`.

Do NOT store task-specific context or ephemeral decisions as system nodes — they pollute every
agent's context. One spec note per project; supersede it when updating.

## KB note authoring

**Override signal:** When a note contradicts the spec or existing code — e.g. "spec says return null here, but you must also check byWindow" — the note title MUST start with `OVERRIDE:` or the summary must start with `SPEC IS INCOMPLETE:`. This prefix signals to consuming agents that the note takes priority over what the spec or code says, and they must not dismiss the discrepancy as a note error.

**Standalone tokens in title:** Note titles must use isolated vocabulary that matches how agents query — NOT camelCase compounds or hyphenated phrases. Write "task transcript" not "taskTranscript", "time window overlap" not "time-window-overlap". Word boundaries matter for the embedding tokenizer; fused tokens produce poor retrieval recall and the note may never surface for the queries it was written to answer.

**Provenance wiring:** Agents creating notes MUST pass `wires_to=[current_task_key]` in `record_decision` so the DAG edge is created at note-creation time. Do not rely on cosine autowire — semantic similarity is best-effort and misses structurally important edges. Example: if working task #17, pass `wires_to=["17"]`.
