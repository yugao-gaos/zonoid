"""bench/zonoid_bench/arms.py — Zonoid Bench SDK: the arms module.

The ONE canonical "Zonoid ON arm" + its contrast arms, replacing the three divergent
per-bench implementations called out in docs/bench-sdk-design.md §1:

  - SWE-Bench-CL judged the autowire candidate set + read tiered /search.
  - agent-memory judged ALL sessions (no suggest_links, inflated by the full session set).
  - FeatureBench used suggest_links + a real agent (claude_code.ClaudeCodeAgent) — the closest
    to canonical, and the reference this module PORTS.

Canonical ON-arm wiring (design §5) — PRODUCTION-FAITHFUL eager-judge pipeline
(OVERRIDE note-mqhha58fz9k corrects the earlier FeatureBench port: the canonical arm must run the
REAL LLM eager-judge over autowire candidates, NOT a ceScore threshold):

  1. mint the unit as a TASK PROBE  ......... workspace.drop_task_stub + client.post_status
                                              (status="not_ready", summary=question). The status
                                              write drives the daemon ingest funnel
                                              (embed → setTaskVec → autowireNewTaskWholeGraph →
                                              markEagerJudge): autowire SEEDS weight-0 candidate
                                              context edges from relevant NOTE providers INTO the
                                              probe at cosine >= SEMANTIC_AUTOWIRE_THRESHOLD (0.55),
                                              and stamps the probe `judging` (judgingSince).
  2. semantic search for pre-loaded context  client.search(q=task_summary) (provenance + the
                                              agent_in_container AGENTS.md bullets only — NOT how
                                              the DAG edges are chosen).
  3. PULL the autowire candidate set  ....... client.judge_next(node=<probe>) — the production
                                              eager-judge read (/judge/next?node=). Returns THIS
                                              probe's whole unjudged candidate edge-set in one slice.
  4. RUN the LLM eager-judge  ............... judge.EdgeJudge over the candidates with the keep/prune
                                              rubric (DEFAULT prune: similarity is necessary, not
                                              sufficient). keepEdge promotes the weight-0 autowire
                                              candidate IN PLACE (judged:true + real weight off the
                                              recall score) so it re-enters ranked retrieval;
                                              pruneEdge deletes it. Posted via client.post_verdict.
  5. read = frozen judged DAG context  ...... client.get_task_context (GET /task/context) — the
                                              kept context_deps (weight>0) are now the probe's frozen
                                              context, exactly as a production task reads them once
                                              the eager judge has run BEFORE the task goes ready.

WHY a TASK probe + a LIVE-bound daemon (note-mqgwrh5a63x, note-mqh0gwz1mxc):
  - The eager judge is task-centric: /judge/next?node=, markEagerJudge, and the judging→ready gate
    all key off a TASK node, and autowire seeds NOTE→TASK candidate edges. So the unit is minted as
    a task PROBE (the question is its summary), not a note. A note is a context PROVIDER, never the
    consumer that reads /task/context.
  - keepEdge promotes a PRE-EXISTING weight-0 autowire candidate edge in place (lib/judge.js). It
    only fires for a candidate autowire actually seeded — i.e. a NOTE whose cosine to the probe was
    >= 0.55. A sub-0.55 evidence note is NEVER an autowire candidate, so keepEdge no-ops on it
    (note-mqh0gwz1mxc) — that miss is CORRECT/EXPECTED behaviour for the production pipeline, not a
    bug to paper over with createEdge.
  - /judge/next and the keepEdge save are HARD-BOUND to the daemon's live state.workspace
    (routes/judge.js): a keepEdge on a non-live (isolated) workspace does not surface in
    /task/context (note-mqgwrh5a63x). So the bench runs ONE embedded daemon per unit whose LIVE
    workspace IS the unit dir (daemon.start(workspace=)); the whole pipeline then operates on one
    consistent in-memory + persisted overlay and the kept edge surfaces in /task/context.

Pluggable executor (design §5):
  - ``agent_in_container``   : build the AGENTS.md (mirror ``_build_agents_md`` — pre-loaded verified
                               context + live curl instructions) for a REAL agent; the bench spawns
                               the agent and grades by its tests. Returns AGENTS.md text + the
                               resolved context (no LLM call here).
  - ``retrieve_and_answer``  : read the wired DAG context and answer via ``judge.claude_p`` (a
                               tool-less completion), scored vs a gold answer (QA benches — can't
                               spawn a real agent per 500 probes).

Contrast arms (design §5):
  - ``cold``                 : NO memory at all (rigging guard / floor). If cold scores as well as
                               an ON arm, the unit was answerable from world knowledge → rigged.
  - ``rag_control``          : client.search WITHOUT task_key — retrieval-time baseline ("normal RAG
                               memory"), no DAG wiring, no probe task.

Sub-0.55 evidence (honest limitation)
-------------------------------------
Because the kept edge MUST be a real autowire candidate (keepEdge promotes in place — it cannot
manufacture an edge autowire never seeded), an evidence note whose cosine to the probe is below
SEMANTIC_AUTOWIRE_THRESHOLD (0.55) is simply not a candidate and the ON arm MISSES it. This is the
production pipeline's actual behaviour and is reported honestly by the smoke (it does NOT fall back
to createEdge to rescue the miss — that would diverge from production and inflate the arm). The
contrast is the earlier, now-superseded ceScore-threshold + overlay_edge approach which would wire
ANY cosine-similar note regardless of the eager judge; this module deliberately abandons that.

Runtime: stdlib ONLY (urllib/json/subprocess via client.py + judge.py). Runs on the embeddable
Python 3.12 at C:\\Users\\Imyu\\AppData\\Local\\py312embed\\python.exe as well as Mac/Linux CPython.
"""

