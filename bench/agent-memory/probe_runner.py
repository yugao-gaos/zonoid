"""Probe runner for the agent-memory benchmark harness — the core of "their test, our DAG read".

For each (conversation, probe) — the conversation already ingested into an isolated,
absolute-path Zonoid workspace by ``ConversationIngester`` — this module answers the QA
probe THREE ways, sharing one answerer model + one answer-prompt template:

  ARM ``our-way``  (DAG read — the headline)
      PRODUCTION-FAITHFUL: delegates to the SDK canonical arm
      ``arms.run_retrieve_and_answer`` (bench/zonoid_bench/arms.py), which does the
      EXACT production eager-judge pipeline:
        mint probe task → autowire (daemon-configured top-K candidate seeding) →
        POST /judge/drain (DRIVE the production sync judge — P3 de-port; the bench runs no
        judge LLM) → keepEdge/pruneEdge applied IN the daemon →
        get_task_context → answer from ONLY kept context summaries.

      For each conversation, an EMBEDDED daemon is started with its LIVE workspace bound
      to the conversation's isolated workspace dir.  Session notes are ingested directly
      into that embedded daemon so the drain's /judge/next pull + keepEdge resolve against
      them.  The embedded daemon is stopped after all probes for the conversation complete.

      The SDK bench daemon drops the old hard cosine floor with ORCH_AUTOWIRE_THRESHOLD=0.0
      and bounds candidate cost with ORCH_AUTOWIRE_K/top-K; keepEdge still only promotes a
      real candidate returned by judge_next. There is NO createEdge workaround and NO
      blind-keep-decision over ALL sessions.

  ARM ``search``   (retrieval-time control — "normal RAG memory")
      Same ingested graph; GET /search?q=<question> -> top-k session summaries ->
      answer.  The apples-to-apples retrieval baseline.

  ARM ``cold``     (floor / rigging guard)
      Answer with NO memory at all.  If the floor scores as well as the memory arms,
      the probe was answerable from world knowledge and the result is rigged.

Honesty bar (NON-NEGOTIABLE)
----------------------------
The gold answer and the dataset ``evidence`` / ``answer_session_ids`` labels are used
ONLY by the scorer (a later task) — NEVER by the retrieve / keep / answer steps of ANY
arm.  The KEEP decision is made by the SDK's LLM EdgeJudge that sees ONLY the question +
autowire candidate note summaries (no gold, no evidence labels).
``gold`` is threaded through to the output record for the scorer's convenience; it never
enters any prediction path.

Production-faithful arm (per /25 decision, SDK arms.py)
--------------------------------------------------------
The ``our-way`` arm delegates ENTIRELY to ``arms.run_retrieve_and_answer``, which:
1. Mints the probe as a TASK PROBE (file-drop stub) so the eager-judge is task-centric.
2. Fires the ingest funnel (embed → setTaskVec → autowireNewTaskWholeGraph → markEagerJudge):
   autowire seeds weight-0 NOTE→probe candidate edges according to the daemon's configured
   candidate policy (canonical bench default: threshold 0.0 + top-K cap).
3. DRIVES the production sync judge via client.judge_drain(node=<probe>): ONE POST /judge/drain
   reuses the in-process production judge (runJudgeDrainSync) to pull the autowire candidate set
   (/judge/next), run the keep/prune rubric, and apply keepEdge/pruneEdge — all in the daemon.
   The bench holds NO judge LLM and parses NO verdict (P3 de-port). keepEdge promotes a weight-0
   candidate IN PLACE (judged:true + real weight); pruneEdge deletes it.
4. Reads GET /task/context → dependencySummaries (weight>0 = kept context edges).
5. Answers from ONLY those summaries via a tool-less claude -p.

WHY embedded daemon (note-mqgwrh5a63x):
  /judge/drain, /judge/next and the keepEdge save are HARD-BOUND to the daemon's LIVE
  state.workspace. A keepEdge on a non-live (isolated) workspace does NOT surface in /task/context.
  One embedded daemon per conversation whose live workspace IS the conv dir ensures
  the whole pipeline (autowire seed → markEagerJudge → /judge/drain → keepEdge save →
  /task/context) operates on ONE consistent in-memory + persisted overlay.

Runtime (note-mqgz977tbqe): embeddable Python 3.12 — stdlib ONLY (urllib.request, json,
subprocess, os).  No pip / requests.  Invoke ``claude -p`` for every answerer / judge call.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any

# Embeddable Python 3.12 (py312embed) strips cwd from sys.path. Insert the directory
# containing this script so sibling modules (zonoid_lifecycle, ingest, datasets) are
# importable regardless of the working directory. (Same pattern as ingest.py.)
_HERE = os.path.dirname(os.path.abspath(__file__))
_BENCH = os.path.dirname(_HERE)
for _p in (_HERE, _BENCH):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from zonoid_lifecycle import (  # noqa: E402
    search as kb_search,
    warm_up,
)

# SDK canonical ON-arm + embedded daemon lifecycle.
from zonoid_bench import arms as _arms  # noqa: E402
from zonoid_bench import daemon as _daemon_mod  # noqa: E402
from zonoid_bench.client import ZonoidClient  # noqa: E402

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_DAEMON = "http://localhost:8787"

# The answerer + judge model. The `claude` CLI resolves the alias. Override via env.
_ANSWER_MODEL = os.environ.get("ZONOID_BENCH_MODEL", "sonnet")


def _resolve_claude_cli() -> str:
    """Resolve the `claude` CLI to an absolute path.

    On Windows `claude` is a `.cmd` shim; subprocess(shell=False) does NOT resolve `.cmd`
    via PATHEXT when given a bare name (only `.exe`). ``shutil.which`` DOES honor PATHEXT, so
    it returns the real ``claude.cmd``/``claude`` path and the spawn works without shell=True.
    Override with ZONOID_BENCH_CLAUDE (an explicit path skips resolution).
    """
    override = os.environ.get("ZONOID_BENCH_CLAUDE")
    if override:
        return override
    found = shutil.which("claude")
    return found or "claude"


# claude CLI path. On this Windows box `claude` is a .cmd shim — resolve via PATHEXT.
_CLAUDE_CLI = _resolve_claude_cli()
# Per `claude -p` call timeout (seconds).
_CLAUDE_TIMEOUT = int(os.environ.get("ZONOID_BENCH_CLAUDE_TIMEOUT", "180"))

# top-k for the search arm.
_SEARCH_K = int(os.environ.get("ZONOID_BENCH_SEARCH_K", "5"))

# Char budget for each session summary shown to the answerer (keeps the `claude -p`
# prompt bounded regardless of conversation length).
_SUMMARY_BUDGET = 2000

# How long to wait between session note ingests (let the embedder index each note).
_INGEST_SETTLE_S = float(os.environ.get("ZONOID_BENCH_INGEST_SETTLE", "3.0"))


# ---------------------------------------------------------------------------
# claude -p helpers (mirrors bench/swe-bench-cl/zonoid_memory.py)
# ---------------------------------------------------------------------------

def _run_claude(prompt: str) -> str | None:
    """Run a single-shot, tool-less ``claude -p`` completion.

    The answerer/judge is a PURE text completion: it needs NO tools and writes nothing.
    We run it with an EMPTY MCP config + --strict-mcp-config (no graph server reachable)
    and --allowedTools "" (forbid all tool use). We do NOT pass
    --dangerously-skip-permissions — there are no tool calls to approve.

    The prompt is delivered on STDIN, NOT as a positional CLI arg. On Windows `claude` is a
    ``.cmd`` shim; a long/multi-line positional prompt (with apostrophes, braces, quotes) gets
    mangled by cmd.exe arg parsing — observed live: medium/long positional prompts arrived
    truncated/empty at the model. ``claude -p`` with NO positional reads the prompt from stdin,
    which is byte-clean regardless of length or special chars. ``input=`` requires no shell.

    Returns the raw stdout text, or None on spawn failure / non-zero exit.
    """
    mcp_off = os.path.join(_HERE, "mcp-off.json")
    args = [
        _CLAUDE_CLI,
        "-p",
        "--model",
        _ANSWER_MODEL,
        "--output-format",
        "text",
        "--allowedTools",
        "",
    ]
    if os.path.exists(mcp_off):
        args[2:2] = ["--mcp-config", mcp_off, "--strict-mcp-config"]
    try:
        run = subprocess.run(
            args,
            input=prompt,  # prompt on stdin — robust on the Windows .cmd shim
            capture_output=True,
            text=True,
            encoding="utf-8",  # force utf-8 I/O (box default is cp1252 -> mojibake/errors)
            timeout=_CLAUDE_TIMEOUT,
        )
    except Exception as exc:  # noqa: BLE001 — spawn failures are non-fatal here
        print(f"[probe_runner] claude -p spawn failed: {exc}", file=sys.stderr)
        return None
    if run.returncode != 0:
        tail = (run.stderr or run.stdout or "")[-400:]
        print(
            f"[probe_runner] claude -p exit={run.returncode}; tail: {tail}",
            file=sys.stderr,
        )
        return None
    return run.stdout or ""


# ---------------------------------------------------------------------------
# Session candidate model (for the session-based probe runner)
# ---------------------------------------------------------------------------

class _SessionCandidate:
    """One ingested session as a blind-judge candidate.

    Attributes:
        sid:        Stable session id label shown to the judge (the session idx as str).
        date:       Session date (or "unknown-date").
        note_keys:  All note keys for this session (>1 if the session was split into .partN).
        summary:    Concatenated, budget-clipped session text (for judge + answerer prompts).
    """

    def __init__(self, sid: str, date: str, note_keys: list[str], summary: str) -> None:
        self.sid = sid
        self.date = date
        self.note_keys = note_keys
        self.summary = summary


def _build_session_candidates(
    conv: dict[str, Any], ingest_map: dict[str, list[dict[str, str]]]
) -> list[_SessionCandidate]:
    """Build the per-session candidate list from the conversation + the ingester's note map.

    ``ingest_map`` is ``{session_idx(str): [{note_key, title}, ...]}`` (the return of
    ``ConversationIngester.ingest``). We pair each session's note keys with a budget-clipped
    rendering of its turns (the same speaker-labelled lines the ingester wrote), so the blind
    judge and the answerer see human-readable session text.
    """
    # Map session idx -> session dict for date + turns.
    by_idx = {str(s.get("idx")): s for s in (conv.get("sessions") or [])}
    cands: list[_SessionCandidate] = []
    for sid, notes in ingest_map.items():
        note_keys = [n["note_key"] for n in notes if n.get("note_key")]
        if not note_keys:
            continue
        sess = by_idx.get(sid, {})
        date = sess.get("date") or "unknown-date"
        # Render the session's turns the same way the ingester did (speaker-labelled lines).
        lines = []
        for t in sess.get("turns") or []:
            speaker = (t.get("speaker") or "unknown").strip()
            text = (t.get("text") or "").strip()
            tid = t.get("turn_id")
            prefix = f"[{tid}] " if tid else ""
            lines.append(f"{prefix}{speaker}: {text}")
        # Prepend the session date so the embedded daemon sees a date-in-body signal that
        # matches what ConversationIngester.ingest() writes on the main-daemon path (the #33
        # date-in-body fix).  Without this prefix the embedded-daemon search scores stay at
        # zero for date-anchored queries and RAG stays empty for LoCoMo convs.
        date_prefix = f"Session date: {date}\n"
        # Do NOT clip here — notes are already chunked at ingest (NOTE_BUDGET=6000 chars);
        # clipping to _SUMMARY_BUDGET would drop facts before they reach the embedded daemon
        # and the answerer.  The ingest chunking already bounds the note size.
        summary = date_prefix + "\n".join(lines)
        cands.append(_SessionCandidate(sid=sid, date=str(date), note_keys=note_keys, summary=summary))
    # Stable order by numeric session idx where possible.
    cands.sort(key=lambda c: (int(c.sid) if c.sid.isdigit() else 1_000_000, c.sid))
    return cands


# ---------------------------------------------------------------------------
# Shared answerer (used by run_search + run_cold; run_our_way delegates to arms.py)
# ---------------------------------------------------------------------------

_COLD_TEMPLATE = (
    "Answer the question concisely — reply with just the answer (a short phrase or sentence), "
    "no explanation. If you do not know, reply exactly: I don't know.\n\n"
    "QUESTION: {question}\n\n"
    "ANSWER:"
)

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


def _answer_from_context(question: str, context_blocks: list[str]) -> str:
    """Answer *question* from the supplied *context_blocks* via the shared answerer template."""
    context = "\n\n---\n\n".join(b for b in context_blocks if b and b.strip())
    if not context.strip():
        context = "(no relevant memory was retrieved)"
    prompt = _ANSWER_TEMPLATE.format(context=context, question=question)
    raw = _run_claude(prompt)
    return (raw or "").strip()


def _answer_cold(question: str) -> str:
    """Answer *question* with NO memory at all (the floor / rigging guard)."""
    prompt = _COLD_TEMPLATE.format(question=question)
    raw = _run_claude(prompt)
    return (raw or "").strip()


# ---------------------------------------------------------------------------
# Embedded daemon lifecycle for the our-way arm (per-conversation)
# ---------------------------------------------------------------------------

def _find_daemon_js() -> str | None:
    """Best-effort: resolve daemon.js from the bench parent tree (same as arms._smoke)."""
    try:
        from zonoid_bench.smoke import _find_daemon_js as _f  # type: ignore[attr-defined]
        return _f()
    except Exception:  # noqa: BLE001
        return None


def _start_our_way_daemon(workspace: str) -> "_daemon_mod.DaemonHandle":
    """Spawn an embedded daemon LIVE-BOUND to *workspace*.

    The eager-judge read (/judge/next?node=) and keepEdge promotion are hard-bound to
    the daemon's live state.workspace (note-mqgwrh5a63x). This makes autowire candidates
    surface and keepEdge results persist in /task/context for notes ingested into *workspace*.

    ORCH_HEADLESS_DRAINS=0 is set by daemon.start() to prevent hang.

    Raises RuntimeError if the daemon fails to reach phase:ready within the timeout.
    """
    daemon_js = _find_daemon_js()
    if daemon_js:
        print(f"[probe_runner] using daemon.js: {daemon_js}", file=sys.stderr)
    handle = _daemon_mod.start(daemon_js=daemon_js, workspace=workspace)
    print(
        f"[probe_runner] embedded daemon ready: {handle.base_url}  ws={workspace!r}",
        file=sys.stderr,
    )
    return handle


def _ingest_candidates_into_daemon(
    client: "ZonoidClient",
    candidates: list["_SessionCandidate"],
    workspace: str,
) -> None:
    """Write each session candidate as a note into the embedded daemon's workspace.

    We use the candidate's already-rendered summary (budget-clipped session text) so the
    content the EdgeJudge ranks is semantically equivalent to what the ingester originally
    wrote.

    WORKSPACE-SKIP: if the workspace already contains session notes (ingested by the
    main-daemon path via ConversationIngester.ingest()), we skip re-ingest entirely.
    Re-ingesting into a workspace that already has notes causes two problems:
      1. The daemon's dup-guard (cosine >= 0.70 title similarity) marks the new notes
         pending_dup=True, making them retrieval-invisible.
      2. The subsumption gate (cosine >= 0.92 body similarity) retires the EXISTING notes
         by setting their validTo — leaving ZERO searchable notes.
    Skipping when the workspace already has notes preserves the main-daemon ingested notes
    (which include the date-in-body fix from ConversationIngester.ingest()) and keeps them
    visible for RAG fill.

    A brief settle after each note lets the embedder index it before autowire seeds candidates.
    """
    # Pre-check: if workspace already has session notes, skip re-ingest to avoid subsumption.
    try:
        pre_hits = client.search("session", k=3, gated=False)
        if pre_hits:
            print(
                f"[probe_runner]   workspace already has {len(pre_hits)} notes — "
                f"skipping re-ingest to preserve existing notes (dup/subsumption safety)",
                file=sys.stderr,
            )
            return
    except Exception as exc:  # noqa: BLE001
        print(f"[probe_runner]   WARN: pre-check search failed ({exc}) — proceeding with re-ingest", file=sys.stderr)

    for c in candidates:
        if not c.summary.strip():
            continue
        title = f"session {c.sid} ({c.date})"
        try:
            resp = client.post_note(
                title=title,
                summary=c.summary,
                category="conversation-session",
                tags=[f"session-{c.sid}"],
                workspace=workspace,
            )
            print(
                f"[probe_runner]   ingested session {c.sid}: key={resp.get('key') or resp.get('note_key')}",
                file=sys.stderr,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[probe_runner]   WARN: session {c.sid} ingest failed: {exc}", file=sys.stderr)
    # Give the embedder time to index all notes before autowire seeds candidates.
    if candidates:
        time.sleep(_INGEST_SETTLE_S)


# ---------------------------------------------------------------------------
# The three arms
# ---------------------------------------------------------------------------

def run_our_way(
    base_url: str,
    workspace: str,
    probe: dict[str, Any],
    candidates: list["_SessionCandidate"],
    *,
    _embedded_client: "ZonoidClient | None" = None,
    _embedded_data_dir: "str | None" = None,
) -> dict[str, Any]:
    """ARM our-way: PRODUCTION-FAITHFUL eager-judge pipeline via the SDK canonical arm.

    Delegates to ``arms.run_retrieve_and_answer`` which does:
      mint probe task → autowire (daemon-configured top-K candidate seeding) →
      POST /judge/drain (DRIVE the production sync judge — P3 de-port; no bench judge LLM) →
      keepEdge/pruneEdge applied IN the daemon →
      get_task_context (read kept context) → answer.

    If *_embedded_client* is provided (pre-started embedded daemon, see
    ``run_probe_with_sdk_daemon``), it is used directly.  Otherwise a fresh embedded
    daemon is spawned just for this probe (slower, but backward-compatible with
    callers that haven't been updated yet).

    The SDK bench daemon broadens candidate recall with ORCH_AUTOWIRE_THRESHOLD=0.0 plus
    ORCH_AUTOWIRE_K/top-K bounds; keepEdge still promotes only real judge_next candidates.
    The old run inflated recall via createEdge by forcing non-candidate sessions into
    context — that bypass is now gone.

    Returns a diagnostics dict: {predicted, kept_sids, context_keys, candidate_sids}.
    The gold answer / evidence labels are NEVER consulted here.

    ``kept_sids`` is now the list of KEPT CONTEXT NOTE KEYS (from wiring.wired_edges)
    rather than session ids — the EdgeJudge keeps by note key (the natural identifier
    in the autowire DAG), not by session id. The scorer uses only ``predicted``.
    ``candidate_sids`` is preserved for backward compatibility with the scorer output shape.
    """
    question = probe["question"]
    unit_id = f"{probe['qid']}-{int(time.time() * 1000) % 1_000_000}"

    diag: dict[str, Any] = {
        "candidate_sids": [c.sid for c in candidates],
        "kept_sids": [],      # will hold wired_edges keys (not session ids)
        "context_keys": [],
        "judge_idle": False,
        "timeout_kills": 0,
        "provisional_kept": 0,
    }

    own_daemon = _embedded_client is None
    handle = None
    try:
        if own_daemon:
            # Spawn a per-probe embedded daemon bound to the conversation workspace.
            # Slower than reusing a per-conversation daemon, but works for callers
            # that haven't migrated to run_probe_with_sdk_daemon yet.
            handle = _start_our_way_daemon(workspace)
            client = ZonoidClient(handle.base_url, workspace=workspace, timeout=120)
            data_dir = handle.data_dir
            _ingest_candidates_into_daemon(client, candidates, workspace)
        else:
            client = _embedded_client
            data_dir = _embedded_data_dir or ""

        # Delegate to the SDK canonical arm (production-faithful eager-judge path).
        result = _arms.run_retrieve_and_answer(
            client,
            unit_id=unit_id,
            question=question,
            task_summary=question,
            data_dir=data_dir,
        )
        w = result.wiring
        diag["context_keys"] = list(result.context_keys)
        if w is not None:
            diag["kept_sids"] = list(w.wired_edges)    # kept note keys
            diag["judge_idle"] = w.judge_idle
            diag["timeout_kills"] = w.timeout_kills
            diag["provisional_kept"] = w.provisional_kept
            if w.task_key:
                diag["probe_key"] = w.task_key
        diag["predicted"] = result.predicted or ""

    finally:
        if own_daemon and handle is not None:
            try:
                _daemon_mod.stop(handle)
            except Exception:  # noqa: BLE001
                pass
    return diag


def run_our_way_prod(
    base_url: str,
    workspace: str,
    probe: dict[str, Any],
    candidates: list["_SessionCandidate"],
    *,
    _embedded_client: "ZonoidClient | None" = None,
    _embedded_data_dir: "str | None" = None,
) -> dict[str, Any]:
    """ARM our-way-prod: PRODUCTION agentic + LLM-GRADER retrieval (the grader-delta arm).

    Identical to ``run_our_way`` up to and INCLUDING the canonical wiring + production sync-judge
    drain (which settles the DAG Tier-1 edges), but the context is retrieved through the PRODUCTION
    agentic loop ``POST /subconscious/search-context`` (``store.searchContext`` →
    ``runAgenticContextSearches`` + ``gradeSearchRound`` per round) instead of the one-shot
    ``/search?task_key=`` read. That loop EXERCISES the LLM grader, so this arm is byte-identical to
    the live production agentic retrieval. We run it ALONGSIDE the frozen-DAG ``our-way`` arm to
    measure the grader delta — ``our-way`` is intentionally kept.

    Delegates to ``arms.run_retrieve_and_answer(..., retrieval="agentic")``.

    Returns a diagnostics dict shaped like ``run_our_way`` plus ``grader`` (the grader provenance —
    {enabled, rounds, kept_keys, last_verdict, ...} — the evidence the agentic+grader loop fired).
    The gold answer / evidence labels are NEVER consulted here.
    """
    question = probe["question"]
    unit_id = f"{probe['qid']}-prod-{int(time.time() * 1000) % 1_000_000}"

    diag: dict[str, Any] = {
        "candidate_sids": [c.sid for c in candidates],
        "kept_sids": [],
        "context_keys": [],
        "judge_idle": False,
        "timeout_kills": 0,
        "provisional_kept": 0,
        "grader": {},
    }

    own_daemon = _embedded_client is None
    handle = None
    try:
        if own_daemon:
            handle = _start_our_way_daemon(workspace)
            client = ZonoidClient(handle.base_url, workspace=workspace, timeout=120)
            data_dir = handle.data_dir
            _ingest_candidates_into_daemon(client, candidates, workspace)
        else:
            client = _embedded_client
            data_dir = _embedded_data_dir or ""

        # Production agentic + grader retrieval path (retrieval="agentic").
        result = _arms.run_retrieve_and_answer(
            client,
            unit_id=unit_id,
            question=question,
            task_summary=question,
            data_dir=data_dir,
            retrieval="agentic",
        )
        w = result.wiring
        diag["context_keys"] = list(result.context_keys)
        diag["grader"] = dict(result.grader or {})
        if w is not None:
            diag["kept_sids"] = list(w.wired_edges)
            diag["judge_idle"] = w.judge_idle
            diag["timeout_kills"] = w.timeout_kills
            diag["provisional_kept"] = w.provisional_kept
            if w.task_key:
                diag["probe_key"] = w.task_key
        diag["predicted"] = result.predicted or ""

    finally:
        if own_daemon and handle is not None:
            try:
                _daemon_mod.stop(handle)
            except Exception:  # noqa: BLE001
                pass
    return diag


def _is_session_note_hit(hit: dict[str, Any]) -> bool:
    """Return True iff *hit* is an ingested session NOTE, not a harness task stub.

    The search index contains both ingested NOTE nodes and harness TASK STUB nodes (probe/*,
    bench/*) minted during the same bench run.  Stubs are ANCHORS, not MEMORY; including them
    injects garbage and drives rag-control accuracy to 0%.  Exclude by two independent signals:

      1. kind != 'task'   — daemon-authoritative: notes are 'knowledge', stubs are 'task'.
      2. key not prefixed 'probe/' or 'bench/'  — belt-and-suspenders harness namespaces.
    """
    key = hit.get("key") or ""
    if hit.get("kind") == "task":
        return False
    if key.startswith("probe/") or key.startswith("bench/"):
        return False
    return True


def run_search(base_url: str, workspace: str, probe: dict[str, Any]) -> dict[str, Any]:
    """ARM search: GET /search?q=<question> -> top-k session NOTE summaries -> answer.

    The retrieval-time control. Uses the SAME ingested graph; no probe task, no DAG read.

    Bug fix (/30): raw /search results include harness TASK STUB nodes (probe/*, bench/*)
    that ranked above session notes, producing 0% accuracy.  We now filter to NOTE-only hits
    (kind!='task' AND key not prefixed probe/|bench/) before building the context.
    """
    question = probe["question"]
    # Request more hits than needed so that after stub filtering we still have _SEARCH_K notes.
    raw_hits = kb_search(base_url, workspace, question, k=_SEARCH_K * 3, gated=False)
    note_hits = [h for h in raw_hits if _is_session_note_hit(h)][:_SEARCH_K]
    context_blocks = [str(h.get("summary") or "") for h in note_hits]
    return {
        "predicted": _answer_from_context(question, context_blocks),
        "hit_keys": [h.get("key") for h in note_hits],
    }


def run_cold(probe: dict[str, Any]) -> dict[str, Any]:
    """ARM cold: answer with NO memory at all (floor / rigging guard)."""
    return {"predicted": _answer_cold(probe["question"])}


def run_probe_combined(
    base_url: str,
    workspace: str,
    distill_workspace: str,
    conv_id: str,
    probe: dict,
) -> list[dict]:
    """ARM combined: merge raw-chunk hits + atomic-fact hits, rank by RRF, answer.

    This is the production-equivalent arm: both ingest paths have already run,
    retrieval merges both pools before answering.
    """
    question = probe["question"]
    k = _SEARCH_K * 3  # fetch extra from each pool before merge

    # Retrieve from both pools independently
    raw_hits  = kb_search(base_url, workspace,         question, k=k, gated=False)
    fact_hits = kb_search(base_url, distill_workspace, question, k=k, gated=False)

    # Filter stubs from each pool
    raw_hits  = [h for h in raw_hits  if _is_session_note_hit(h)]
    fact_hits = [h for h in fact_hits if _is_session_note_hit(h)]

    # Merge by key (fact_hits take precedence on collision — more specific)
    seen: dict[str, Any] = {}
    for h in fact_hits:
        seen[h.get("key")] = h
    for h in raw_hits:
        k_ = h.get("key")
        if k_ not in seen:
            seen[k_] = h

    # Re-rank merged pool by score descending, take top _SEARCH_K
    merged = sorted(seen.values(), key=lambda h: h.get("score", 0), reverse=True)[:_SEARCH_K]

    context_blocks = [str(h.get("summary") or "") for h in merged]
    predicted = _answer_from_context(question, context_blocks)

    common = {
        "conv_id": conv_id,
        "qid": probe.get("qid"),
        "category": probe.get("category"),
        "question": probe.get("question"),
        "gold": probe.get("answer"),
    }
    return [{
        "arm": "combined",
        **common,
        "predicted": predicted,
        "hit_keys": [h.get("key") for h in merged],
    }]


def run_probe_distill(
    base_url: str,
    workspace: str,
    conv_id: str,
    probe: dict[str, Any],
) -> list[dict[str, Any]]:
    """ARM distill: search the distilled-fact workspace and answer the probe.

    The distill arm is structurally identical to the search arm, except it
    operates on a DIFFERENT workspace that was populated by ``ConversationDistiller``
    (atomic LLM-extracted fact notes) rather than by ``ConversationIngester``
    (raw session-turn notes).

    This makes a direct apples-to-apples comparison possible:
      - search arm: retrieval over raw session chunks (current baseline)
      - distill arm: retrieval over atomic fact notes (Phase 1 hypothesis)

    Returns a list with one record (arm="distill").
    ``gold`` is recorded FOR THE SCORER ONLY; it never enters the prediction path.
    """
    common = {
        "conv_id": conv_id,
        "qid": probe.get("qid"),
        "category": probe.get("category"),
        "question": probe.get("question"),
        "gold": probe.get("answer"),  # for the scorer; NOT used by any arm
    }
    question = probe["question"]
    raw_hits = kb_search(base_url, workspace, question, k=_SEARCH_K * 3, gated=False)
    note_hits = [h for h in raw_hits if _is_session_note_hit(h)][:_SEARCH_K]
    context_blocks = [str(h.get("summary") or "") for h in note_hits]
    predicted = _answer_from_context(question, context_blocks)
    return [{
        "arm": "distill",
        **common,
        "predicted": predicted,
        "hit_keys": [h.get("key") for h in note_hits],
    }]


def run_probe_dag_combined(
    base_url: str,
    workspace: str,
    distill_workspace: str,
    conv_id: str,
    probe: dict[str, Any],
    candidates: list[_SessionCandidate],
) -> list[dict[str, Any]]:
    """ARM dag-combined: settled task context plus distill fact search, merged context.

    Merges two production-faithful retrieval surfaces then answers ONCE:
      1. Task context : autowire candidate set → production sync judge (POST /judge/drain, P3
                        de-port — no bench judge LLM) → task-scoped search. A settled
                        probe yields system + frozen DAG context, not a synthetic RAG fill.
      2. Distill tier : top-k vector search over atomic fact notes (*distill_workspace*).

    The task-context tier uses the embedded daemon (fresh overlay, no pendingDup). Keys are deduped
    across tiers; blocks preserve [SYSTEM]/[DAG] provenance and label [DISTILL] separately.
    """
    question = probe["question"]
    unit_id = f"{probe['qid']}-dc-{int(time.time() * 1000) % 1_000_000}"
    common = {
        "conv_id": conv_id,
        "qid": probe.get("qid"),
        "category": probe.get("category"),
        "question": probe.get("question"),
        "gold": probe.get("answer"),
    }

    handle = None
    emb_workspace = tempfile.mkdtemp(prefix="zonoid-dag-emb-")
    try:
        # ONE embedded daemon on a FRESH temp workspace so _ingest_candidates_into_daemon
        # never hits the "already has notes" skip — the outer workspace has main-daemon
        # notes that would trigger the pre-check and prevent ingest.
        handle = _start_our_way_daemon(emb_workspace)
        emb_url = handle.base_url
        emb_data_dir = handle.data_dir
        emb_client = ZonoidClient(emb_url, workspace=emb_workspace, timeout=120)
        _ingest_candidates_into_daemon(emb_client, candidates, emb_workspace)

        seen_keys: set[str] = set()
        context_blocks: list[str] = []

        # ── Tier 1: production task-scoped context after eager judgment ─────────────────────
        try:
            wiring = _arms.run_canonical_wiring(
                emb_client,
                unit_id=unit_id,
                task_summary=question,
                data_dir=emb_data_dir,
            )
            dag_count = 0
            system_count = 0
            raw_hits = _arms.read_task_search_context(
                emb_client, wiring.task_key, question, k=_SEARCH_K
            )
            for h in raw_hits:
                key = h.get("key") or ""
                if not key or key in seen_keys:
                    continue
                text = str(h.get("summary") or "")
                if not text.strip():
                    continue
                label = _arms.task_search_context_label(h)
                context_blocks.append(f"[{label}] {text}")
                seen_keys.add(key)
                if label == "DAG":
                    dag_count += 1
                elif label == "SYSTEM":
                    system_count += 1
            print(
                f"[probe_runner] task context: judge_idle={wiring.judge_idle} dag={dag_count} system={system_count}",
                file=sys.stderr,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[probe_runner] task context tier failed (non-fatal): {exc}", file=sys.stderr)

        # ── Tier 3: distill fact search (main daemon — distill facts are not in embedded daemon) ─
        try:
            dist_client = ZonoidClient(base_url, workspace=distill_workspace, timeout=120)
            distill_raw = dist_client.search(question, k=_SEARCH_K * 3, gated=False)
            for h in [h for h in distill_raw if _is_session_note_hit(h)][:_SEARCH_K]:
                key = h.get("key") or ""
                if key and key not in seen_keys:
                    text = str(h.get("summary") or "")
                    if text.strip():
                        context_blocks.append(f"[DISTILL] {text}")
                    seen_keys.add(key)
        except Exception as exc:  # noqa: BLE001
            print(f"[probe_runner] dag-combined distill tier failed (non-fatal): {exc}", file=sys.stderr)

        predicted = _answer_from_context(question, context_blocks)

    finally:
        if handle is not None:
            try:
                _daemon_mod.stop(handle)
            except Exception:  # noqa: BLE001
                pass
        shutil.rmtree(emb_workspace, ignore_errors=True)

    return [{"arm": "dag-combined", **common, "predicted": predicted}]


# ---------------------------------------------------------------------------
# Orchestration: run all three arms for one (conv, probe)
# ---------------------------------------------------------------------------

def run_probe(
    base_url: str,
    workspace: str,
    conv_id: str,
    probe: dict[str, Any],
    candidates: list[_SessionCandidate],
    arms: "list[str] | None" = None,
) -> list[dict[str, Any]]:
    """Run the standard arms for one probe and return one result record per arm.

    Each record: {arm, conv_id, qid, category, question, gold, predicted, ...diagnostics}.
    ``gold`` is recorded FOR THE SCORER ONLY; it never enters any prediction path above.

    Always runs our-way + search + cold (the legacy default). When ``arms`` includes
    ``"our-way-prod"``, ALSO runs the production agentic + LLM-grader retrieval arm (run_our_way_prod)
    reusing the SAME embedded daemon — gated on the arm being requested so its extra grader +
    answerer cost is only paid when asked for. ``arms`` is the caller's requested-arm list (run.py
    passes it); None means "legacy three only".

    Uses ONE embedded daemon for the our-way / our-way-prod / search arms so they all benefit
    from the embedded daemon's fresh overlay (no pendingDup) — all ingested session notes
    are visible. The main daemon's overlay can have pendingDup entries that make notes
    retrieval-invisible, causing 0% accuracy on real multi-session data.
    """
    want_prod = bool(arms) and ("our-way-prod" in arms)
    common = {
        "conv_id": conv_id,
        "qid": probe.get("qid"),
        "category": probe.get("category"),
        "question": probe.get("question"),
        "gold": probe.get("answer"),  # for the scorer; NOT used by any arm
    }
    records: list[dict[str, Any]] = []

    # Start ONE embedded daemon for the our-way / our-way-prod / search arms.
    # The embedded daemon loads a fresh overlay from graph-store (no pendingDup),
    # making all ingested session notes visible to search retrieval.
    handle = None
    try:
        handle = _start_our_way_daemon(workspace)
        emb_url = handle.base_url
        emb_data_dir = handle.data_dir
        emb_client = ZonoidClient(emb_url, workspace=workspace, timeout=120)
        _ingest_candidates_into_daemon(emb_client, candidates, workspace)

        # ARM our-way (headline, frozen-DAG read) — reuses embedded daemon
        ow = run_our_way(
            base_url, workspace, probe, candidates,
            _embedded_client=emb_client,
            _embedded_data_dir=emb_data_dir,
        )
        records.append({
            "arm": "our-way",
            **common,
            "predicted": ow.get("predicted", ""),
            "kept_sids": ow.get("kept_sids"),
            "context_keys": ow.get("context_keys"),
            "candidate_sids": ow.get("candidate_sids"),
        })

        # ARM our-way-prod (production agentic + LLM-grader retrieval) — reuses embedded daemon.
        # Gated on request so its extra grader/answerer cost is only paid when asked for. Run
        # ALONGSIDE our-way to measure the grader delta (our-way is intentionally kept).
        if want_prod:
            owp = run_our_way_prod(
                base_url, workspace, probe, candidates,
                _embedded_client=emb_client,
                _embedded_data_dir=emb_data_dir,
            )
            records.append({
                "arm": "our-way-prod",
                **common,
                "predicted": owp.get("predicted", ""),
                "kept_sids": owp.get("kept_sids"),
                "context_keys": owp.get("context_keys"),
                "candidate_sids": owp.get("candidate_sids"),
                "grader": owp.get("grader"),
            })

        # ARM search — uses embedded daemon for full note visibility (no pendingDup)
        sr = run_search(emb_url, workspace, probe)
        records.append({
            "arm": "search",
            **common,
            "predicted": sr.get("predicted", ""),
            "hit_keys": sr.get("hit_keys"),
        })
    finally:
        if handle is not None:
            try:
                _daemon_mod.stop(handle)
            except Exception:  # noqa: BLE001
                pass

    # ARM cold (floor) — no memory needed, runs after daemon stop
    cd = run_cold(probe)
    records.append({
        "arm": "cold",
        **common,
        "predicted": cd.get("predicted", ""),
    })

    return records


def run_conversation(
    base_url: str,
    conv: dict[str, Any],
    ingester: "Any",
    out_fh: "Any",
    max_probes: int | None = None,
) -> int:
    """Ingest *conv* (if not already), then run every probe through all three arms.

    Writes one JSONL record per (probe, arm) to *out_fh*. Returns the number of records.

    NOTE: the caller may pre-ingest; we (re)ingest here idempotently is NOT safe (it would
    write duplicate notes), so this assumes the conversation has NOT yet been ingested by the
    caller. For a caller that already ingested, use run_probe directly with a pre-built
    candidate list.
    """
    conv_id = str(conv.get("conv_id") or "unknown")
    workspace = ingester.workspace_for(conv_id)
    ingest_map = ingester.ingest(conv)
    candidates = _build_session_candidates(conv, ingest_map)

    probes = conv.get("probes") or []
    if max_probes is not None:
        probes = probes[:max_probes]

    n = 0
    for probe in probes:
        for rec in run_probe(base_url, workspace, conv_id, probe, candidates):
            out_fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            out_fh.flush()
            n += 1
    return n


# ---------------------------------------------------------------------------
# Fixture end-to-end verify (using an embedded daemon for production fidelity)
# ---------------------------------------------------------------------------

def _verify(daemon: str = DEFAULT_DAEMON) -> int:  # noqa: ARG001 — daemon arg kept for CLI compat; we always use embedded
    """End-to-end verify: load LoCoMo fixture, ingest via embedded daemon, run >=1 probe.

    Uses an embedded daemon (live-bound to the conv workspace) so the production-faithful
    eager-judge path (judge_next + keepEdge) resolves correctly — the same path the SDK
    arm uses.  The *daemon* arg is accepted for CLI compat but the verify always uses its
    own embedded daemon.

    Asserts:
      - all 3 arms return a non-empty answer
      - our-way: no createEdge in code (static grep), keepEdge path used
      - our-way: /task/context returned >=1 kept context key
      - our-way: judge_idle info and fidelity counters are clean
    Returns 0 PASS / 1 FAIL.
    """
    import tempfile

    from datasets import load_locomo

    fixture_dir = os.path.join(_HERE, "fixtures")
    print(f"[verify] loading LoCoMo fixture from {fixture_dir}")
    try:
        records = load_locomo(fixture_dir)
    except FileNotFoundError as exc:
        print(f"FAIL: {exc}")
        return 1
    if not records:
        print("FAIL: fixture loaded but no records found")
        return 1

    conv = records[0]
    conv_id = conv["conv_id"]
    print(f"[verify] conv_id={conv_id!r}: {len(conv['sessions'])} sessions, {len(conv['probes'])} probes")

    # Isolated temp workspace.
    ws_root = tempfile.mkdtemp(prefix="zonoid-probe-verify-")
    workspace = os.path.join(ws_root, conv_id)
    os.makedirs(workspace, exist_ok=True)

    # Spin up an embedded daemon LIVE-BOUND to the conv workspace.
    print("[verify] starting embedded daemon (live-bound to conv workspace)…")
    handle = None
    ok = True
    try:
        handle = _start_our_way_daemon(workspace)
        emb_url = handle.base_url
        emb_data_dir = handle.data_dir
        client = ZonoidClient(emb_url, workspace=workspace, timeout=120)

        # Warm-up.
        print("[verify] warming up embedder…")
        try:
            client.warm_up()
            client.search("warmup", k=1)
            print("[verify] warm-up OK")
        except Exception as exc:  # noqa: BLE001
            print(f"FAIL: embedded daemon unreachable after start: {exc}")
            return 1

        # Build candidates from conv (the session summaries to ingest).
        # We use a stub ingest_map (empty note keys) just to get the candidate summaries;
        # real ingestion happens via the embedded daemon below.
        sessions = conv.get("sessions") or []
        stub_map: dict[str, list[dict[str, str]]] = {
            str(s.get("idx")): [{"note_key": f"stub-{s.get('idx')}", "title": f"session {s.get('idx')}"}]
            for s in sessions
        }
        candidates = _build_session_candidates(conv, stub_map)
        print(f"[verify] {len(candidates)} session candidates built")

        # Ingest session summaries into the embedded daemon.
        print(f"[verify] ingesting {len(candidates)} sessions into embedded daemon…")
        _ingest_candidates_into_daemon(client, candidates, workspace)

        probe = conv["probes"][0]
        print(f"\n[verify] PROBE qid={probe['qid']} category={probe['category']}")
        print(f"[verify]   Q: {probe['question']}")
        print(f"[verify]   gold (scorer-only): {probe['answer']!r}")

        # ---- ARM our-way (SDK path, no embedded client spawn — reuse handle) ----
        print("\n[verify] === ARM our-way (SDK eager-judge, production-faithful) ===")
        ow = run_our_way(
            emb_url, workspace, probe, candidates,
            _embedded_client=client,
            _embedded_data_dir=emb_data_dir,
        )
        print(f"[verify]   probe task key:    {ow.get('probe_key')}")
        print(f"[verify]   candidate sids:    {ow['candidate_sids']}")
        print(f"[verify]   kept (note keys):  {ow['kept_sids']}  (EdgeJudge, NO createEdge)")
        print(f"[verify]   context dep keys:  {ow['context_keys']}")
        print(f"[verify]   judge_idle:        {ow.get('judge_idle')}")
        print(f"[verify]   timeout_kills:     {ow.get('timeout_kills', 0)}")
        print(f"[verify]   provisional_kept:  {ow.get('provisional_kept', 0)}")
        print(f"[verify]   our-way answer:    {ow.get('predicted')!r}")

        # ---- ARM search (uses live :8787 for search, re-using same workspace notes) ----
        # search arm reads from the embedded daemon's workspace via the same emb_url.
        print("\n[verify] === ARM search (retrieval control) ===")
        sr = run_search(emb_url, workspace, probe)
        print(f"[verify]   search hit keys:  {sr.get('hit_keys')}")
        print(f"[verify]   search answer:    {sr.get('predicted')!r}")

        # ---- ARM cold ----
        print("\n[verify] === ARM cold (floor) ===")
        cd = run_cold(probe)
        print(f"[verify]   cold answer:      {cd.get('predicted')!r}")

        # ---- Assertions ----
        print("\n[verify] === assertions ===")

        for arm_name, pred in (
            ("our-way", ow.get("predicted")),
            ("search", sr.get("predicted")),
            ("cold", cd.get("predicted")),
        ):
            non_empty = bool(pred and str(pred).strip())
            print(f"[verify]   [{'PASS' if non_empty else 'FAIL'}] {arm_name} returned a non-empty answer")
            ok = ok and non_empty

        # our-way must have context_keys (or at least judge produced output, even if idle).
        ctx_keys = ow.get("context_keys") or []
        judge_idle = ow.get("judge_idle", False)
        timeout_kills = ow.get("timeout_kills", 0)
        provisional = ow.get("provisional_kept", 0)

        if not judge_idle:
            # Non-idle: expect at least one kept context key.
            ctx_ok = bool(ctx_keys)
            print(
                f"[verify]   [{'PASS' if ctx_ok else 'FAIL'}] "
                f"our-way judge active + /task/context returned kept context ({ctx_keys})"
            )
            ok = ok and ctx_ok
        else:
            print(
                f"[verify]   [INFO] our-way judge IDLE (daemon returned no candidates). "
                f"This is an honest no-context result under the current candidate policy. "
                f"Check that relevant sessions were ingested."
            )
            # Idle is not a hard failure (it's the honest production result) but warn loudly.
            print("[verify]   [WARN] judge was idle — our-way context will be empty.")

        # No createEdge verdict dict construction in the code path (static grep).
        # We look for the actual dict key pattern {"createEdge": ...} used in post_verdict
        # calls — NOT bare occurrences of the word in comments/strings.
        this_file = os.path.abspath(__file__)
        with open(this_file, "r", encoding="utf-8") as fh:
            src = fh.read()
        import re as _re
        # Strip single-line comments first.
        no_comment = _re.sub(r"#[^\n]*", "", src)
        # Look for the verdict construction pattern: {"createEdge" or 'createEdge' as a dict key.
        create_edge_verdict_pattern = _re.compile(r'["\']createEdge["\']')
        create_edge_matches = create_edge_verdict_pattern.findall(no_comment)
        # The only remaining matches should be inside string *values* (comments we stripped)
        # — if create_edge_matches is non-empty, there may be live verdict constructions.
        # For a conservative check: confirm the pattern "createEdge" does NOT appear as a dict key
        # being constructed (i.e., preceded by {, ,, or = on the same expression line).
        dict_key_pattern = _re.compile(r"""(?:^|[{,=\s])\s*["']createEdge["']\s*:""", _re.MULTILINE)
        no_create_edge = not bool(dict_key_pattern.search(no_comment))
        print(
            f"[verify]   [{'PASS' if no_create_edge else 'FAIL'}] "
            f"NO createEdge dict-key construction in live code (only keepEdge+EdgeJudge active)"
        )
        ok = ok and no_create_edge

        # Fidelity counters.
        fid_ok = timeout_kills == 0 and provisional == 0
        print(
            f"[verify]   [{'PASS' if fid_ok else 'WARN'}] "
            f"fidelity counters: timeout_kills={timeout_kills} provisional_kept={provisional} "
            f"({'clean' if fid_ok else 'non-zero — retries were needed'})"
        )
        # Non-zero counters are a warning, not a hard failure (production-faithful retry path).

        print(f"\n{'PASS' if ok else 'FAIL'}")
    finally:
        if handle is not None:
            try:
                _daemon_mod.stop(handle)
            except Exception:  # noqa: BLE001
                pass
    return 0 if ok else 1


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run agent-memory QA probes three ways (our-way DAG read · search · cold)."
    )
    parser.add_argument("--verify", action="store_true", help="Run the fixture end-to-end verify.")
    parser.add_argument("--daemon", default=DEFAULT_DAEMON, help="Daemon base URL.")
    parser.add_argument("--data-dir", help="Directory with locomo10.json / longmemeval_*.json.")
    parser.add_argument(
        "--dataset",
        choices=["locomo", "longmemeval-oracle", "longmemeval-s", "longmemeval-m"],
        default="locomo",
        help="Which dataset to run (when not --verify).",
    )
    parser.add_argument("--out", default="results.jsonl", help="Output JSONL path.")
    parser.add_argument("--workspace-root", help="Parent dir for per-conversation workspaces.")
    parser.add_argument("--max-convs", type=int, default=None, help="Limit number of conversations.")
    parser.add_argument("--max-probes", type=int, default=None, help="Limit probes per conversation.")
    args = parser.parse_args(argv)

    if args.verify:
        return _verify(args.daemon)

    if not args.data_dir:
        print("ERROR: --data-dir is required (or pass --verify).", file=sys.stderr)
        return 2

    from datasets import load_locomo, load_longmemeval
    from ingest import ConversationIngester

    if args.dataset == "locomo":
        convs = load_locomo(args.data_dir)
    else:
        variant = args.dataset.split("-", 1)[1]
        convs = load_longmemeval(args.data_dir, variant=variant)
    if args.max_convs is not None:
        convs = convs[: args.max_convs]

    warm_up(args.daemon, timeout=120)
    ingester = ConversationIngester(
        base_url=args.daemon, workspace_root=args.workspace_root, timeout=120
    )

    total = 0
    with open(args.out, "w", encoding="utf-8") as out_fh:
        for conv in convs:
            total += run_conversation(
                args.daemon, conv, ingester, out_fh, max_probes=args.max_probes
            )
    print(f"[probe_runner] wrote {total} records to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
