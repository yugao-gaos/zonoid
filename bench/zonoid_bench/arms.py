"""bench/zonoid_bench/arms.py — Zonoid Bench SDK: the arms module.

The ONE canonical "Zonoid ON arm" + its contrast arms, replacing the three divergent
per-bench implementations called out in docs/bench-sdk-design.md §1:

  - SWE-Bench-CL judged the autowire candidate set + read tiered /search.
  - agent-memory judged ALL sessions (no suggest_links, inflated by the full session set).
  - FeatureBench used suggest_links + a real agent (claude_code.ClaudeCodeAgent) — the closest
    to canonical, and the reference this module PORTS.

Canonical ON-arm wiring (design §5) — PRODUCTION-FAITHFUL eager-judge pipeline
(OVERRIDE note-mqhha58fz9k corrects the earlier FeatureBench port: the canonical arm must run the
REAL LLM eager-judge over autowire candidates, NOT a ceScore threshold. P3 de-ports the judge:
the bench no longer runs ANY judge LLM of its own — it DRIVES the production sync judge over HTTP):

  1. mint the unit as a TASK PROBE  ......... workspace.drop_task_stub + client.post_status
                                              (status="not_ready", summary=question). The status
                                              write drives the daemon ingest funnel
                                              (embed → setTaskVec → autowireNewTaskWholeGraph →
                                              markEagerJudge): autowire SEEDS weight-0 candidate
                                              context edges from NOTE providers INTO the probe
                                              according to the daemon's configured candidate policy.
                                              The canonical bench daemon inherits production's 0-floor
                                              + top-K, so the production judge arbitrates the candidate
                                              set instead of a hard cosine floor. The probe is stamped
                                              `judging` (judgingSince).
  2. workspace-scoped search bullets  ......  client.search(q=task_summary) for diagnostic
                                              provenance only — NOT injected into AGENTS.md and
                                              NOT how the DAG edges are chosen.
  3. DRIVE the PRODUCTION sync judge  ....... client.judge_drain(node=<probe>, budget=N) — ONE call
                                              to POST /judge/drain (P1). The daemon's in-process judge
                                              (lib/headless-drain.runJudgeDrainSync → resolveJudgeBackend
                                              → provider.runJudgeLoop) pulls THIS probe's unjudged
                                              autowire candidate edge-set via /judge/next?node=, applies
                                              the SAME keep/prune rubric (buildJudgePrompt), and posts
                                              keepEdge/pruneEdge — keepEdge promotes the weight-0 autowire
                                              candidate IN PLACE so it re-enters ranked retrieval, pruneEdge
                                              deletes it. The bench runs NO judge LLM, holds NO rubric,
                                              parses NO verdict — there is ONE judge, in production.
                                              Returns {judged, kept, pruned, idle, rounds}.
  4. read the frozen judged DAG  ............ read_wired_context(probe) via GET /task/context — the
                                              candidate edges the production judge KEPT surface as
                                              weight>0 context deps. These are the verified wired edges
                                              (the bench reads them back; it does not author them).
  5. read = production task search  ......... client.search(..., task_key=<probe>) — after eager
                                              judgment, a settled probe returns system notes plus
                                              frozen DAG context. It is DAG-only: semantic RAG is
                                              not appended to that response.

WHY a TASK probe + a LIVE-bound daemon (note-mqgwrh5a63x, note-mqh0gwz1mxc):
  - The eager judge is task-centric: /judge/next?node=, markEagerJudge, and the judging→ready gate
    all key off a TASK node, and autowire seeds NOTE→TASK candidate edges. So the unit is minted as
    a task PROBE (the question is its summary), not a note. A note is a context PROVIDER, never the
    consumer that owns task-scoped retrieval.
  - keepEdge promotes a PRE-EXISTING weight-0 autowire candidate edge in place (lib/judge.js). It
    only fires for a candidate the daemon actually seeded. The canonical bench daemon inherits the
    production 0-floor (P2) + uncapped top-K fan-out, so candidate selection is broad and the
    PRODUCTION judge (driven via /judge/drain) performs the keep/prune arbitration. There is still no
    createEdge rescue path.
  - /judge/drain, /judge/next, and the keepEdge save are ALL HARD-BOUND to the daemon's live
    state.workspace (routes/judge.js): a keepEdge on a non-live (isolated) workspace is not visible to
    the settled task-scoped read (note-mqgwrh5a63x). The drain itself runs IN the daemon process and
    reads state.workspace, so the bench runs ONE embedded daemon per unit whose LIVE workspace IS the
    unit dir (daemon.start(workspace=)); the whole pipeline then operates on one consistent in-memory +
    persisted overlay and the kept edge surfaces through task-scoped retrieval.

Pluggable executor (design §5):
  - ``agent_in_container``   : build the AGENTS.md for a REAL agent with API-only memory/search
                               instructions; the bench spawns the agent and grades by its tests.
                               Returns AGENTS.md text + resolved context provenance (no LLM call
                               here).
  - ``retrieve_and_answer``  : read production ``/search?task_key=`` context and answer via
                               ``judge.claude_p`` (a tool-less completion), scored vs a gold answer
                               (QA benches — can't spawn a real agent per 500 probes).

Contrast arms (design §5):
  - ``cold``                 : NO memory at all (rigging guard / floor). If cold scores as well as
                               an ON arm, the unit was answerable from world knowledge → rigged.
  - ``rag_control``          : client.search WITHOUT task_key — retrieval-time baseline ("normal RAG
                               memory"), no DAG wiring, no probe task.

Autowire candidate coverage (honest limitation)
-----------------------------------------------
Because the kept edge MUST be a real autowire candidate (keepEdge promotes in place — it cannot
manufacture an edge autowire never seeded), the ON arm can only keep candidates returned by the
daemon's configured autowire policy. The canonical bench daemon inherits the production 0-floor (P2)
+ uncapped top-K, so stale hard-floor miss language does not apply to SDK bench runs. If an
externally supplied daemon uses a stricter policy and the production judge keeps nothing, the arm
reports judge_idle honestly and still never falls back to createEdge or the old ceScore-threshold +
overlay_edge path.

Runtime: stdlib ONLY (urllib/json/subprocess via client.py + judge.py). Runs on the embeddable
Python 3.12 at C:\\Users\\Imyu\\AppData\\Local\\py312embed\\python.exe as well as Mac/Linux CPython.
"""

