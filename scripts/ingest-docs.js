#!/usr/bin/env node
'use strict';
/**
 * ingest-docs.js — distill the repo's rationale docs (README, CLAUDE.md, SKILL.md, ADRs)
 * into candidate note nodes for the self-learning graph.
 *
 * It does NOT inject into the graph. It globs the design/doc markdown (skipping
 * node_modules/worktrees/bench), verifies each source exists, and emits a JSON array of
 * tight candidate notes — the durable "why / must / never / chose X over Y" knowledge
 * extracted from each doc, NOT a raw restatement.
 *
 *   node scripts/ingest-docs.js            # writes bench/ingest/doc-notes.json
 *   node scripts/ingest-docs.js --stdout   # print to stdout instead
 *
 * Each note: { title, summary, source: <relative path>, kind: 'decision'|'constraint'|'doc' }
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'worktrees', 'bench', '.git']);
const OUT = path.join(REPO, 'bench', 'ingest', 'doc-notes.json');

/** Recursively glob *.md under REPO, skipping SKIP_DIRS. Returns repo-relative paths. */
function globDocs(dir = REPO, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') && ent.name !== '.claude-plugin') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      globDocs(full, out);
    } else if (ent.isFile() && ent.name.endsWith('.md')) {
      out.push(path.relative(REPO, full));
    }
  }
  return out;
}

/**
 * Distilled candidate notes, keyed by source. The distillation is curated (the durable
 * rationale extracted from reading each doc), but every entry is verified against the live
 * glob below so stale sources surface loudly instead of emitting phantom notes.
 */
