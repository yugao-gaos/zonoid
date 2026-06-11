# Workspace instructions

## Orchestrator dashboard

This workspace uses the Orchestrator (task-graph daemon on `http://localhost:8787`).

**Always surface the dashboard link in your replies** when doing orchestrator/multi-task work,
so the user can open it whenever the panel isn't already up:

> 📊 Dashboard: http://localhost:8787/graph

The link is cheap to include and harmless if the dashboard is already open — prefer including it
over guessing whether it's open (the agent can't reliably detect the panel state). Drop it only
in purely conversational turns with no task-graph activity.

## Default to background-subagent dispatch

For any **substantive multi-step work** (a feature build, refactor, migration, audit, or
multi-file change), the main agent should **not implement inline**. Instead:

1. Decompose into native tasks (`TaskCreate`) and register them in the orchestrator graph.
2. After creating a task, call `suggest_links` and add `context`/`blocking` edges so it wires
   into existing/completed work instead of becoming an orphan root node.
3. **Dispatch the actual work to a background subagent** (`Agent` tool, `run_in_background: true`)
   that claims the task (`start_task`) and reports back (`complete_task`).
4. Keep the **main thread free** to orchestrate and talk to the user — never block it on a build.

Do the work inline only for genuinely trivial edits (a one-liner, a doc tweak, a config change).
This is instruction-level in the desktop app (which runs no settings.json hooks); in the CLI a
PreToolUse exit-2 gate (`hooks/orch-gate.sh` + `hooks/orch-gate-bash.sh`) hard-blocks **both**
`Edit`/`Write` tools and `Bash` file-write commands — agents must claim a task before editing.
Users opt out per-conversation with `orch off`.

**Gate contract for subagents:** call `mcp__orchestrator-graph__start_task(task_key, agent_id)`
**before** any file write. The gate checks `/active-claim?session=<session_id>` on the daemon —
a valid claim unlocks all writes for that session. `ORCH_GATE_OFF=1` as an inline env prefix
(e.g. `ORCH_GATE_OFF=1 python3 ...`) **does not work** from subagents — the hook runs as a
separate process inheriting the Claude Code process env, not the shell command env. Never
attempt to bypass the gate via workarounds (rsync, fabricated claims, etc.); claim properly.

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