from __future__ import annotations

import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import json
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

# Embeddable Python 3.12 (py312embed) strips cwd from sys.path. Insert the directory containing
# this file's package parent (bench/) so ``zonoid_bench`` is importable regardless of cwd, mirroring
# the bootstrap in smoke_daemon.py / probe_runner.py.
_HERE = os.path.dirname(os.path.abspath(__file__))
_BENCH = os.path.dirname(_HERE)
if _BENCH not in sys.path:
    sys.path.insert(0, _BENCH)

from zonoid_bench.client import ZonoidClient  # noqa: E402
from zonoid_bench import judge as judge_mod  # noqa: E402
from zonoid_bench.workspace import drop_task_stub  # noqa: E402


# ---------------------------------------------------------------------------
# Tunables (env-overridable, same convention as the rest of the SDK)
# ---------------------------------------------------------------------------

# Per-round adjudication budget forwarded to the production sync judge (POST /judge/drain?budget=).
# The daemon clamps this to [1, 50]; the per-node candidate set is small so 20 is ample headroom.
JUDGE_BUDGET: int = int(os.environ.get("ZONOID_BENCH_JUDGE_BUDGET", "20"))

# Minimum plain-cosine score for a /search hit to be retained as diagnostic context provenance.
# Used only for WiringResult.context_deps — NOT for DAG edge selection, which is the eager judge's
# job, and NOT injected into AGENTS.md (agent memory access stays API-only).
SEARCH_SCORE_FLOOR: float = float(os.environ.get("ZONOID_BENCH_SEARCH_FLOOR", "0.1"))

# How many /search hits to keep as diagnostic provenance for agent_in_container.
CONTEXT_TOPK: int = int(os.environ.get("ZONOID_BENCH_CONTEXT_TOPK", "6"))

# top-k for the rag_control arm's /search.
RAG_CONTROL_K: int = int(os.environ.get("ZONOID_BENCH_SEARCH_K", "5"))

# Char budget per diagnostic /search summary and answer-context block.
SUMMARY_BUDGET: int = int(os.environ.get("ZONOID_BENCH_SUMMARY_BUDGET", "2000"))

# How long to wait for the daemon to adopt a dropped task stub (file-drop lane, ~1.5 s adoption).
ADOPT_TIMEOUT_S: float = float(os.environ.get("ZONOID_BENCH_ADOPT_TIMEOUT", "20"))
# How long to let the ingest funnel embed + autowire after the status write before reading.
AUTOWIRE_SETTLE_S: float = float(os.environ.get("ZONOID_BENCH_AUTOWIRE_SETTLE", "6"))
_POLL_INTERVAL_S: float = 0.75

# Harness namespace for unit task/probe stubs (avoid "followup" and UUID-like names — see
# workspace.drop_task_stub).
UNIT_HARNESS: str = os.environ.get("ZONOID_BENCH_UNIT_HARNESS", "bench")


# ---------------------------------------------------------------------------
# Answer prompt templates (shared, ported from probe_runner)
# ---------------------------------------------------------------------------

_ANSWER_TEMPLATE = (
    "Answer the question using ONLY the context provided below.\n\n"
    "Rules:\n"
    "1. Give the SPECIFIC fact (a name, date, place, number, or short phrase) — NOT a generic "
    "relational answer like 'the person mentioned' or 'what was discussed'.\n"
    "2. Answer from PARAPHRASED evidence: if the fact is clearly present in the context but "
    "stated in different words, still extract and state the specific answer — do NOT say "
    "'I don't know' just because the wording differs from the question.\n"
    "3. RESOLVE relative time expressions (e.g. 'yesterday', 'last week', 'this month', "
    "'next Tuesday') against any 'Session date:' line present in the context. Convert them "
    "to the actual calendar date or month in your answer.\n"
    "4. Reply with ONLY the answer — a short phrase or sentence, no explanation.\n"
    "5. If the answer truly cannot be determined from the context, reply exactly: I don't know.\n\n"
    "CONTEXT:\n{context}\n\n"
    "QUESTION: {question}\n\n"
    "ANSWER:"
)

_COLD_TEMPLATE = (
    "Answer the question concisely — reply with just the answer (a short phrase or sentence), "
    "no explanation. If you do not know, reply exactly: I don't know.\n\n"
    "QUESTION: {question}\n\n"
    "ANSWER:"
)


# ---------------------------------------------------------------------------
# Result dataclasses
# ---------------------------------------------------------------------------

@dataclass
class WiringResult:
    """The outcome of the canonical ON-arm eager-judge wiring for one unit.

    P3: the bench no longer runs its own judge — it DRIVES the production sync judge via
    POST /judge/drain. The {judged,kept,pruned,idle,rounds} fields are the daemon's drain counts;
    wired_edges is read back from /task/context (the kept weight>0 context edges the production
    judge promoted). The bench authors NO verdict.

    Attributes
    ----------
    task_key        : the probe TASK key in the graph (the node autowire seeds context edges INTO).
    node_kind       : always "task" — the eager judge is task-centric (see module docstring).
    context_deps    : diagnostic /search bullets {label, summary, score} retained for provenance
                      only — NOT injected into AGENTS.md and NOT how DAG edges are chosen.
    wired_edges     : the candidate PROVIDER keys the PRODUCTION judge KEPT, read back from
                      /task/context as the weight>0 context deps of the probe (keepEdge promoted
                      them in place). The bench reads these; it does not author them.
    candidates_seen : the kept providers, with their post-drain verdict {key, title, edge:"keep"}.
                      (The drain returns counts, not per-candidate pruned keys, so only KEPT
                      providers — the ones that surface in /task/context — are enumerated here.)
    pruned_edges    : retained for API stability; the production drain returns a pruned COUNT
                      (see `pruned`), not the individual pruned provider keys, so this stays empty.
    judge_idle      : True when the production judge had NO candidate to keep — it judged nothing,
                      kept nothing, and no weight>0 context edge surfaced. Distinguishes "judged,
                      kept nothing / kept something" from "nothing was ever seeded to judge".
    search_hits     : raw /search hit keys (provenance).
    judged          : production drain count — candidate edges that left the unjudged set (kept+pruned).
    kept            : production drain count — keepEdge verdicts the production judge applied.
    pruned          : production drain count — pruneEdge verdicts the production judge applied.
    rounds          : production drain count — runJudgeLoop rounds the sync judge ran (bounded).
    drain_skipped   : the drain's `skipped` reason when the backend was unusable (e.g. no_backend),
                      else None. A skip is an honest clean pause, not a wiring error.
    timeout_kills   : retained for report API stability. The PER-CALL timeout now lives inside the
                      production drain (runJudgeDrainSync wraps each round in cfg.timeoutMs); the
                      bench no longer runs/retries a judge call, so this stays 0 here.
    judge_idle_count: how many times the production judge had no candidate to keep for this wiring
                      call. Currently 0 or 1 (one drain per run_canonical_wiring), exposed as a count
                      so callers can aggregate across a batch.
    provisional_kept: retained for report API stability. Provisional-on-timeout handling now lives
                      inside the production drain, so the bench reports 0 here.
    """

    task_key: str
    node_kind: str
    context_deps: list[dict[str, Any]] = field(default_factory=list)
    wired_edges: list[str] = field(default_factory=list)
    candidates_seen: list[dict[str, Any]] = field(default_factory=list)
    pruned_edges: list[str] = field(default_factory=list)
    judge_idle: bool = True
    search_hits: list[str] = field(default_factory=list)
    # Production sync-judge drain counts (POST /judge/drain → runJudgeDrainSync).
    judged: int = 0
    kept: int = 0
    pruned: int = 0
    rounds: int = 0
    drain_skipped: Optional[str] = None
    # Retained for report.py API stability (the timeout/provisional path now lives in the daemon).
    timeout_kills: int = 0
    judge_idle_count: int = 0
    provisional_kept: int = 0