const NOTES_BY_SOURCE = {
  'README.md': [
    {
      title: 'Build on native tasks, never reimplement orchestration',
      summary: 'Claude Code already ships Workflow, Agent Teams, ultracode, and a native task system with blocks/blockedBy gating. The orchestrator deliberately does NOT reimplement any of it; it fills only two gaps native lacks — auto-routing per prompt, and a cross-session/workspace dependency graph.',
      kind: 'decision',
    },
    {
      title: 'Read native task files; never write them',
      summary: 'Native task JSON is the source of truth for native fields (status, intra-session deps). Writing it directly is unsafe (.lock, may be overwritten by Claude Code). All non-native data (cross-session edges, richer status, notes) lives in OUR overlay; agents mutate native only via TaskUpdate.',
      kind: 'constraint',
    },
    {
      title: 'Native task format is undocumented — isolate it behind one adapter',
      summary: 'The native task file format is internal/undocumented and may change across Claude Code versions. All file access is confined to lib/native-tasks.js so only one adapter breaks on a format change; formatHealth/health fail loud to surface drift.',
      kind: 'constraint',
    },
    {
      title: 'Cross-session task IDs must be namespaced session/id',
      summary: 'Native task IDs are local ("1","2",...) and unique only within a session dir. Any cross-session reference MUST be namespaced {session-uuid}/{id}; native sessions share no tasks (only Agent Teams share, within one team).',
      kind: 'constraint',
    },
    {
      title: 'Three sync sources reconciled by source authority',
      summary: 'Daemon ingests state from file-read (truth for native fields), hooks (low-latency signal only — they carry no deps/in_progress, so they just trigger a re-read), and agent MCP reports (truth for non-native fields only). Conflict rule: on a native field the file wins; non-native fields exist only in the overlay so there is nothing to reconcile.',
      kind: 'decision',
    },
    {
      title: 'Ghost edges store on the consumer; resolve foreign status on demand',
      summary: 'A cross-workspace dependency (provider in another workspace) is stored in the CONSUMER’s overlay (the graph whose derivation needs it). Foreign target status is resolved lazily per request (cached, cycle-guarded) so it can still gate ready/not_ready; the full foreign graph loads only on explicit GET /peek.',
      kind: 'decision',
    },
    {
      title: 'Daemon stays dumb; the intelligence is in subagent skills',
      summary: 'The self-learning loop (branch→test→judge→merge→record) keeps the daemon mechanical: it only exposes isolated git worktrees and a merge primitive. Judgement, planning, and benchmark research are subagent skills. If a skill wants a new endpoint it is probably overreaching.',
      kind: 'decision',
    },
    {
      title: 'merge_attempt auto-aborts on conflict, never forces',
      summary: 'Winner merge uses git merge --no-ff; on conflict it auto-aborts to a clean tree and returns {conflict, files}. The judge then records the conflict and escalates rather than forcing a merge — forcing defeats the point of judging.',
      kind: 'constraint',
    },
    {
      title: 'Git ops resolve target repo separately from the daemon workspace',
      summary: 'Every /git/* op resolves its repo by precedence: explicit repo_path > task overlay repo field > daemon workspace. This decouples branch/merge from the workspace because the common case is the workspace is not itself a git repo.',
      kind: 'decision',
    },
    {
      title: 'Converged-vs-iterate is decided mechanically in the daemon',
      summary: 'After a metric problem gets a judge verdict, the heartbeat (decideOptimize) decides iterate-vs-stop mechanically, NOT by LLM free-choice. Precedence: target met→converged; K no-winner rounds→stuck (escalate to human, never auto-cancel); diminishing deltas→converged; budget exhausted→stop; else iterate with prior_verdict so the planner proposes a DIFFERENT change.',
      kind: 'decision',
    },
    {
      title: 'A stuck optimization escalates to a human, never self-drops',
      summary: 'When the last K rounds produce no usable winner (all no-winner or all guardrail-regressed), the loop raises request_guidance and halts rather than quietly dropping or replanning the problem — a genuinely-broken problem must reach a human.',
      kind: 'constraint',
    },
    {
      title: 'Bearer-token auth is opt-in, default-deny allowlist when set',
      summary: 'Auth is off by default (back-compat: no token ⇒ every endpoint open). When ORCH_TOKEN / token-file is set it is a default-deny allowlist: writes (/mcp, /reset, /overlay/*, loop control) require it, reads stay open. Set it whenever exposing the daemon beyond localhost.',
      kind: 'decision',
    },
    {
      title: 'Measure work by output_tokens, not gross-minus-plumbing',
      summary: 'Benchmark caveat: MCP token attribution is sticky and buckets cache_read into "plumbing", producing a spurious "65% less work" artifact if you compute a gross−plumbing "net". Trust output_tokens for actual work and cost-weighted gross (cache_read ×0.1) for cost.',
      kind: 'constraint',
    },
    {
      title: 'Context cost is entirely payload size; lean payload → cost parity',
      summary: 'A/B benchmark finding: actual work was parity ON vs OFF on self-solvable tasks. The whole ON-vs-OFF cost difference is cache_read from re-attending the loaded payload + tool schemas each turn. A compact get_learnings payload (~1-3k vs ~25k) brought cost to parity. No work/quality benefit was measured (benefit unproven, not disproven).',
      kind: 'doc',
    },
    {
      title: 'Self-signed certs cannot shortcut local HTTPS; mkcert is required',
      summary: 'TLS validates the cert’s issuer against the system trust store regardless of localhost, so a self-signed cert (its own untrusted issuer) is rejected. mkcert -install adds a trusted local CA (the password step), which is the only reason it works. HTTPS is needed ONLY for the inline-chat connector or off-localhost exposure; normal local use skips it.',
      kind: 'constraint',
    },
    {
      title: 'Desktop app runs MCP but not settings.json hooks',
      summary: 'The desktop app runs .mcp.json servers but no settings.json hooks. So the MCP server self-boots the daemon and registers the workspace on startup — the graph + all tools work hookless. Hook-only features (auto-router, terminal status line) need the CLI; substitutes are the explicit skill + preview/inline UI.',
      kind: 'constraint',
    },
    {
      title: 'The PreToolUse gate enforces task existence, not status truth',
      summary: 'orch-gate.sh denies inline Write/Edit unless this session holds a claimed in_progress task (exit 2). Honest limit: it checks task EXISTENCE, not that the edit matches the task — a rubber-stamp task passes it. It fails OPEN when the daemon is unreachable so an outage never bricks editing.',
      kind: 'constraint',
    },
  ],
  'CLAUDE.md': [
    {
      title: 'Route substantive multi-step work through the orchestrator, not inline',
      summary: 'For any feature build, refactor, migration, audit, or multi-file change the main agent must NOT implement inline: decompose into TaskCreate nodes, wire them with suggest_links context/blocking edges, and dispatch the work to a background subagent that claims (start_task) and reports (complete_task). Keep the main thread free to orchestrate. Inline is allowed only for genuinely trivial edits.',
      kind: 'decision',
    },
    {
      title: 'New tasks must be wired in, never left as orphan roots',
      summary: 'After TaskCreate, always call suggest_links and add context/blocking edges so the task inherits prior context instead of becoming a disconnected root node.',
      kind: 'constraint',
    },
    {
      title: 'Capture durable decisions as note nodes; lean toward NOT recording',
      summary: 'Use record_decision for durable knowledge (a real decision with a reason, a non-obvious finding/constraint, or explicit "remember this"). Do NOT record chatter, restatements, or transient status. On a borderline case, lean toward NOT recording — note-node noise is worse than a missed minor point.',
      kind: 'decision',
    },
  ],
  'skills/parallel-orchestrate/SKILL.md': [
    {
      title: 'Two-tier context handoff between dependent tasks',
      summary: 'Token-saving contract: on finish, complete_task stores a SHORT interface summary. Dependents read all dep summaries via get_dependency_summaries (Tier 1, cheap, usually enough) and only deep-fetch get_task_detail (Tier 2) for a specific dependency when depth is actually needed. attach_knowledge adds precise reusable items so dependents fetch instead of re-deriving.',
      kind: 'decision',
    },
    {
      title: 'Serialize file-coupled tasks; the graph tracks logical deps only',
      summary: 'The orchestrator graph tracks logical dependencies, NOT file-write contention. Before parallelizing, check tasks don’t share files: disjoint areas fan out in parallel, file-coupled tasks must be serialized (one background agent at a time) even if logically independent.',
      kind: 'constraint',
    },
  ],
  'skills/orch-loop/SKILL.md': [
    {
      title: 'Autonomous loop holds every code change; merge is a human decision',
      summary: 'Default hold-merge mode: every code-producing task works in an isolated worktree off the code repo (branch orch/attempt/<slug>), NEVER edits the live checkout and NEVER merges to main. It completes with a "MERGE PENDING" summary so the task reaches done. The loop never merges and never halts on guidance — it queues everything for human review in the morning.',
      kind: 'decision',
    },
    {
      title: 'The daemon decides each tick; the agent only executes and reschedules',
      summary: 'next_action returns spawn/idle/stop/plan/optimize/await_user plus an adaptive next_poll_seconds. The agent acts and reschedules via ScheduleWakeup; it does not reason on idle ticks (one MCP call + one-word reply). Hard token/iteration caps and auto-stop on drain are enforced by the daemon.',
      kind: 'decision',
    },
    {
      title: 'Cooperative stop is enforced by the daemon inside next_action',
      summary: 'The heartbeat tick runs in-process so the PreToolUse stop hook cannot interrupt it. Instead every next_action first polls the loop’s stop signal (cancel on the loop’s claimed task or stop on its agent); if set it returns stop and clears loop.active, so the loop self-exits within one iteration. Pass session to loop_control(action:"start") to arm this.',
      kind: 'constraint',
    },
  ],
  'skills/self-learn-judge/SKILL.md': [
    {
      title: 'Judge metric-first when a spec is present, else rationale',
      summary: 'When the problem carries a metric spec + measurements, judge METRIC-FIRST: improvement vs baseline, guardrail regressions (a near-veto), and gap to a researched competitor benchmark (confidence-weighted tiebreaker). Otherwise fall back to test pass/fail then rationale (simplest diff, fewest side effects, matches style). The judge weighs tradeoffs with judgment, NOT a fixed weighted-score formula.',
      kind: 'decision',
    },
    {
      title: 'Judge evaluates only; never generates or edits attempts',
      summary: 'Rival generation happens upstream. In metric mode the judge reads measurements + benchmark and weighs tradeoffs but never writes code, invents attempts, or fabricates a benchmark (absent node.benchmark ⇒ baseline-only). A guardrail regression is a near-veto, not a footnote.',
      kind: 'constraint',
    },
    {
      title: 'Escalate the user’s calls; never force an outcome',
      summary: 'No passing attempt, a conflicting winner, or a genuinely ambiguous (low-confidence/high-impact) choice → record the verdict and request_guidance instead of forcing a merge or guessing. Honor escalation config toggles (a disabled trigger means proceed with best judgment). Under the autonomous loop this is overridden by hold-merge mode — record + queue, never halt.',
      kind: 'constraint',
    },
  ],
  'skills/self-learn-planner/SKILL.md': [
    {
      title: 'Planner only ADDs nodes; never touches in-flight work',
      summary: 'The planner caused a runaway once. Hard rules: NEVER cancel/supersede an in-flight task (re-planning live work is the user’s call), NEVER duplicate an existing open task (suggest_links + dedup BEFORE TaskCreate), cap output at 1-3 initiatives, and if nothing is genuinely worth doing, STOP rather than fabricate busywork — graph bloat is failure.',
      kind: 'constraint',
    },
    {
      title: 'Check the rejected-approaches ledger before proposing',
      summary: 'get_learnings().rejected[] is the pre-digested ledger of approaches already tried-and-lost (source:’verdict’, with reason + beatenBy) or genuine dead ends (source:’failure’). Test every candidate against it: drop a re-proposed losing approach or pivot to a different one, and when adjacent to a settled question cite the prior verdict so the lesson propagates.',
      kind: 'decision',
    },
    {
      title: 'Research only when it would flip the decision',
      summary: 'The deep-research step is expensive; skip it unless an external fact would actually change which initiative is proposed (or whether to propose one). One focused, bounded pass — never a survey.',
      kind: 'constraint',
    },
  ],
  'skills/self-learn-benchmark/SKILL.md': [
    {
      title: 'Never fabricate a benchmark; degrade to baseline-only',
      summary: 'A wrong benchmark is worse than none — it would mislead the judge. Run bounded research (≤~5 queries, prefer reputable primary sources); a credible figure requires a real source (the daemon rejects a record with no source). No credible source ⇒ record nothing and signal "no benchmark — baseline-only" so the judge degrades gracefully.',
      kind: 'constraint',
    },
  ],
  'skills/setup/SKILL.md': [
    {
      title: 'Setup is an idempotent doctor; never run password steps silently',
      summary: 'The setup wizard detects what is already done and skips it, and must never run a step that needs a password (mkcert -install / Keychain) without telling the user what to expect. The inline-UI connector-add is a UI action only the user can perform; if it can’t be reached, the preview panel remains the working in-app dashboard.',
      kind: 'constraint',
    },
  ],
};