from __future__ import annotations

import os
import sys
import time
import urllib.error
import urllib.request
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

# Budget for the eager-judge candidate pull (GET /judge/next?node=&budget=). The daemon clamps
# this to [1, 50]; the per-node candidate set is small so 20 is ample headroom.
JUDGE_BUDGET: int = int(os.environ.get("ZONOID_BENCH_JUDGE_BUDGET", "20"))

# Minimum plain-cosine score for a /search hit to be treated as relevant pre-loaded context
# (FB uses score > 0.1 in _setup_zonoid_context). Used ONLY for the agent_in_container AGENTS.md
# bullets — NOT for the DAG edge selection, which is the eager judge's job.
SEARCH_SCORE_FLOOR: float = float(os.environ.get("ZONOID_BENCH_SEARCH_FLOOR", "0.1"))

# How many /search hits to keep as pre-loaded context bullets (agent_in_container only).
CONTEXT_TOPK: int = int(os.environ.get("ZONOID_BENCH_CONTEXT_TOPK", "6"))

# top-k for the rag_control arm's /search.
RAG_CONTROL_K: int = int(os.environ.get("ZONOID_BENCH_SEARCH_K", "5"))

# Char budget per pre-loaded context summary (keeps the answerer/AGENTS.md prompt bounded).
SUMMARY_BUDGET: int = int(os.environ.get("ZONOID_BENCH_SUMMARY_BUDGET", "2000"))

# How long to wait for the daemon to adopt a dropped task stub (file-drop lane, ~1.5 s adoption).
ADOPT_TIMEOUT_S: float = float(os.environ.get("ZONOID_BENCH_ADOPT_TIMEOUT", "20"))
# How long to let the ingest funnel embed + autowire after the status write before reading.
AUTOWIRE_SETTLE_S: float = float(os.environ.get("ZONOID_BENCH_AUTOWIRE_SETTLE", "6"))
_POLL_INTERVAL_S: float = 0.75