@dataclass
class ArmResult:
    """The outcome of running one arm on one unit.

    Attributes
    ----------
    arm        : arm label ("on", "cold", "rag_control").
    mode       : executor mode for the ON arm ("agent_in_container" | "retrieve_and_answer"), else "".
    predicted  : the answer text (retrieve_and_answer / cold / rag_control); "" for agent_in_container.
    agents_md  : the AGENTS.md text (agent_in_container only), else "".
    context_keys: the node keys whose summaries fed the answer (provenance).
    wiring     : the WiringResult for the ON arm (None for contrast arms).
    grader     : the agentic+grader provenance ({enabled, rounds, kept_keys, last_verdict, ...})
                 when retrieval="agentic" exercised the production grader path; {} otherwise.
    """

    arm: str
    mode: str = ""
    predicted: str = ""
    agents_md: str = ""
    context_keys: list[str] = field(default_factory=list)
    wiring: Optional[WiringResult] = None
    ctx_chars: int = 0
    answer_input_tokens: int = 0
    answer_output_tokens: int = 0
    grader: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Canonical ON-arm wiring (the headline — port of FB _setup_zonoid_context)
# ---------------------------------------------------------------------------

def _clip(text: str, n: int = SUMMARY_BUDGET) -> str:
    return (text or "")[:n]


def _mint_probe_task(
    client: ZonoidClient,
    unit_id: str,
    task_summary: str,
    *,
    data_dir: Optional[str],
) -> str:
    """Mint the bench unit as a TASK PROBE and drive the autowire ingest funnel; return its key.

    The eager judge is task-centric (see module docstring), so the unit is ALWAYS a task node:

      1. drop a file-drop task stub (workspace.drop_task_stub) so the unit is a TASK node.
      2. wait for the daemon to adopt the stub (it becomes visible in buildGraph).
      3. POST /overlay/status {status:"not_ready", summary} to fire the first-vec ingest funnel
         (embed → setTaskVec → autowireNewTaskWholeGraph (seed weight-0 NOTE→probe candidate edges
         according to daemon candidate policy) → markEagerJudge (stamp judgingSince)).
         status:not_ready — NOT
         in_progress, which would trip the unwired-claim + judging-gate.
      4. settle so the embed + autowire complete before the eager-judge pull reads the candidates.
    """
    if not data_dir:
        raise ValueError("run_canonical_wiring requires data_dir (where the file-drop stub is written)")
    ws = client.workspace
    if not ws:
        raise ValueError("client.workspace must be set to register a probe task stub")
    task_key = drop_task_stub(
        data_dir, ws, unit_id, task_summary, harness=UNIT_HARNESS,
        agent_id="zonoid_bench_arms",
    )
    _wait_for_adoption(client, task_key, ADOPT_TIMEOUT_S)
    client.post_status(task_key, "not_ready", summary=task_summary)
    time.sleep(min(AUTOWIRE_SETTLE_S, 6.0))
    return task_key


def _wait_for_adoption(client: ZonoidClient, task_key: str, timeout_s: float) -> bool:
    """Poll GET /task/context until the daemon has adopted *task_key* (200), or timeout.

    Mirrors probe_runner._wait_for_task_adoption. Bounded poll with a hard deadline (the handoff
    permits a bounded poll for task adoption inside arms code).
    """
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            client.get_task_context(task_key, timeout=30)
            return True  # 200 ⇒ task exists
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
        except Exception:  # noqa: BLE001 — transient, keep polling
            pass
        time.sleep(_POLL_INTERVAL_S)
    return False


def _is_note_hit(hit: dict[str, Any]) -> bool:
    """Return True iff *hit* is an ingested session NOTE, not a harness task stub.

    The search index contains both ingested NOTE nodes (kind='knowledge') and harness TASK
    STUB nodes (kind='task') — probe/bench stubs minted during the same bench run.  Stubs are
    ANCHORS (autowire seeds edges FROM them to session notes), not MEMORY; including them as
    retrieved context injects garbage and makes the rag_control arm score 0% (the stubs contain
    task metadata, not session content).  We exclude them by checking two independent signals:

      1. kind != 'task'  — daemon-authoritative: notes are 'knowledge', stubs are 'task'.
      2. key prefix not in ('probe/', 'bench/')  — belt-and-suspenders: harness namespaces.
    """
    key = hit.get("key") or ""
    if hit.get("kind") == "task":
        return False
    if key.startswith("probe/") or key.startswith("bench/"):
        return False
    return True