function main() {
  const found = new Set(globDocs());
  const declared = Object.keys(NOTES_BY_SOURCE);

  // Loud failure on drift: a declared source that no longer exists, or a doc with no notes.
  const missing = declared.filter((s) => !found.has(s));
  if (missing.length) {
    console.error('ingest-docs: declared source(s) not found on disk (stale distillation):');
    for (const m of missing) console.error('  - ' + m);
    process.exitCode = 1;
  }
  const undistilled = [...found].filter((s) => !NOTES_BY_SOURCE[s]);
  if (undistilled.length) {
    console.error('ingest-docs: doc(s) globbed but not distilled (add notes or skip):');
    for (const u of undistilled) console.error('  - ' + u);
  }

  const notes = [];
  for (const source of declared) {
    if (!found.has(source)) continue; // skip stale; already flagged above
    for (const n of NOTES_BY_SOURCE[source]) {
      notes.push({ title: n.title, summary: n.summary, source, kind: n.kind });
    }
  }

  const json = JSON.stringify(notes, null, 2);
  if (process.argv.includes('--stdout')) {
    process.stdout.write(json + '\n');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, json + '\n');
    console.error(`ingest-docs: wrote ${notes.length} candidate notes from ${declared.length} docs → ${path.relative(REPO, OUT)}`);
  }
}

main();