# Maximum number of claude_p retries on a per-call timeout (mirrors the production retry pattern
# from lib/headless-drain.js). After JUDGE_MAX_RETRIES exhausted, the edge is kept PROVISIONAL.
JUDGE_MAX_RETRIES: int = int(os.environ.get("ZONOID_BENCH_JUDGE_MAX_RETRIES", "2"))

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

    Attributes
    ----------
    task_key        : the probe TASK key in the graph (the node autowire seeds context edges INTO).
    node_kind       : always "task" — the eager judge is task-centric (see module docstring).
    context_deps    : pre-loaded /search bullets {label, summary, score} (agent_in_container AGENTS.md
                      only — NOT how the DAG edges are chosen).
    wired_edges     : the candidate PROVIDER keys the eager judge KEPT (keepEdge from=provider,
                      to=probe) — i.e. the autowire candidates promoted into verified context.
                      Does NOT include provisional edges (timeout fallback; those stay weight-0).
    candidates_seen : every autowire candidate the eager-judge pull returned, with its verdict
                      {key, title, edge:"keep"|"prune"}.
    pruned_edges    : the candidate PROVIDER keys the eager judge PRUNED (pruneEdge).
    judge_idle      : True when /judge/next?node= returned no candidates (autowire seeded none — e.g.
                      all evidence sub-0.55). Distinguishes "judged, kept nothing" from "nothing to
                      judge", which matters for the honest sub-0.55 reporting.
    search_hits     : raw /search hit keys (provenance).
    timeout_kills   : number of claude_p calls that hit the hard per-call timeout and were retried or
                      fell back to keep-provisional. Mirrors the production retry/provisional path:
                      daemon.js:1640-1646 keeps timed-out edges provisional rather than pruning them.
    judge_idle_count: how many times judge_next returned no >=0.55 candidates for this wiring call.
                      Currently 0 or 1 (one judge_next pull per run_canonical_wiring), but exposed
                      as a count so callers can aggregate across a batch.
    provisional_kept: number of candidate edges kept PROVISIONAL (not judged) because all retries
                      timed out. Mirrors production: timed-out edges stay accessible in get_task_context
                      as provisional (not pruned). A run with provisional_kept=0 is fully faithful.
    """

    task_key: str
    node_kind: str
    context_deps: list[dict[str, Any]] = field(default_factory=list)
    wired_edges: list[str] = field(default_factory=list)
    candidates_seen: list[dict[str, Any]] = field(default_factory=list)
    pruned_edges: list[str] = field(default_factory=list)
    judge_idle: bool = True
    search_hits: list[str] = field(default_factory=list)
    # Production-faithful timeout/retry/provisional counters (Step 3 fidelity fix).
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
         at cosine >= 0.55) → markEagerJudge (stamp judgingSince)). status:not_ready — NOT
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


def _candidate_summary(item: dict[str, Any]) -> str:
    """Best-effort summary text for an eager-judge candidate edge item.

    /judge/next returns each candidate's `from` endpoint as {key, title, summary} (summary clipped
    to 200 chars by the daemon). Fall back to the title when the summary is empty.
    """
    frm = item.get("from") or {}
    return str(frm.get("summary") or frm.get("title") or "")


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


def _judge_with_retry(
    ej: Any,
    anchor_key: str,
    anchor_summary: str,
    candidates: list[dict[str, Any]],
    result: "WiringResult",
) -> Optional[dict[str, dict[str, Any]]]:
    """Run EdgeJudge.judge with bounded retry on timeout/kill, recording counters on *result*.

    Production behaviour (daemon.js:1640-1646, lib/headless-drain.js):
    - A per-call claude_p timeout/kill is retried up to JUDGE_MAX_RETRIES times.
    - After retries exhausted with no verdict, the candidates are kept PROVISIONAL:
      they remain in get_task_context but are flagged (provisional_kept counter incremented).
      Production NEVER ceScore→overlay_edge and NEVER prunes on timeout.

    Returns the verdict dict on success, or None if retries exhausted (caller keeps provisional).
    """
    for attempt in range(JUDGE_MAX_RETRIES + 1):
        raw = ej._llm_judge(anchor_key, anchor_summary, candidates)  # type: ignore[attr-defined]
        if raw is not None:
            return raw
        # _llm_judge returned None — a claude_p timeout/kill.
        result.timeout_kills += 1
        if attempt < JUDGE_MAX_RETRIES:
            print(
                f"[arms] EdgeJudge timeout (attempt {attempt + 1}/{JUDGE_MAX_RETRIES + 1}); "
                f"retrying ...",
                file=sys.stderr,
            )
        else:
            # Retries exhausted — keep candidates PROVISIONAL (never prune on timeout).
            print(
                f"[arms] EdgeJudge timeout_kills={result.timeout_kills}; "
                f"retries exhausted — keeping {len(candidates)} candidate(s) PROVISIONAL "
                f"(production-faithful: timed-out edges are never pruned).",
                file=sys.stderr,
            )
            result.provisional_kept += len(candidates)
    return None


def run_canonical_wiring(
    client: ZonoidClient,
    unit_id: str,
    task_summary: str,
    *,
    data_dir: Optional[str] = None,
    judge: Optional[Any] = None,
    judge_budget: int = JUDGE_BUDGET,
    # Accepted for back-compat with older callers; the eager judge is always task-based so these
    # are advisory only (the unit is ALWAYS minted as a task probe).
    as_task: bool = True,  # noqa: ARG001 — kept for signature stability
    tags: Optional[list[str]] = None,  # noqa: ARG001 — unused in the task-probe path
) -> WiringResult:
    """Run the PRODUCTION-FAITHFUL canonical ON-arm eager-judge wiring for one unit.

    Steps (see module docstring for the full rationale + note provenance):

      1. mint the unit as a TASK PROBE → drive autowire (seed weight-0 NOTE→probe candidate edges
         at cosine >= 0.55) + markEagerJudge.  (_mint_probe_task)
      2. client.search(q=task_summary) → pre-loaded /search bullets (agent_in_container AGENTS.md
         provenance ONLY — NOT how the DAG edges are chosen).
      3. client.judge_next(node=<probe>) → pull the autowire candidate edge-set (the eager-judge read).
      4. judge.EdgeJudge over the candidates (keep/prune, DEFAULT prune) → client.post_verdict with
         keepEdge for kept (promotes the weight-0 autowire candidate in place) / pruneEdge for pruned.
      5. (read is the caller's job — read_wired_context / get_task_context for the frozen judged DAG.)

    `judge` is an optional pre-built judge.EdgeJudge (so a batch run can share one instance + model
    config); a fresh one is created when None. `judge_budget` is forwarded to /judge/next.

    Returns a WiringResult capturing the probe key, pre-loaded /search bullets, the KEPT provider
    keys (verified context), the pruned keys, and judge_idle (autowire seeded no candidate at all).
    """
    node_key = _mint_probe_task(client, unit_id, task_summary, data_dir=data_dir)

    result = WiringResult(task_key=node_key, node_kind="task")

    # ---- Step 2: /search bullets (agent_in_container AGENTS.md provenance ONLY) ----
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

    # ---- Step 3: pull the eager-judge autowire candidate set (production read) ----
    pull = client.judge_next(node_key, budget=judge_budget)
    items = [it for it in (pull.get("items") or []) if it.get("kind") == "edge"]
    result.judge_idle = bool(pull.get("idle")) or not items
    if result.judge_idle:
        # Autowire seeded NO candidate for this probe (e.g. every evidence note fell below the 0.55
        # seed threshold, or the probe genuinely has no relevant neighbour). Nothing for the eager
        # judge to keep — the probe goes ready with empty context. This is correct/expected, not an
        # error (see module docstring "Sub-0.55 evidence").
        # NEVER fall back to ceScore→overlay_edge here — that inflates the score vs production
        # (production wires nothing when idle). The bench reports this honestly.
        result.judge_idle_count = 1
        return result

    # ---- Step 4: run the LLM eager-judge (keep/prune, DEFAULT prune) ----
    # Build the EdgeJudge candidate list: each /judge/next edge item is provider(from) -> probe(to);
    # the anchor we judge against is the PROBE (its summary == the question). is_dup is not exercised
    # here (autowire task-context candidates are never near-dup note clusters), so default False.
    #
    # DEFENSIVE: exclude harness task stub nodes from candidacy. autowireNewTaskWholeGraph also seeds
    # task→task candidate edges (anchor→other-task), so other probe/bench stub nodes CAN appear as
    # providers (from) in /judge/next results for this probe. Stubs are structural ANCHORS, not
    # session MEMORY — including them wastes judge budget and risks a spurious keepEdge on a stub.
    # Exclude by: (a) from-node kind=='task', (b) key prefixed 'probe/' or 'bench/'.
    def _is_note_provider(it: dict[str, Any]) -> bool:
        frm = it.get("from") or {}
        key = frm.get("key") or ""
        if frm.get("kind") == "task":
            return False
        if key.startswith("probe/") or key.startswith("bench/"):
            return False
        return bool(key)

    ej = judge if judge is not None else judge_mod.EdgeJudge()
    candidates = [
        {
            "key": (it.get("from") or {}).get("key"),
            "title": (it.get("from") or {}).get("title", ""),
            "summary": _candidate_summary(it),
            "is_dup": False,
        }
        for it in items
        if _is_note_provider(it)
    ]
    # If ALL items were harness stubs (filtered away), treat as idle — nothing to judge.
    if not candidates:
        result.judge_idle = True
        result.judge_idle_count = 1
        return result

    # Production-faithful retry semantics: per-call timeout → retry up to JUDGE_MAX_RETRIES.
    # After retries exhausted → keep-provisional (NEVER prune, NEVER ceScore fallback).
    # Mirrors daemon.js:1640-1646 + lib/headless-drain.js provisional handling.
    verdicts_raw = _judge_with_retry(ej, node_key, task_summary, candidates, result)

    if verdicts_raw is None:
        # Retries exhausted — edges are kept PROVISIONAL (result.provisional_kept already set).
        # No /judge/verdict call: provisional edges stay weight-0/judged:false in the daemon.
        # They are NOT pruned (production-faithful: daemon.js:1640-1646 never drops timed-out edges).
        # They stay in the eager-judge queue for a later drain.
        # Record all as "provisional" in candidates_seen for provenance/counting.
        # Do NOT add to wired_edges (they are NOT verified kept context — they are deferred).
        # read_wired_context filters weight>0 so provisional weight-0 edges won't surface to the
        # answerer this run — that is the production-faithful result (answerer sees honest empty ctx).
        for c in candidates:
            result.candidates_seen.append({
                "key": c["key"], "title": c.get("title", ""), "edge": "provisional"
            })
        return result

    # Normal path: verdicts returned — translate to /judge/verdict.
    # Translate per-candidate keep/prune verdicts into /judge/verdict wrapped items. EdgeJudge's
    # to_verdict_list orients edges provider(from) -> anchor(to) — exactly the autowire direction,
    # so keepEdge promotes the right weight-0 candidate in place.
    verdict_items = ej.to_verdict_list(node_key, candidates, verdicts_raw)
    if verdict_items:
        client.post_verdict(verdict_items)

    # Record provenance: which providers were kept (verified context) vs pruned.
    for c in candidates:
        key = c["key"]
        edge = (verdicts_raw.get(key) or {}).get("edge", "prune")
        result.candidates_seen.append({"key": key, "title": c.get("title", ""), "edge": edge})
        if edge == "keep":
            result.wired_edges.append(key)
        else:
            result.pruned_edges.append(key)

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


# ---------------------------------------------------------------------------
# Executor (a): agent_in_container — build AGENTS.md for a real agent
# ---------------------------------------------------------------------------

def build_agents_md(
    unit_id: str,
    agent_url: str,
    context_deps: list[dict[str, Any]],
) -> str:
    """Build the /testbed/AGENTS.md a real agent reads (mirror of FB ``_build_agents_md``).

    Pre-loaded verified context bullets + live curl instructions (search / record / mark-done)
    pointing at *agent_url* (the host gateway URL the in-container agent can reach).

    The structure is faithfully ported so the FeatureBench eval ON arm
    (arms agent_in_container) is byte-compatible with the reference. The wires the agent records
    mid-session carry ``wires_to:[unit_id]`` for provenance (CLAUDE.md KB-authoring rule).
    """
    lines = [
        "# Zonoid Knowledge Base",
        "",
        f"A live Zonoid KB instance is accessible at **{agent_url}** with pre-built",
        "knowledge about this repository.",
        "",
        f"**Your task ID**: `{unit_id}`",
        "",
    ]

    if context_deps:
        lines += ["## Pre-loaded context (verified for this task)", ""]
        for dep in context_deps:
            summary = dep.get("summary", "")
            label = (dep.get("label", "") or "").strip()
            if not summary:
                continue
            if label:
                lines.append(f"- **{label}**: {summary}")
            else:
                lines.append(f"- {summary}")
        lines.append("")

    lines += [
        "## Instructions",
        "",
        "**Before writing any code**, complete these steps:",
        "",
        "### 1. Check your pre-loaded context above — it contains repo-specific KB.",
        "",
        "### 2. Search for relevant knowledge as you work:",
        "```bash",
        f'curl -s "{agent_url}/search?q=YOUR+QUERY+HERE&task_key={unit_id}"',
        "```",
        "",
        "### 3. Record discoveries for future tasks:",
        "```bash",
        f"curl -s -X POST {agent_url}/overlay/note \\",
        "  -H 'Content-Type: application/json' \\",
        f"""  -d '{{"wires_to":["{unit_id}"],"title":"Finding title","summary":"What you discovered"}}'""",
        "```",
        "",
        "### 4. Mark task complete when done:",
        "```bash",
        f"curl -s -X POST {agent_url}/overlay/status \\",
        "  -H 'Content-Type: application/json' \\",
        f"""  -d '{{"key":"{unit_id}","status":"done","summary":"One-line summary of what you implemented"}}'""",
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
    It returns the AGENTS.md text + the pre-loaded /search context so the bench's container runner
    can inject it (the division of labour in claude_code.pre_run_hook / _build_agents_md).

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
    agents_md = build_agents_md(unit_id, url, wiring.context_deps)
    return ArmResult(
        arm="on",
        mode="agent_in_container",
        agents_md=agents_md,
        context_keys=list(wiring.wired_edges),
        wiring=wiring,
    )


# ---------------------------------------------------------------------------
# Executor (b): retrieve_and_answer — read wired DAG + answer via claude_p
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
    rag_k: int = 5,
) -> ArmResult:
    """ON arm, executor (b): wire the DAG + RAG fill, read combined context, answer via claude_p.

    For QA benches that can't spawn a real agent per probe (500+ units). The unit is minted as a
    TASK PROBE so the read comes cleanly off GET /task/context; the question itself is the task
    summary (so autowire ranks NOTE providers against the question's embedding and the eager judge
    keeps/prunes them).

    After the DAG wiring step we ALSO run a RAG search (/search with the question, note-only via
    _is_note_hit filter) to catch relevant session notes that fell below the 0.55 autowire seed
    threshold — the DAG tier alone misses sub-0.55 evidence.  We dedupe by note key and tag
    DAG-vs-RAG provenance in the diagnostics on the returned WiringResult.

    The combined (DAG-kept + RAG-fill) context blocks are injected into the answer prompt.  The
    answerer remains tool-less/MCP-off: WE retrieve and inject; the answer agent calls no tools.

    Mirrors production search_knowledge(task_key) = DAG tier + RAG fill.

    *task_summary* defaults to *question* (the FB convention — embed against the unit's text).
    *data_dir* is required (the file-drop stub destination); defaults to CLAUDE_PLUGIN_DATA or the
    standard orchestrator data dir.
    *rag_k* is the top-k for the RAG fill search (default 5).
    """
    summary = task_summary or question
    dd = data_dir or os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.join(
        os.path.expanduser("~"), ".claude", "orchestrator"
    )
    wiring = run_canonical_wiring(client, unit_id, summary, data_dir=dd)
    ctx_deps = read_wired_context(client, wiring.task_key)

    # --- DAG tier (eager-judge kept edges) ---
    dag_keys: set[str] = set()
    context_blocks: list[str] = []
    all_context_keys: list[str] = []
    for d in ctx_deps:
        key = d.get("key") or ""
        text = str(d.get("summary") or "")
        if text.strip():
            context_blocks.append(f"[DAG] {text}")
        if key:
            dag_keys.add(key)
            all_context_keys.append(key)

    # --- RAG fill (semantic search, note-only, dedupe against DAG tier) ---
    rag_keys: list[str] = []
    try:
        raw_hits = client.search(question, k=rag_k * 3, gated=False)
        note_hits = [h for h in raw_hits if _is_note_hit(h)][:rag_k]
        for h in note_hits:
            key = h.get("key") or ""
            if key and key not in dag_keys:
                text = str(h.get("summary") or "")
                if text.strip():
                    context_blocks.append(f"[RAG] {text}")
                    rag_keys.append(key)
                    all_context_keys.append(key)
    except Exception as exc:  # noqa: BLE001 — RAG fill is best-effort
        print(f"[arms] RAG fill search failed (non-fatal): {exc}", file=sys.stderr)

    # Record RAG fill provenance on the wiring result for diagnostics.
    if wiring is not None:
        wiring.search_hits = list(dag_keys) + rag_keys  # dag kept + rag fill, for provenance

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
# Smoke / verify — proves the eager-judge keepEdge PERSISTS in /task/context
# ---------------------------------------------------------------------------

def _smoke(daemon: Optional[str] = None) -> int:
    """End-to-end smoke for the production-faithful eager-judge ON arm.

    Spawns an EMBEDDED daemon bound LIVE to the unit workspace (so /judge/next?node= + keepEdge
    resolve to the unit dir — note-mqgwrh5a63x) unless *daemon* is an explicit base URL, in which
    case it binds that daemon's live workspace to the unit dir via POST /workspace.

    Steps:
      1. warm_up the embedder.
      2. Ingest a planted note (cosine to the question >= 0.55 → an autowire candidate) + an
         off-topic distractor note (cosine < 0.55 → NOT a candidate).
      3. run_retrieve_and_answer on the planted fact: mint probe → autowire seeds the candidate →
         EAGER JUDGE keeps it (keepEdge promotes in place) → read /task/context.
    Assertions:
      A1  ON answer CONTAINS the planted fact.
      A2  the eager-judge keepEdge PERSISTED — the planted note surfaces in /task/context
          (on.context_keys), and wiring.wired_edges came from a keepEdge verdict (NOT idle).
      A3  cold answer does NOT contain the fact (rigging guard).
    Also runs an HONEST sub-0.55 probe and REPORTS (does not assert) whether the evidence was
    missed — that miss is correct/expected for the production pipeline.

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
    # An off-topic note (no lexical/semantic overlap with the calibration question) — expected to
    # fall BELOW the 0.55 autowire seed threshold and therefore never become a candidate.
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

        # ---- HONEST sub-0.55 probe (report-only) ----
        # Ask about the distractor's content. The distractor note is off-topic to the calibration
        # corpus; whether it clears 0.55 to THIS new probe is an empirical fact we REPORT, not rig.
        print("  [honest] sub-0.55 probe on the off-topic distractor (report-only)... ", flush=True)
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
            print(f"    => evidence {'MISSED (sub-0.55, expected/correct)' if sub_missed else 'surfaced (>=0.55 candidate)'}")
        except Exception as e:  # noqa: BLE001
            print(f"    (sub-0.55 probe errored, non-fatal: {e})")

        # ---- assertions ----
        print("\n[arms.smoke] === assertions ===")
        ok = True

        on_has = secret.lower() in (on.predicted or "").lower()
        print(f"  [{'PASS' if on_has else 'FAIL'}] A1 ON answer CONTAINS planted fact {secret!r}")
        ok = ok and on_has

        # A2: the eager-judge keepEdge PERSISTED — the planted note is in /task/context AND it was
        # KEPT by the judge (came via keepEdge, not idle). This is the spike's old failure mode
        # (empty context_keys) being explicitly guarded.
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
            print(f"  [INFO] sub-0.55 evidence behavior: "
                  f"{'MISSED (correct/expected)' if sub_missed else 'surfaced'} — report-only, not asserted")

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