def run_canonical_wiring(
    client: ZonoidClient,
    unit_id: str,
    task_summary: str,
    *,
    data_dir: Optional[str] = None,
    judge: Optional[Any] = None,  # noqa: ARG001 — accepted for signature stability; bench runs no judge
    judge_budget: int = JUDGE_BUDGET,
    # Accepted for back-compat with older callers; the eager judge is always task-based so these
    # are advisory only (the unit is ALWAYS minted as a task probe).
    as_task: bool = True,  # noqa: ARG001 — kept for signature stability
    tags: Optional[list[str]] = None,  # noqa: ARG001 — unused in the task-probe path
) -> WiringResult:
    """Run the PRODUCTION-FAITHFUL canonical ON-arm wiring for one unit — DRIVING the prod judge.

    P3: the bench runs NO judge LLM of its own. It mints the probe, then makes ONE call to the
    production sync judge (POST /judge/drain → lib/headless-drain.runJudgeDrainSync), and reads the
    kept edges back. The keep/prune rubric, /judge/next pull, and /judge/verdict write all live in
    production — there is exactly one judge implementation.

    Steps (see module docstring for the full rationale + note provenance):

      1. mint the unit as a TASK PROBE → drive autowire (seed weight-0 NOTE→probe candidate edges
         according to daemon candidate policy) + markEagerJudge.  (_mint_probe_task)
      2. client.search(q=task_summary, workspace=...) → /search provenance bullets
         (diagnostics ONLY — NOT injected into AGENTS.md and NOT how DAG edges are chosen).
      3. client.judge_drain(node=<probe>, budget=...) → drive the PRODUCTION sync judge to drain the
         probe's autowire candidate edge-set to idle (keepEdge/pruneEdge applied IN the daemon).
      4. read_wired_context(<probe>) → the weight>0 context deps the production judge KEPT.

    `judge` is accepted for signature stability but ignored (the bench holds no judge). `judge_budget`
    is forwarded to /judge/drain (per-round adjudication budget, clamped 1..50 by the daemon).

    Returns a WiringResult capturing the probe key, diagnostic /search bullets, the production drain
    counts {judged,kept,pruned,rounds}, the KEPT provider keys read back from /task/context, and
    judge_idle (the production judge had no candidate to keep).
    """
    node_key = _mint_probe_task(client, unit_id, task_summary, data_dir=data_dir)

    result = WiringResult(task_key=node_key, node_kind="task")

    # ---- Step 2: /search bullets (diagnostic provenance ONLY) ----
    # Over-fetch then filter stubs — same kind-filter as run_rag_control (_is_note_hit).
    raw_hits = client.search(task_summary, k=CONTEXT_TOPK * 4, gated=False)
    note_hits_step2 = [h for h in raw_hits if _is_note_hit(h)]
    for h in note_hits_step2[:CONTEXT_TOPK]:
        summary = h.get("summary") or ""
        score = h.get("score") or 0
        label = h.get("label") or ""
        if summary and score > SEARCH_SCORE_FLOOR:
            result.context_deps.append(
                {"label": label, "summary": _clip(summary), "score": score}
            )
        if h.get("key"):
            result.search_hits.append(h["key"])

    # ---- Step 3: DRIVE the production sync judge (POST /judge/drain) ----
    # ONE call drains the probe's whole unjudged autowire candidate edge-set to idle (or the
    # budget/round ceiling) by REUSING the in-process production judge: runJudgeDrainSync →
    # resolveJudgeBackend → provider.runJudgeLoop, the SAME prompt + /judge/next + /judge/verdict
    # path the eager/background drains use. The bench holds NO rubric and parses NO verdict.
    drain = client.judge_drain(node_key, budget=judge_budget)
    result.judged = int(drain.get("judged") or 0)
    result.kept = int(drain.get("kept") or 0)
    result.pruned = int(drain.get("pruned") or 0)
    result.rounds = int(drain.get("rounds") or 0)
    result.drain_skipped = drain.get("skipped")

    # ---- Step 4: read back the KEPT context edges (the production judge's keepEdge promotions) ----
    # read_wired_context filters /task/context to weight>0 context deps — exactly the candidates the
    # production judge promoted in place via keepEdge. The bench reads these; it authors nothing.
    try:
        kept_ctx = read_wired_context(client, node_key)
    except Exception as exc:  # noqa: BLE001 — context read is best-effort; treat as empty on failure
        print(f"[arms] read_wired_context failed (non-fatal): {exc}", file=sys.stderr)
        kept_ctx = []
    for d in kept_ctx:
        key = d.get("key")
        if not key:
            continue
        result.wired_edges.append(key)
        result.candidates_seen.append({
            "key": key, "title": d.get("label", ""), "edge": "keep"
        })

    # judge_idle = the production judge had NOTHING to keep: it judged nothing, kept nothing, and no
    # weight>0 context edge surfaced. (A drain that judged>0 but kept 0 — pruned everything — is NOT
    # idle: there WERE candidates, the judge just kept none. Only "no candidate seeded at all" is
    # idle.) The drain's own `idle` flag means "queue drained", NOT "no candidates", so it is not
    # used directly here.
    result.judge_idle = (result.judged == 0 and result.kept == 0 and not result.wired_edges)
    if result.judge_idle:
        result.judge_idle_count = 1

    return result


# ---------------------------------------------------------------------------
# Reading the wired DAG context (the frozen-DAG read surface)
# ---------------------------------------------------------------------------

def read_wired_context(client: ZonoidClient, node_key: str) -> list[dict[str, Any]]:
    """Read the frozen DAG context for *node_key* via GET /task/context.

    Returns the context dependency entries with weight > 0 (the wired/kept context edges).
    Weight-0 edges are unjudged autowire candidates — the daemon lists them but they are NOT
    verified context, so we filter them out client-side (same as probe_runner line 594; the
    /task/context route itself does not drop them — see routes/task.js:71-74).

    Each entry: {key, label, status, summary, via:"context", weight}.
    """
    ctx = client.get_task_context(node_key)
    return [
        d
        for d in (ctx.get("dependencySummaries") or [])
        if d.get("via") == "context" and (d.get("weight") or 0) > 0
    ]


def read_task_search_context(
    client: ZonoidClient,
    node_key: str,
    query: str,
    *,
    k: int = 5,
) -> list[dict[str, Any]]:
    """Read the task-scoped production search response after eager judgment.

    A settled probe is non-provisional, so ``/search?task_key=`` returns system notes plus
    frozen DAG context and omits semantic RAG. A provisional probe may legitimately return a
    RAG tier; callers preserve the daemon's tier instead of manufacturing a separate fill.
    """
    return client.search(query, k=k, gated=False, task_key=node_key)


