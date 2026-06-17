"""bench/zonoid_bench/arms.py — Zonoid Bench SDK: the arms module.

The ONE canonical "Zonoid ON arm" + its contrast arms, replacing the three divergent
per-bench implementations called out in docs/bench-sdk-design.md §1:

  - SWE-Bench-CL judged the autowire candidate set + read tiered /search.
  - agent-memory judged ALL sessions (no suggest_links, inflated by the full session set).
  - FeatureBench used suggest_links + a real agent (claude_code.ClaudeCodeAgent) — the closest
    to canonical, and the reference this module PORTS.

Canonical ON-arm wiring (design §5) — port of FeatureBench
``.venv-fb/Lib/site-packages/featurebench/infer/agents/claude_code.py``
(``_setup_zonoid_context`` + ``_build_agents_md``):

  1. register the unit as a note  ............ client.post_note  (POST /overlay/note, NO force)
  2. semantic search for relevant KB  ........ client.search(q=task_summary)
  3. suggest_links → ceScore  ................ client.task_suggest(task_key) (GET /task/suggest)
  4. WIRE the verified DAG  .................. for ceScore>0.2 & non-dup:
                                               client.overlay_edge(from=note, to=node, kind="context")
  5. read = frozen DAG context  ............. client.get_task_context  (GET /task/context)
                                               + the OPTION of live client.search(task_key=...).

OVERRIDE / SPEC FIX (the FeatureBench reference carries TWO latent bugs — do NOT copy them):
  (1) KIND: ``claude_code._setup_zonoid_context`` POSTs ``/overlay/edge`` with
      ``{"type": "context"}``. The daemon (routes/overlay.js:43,51) reads ``b.kind`` — NOT
      ``b.type`` — so ``type:"context"`` is ignored and the edge is created as the back-compat
      default **blocking** kind. A blocking edge also auto-seeds a low-weight context edge
      (seedBlockingDepContext), so FB's wiring "works" by accident, but the asserted edge has the
      wrong kind + an unintended blocking semantic. This SDK asserts ``kind="context"`` via
      ``client.overlay_edge`` (the canonical createEdge contract, client.py finding #6).
  (2) DIRECTION: FB wires ``from=note, to=node`` (note CONSUMES the candidate). For a unit whose
      ``/task/context`` is later READ (the retrieve_and_answer executor), the KB note must be the
      context PROVIDER, and the daemon collects a task's context_deps as the edges where
      ``e.to === task`` (depRefs, daemon.js:1599-1600). So this SDK orients the edge
      ``from=candidate(KB note), to=node(unit)`` — the candidate provides context INTO the unit.
      Same orientation as probe_runner's createEdge ({"from": note, "to": probe}). FB never reads
      /task/context (it builds AGENTS.md from /search), so its reversed direction is invisible
      there — but it is wrong for any DAG read and is fixed here.

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

§10 task→note wiring nuance (encoded, not fixed)
------------------------------------------------
note↔note kept edges are retrieval-inert over the isolated-workspace HTTP surface (the structBoost
daemon gap, note-mqfm5mvl8zw). For a TASK/PROBE node we therefore wire with createEdge
(client.overlay_edge), which UPSERTS an asserted context edge into the DAG adjacency — promoting a
pre-existing weight-0 autowire candidate AND creating one that autowire never seeded (a kept node
whose cosine fell below the 0.55 seed threshold). The read surface (GET /task/context) filters
weight-0 edges out client-side, so only wired context surfaces. This is the same createEdge / KEEP-
ONLY discipline proven in bench/agent-memory/probe_runner.py; it is the workaround the SDK encodes.

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

# ceScore threshold above which a suggest_links candidate is wired as verified context.
# Matches the FeatureBench canonical ON arm (claude_code._setup_zonoid_context) and the
# documented convention in client.task_suggest.
CE_SCORE_THRESHOLD: float = float(os.environ.get("ZONOID_BENCH_CE_THRESHOLD", "0.2"))

# Minimum plain-cosine score for a /search hit to be treated as relevant pre-loaded context
# (FB uses score > 0.1 in _setup_zonoid_context).
SEARCH_SCORE_FLOOR: float = float(os.environ.get("ZONOID_BENCH_SEARCH_FLOOR", "0.1"))

# How many /search hits to keep as pre-loaded context bullets.
CONTEXT_TOPK: int = int(os.environ.get("ZONOID_BENCH_CONTEXT_TOPK", "6"))

# How many suggest_links candidates to consider for wiring.
SUGGEST_TOPK: int = int(os.environ.get("ZONOID_BENCH_SUGGEST_TOPK", "5"))

# top-k for the rag_control arm's /search.
RAG_CONTROL_K: int = int(os.environ.get("ZONOID_BENCH_SEARCH_K", "5"))

# Weight asserted on a kept context edge. Must be > 0 so the edge is retrieval-visible
# (the graph builder filters weight-0 context edges out of the /task/context read).
# 0.5 matches the daemon DEFAULT_CONTEXT_WEIGHT and probe_runner's _KEEP_EDGE_WEIGHT.
KEEP_EDGE_WEIGHT: float = float(os.environ.get("ZONOID_BENCH_KEEP_WEIGHT", "0.5"))

# Char budget per pre-loaded context summary (keeps the answerer/AGENTS.md prompt bounded).
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
    "Answer the question using ONLY the context provided below. Be concise — reply with just "
    "the answer (a short phrase or sentence), no explanation. If the context does not contain "
    "the answer, reply exactly: I don't know.\n\n"
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
    """The outcome of the canonical ON-arm DAG wiring for one unit.

    Attributes
    ----------
    task_key       : the unit's task/note key in the graph (the node we wired context INTO).
    node_kind      : "note" (post_note) or "task" (drop_task_stub) — how the unit was registered.
    context_deps   : pre-loaded verified context bullets {label, summary, score} from /search.
    wired_edges    : the candidate KB-note keys wired as context PROVIDERS into the unit
                     (overlay_edge from=candidate, to=task_key; ceScore>0.2, non-dup).
    suggest_seen   : every suggest_links candidate considered {key, label, ceScore, duplicate}.
    search_hits    : raw /search hit keys (provenance).
    """

    task_key: str
    node_kind: str
    context_deps: list[dict[str, Any]] = field(default_factory=list)
    wired_edges: list[str] = field(default_factory=list)
    suggest_seen: list[dict[str, Any]] = field(default_factory=list)
    search_hits: list[str] = field(default_factory=list)


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


# ---------------------------------------------------------------------------
# Canonical ON-arm wiring (the headline — port of FB _setup_zonoid_context)
# ---------------------------------------------------------------------------

def _clip(text: str, n: int = SUMMARY_BUDGET) -> str:
    return (text or "")[:n]


def _register_unit(
    client: ZonoidClient,
    unit_id: str,
    task_summary: str,
    *,
    as_task: bool,
    data_dir: Optional[str],
    tags: Optional[list[str]] = None,
) -> tuple[str, str]:
    """Register the bench unit in the graph and return (node_key, node_kind).

    Two registration shapes, both feeding the daemon's autowire/ingest funnel:

    - as_task=False (default, mirrors FB): POST /overlay/note. The note becomes a provenance
      anchor + a suggest_links source. node_kind="note".
    - as_task=True: drop a file-drop task stub (workspace.drop_task_stub) so the unit is a TASK
      node, then POST /overlay/status {summary} to fire the first-vec ingest funnel
      (embed → autowireNewTaskWholeGraph → markEagerJudge). node_kind="task". Used by
      retrieve_and_answer's probe path (a task node reads cleanly off /task/context).
    """
    if as_task:
        if not data_dir:
            raise ValueError("as_task=True requires data_dir (where the file-drop stub is written)")
        ws = client.workspace
        if not ws:
            raise ValueError("client.workspace must be set to register a task stub")
        task_key = drop_task_stub(
            data_dir, ws, unit_id, task_summary, harness=UNIT_HARNESS,
            agent_id="zonoid_bench_arms",
        )
        # Wait for the daemon to adopt the stub, then drive the ingest funnel with a status write
        # carrying the summary (status:not_ready — NOT in_progress, which trips the unwired-claim
        # gate). This is the probe_runner funnel discipline.
        _wait_for_adoption(client, task_key, ADOPT_TIMEOUT_S)
        client.post_status(task_key, "not_ready", summary=task_summary)
        time.sleep(min(AUTOWIRE_SETTLE_S, 6.0))
        return task_key, "task"

    # Note path (FB default).
    resp = client.post_note(
        title=f"bench unit: {unit_id}",
        summary=task_summary,
        category="bench-unit",
        tags=tags or [unit_id.split(".")[0], "bench"],
    )
    note_key = resp.get("key") or resp.get("note_key") or ""
    if not note_key:
        raise RuntimeError(f"post_note did not return a key: {resp}")
    # Give the embedder a moment to index the new note before suggest_links/search (FB sleeps 2 s).
    time.sleep(2)
    return note_key, "note"


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


def run_canonical_wiring(
    client: ZonoidClient,
    unit_id: str,
    task_summary: str,
    *,
    as_task: bool = False,
    data_dir: Optional[str] = None,
    tags: Optional[list[str]] = None,
) -> WiringResult:
    """Run the canonical ON-arm DAG wiring for one unit (design §5).

    The five steps, ported faithfully from FeatureBench ``_setup_zonoid_context`` with the
    ``kind="context"`` correctness fix:

      1. register the unit (note or task — see _register_unit)
      2. client.search(q=task_summary) → relevant KB hits (score > SEARCH_SCORE_FLOOR)
      3. client.task_suggest(node_key) → ceScore-ranked candidates
      4. for ceScore > CE_SCORE_THRESHOLD and not duplicate:
         client.overlay_edge(from=node_key, to=candidate, kind="context", weight=KEEP_EDGE_WEIGHT)
      5. (read is the caller's job — get_task_context for the frozen DAG, optional live search)

    Returns a WiringResult capturing the node key, pre-loaded context, and the wired edges.
    """
    node_key, node_kind = _register_unit(
        client, unit_id, task_summary, as_task=as_task, data_dir=data_dir, tags=tags
    )

    result = WiringResult(task_key=node_key, node_kind=node_kind)

    # ---- Step 2: semantic search for relevant KB notes ----
    hits = client.search(task_summary, k=CONTEXT_TOPK * 2, gated=False)
    for h in hits[:CONTEXT_TOPK]:
        summary = h.get("summary") or ""
        score = h.get("score") or 0
        label = h.get("label") or ""
        if summary and score > SEARCH_SCORE_FLOOR:
            result.context_deps.append(
                {"label": label, "summary": _clip(summary), "score": score}
            )
        if h.get("key"):
            result.search_hits.append(h["key"])

    # ---- Step 3 + 4: suggest_links → ceScore → WIRE verified context edges ----
    suggest = client.task_suggest(node_key)
    suggestions = (suggest or {}).get("suggestions", []) or []
    dup_keys = {d.get("key") for d in (suggest.get("duplicates") or []) if d.get("key")}
    for s in suggestions[:SUGGEST_TOPK]:
        cand_key = s.get("key")
        ce = s.get("ceScore")
        # Fall back to plain cosine score when the cross-encoder sidecar is unavailable
        # (ceScore absent), matching FB's `s.get("ceScore") or s.get("score")`.
        score = ce if ce is not None else (s.get("score") or 0)
        is_dup = bool(s.get("duplicate")) or (cand_key in dup_keys)
        result.suggest_seen.append(
            {"key": cand_key, "label": s.get("label"), "ceScore": ce,
             "score": s.get("score"), "duplicate": is_dup}
        )
        if not cand_key or cand_key == node_key:
            continue
        if score > CE_SCORE_THRESHOLD and not is_dup:
            # createEdge / overlay_edge: assert a context edge candidate -> node, i.e.
            # from=candidate (the KB note that PROVIDES context), to=node_key (the unit that
            # CONSUMES it). This direction is load-bearing: the daemon's depRefs(ws, key)
            # collects edges where `e.to === key` (daemon.js:1599-1600), so the candidate only
            # appears in the unit's /task/context context_deps when the unit is the edge's `to`.
            # Same direction as probe_runner's createEdge ({"from": note, "to": probe}).
            #
            # Two correctness fixes over the FeatureBench reference
            # (claude_code._setup_zonoid_context):
            #   (1) kind="context" — FB POSTs type:"context", which the daemon ignores
            #       (routes/overlay.js reads b.kind), silently creating a BLOCKING edge.
            #   (2) from/to orientation — FB wires from=note, to=node; for a node whose
            #       /task/context is later READ, the provider must be `from`, so we orient the
            #       KB note as the provider.
            # weight>0 makes it retrieval-visible (the §10 structBoost-gap workaround: the graph
            # builder excludes weight-0 context edges from the context_deps payload).
            client.overlay_edge(
                cand_key, node_key, kind="context", weight=KEEP_EDGE_WEIGHT
            )
            result.wired_edges.append(cand_key)

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
    """ON arm, executor (a): wire the DAG, then build the AGENTS.md for a REAL agent.

    The bench (FeatureBench) runs the real Claude Code agent against this AGENTS.md and grades by
    the repo's tests; this function does NOT spawn the agent or call any LLM. It returns the
    AGENTS.md text + the verified context so the bench's container runner can inject it (the
    division of labour in claude_code.pre_run_hook / _build_agents_md).

    *agent_url* is the URL the in-container agent uses to reach the daemon (e.g. the docker host
    gateway). Defaults to the client's base_url when not crossing a container boundary.
    """
    wiring = run_canonical_wiring(
        client, unit_id, task_summary, as_task=as_task, data_dir=data_dir, tags=tags
    )
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

def _answer_from_context(question: str, context_blocks: list[str], model: Optional[str]) -> str:
    """Answer *question* from *context_blocks* via the shared tool-less ``judge.claude_p``.

    If no context was retrieved we make the answerer say so honestly (don't fall back to world
    knowledge — that would contaminate the arm, the same honesty discipline as probe_runner).
    """
    context = "\n\n---\n\n".join(b for b in context_blocks if b and b.strip())
    if not context.strip():
        context = "(no relevant memory was retrieved)"
    prompt = _ANSWER_TEMPLATE.format(context=context, question=question)
    raw = judge_mod.claude_p(prompt, model=model)
    return (raw or "").strip()


def run_retrieve_and_answer(
    client: ZonoidClient,
    unit_id: str,
    question: str,
    *,
    task_summary: Optional[str] = None,
    data_dir: Optional[str] = None,
    model: Optional[str] = None,
) -> ArmResult:
    """ON arm, executor (b): wire the DAG for the unit, read the wired context, answer via claude_p.

    For QA benches that can't spawn a real agent per probe (500+ units). The unit is registered as
    a TASK node (as_task=True) so the read comes cleanly off GET /task/context; the question itself
    is the task summary (so autowire + suggest_links rank against the question's embedding). The
    answer is then produced by a tool-less ``claude -p`` over ONLY the wired context summaries.

    *task_summary* defaults to *question* (the FB convention — embed against the unit's text).
    *data_dir* is required (the file-drop stub destination); defaults to CLAUDE_PLUGIN_DATA or the
    standard orchestrator data dir.
    """
    summary = task_summary or question
    dd = data_dir or os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.join(
        os.path.expanduser("~"), ".claude", "orchestrator"
    )
    wiring = run_canonical_wiring(
        client, unit_id, summary, as_task=True, data_dir=dd
    )
    ctx_deps = read_wired_context(client, wiring.task_key)
    context_blocks = [str(d.get("summary") or "") for d in ctx_deps]
    predicted = _answer_from_context(question, context_blocks, model)
    return ArmResult(
        arm="on",
        mode="retrieve_and_answer",
        predicted=predicted,
        context_keys=[d.get("key") for d in ctx_deps if d.get("key")],
        wiring=wiring,
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
    raw = judge_mod.claude_p(prompt, model=model)
    return ArmResult(arm="cold", predicted=(raw or "").strip())


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
    """
    hits = client.search(question, k=k, gated=False)  # NB: no task_key — retrieval-time control.
    context_blocks = [str(h.get("summary") or "") for h in hits]
    predicted = _answer_from_context(question, context_blocks, model)
    return ArmResult(
        arm="rag_control",
        predicted=predicted,
        context_keys=[h.get("key") for h in hits if h.get("key")],
    )


# ---------------------------------------------------------------------------
# Smoke / verify (run directly against a live daemon)
# ---------------------------------------------------------------------------

def _smoke(daemon: str = "http://localhost:8787") -> int:
    """End-to-end smoke against the live daemon (design verify spec).

    Steps:
      1. warm_up the embedder.
      2. Ingest ONE toy note carrying a planted fact into an isolated absolute workspace.
      3. Register a probe TASK for a question about that fact + run the canonical wiring
         (post_note/stub → search → suggest_links → overlay_edge).
      4. read_wired_context (GET /task/context) — assert it returns ≥0 entries without error.
      5. retrieve_and_answer on the planted fact — assert the answer CONTAINS the fact.
      6. cold on the same question — assert the answer does NOT contain the fact (rigging guard).
    Prints PASS/FAIL. If the daemon is down, says so and returns 1.
    """
    import tempfile

    # The embeddable Python console is cp1252; force utf-8 so diagnostic glyphs never crash the
    # smoke (best-effort — reconfigure exists on 3.7+; ignore if the stream lacks it).
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001
            pass

    print(f"[arms.smoke] daemon={daemon}")

    # The planted fact: a deliberately non-world-knowledge token so cold cannot know it.
    secret = "Zorblax-7741"
    fact = (
        f"The internal codename for the Zonoid bench arms calibration unit is {secret}. "
        f"This codename {secret} is recorded only in this private knowledge base and appears "
        f"in no public source."
    )
    question = "What is the internal codename for the Zonoid bench arms calibration unit?"

    ws = os.path.abspath(tempfile.mkdtemp(prefix="zonoid-arms-smoke-"))
    data_dir = os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.join(
        os.path.expanduser("~"), ".claude", "orchestrator"
    )
    client = ZonoidClient(daemon, workspace=ws, timeout=120)

    # ---- 1. warm_up ----
    print("  warm_up()... ", end="", flush=True)
    try:
        client.warm_up()
        # A real reachability probe (warm_up swallows errors): a bare /search must round-trip.
        client.search("warmup probe", k=1)
        print("OK")
    except Exception as e:  # noqa: BLE001
        print(f"FAILED - daemon may be DOWN: {e}")
        return 1

    # ---- 2. ingest one toy note with the planted fact ----
    print(f"  ingest toy note (ws={ws})... ", end="", flush=True)
    try:
        note = client.post_note(
            title="Zonoid bench arms calibration codename",
            summary=fact,
            category="bench-smoke",
            tags=["zonoid-bench", "smoke"],
        )
        note_key = note.get("key") or note.get("note_key")
        assert note_key, f"post_note returned no key: {note}"
        print(f"OK (note={note_key})")
    except Exception as e:  # noqa: BLE001
        print(f"FAILED: {e}")
        return 1
    # Let the embedder index the planted note before we search/suggest against it.
    time.sleep(3)

    # ---- 3. register probe task + run canonical wiring ----
    print("  retrieve_and_answer (register -> wire -> read -> answer)... ", flush=True)
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
    print(f"    search hits    : {w.search_hits if w else '?'}")
    print(f"    suggest seen   : {[ (s['key'], s['ceScore'], s['score'], s['duplicate']) for s in (w.suggest_seen if w else []) ]}")
    print(f"    wired edges    : {w.wired_edges if w else '?'}")
    print(f"    context keys   : {on.context_keys}")
    print(f"    ON answer      : {on.predicted!r}")

    # ---- 5/6. cold contrast ----
    print("  cold (no memory)... ", flush=True)
    try:
        cold = run_cold(question)
    except Exception as e:  # noqa: BLE001
        print(f"  FAILED during cold arm: {e}")
        return 1
    print(f"    cold answer    : {cold.predicted!r}")

    # ---- assertions ----
    print("\n[arms.smoke] === assertions ===")
    ok = True

    on_has = secret.lower() in (on.predicted or "").lower()
    print(f"  [{'PASS' if on_has else 'FAIL'}] ON (retrieve_and_answer) answer CONTAINS planted fact {secret!r}")
    ok = ok and on_has

    # The wiring must have surfaced the planted note as verified context (the whole point).
    wired_ok = bool(w and (w.wired_edges or on.context_keys))
    print(f"  [{'PASS' if wired_ok else 'FAIL'}] canonical wiring surfaced >=1 verified context edge")
    ok = ok and wired_ok

    cold_has = secret.lower() in (cold.predicted or "").lower()
    print(f"  [{'PASS' if not cold_has else 'FAIL'}] cold answer does NOT contain {secret!r} (rigging guard)")
    ok = ok and (not cold_has)

    print("\n" + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Zonoid Bench SDK arms — canonical ON arm (+pluggable executor) + contrast arms."
    )
    parser.add_argument("--smoke", action="store_true", help="Run the live-daemon smoke test.")
    parser.add_argument("--daemon", default="http://localhost:8787", help="Daemon base URL.")
    args = parser.parse_args()

    if args.smoke:
        sys.exit(_smoke(args.daemon))
    parser.print_help()
    sys.exit(0)
