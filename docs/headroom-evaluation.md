# Headroom Evaluation

Status: exploratory evaluation, 2026-06-22

Scope: evaluate Headroom as an opt-in compression layer for zonoid workloads. This
does not add a dependency or change runtime behavior.

## Recommendation

Pilot Headroom only as an opt-in wrapper/proxy around high-volume agent sessions.
Do not add it to zonoid's default MCP or graph payload path yet.

Zonoid already has a project-local context selection layer: dependency summaries,
task-gated context, the context-need gate, and token/cost accounting. Headroom is a
better fit for raw, bulky material before it reaches the model: command output, logs,
large file reads, benchmark JSONL, RAG chunks, and long transcript slices.

The first pilot should be external to the daemon:

1. Run selected worker sessions through Headroom's CLI wrapper or proxy.
2. Keep zonoid's MCP tool responses exact by default.
3. Compare task success, token usage, latency, and retrieval fidelity against the
   same workload without Headroom.

## Sources Checked

- Graph context note `note:note-mqkzbyez8m4`: Headroom is a local-first context
  compression/proxy/library/MCP layer for AI agents, with reversible retrieval and
  optional output shaping.
- Headroom repository and documentation: <https://github.com/headroomlabs-ai/headroom>
- Headroom quickstart: <https://headroom-docs.vercel.app/docs/quickstart>
- Headroom limitations: <https://headroom-docs.vercel.app/docs/limitations>
- Headroom telemetry note: <https://headroom-docs.vercel.app/docs/telemetry>

## Fit With Zonoid

### Good Fit

- Agentic CLI runs that produce large tool output before zonoid sees final results.
- Onboarding and self-learning jobs that read many files, mined notes, or benchmark
  artifacts.
- Bench/debug sessions that paste large logs or command output into the model.
- Future API-backend calls, if zonoid grows a configurable OpenAI-compatible base URL
  or explicit proxy setting.

### Poor Fit

- Default `get_dependency_summaries` and task result payloads. Those are already
  curated Tier-1 context and should stay exact.
- Graph topology, task keys, edge metadata, verdict payloads, and usage records.
  These are machine contracts, not natural-language context.
- Automatic writes to `AGENTS.md`, `CLAUDE.md`, or equivalent rule files. Zonoid's
  durable memory is the graph note layer; learned prompt edits should remain a
  separate, explicit review gate.

## Integration Options

### Option A: External Wrapper Pilot

Use Headroom outside zonoid for selected worker sessions.

Example shape:

```sh
headroom wrap codex
headroom wrap claude
```

This is the lowest-risk path because zonoid does not need to know how Headroom stores,
retrieves, or formats compressed spans. Existing task claims, worktrees, and MCP calls
remain unchanged.

Acceptance gates:

- Off by default.
- No zonoid package dependency.
- Same tasks succeed with and without the wrapper.
- Required identifiers, file paths, task keys, and verdict JSON survive compression.
- Token reduction is large enough to beat added latency.

### Option B: Proxy for API Backend

Zonoid has an OpenRouter API backend in `lib/llm-backend.js`, but it currently calls
OpenRouter directly. A later proxy pilot would need an explicit base URL or proxy
setting before Headroom can sit between zonoid and the hosted model.

Acceptance gates:

- Proxy config is opt-in and visible in dashboard/config output.
- Usage accounting records provider usage and Headroom compression stats separately.
- API errors, throttling, and timeouts still feed the existing backoff governor.

### Option C: MCP Compression Tool

Headroom can expose MCP tools, but zonoid should not route all orchestrator MCP
responses through it. If used, expose it as a separate user-invoked compressor for
large natural-language artifacts.

Acceptance gates:

- Never compress structured graph mutation responses.
- Never hide raw payload access from a judge or dispatcher.
- The compressed result must carry enough provenance to retrieve the original span.

## Pilot Workloads

Use workloads that are large enough to make compression measurable and specific
enough to catch semantic loss:

1. Onboarding mine/drain dry run over this repo.
2. A benchmark-analysis task that reads `bench-results*.json` and `bench-results*.jsonl`.
3. A debugging task with a long failing test log.
4. A code-search task that reads many matching files and must preserve exact symbols.
5. A graph-review task that calls `get_graph` or adjacent graph reads, but only
   compresses prose analysis outside the MCP response contract.

## Measurement Plan

Run each workload twice from clean attempt branches:

1. Baseline: normal zonoid worker.
2. Pilot: same prompt and task context, with Headroom enabled externally.

Capture:

- Task result: pass/fail/tested and judge verdict if present.
- Input tokens, output tokens, cache-read tokens, and total cost from zonoid usage
  records or harness transcript usage.
- Headroom compression stats from its own local report/log output.
- Wall-clock time.
- Retry count and any task kickbacks.
- Exactness probes: task keys, file paths, JSON field names, and code symbols named
  in the prompt must appear unchanged in the final answer or patch.

Initial pass threshold:

- At least 25% lower billed input tokens on the large-output workloads.
- No regression in task success or tests.
- No missing exact identifiers in exactness probes.
- Median wall-clock overhead below 20%, unless the token/cost reduction justifies it.

## Risks

- Compression can remove the exact token that makes a graph or code task correct.
  Keep structured payloads raw and probe exact identifiers explicitly.
- Headroom is another memory layer. If it learns or edits rules automatically, it can
  conflict with zonoid's graph-note memory and the repo's `AGENTS.md` contract.
- Proxy mode changes the failure surface for model calls. Timeout, rate-limit, and
  usage reporting behavior need focused tests before any in-process backend support.
- The documentation says local telemetry is anonymous and can be disabled. Any zonoid
  pilot should disable it unless the user explicitly opts in.

## Next Implementation Step

If this evaluation is accepted, add a small opt-in harness note rather than a runtime
dependency:

- Document `ZONOID_HEADROOM=1` as an experimental user convention for workers.
- Teach dispatch prompts to mention Headroom only when the task is expected to produce
  large natural-language context.
- Do not modify `lib/mcp-core.js` or graph routes until the pilot has measured wins.