def task_search_context_label(hit: dict[str, Any]) -> str:
    """Map production search tiers to answer-context labels without relabeling them as RAG."""
    tier = str(hit.get("tier") or "dag")
    if tier == "system":
        return "SYSTEM"
    if tier in {"dag", "dag-note", "surrounding"}:
        return "DAG"
    return tier.upper()


def read_agentic_search_context(
    client: ZonoidClient,
    node_key: str,
    query: str,
    *,
    k: int = 5,
    max_rounds: Optional[int] = None,
    use_grader: Optional[bool] = True,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Read context through the PRODUCTION AGENTIC + LLM-GRADER path (POST /subconscious/search-context).

    This is the byte-identical production retrieval surface the live agentic loop uses:
    ``store.searchContext`` on ``defaultSubconsciousStore`` (graderEnabled:true) runs the adaptive
    multi-round search and invokes the LLM grader per round (gradeSearchRound). The one-shot
    ``/search?task_key=`` surface used by ``read_task_search_context`` does NOT exercise the grader —
    this does, so the ON arm built on it is identical to production retrieval.

    Returns ``(items, grader)`` where:
      - ``items``  : the envelope's ``context_deps`` — selected context entries
                     [{key, title, summary, relevance_score, ...}] to feed the answerer.
      - ``grader`` : the envelope's ``grader`` provenance object (``{}`` if the grader did not run /
                     degraded to the heuristic floor) — the evidence the agentic+grader loop fired
                     (``grader["rounds"] >= 1`` and ``grader["enabled"] is True``).
    """
    envelope = client.search_context(
        node_key, query=query, k=k, max_rounds=max_rounds, use_grader=use_grader
    )
    if not isinstance(envelope, dict):
        return [], {}
    items = envelope.get("context_deps")
    if not isinstance(items, list):
        # Fall back to the raw selected results if context_deps is absent for any reason.
        items = envelope.get("context") if isinstance(envelope.get("context"), list) else []
    grader = envelope.get("grader") if isinstance(envelope.get("grader"), dict) else {}
    return items, grader


# ---------------------------------------------------------------------------
# Executor (a): agent_in_container — build AGENTS.md for a real agent
# ---------------------------------------------------------------------------

def build_agents_md(
    unit_id: str,
    agent_url: str,
    context_deps: list[dict[str, Any]],
    workspace: Optional[str] = None,
) -> str:
    """Build the /testbed/AGENTS.md a real agent reads.

    The prompt intentionally does NOT include raw KB summaries or answers. It only gives live curl
    instructions (task context / search / record / mark-done) pointing at *agent_url* (the host
    gateway URL the in-container agent can reach). The active executor path passes *workspace* so all
    /search and overlay calls are scoped to the isolated bench workspace.

    The wires the agent records mid-session carry ``wires_to:[unit_id]`` for provenance
    (CLAUDE.md KB-authoring rule).
    """
    _ = context_deps  # retained in the signature for callers that inspect WiringResult provenance.
    workspace = workspace or ""
    workspace_q = urllib.parse.quote(workspace, safe="")
    task_key_q = urllib.parse.quote(unit_id, safe="")
    note_body = json.dumps(
        {
            "workspace": workspace,
            "wires_to": [unit_id],
            "title": "Finding title",
            "summary": "What you discovered",
        },
        separators=(",", ":"),
    )
    status_body = json.dumps(
        {
            "workspace": workspace,
            "key": unit_id,
            "status": "done",
            "summary": "One-line summary of what you implemented",
        },
        separators=(",", ":"),
    )
    search_url = (
        f"{agent_url}/search?q=YOUR+QUERY+HERE&workspace={workspace_q}"
        f"&task_key={task_key_q}&gated=false"
    )
    context_url = f"{agent_url}/task/context?key={task_key_q}&workspace={workspace_q}"

    lines = [
        "# Zonoid Knowledge Base",
        "",
        f"A local isolated Zonoid bench daemon is accessible at **{agent_url}**.",
        "It only contains knowledge the bench harness explicitly loaded into this workspace",
        "(for example via warm.load_snapshot/onboarding injection); do not assume it starts",
        "prepopulated.",
        "",
        f"**Your task ID**: `{unit_id}`",
        f"**Workspace**: `{workspace}`",
        "",
    ]

    lines += [
        "## Instructions",
        "",
        "**Before writing any code**, complete these steps:",
        "",
        "### 1. Read task-scoped context through the bench API:",
        "```bash",
        f'curl -s "{context_url}"',
        "```",
        "",
        "### 2. Search for relevant knowledge as you work:",
        "```bash",
        f'curl -s "{search_url}"',
        "```",
        "",
        "### 3. Record discoveries for future tasks:",
        "```bash",
        f"curl -s -X POST {agent_url}/overlay/note \\",
        "  -H 'Content-Type: application/json' \\",
        f"  -d '{note_body}'",
        "```",
        "",
        "### 4. Mark task complete when done:",
        "```bash",
        f"curl -s -X POST {agent_url}/overlay/status \\",
        "  -H 'Content-Type: application/json' \\",
        f"  -d '{status_body}'",
        "```",
        "",
    ]
    return "\n".join(lines)


def run_agent_in_container(
    client: ZonoidClient,
    unit_id: str,
    task_summary: str,
    *,
    agent_url: Optional[str] = None,
    as_task: bool = False,
    data_dir: Optional[str] = None,
    tags: Optional[list[str]] = None,
) -> ArmResult:
    """ON arm, executor (a): run the eager-judge DAG wiring, then build the AGENTS.md for a REAL agent.

    The bench (FeatureBench) runs the real Claude Code agent against this AGENTS.md and grades by
    the repo's tests; this function does NOT spawn the agent or call any LLM beyond the eager judge.
    It returns the AGENTS.md text + context provenance so the bench's container runner can provide
    only API instructions, never raw gold answers or hidden benchmark artifacts.

    *agent_url* is the URL the in-container agent uses to reach the daemon (e.g. the docker host
    gateway). Defaults to the client's base_url when not crossing a container boundary.
    *data_dir* is the file-drop stub destination (required by the task-probe path); defaults to
    CLAUDE_PLUGIN_DATA or the standard orchestrator data dir.
    """
    dd = data_dir or os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.join(
        os.path.expanduser("~"), ".claude", "orchestrator"
    )
    wiring = run_canonical_wiring(client, unit_id, task_summary, data_dir=dd)
    url = agent_url or client.base_url
    if not client.workspace:
        raise ValueError("run_agent_in_container requires client.workspace for workspace-scoped /search")
    agents_md = build_agents_md(wiring.task_key, url, wiring.context_deps, client.workspace)
    return ArmResult(
        arm="on",
        mode="agent_in_container",
        agents_md=agents_md,
        context_keys=list(wiring.wired_edges),
        wiring=wiring,
    )


# ---------------------------------------------------------------------------
# Executor (b): retrieve_and_answer - read task-scoped /search + answer via claude_p
# ---------------------------------------------------------------------------

def _answer_from_context(
    question: str,
    context_blocks: list[str],
    model: Optional[str],
) -> tuple[str, dict[str, int]]:
    """Answer *question* from *context_blocks*; return (answer, usage).

    usage = {"input_tokens": N, "output_tokens": N} from the claude_p call.
    If no context was retrieved we make the answerer say so honestly.
    """
    context = "\n\n---\n\n".join(b for b in context_blocks if b and b.strip())
    if not context.strip():
        context = "(no relevant memory was retrieved)"
    prompt = _ANSWER_TEMPLATE.format(context=context, question=question)
    text, usage = judge_mod.claude_p_with_usage(prompt, model=model)
    return (text or "").strip(), usage


def run_retrieve_and_answer(
    client: ZonoidClient,
    unit_id: str,
    question: str,
    *,
    task_summary: Optional[str] = None,
    data_dir: Optional[str] = None,
    model: Optional[str] = None,
    context_k: int = 5,
    retrieval: str = "task_search",
    max_rounds: Optional[int] = None,
) -> ArmResult:
    """ON arm, executor (b): wire the DAG, read production context, answer via claude_p.

    For QA benches that can't spawn a real agent per probe (500+ units). The unit is minted as a
    TASK PROBE so the settled read uses a production retrieval surface; the question itself is the
    task summary (so autowire ranks NOTE providers against the question's embedding and the eager
    judge keeps/prunes them).

    Retrieval surface (``retrieval`` selector — both run AFTER the canonical wiring + judge drain,
    which settles the DAG Tier-1 edges; that wiring is preserved unchanged for both):
      - ``"task_search"`` (DEFAULT, the frozen-DAG ``our-way`` arm): read the task-scoped
        ``/search?task_key=`` surface (``read_task_search_context``). A settled probe receives system
        context plus frozen DAG context; it does NOT get a hand-added semantic RAG fill, and this
        ONE-SHOT path does NOT exercise the LLM grader.
      - ``"agentic"`` (the ``our-way-prod`` arm): read through the PRODUCTION agentic + LLM-grader
        loop (``POST /subconscious/search-context`` → ``store.searchContext`` →
        ``runAgenticContextSearches`` + ``gradeSearchRound`` per round). This is byte-identical to
        production retrieval and EXERCISES the grader. The returned ``ArmResult.grader`` carries the
        grader provenance (rounds / kept_keys / last_verdict) as evidence the loop fired.

    The returned production context blocks are injected into the answer prompt. The answerer
    remains tool-less/MCP-off: WE retrieve and inject; the answer agent calls no tools.

    *task_summary* defaults to *question* (the FB convention — embed against the unit's text).
    *data_dir* is required (the file-drop stub destination); defaults to CLAUDE_PLUGIN_DATA or the
    standard orchestrator data dir.
    *context_k* is forwarded to the production retrieval (default 5).
    *max_rounds* (agentic only) caps the adaptive search rounds; None lets the daemon decide.
    """
    summary = task_summary or question
    dd = data_dir or os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.join(
        os.path.expanduser("~"), ".claude", "orchestrator"
    )
    # KEEP the canonical wiring + judge drain for BOTH retrieval modes: it mints the probe, seeds
    # autowire candidates, and drives the production sync judge so the DAG Tier-1 edges settle.
    if retrieval not in {"task_search", "agentic"}:
        raise ValueError(f"unknown retrieval mode: {retrieval!r}")

    wiring = run_canonical_wiring(client, unit_id, summary, data_dir=dd)
    context_blocks: list[str] = []
    all_context_keys: list[str] = []
    seen_keys: set[str] = set()
    grader_provenance: dict[str, Any] = {}

    if retrieval == "agentic":
        # PRODUCTION agentic + LLM-grader retrieval (the our-way-prod arm). Byte-identical to the
        # production agentic path; exercises the grader (vs. the one-shot /search?task_key above).
        try:
            items, grader_provenance = read_agentic_search_context(
                client, wiring.task_key, question, k=context_k, max_rounds=max_rounds
            )
            for d in items:
                key = d.get("key") or d.get("task_key") or ""
                if not key or key in seen_keys:
                    continue
                text = str(d.get("summary") or "")
                if not text.strip():
                    continue
                context_blocks.append(f"[AGENTIC] {text}")
                seen_keys.add(key)
                all_context_keys.append(key)
        except Exception as exc:  # noqa: BLE001 — agentic context retrieval is best-effort
            print(f"[arms] agentic search-context retrieval failed (non-fatal): {exc}", file=sys.stderr)
    else:
        try:
            raw_hits = read_task_search_context(
                client, wiring.task_key, question, k=context_k
            )
            for h in raw_hits:
                key = h.get("key") or ""
                if not key or key in seen_keys:
                    continue
                text = str(h.get("summary") or "")
                if not text.strip():
                    continue
                context_blocks.append(f"[{task_search_context_label(h)}] {text}")
                seen_keys.add(key)
                all_context_keys.append(key)
        except Exception as exc:  # noqa: BLE001 — task-scoped search retrieval is best-effort
            print(f"[arms] task-scoped context search failed (non-fatal): {exc}", file=sys.stderr)

    ctx_chars = sum(len(b) for b in context_blocks if b and b.strip())
    predicted, usage = _answer_from_context(question, context_blocks, model)
    return ArmResult(
        arm="on",
        mode="retrieve_and_answer",
        predicted=predicted,
        context_keys=all_context_keys,
        wiring=wiring,
        ctx_chars=ctx_chars,
        answer_input_tokens=usage.get("input_tokens", 0),
        answer_output_tokens=usage.get("output_tokens", 0),
        grader=grader_provenance,
    )


# ---------------------------------------------------------------------------
# Contrast arms: cold (no memory) + rag_control (search, no task_key)
# ---------------------------------------------------------------------------

def run_cold(question: str, *, model: Optional[str] = None) -> ArmResult:
    """Contrast arm ``cold``: answer with NO memory at all (rigging guard / floor).

    No graph, no search, no DAG. If this floor scores as well as an ON arm, the unit was
    answerable from world knowledge and the comparison is rigged.
    """
    prompt = _COLD_TEMPLATE.format(question=question)
    text, usage = judge_mod.claude_p_with_usage(prompt, model=model)
    return ArmResult(
        arm="cold",
        predicted=(text or "").strip(),
        ctx_chars=0,
        answer_input_tokens=usage.get("input_tokens", 0),
        answer_output_tokens=usage.get("output_tokens", 0),
    )


def run_rag_control(
    client: ZonoidClient,
    question: str,
    *,
    k: int = RAG_CONTROL_K,
    model: Optional[str] = None,
) -> ArmResult:
    """Contrast arm ``rag_control``: GET /search WITHOUT task_key → top-k summaries → answer.

    The retrieval-time baseline ("normal RAG memory"): the SAME workspace/KB as the ON arm, but
    NO DAG wiring, NO probe task, NO suggest_links — just plain top-k semantic retrieval. Isolates
    the value the DAG wiring adds over vanilla RAG.

    Bug fix (/30): the search index includes harness TASK STUB nodes (probe/*, bench/*) which
    ranked above ingested session notes, producing 0% accuracy. We now filter to NOTE-only hits
    via _is_note_hit (kind!='task' AND key not prefixed probe/|bench/).
    """
    # Request more hits than needed so that after stub filtering we still have k note hits.
    raw_hits = client.search(question, k=k * 3, gated=False)  # NB: no task_key — retrieval-time control.
    note_hits = [h for h in raw_hits if _is_note_hit(h)][:k]
    context_blocks = [str(h.get("summary") or "") for h in note_hits]
    ctx_chars = sum(len(b) for b in context_blocks if b and b.strip())
    predicted, usage = _answer_from_context(question, context_blocks, model)
    return ArmResult(
        arm="rag_control",
        predicted=predicted,
        context_keys=[h.get("key") for h in note_hits if h.get("key")],
        ctx_chars=ctx_chars,
        answer_input_tokens=usage.get("input_tokens", 0),
        answer_output_tokens=usage.get("output_tokens", 0),
    )


# ---------------------------------------------------------------------------
# Smoke / verify - proves the eager-judge keepEdge surfaces in task-scoped search context
# ---------------------------------------------------------------------------

def _smoke(daemon: Optional[str] = None) -> int:
    """End-to-end smoke for the production-faithful eager-judge ON arm.

    Spawns an EMBEDDED daemon bound LIVE to the unit workspace (so /judge/drain + /judge/next?node=
    + keepEdge resolve to the unit dir — note-mqgwrh5a63x) unless *daemon* is an explicit base URL,
    in which case it binds that daemon's live workspace to the unit dir via POST /workspace.

    Steps:
      1. warm_up the embedder.
      2. Ingest a planted note + an off-topic distractor note. The embedded canonical bench daemon
         inherits production's 0-floor/top-K autowire; the PRODUCTION judge (driven via /judge/drain)
         keeps or prunes candidates.
      3. run_retrieve_and_answer on the planted fact: mint probe → autowire seeds the candidate →
         PRODUCTION JUDGE (via /judge/drain) keeps it (keepEdge promotes in place) → read /search?task_key.
    Assertions:
      A1  ON answer CONTAINS the planted fact.
      A2  the keepEdge PERSISTED — the planted note surfaces in task-scoped search context
          (on.context_keys), and wiring.wired_edges came from a keepEdge promotion (NOT idle).
      A3  cold answer does NOT contain the fact (rigging guard).
    Also runs an off-topic probe and REPORTS (does not assert) whether the distractor surfaced under
    the current daemon candidate policy.

    Returns 0 on PASS, 1 on FAIL/daemon-down.
    """
    import tempfile

    # The embeddable Python console is cp1252; force utf-8 so diagnostic glyphs never crash.
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001
            pass

    # The planted fact: a deliberately non-world-knowledge token so cold cannot know it.
    secret = "Zorblax-7741"
    fact = (
        f"The internal codename for the Zonoid bench arms calibration unit is {secret}. "
        f"This codename {secret} is recorded only in this private knowledge base and appears "
        f"in no public source."
    )
    question = "What is the internal codename for the Zonoid bench arms calibration unit?"
    # An off-topic note (no lexical/semantic overlap with the calibration question). Under the
    # canonical bench daemon it may still be considered as a top-K candidate, but the production
    # judge should prune it.
    distractor = (
        "The cafeteria on the third floor serves lunch between 11:30 and 14:00 on weekdays; the "
        "espresso machine in the north break room was replaced last quarter."
    )

    ws = os.path.abspath(tempfile.mkdtemp(prefix="zonoid-arms-smoke-"))

    handle = None
    own_daemon = daemon is None
    try:
        if own_daemon:
            from zonoid_bench import daemon as daemon_mod
            print("[arms.smoke] starting EMBEDDED daemon (live-bound to unit ws) ...")
            # The local worktree may lack node_modules (no @xenova for the embed sidecar). Reuse the
            # integration smoke's resolver to find a daemon.js whose sibling node_modules is installed
            # (typically the main worktree), so the embedded daemon can embed + rerank.
            daemon_js = None
            try:
                from zonoid_bench.smoke import _find_daemon_js
                daemon_js = _find_daemon_js()
                print(f"  using daemon.js: {daemon_js}")
            except Exception as e:  # noqa: BLE001
                print(f"  (daemon.js resolver fell back to default: {e})")
            handle = daemon_mod.start(daemon_js=daemon_js, workspace=ws)
            base_url = handle.base_url
            data_dir = handle.data_dir
            print(f"  embedded daemon ready: {base_url}  data_dir={data_dir!r}")
        else:
            base_url = daemon
            data_dir = os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.join(
                os.path.expanduser("~"), ".claude", "orchestrator"
            )
            print(f"[arms.smoke] using daemon={base_url}; binding its live workspace to the unit ws ...")

        client = ZonoidClient(base_url, workspace=ws, timeout=120)

        # When pointing at an external daemon, bind its live workspace to the unit dir so the
        # eager-judge read resolves (the embedded path already bound it in daemon.start).
        if not own_daemon:
            try:
                bind = client.set_workspace(ws, force=True)
                print(f"  /workspace bind: {bind}")
            except Exception as e:  # noqa: BLE001
                print(f"  FAILED to bind live workspace (eager judge cannot resolve): {e}")
                return 1

        # ---- 1. warm_up ----
        print("  warm_up()... ", end="", flush=True)
        try:
            client.warm_up()
            client.search("warmup probe", k=1)
            print("OK")
        except Exception as e:  # noqa: BLE001
            print(f"FAILED - daemon may be DOWN: {e}")
            return 1

        # ---- 2. ingest planted + distractor notes ----
        print(f"  ingest planted + distractor notes (ws={ws})... ", end="", flush=True)
        try:
            note = client.post_note(
                title="Zonoid bench arms calibration codename",
                summary=fact, category="bench-smoke", tags=["zonoid-bench", "smoke"],
            )
            note_key = note.get("key") or note.get("note_key")
            assert note_key, f"post_note returned no key: {note}"
            dist = client.post_note(
                title="Cafeteria and break-room logistics",
                summary=distractor, category="bench-smoke", tags=["zonoid-bench", "smoke"],
            )
            dist_key = dist.get("key") or dist.get("note_key")
            print(f"OK (planted={note_key}, distractor={dist_key})")
        except Exception as e:  # noqa: BLE001
            print(f"FAILED: {e}")
            return 1
        time.sleep(3)  # let the embedder index both notes before autowire runs

        # ---- 3. ON arm: mint probe -> autowire -> EAGER JUDGE -> read ----
        print("  retrieve_and_answer (mint probe -> autowire -> eager judge -> read)... ", flush=True)
        try:
            on = run_retrieve_and_answer(
                client, unit_id=f"arms-smoke-{int(time.time())%100000}", question=question,
                task_summary=question, data_dir=data_dir,
            )
        except Exception as e:  # noqa: BLE001
            print(f"  FAILED during ON arm: {e}")
            return 1
        w = on.wiring
        print(f"    probe task key : {w.task_key if w else '?'}")
        print(f"    judge idle     : {w.judge_idle if w else '?'}  (True = autowire seeded NO candidate)")
        print(f"    candidates     : {[(c['key'], c['edge']) for c in (w.candidates_seen if w else [])]}")
        print(f"    KEPT (keepEdge): {w.wired_edges if w else '?'}")
        print(f"    PRUNED         : {w.pruned_edges if w else '?'}")
        print(f"    /task/context  : {on.context_keys}")
        print(f"    ON answer      : {on.predicted!r}")

        # ---- cold contrast ----
        print("  cold (no memory)... ", flush=True)
        try:
            cold = run_cold(question)
        except Exception as e:  # noqa: BLE001
            print(f"  FAILED during cold arm: {e}")
            return 1
        print(f"    cold answer    : {cold.predicted!r}")

        # ---- HONEST off-topic probe (report-only) ----
        # Ask about the distractor's content. Whether it surfaces under the current daemon candidate
        # policy is an empirical fact we REPORT, not rig.
        print("  [honest] off-topic probe on the distractor (report-only)... ", flush=True)
        sub_missed = None
        try:
            sub_q = "What time does the third-floor cafeteria stop serving lunch on weekdays?"
            sub = run_retrieve_and_answer(
                client, unit_id=f"arms-smoke-sub-{int(time.time())%100000}", question=sub_q,
                task_summary=sub_q, data_dir=data_dir,
            )
            sw = sub.wiring
            sub_missed = bool(sw and sw.judge_idle) or not (sub.context_keys)
            print(f"    sub probe key  : {sw.task_key if sw else '?'}")
            print(f"    judge idle     : {sw.judge_idle if sw else '?'}")
            print(f"    candidates     : {[(c['key'], c['edge']) for c in (sw.candidates_seen if sw else [])]}")
            print(f"    /task/context  : {sub.context_keys}")
            print(f"    => evidence {'not surfaced by judged context' if sub_missed else 'surfaced'}")
        except Exception as e:  # noqa: BLE001
            print(f"    (off-topic probe errored, non-fatal: {e})")

        # ---- assertions ----
        print("\n[arms.smoke] === assertions ===")
        ok = True

        on_has = secret.lower() in (on.predicted or "").lower()
        print(f"  [{'PASS' if on_has else 'FAIL'}] A1 ON answer CONTAINS planted fact {secret!r}")
        ok = ok and on_has

        # A2: the eager-judge keepEdge PERSISTED — the planted note is in task-scoped search context
        # AND it was KEPT by the judge (came via keepEdge, not idle). This is the spike's old failure
        # mode (empty context_keys) being explicitly guarded.
        kept_planted = bool(note_key and note_key in (on.context_keys or []))
        from_keep = bool(w and w.wired_edges and not w.judge_idle)
        a2 = kept_planted and from_keep
        print(f"  [{'PASS' if a2 else 'FAIL'}] A2 eager-judge keepEdge PERSISTED in /task/context "
              f"(planted in ctx={kept_planted}, from keepEdge={from_keep})")
        ok = ok and a2

        cold_has = secret.lower() in (cold.predicted or "").lower()
        print(f"  [{'PASS' if not cold_has else 'FAIL'}] A3 cold answer does NOT contain {secret!r} (rigging guard)")
        ok = ok and (not cold_has)

        if sub_missed is not None:
            print(f"  [INFO] off-topic evidence behavior: "
                  f"{'not surfaced' if sub_missed else 'surfaced'} — report-only, not asserted")

        print("\n" + ("PASS" if ok else "FAIL"))
        return 0 if ok else 1
    finally:
        if handle is not None:
            try:
                from zonoid_bench import daemon as daemon_mod
                daemon_mod.stop(handle)
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Zonoid Bench SDK arms — canonical ON arm (+pluggable executor) + contrast arms."
    )
    parser.add_argument("--smoke", action="store_true",
                        help="Run the eager-judge smoke (embedded daemon by default).")
    parser.add_argument("--daemon", default=None,
                        help="Use an EXISTING daemon at this base URL (binds its live workspace to "
                             "the unit dir). Omit to spawn an embedded daemon.")
    args = parser.parse_args()

    if args.smoke:
        sys.exit(_smoke(args.daemon))
    parser.print_help()
    sys.exit(0)
