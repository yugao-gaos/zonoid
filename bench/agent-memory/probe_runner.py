"""Probe runner for the agent-memory benchmark harness — the core of "their test, our DAG read".

For each (conversation, probe) — the conversation already ingested into an isolated,
absolute-path Zonoid workspace by ``ConversationIngester`` — this module answers the QA
probe THREE ways, sharing one answerer model + one answer-prompt template:

  ARM ``our-way``  (DAG read — the headline)
      Mint the probe as a TASK node, let the daemon's ingest funnel autowire
      candidate note->probe edges, BLIND-judge which sessions actually hold the
      evidence (no gold, no dataset evidence labels), keep only those edges, then
      answer from ONLY the kept session summaries read off GET /task/context.

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
arm.  In ``our-way`` the KEEP decision is made by a BLIND ``claude -p`` edge-judge that
sees only the question + candidate session summaries.  Letting it see the gold answer or
the evidence labels would be an oracle leak and would invalidate the headline result.
``gold`` is threaded through to the output record for the scorer's convenience; it never
enters any prediction path.

Funnel mechanics (from spike note-mqgwr63ms7q + OVERRIDE note-mqgwrh5a63x)
-------------------------------------------------------------------------
1. Session notes are posted by ``ingest.ConversationIngester`` (NO force — lets autowire +
   dup-guard run).  Returns ``{session_idx: [{note_key, title}]}``.
2. Mint the probe as a TASK node via a file-drop stub written to
   ``<CLAUDE_PLUGIN_DATA | ~/.claude/orchestrator>/tasks/<workspaceKey(ws)>/<harness>/<id>.json``
   = ``{id, subject:<question>, status:"pending"}``.  The daemon adopts it (~1.5 s).
   Task key = ``"<harness>/<id>"``.  (workspaceKey rebuilt here in Python — the spike's
   probe_seed.js was never committed; the rules live in lib/filedrop-tasks.js.)
3. ``POST /overlay/status {workspace, key:<probe>, status:"not_ready", summary:<question>}``
   — NOT ``in_progress`` (that trips the unwired-claim gate).  This fires the first-vec
   ingest funnel: embed -> autowireNewTaskWholeGraph -> markEagerJudge.  Autowire seeds
   note->probe candidate edges at weight 0 / judged:false, above SEMANTIC_AUTOWIRE_THRESHOLD
   (0.55).
4. BLIND edge-judge picks the sessions that contain the evidence.  ``POST /judge/verdict
   {workspace, verdicts:[{createEdge:{from:"note:<sid>", to:<probe>, weight:0.5}}]}`` for the
   kept sessions only.  createEdge UPSERTS a judged context edge — it promotes a pre-existing
   weight-0 autowire candidate AND creates one if autowire never seeded it (the kept session's
   cosine was below the 0.55 seed threshold).  keepEdge alone is insufficient: it only promotes
   pre-existing candidates, so a sub-threshold kept session would silently never surface.
5. ``GET /task/context?key=<probe>&workspace=<ws>`` -> ``dependencySummaries`` (weight-0
   edges are filtered out by the graph builder, so unkept candidates simply do not appear).
   Answer from ONLY those summaries.  NEVER ``GET /search?task_key=`` on a probe (RAG-fill
   leak on a provisional probe).

OVERRIDE (note-mqgwrh5a63x): on an isolated workspace a *pruned* edge does NOT reliably
clear, so we NEVER rely on pruneEdge.  We use KEEP-ONLY: unkept candidates stay at weight 0
and are filtered out of the read.  The DAG-read surface (GET /task/context) is robust
regardless because it drops weight-0 edges.

Runtime (note-mqgz977tbqe): embeddable Python 3.12 — stdlib ONLY (urllib.request, json,
subprocess, os).  No pip / requests.  Invoke ``claude -p`` for every answerer / judge call.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any

# Embeddable Python 3.12 (py312embed) strips cwd from sys.path. Insert the directory
# containing this script so sibling modules (zonoid_lifecycle, ingest, datasets) are
# importable regardless of the working directory. (Same pattern as ingest.py.)
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from zonoid_lifecycle import (  # noqa: E402
    _http_get,
    _http_post,
    get_task_context,
    post_verdict,
    search as kb_search,
    warm_up,
)

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

# File-drop probe stub: harness namespace + data dir (mirrors lib/filedrop-tasks.js).
_PROBE_HARNESS = "probe"
_DATA_DIR = os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.join(
    os.path.expanduser("~"), ".claude", "orchestrator"
)

# How long to wait for the daemon to (a) adopt a dropped stub and (b) run the ingest
# funnel that seeds candidate edges. The spike measured ~1.5 s adoption; we poll.
_ADOPT_TIMEOUT_S = float(os.environ.get("ZONOID_BENCH_ADOPT_TIMEOUT", "20"))
_AUTOWIRE_TIMEOUT_S = float(os.environ.get("ZONOID_BENCH_AUTOWIRE_TIMEOUT", "30"))
_POLL_INTERVAL_S = 0.75

# top-k for the search arm.
_SEARCH_K = int(os.environ.get("ZONOID_BENCH_SEARCH_K", "5"))

# Weight asserted on a KEPT note->probe context edge. Must be > 0 so the edge is retrieval-
# visible (the graph builder filters weight-0 edges out of /task/context). 0.5 matches the
# daemon's DEFAULT_CONTEXT_WEIGHT and the judge's keep-promotion default (PROMOTED_EDGE_WEIGHT).
_KEEP_EDGE_WEIGHT = float(os.environ.get("ZONOID_BENCH_KEEP_WEIGHT", "0.5"))

# Char budget for each session summary shown to the blind judge / answerer (keeps the
# `claude -p` prompt bounded regardless of conversation length).
_SUMMARY_BUDGET = 2000


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


def _extract_json_objects(text: str) -> list[dict]:
    """Return every top-level ``{...}`` block in *text* that parses as JSON.

    Brace-matching scan (mirrors zonoid_memory._parse_judge_output). Used to pull a
    strict-JSON verdict object out of the judge's free-text output.
    """
    out: list[dict] = []
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    blob = text[start : i + 1]
                    try:
                        obj = json.loads(blob)
                        if isinstance(obj, dict):
                            out.append(obj)
                    except Exception:  # noqa: BLE001
                        pass
                    start = -1
    return out


# ---------------------------------------------------------------------------
# workspaceKey — EXACT port of lib/filedrop-tasks.js workspaceKey()
# ---------------------------------------------------------------------------

def workspace_key(workspace: str) -> str:
    """Collision-free per-workspace folder name.

    MUST stay in lockstep with lib/filedrop-tasks.js workspaceKey():
        `${sanitizedBasename}-${sha1(workspace).hex.slice(0,16)}`
    where basename is os.path.basename, sanitised to [A-Za-z0-9._-] (others -> '_').
    """
    import hashlib

    ws = str(workspace or "")
    h = hashlib.sha1(ws.encode("utf-8")).hexdigest()[:16]
    base = os.path.basename(ws) or "ws"
    base = re.sub(r"[^A-Za-z0-9._-]", "_", base)
    return f"{base}-{h}"


def _probe_stub_path(workspace: str, probe_id: str) -> str:
    """Absolute stub-file path for a probe task: <data>/tasks/<wsKey>/<harness>/<id>.json."""
    return os.path.join(
        _DATA_DIR, "tasks", workspace_key(workspace), _PROBE_HARNESS, f"{probe_id}.json"
    )


def _probe_task_key(probe_id: str) -> str:
    """The daemon task key for a dropped probe stub: '<harness>/<id>'."""
    return f"{_PROBE_HARNESS}/{probe_id}"


# ---------------------------------------------------------------------------
# Funnel step 2: mint the probe as a TASK node via file-drop stub
# ---------------------------------------------------------------------------

def _drop_probe_stub(workspace: str, probe_id: str, question: str) -> str:
    """Write the file-drop stub for *probe_id* and return its '<harness>/<id>' task key.

    Atomic temp+rename (the convention the daemon's reader expects: it ignores *.tmp).
    """
    path = _probe_stub_path(workspace, probe_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    stub = {
        "id": probe_id,
        "subject": question,
        "description": "",
        "status": "pending",
        "created_by": {"harness": _PROBE_HARNESS, "agent_id": "probe_runner"},
    }
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(stub, fh, indent=2)
    os.replace(tmp, path)
    return _probe_task_key(probe_id)


def _remove_probe_stub(workspace: str, probe_id: str) -> None:
    """Best-effort cleanup of the dropped stub file (mint artifact, not durable state)."""
    try:
        path = _probe_stub_path(workspace, probe_id)
        if os.path.exists(path):
            os.remove(path)
    except Exception:  # noqa: BLE001
        pass


def _post_status_with_summary(
    base_url: str, workspace: str, node_key: str, status: str, summary: str, timeout: int = 120
) -> dict[str, Any]:
    """POST /overlay/status carrying a summary.

    ``zonoid_lifecycle.post_status`` deliberately omits the summary field, but the ingest
    funnel is gated on (summary set OR no vec) — so the probe's status write MUST carry the
    question as the summary to seed the first embedding + autowire. We POST directly.
    """
    body = {"workspace": workspace, "key": node_key, "status": status, "summary": summary}
    return _http_post(f"{base_url.rstrip('/')}/overlay/status", body, timeout)


def _wait_for_task_adoption(base_url: str, workspace: str, probe_key: str, timeout_s: float) -> bool:
    """Poll GET /task/context until the daemon has adopted the probe task (or timeout).

    Returns True once /task/context returns 200 for the probe key.
    """
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            _http_get(
                f"{base_url.rstrip('/')}/task/context",
                {"key": probe_key, "workspace": workspace},
                30,
            )
            return True  # 200 => task exists (404 raises HTTPError below)
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                # Unexpected error — surface it rather than spinning silently.
                raise
        except Exception:  # noqa: BLE001 — transient; keep polling
            pass
        time.sleep(_POLL_INTERVAL_S)
    return False


def _context_dep_keys(base_url: str, workspace: str, probe_key: str) -> set[str]:
    """Return the set of context-dep keys currently visible on the probe's /task/context."""
    ctx = get_task_context(base_url, workspace, probe_key)
    return {
        d.get("key")
        for d in (ctx.get("dependencySummaries") or [])
        if d.get("via") == "context" and d.get("key")
    }


def _wait_for_autowire(
    base_url: str, workspace: str, probe_key: str, timeout_s: float
) -> set[str]:
    """Poll until autowire has seeded >=1 candidate context edge, returning the candidate set.

    NOTE: freshly-autowired candidate edges are weight 0 and are FILTERED OUT of
    /task/context (the graph builder drops weight-0 edges). So we cannot observe candidates
    via /task/context — they only become visible after keepEdge promotes them. We therefore
    cannot poll for candidates here; this function instead just waits a settle interval and
    returns the (expected-empty) visible context set. The candidate enumeration for the
    blind judge comes from the ingester's note map, not from the daemon.
    """
    # Give the ingest funnel time to embed + autowire. We can't see weight-0 edges, so this
    # is a fixed settle wait rather than a poll-until-nonempty.
    settle = min(timeout_s, 6.0)
    time.sleep(settle)
    return _context_dep_keys(base_url, workspace, probe_key)


# ---------------------------------------------------------------------------
# Session candidate model (for the blind judge)
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
        summary = "\n".join(lines)[:_SUMMARY_BUDGET]
        cands.append(_SessionCandidate(sid=sid, date=str(date), note_keys=note_keys, summary=summary))
    # Stable order by numeric session idx where possible.
    cands.sort(key=lambda c: (int(c.sid) if c.sid.isdigit() else 1_000_000, c.sid))
    return cands


# ---------------------------------------------------------------------------
# Blind edge-judge (the honesty bar)
# ---------------------------------------------------------------------------

_BLIND_JUDGE_RUBRIC = (
    "You are selecting which past conversation sessions contain the EVIDENCE needed to "
    "answer a question. You will be given ONLY the question and a numbered list of candidate "
    "sessions (each with its date and transcript). You are NOT given the answer.\n\n"
    "For each candidate, decide whether that session contains information that is directly "
    "useful for answering the question (a fact, statement, or event the answer depends on). "
    "Keep a session ONLY if it genuinely helps; do not keep a session merely because it is "
    "on a related topic. It is fine to keep more than one session (multi-hop questions need "
    "several), and it is fine to keep exactly one.\n\n"
    'Return STRICT JSON ONLY, no prose, in exactly this shape:\n'
    '{"keep": ["<sid>", ...]}\n'
    "where each <sid> is the session id (the value after \"session id:\") of a session to keep. "
    "Return an empty list if none are relevant."
)


def _blind_keep_decision(question: str, candidates: list[_SessionCandidate]) -> list[str]:
    """Ask a BLIND ``claude -p`` judge which session ids hold the evidence.

    The judge sees ONLY the question + candidate session transcripts. It NEVER sees the gold
    answer or the dataset evidence labels — that is the honesty bar.

    Returns the list of kept session ids (subset of candidate sids). On judge failure we
    FAIL CLOSED to "keep nothing" rather than leaking — but we log loudly, because a silent
    keep-all would be a different kind of rig (it would hand the answerer every session).
    """
    if not candidates:
        return []
    cand_lines = []
    for i, c in enumerate(candidates):
        cand_lines.append(
            f"[{i}] session id: {c.sid}   date: {c.date}\n"
            f"    transcript:\n{c.summary}"
        )
    prompt = (
        _BLIND_JUDGE_RUBRIC
        + "\n\nQUESTION:\n"
        + question
        + "\n\nCANDIDATE SESSIONS:\n"
        + "\n\n".join(cand_lines)
        + "\n\nReturn the strict-JSON keep object now."
    )
    raw = _run_claude(prompt)
    if raw is None:
        print("[probe_runner] BLIND judge failed; keeping nothing for this probe.", file=sys.stderr)
        return []
    valid_sids = {c.sid for c in candidates}
    for obj in _extract_json_objects(raw):
        keep = obj.get("keep")
        if isinstance(keep, list):
            kept = [str(k) for k in keep if str(k) in valid_sids]
            return kept
    print(
        f"[probe_runner] BLIND judge output unparseable; keeping nothing. raw head: {raw[:200]!r}",
        file=sys.stderr,
    )
    return []


# ---------------------------------------------------------------------------
# Shared answerer
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


def _answer_from_context(question: str, context_blocks: list[str]) -> str:
    """Answer *question* from the supplied *context_blocks* via the shared answerer template."""
    context = "\n\n---\n\n".join(b for b in context_blocks if b and b.strip())
    if not context.strip():
        # No retrieved context at all — make the answerer say so honestly (don't fall back to
        # cold/world-knowledge, which would contaminate the arm).
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
# The three arms
# ---------------------------------------------------------------------------

def run_our_way(
    base_url: str,
    workspace: str,
    probe: dict[str, Any],
    candidates: list[_SessionCandidate],
) -> dict[str, Any]:
    """ARM our-way: DAG read. Mint probe -> funnel -> blind keep -> read context -> answer.

    Returns a diagnostics dict: {predicted, kept_sids, context_keys, candidate_sids}.
    The gold answer / evidence labels are NEVER consulted here.
    """
    question = probe["question"]
    probe_id = f"{probe['qid']}-{int(time.time() * 1000) % 1_000_000}"  # unique per run
    probe_key = _drop_probe_stub(workspace, probe_id, question)

    diag: dict[str, Any] = {
        "probe_key": probe_key,
        "candidate_sids": [c.sid for c in candidates],
        "kept_sids": [],
        "context_keys": [],
    }
    try:
        # Funnel step: wait for adoption, then drive the ingest funnel via a status write.
        adopted = _wait_for_task_adoption(base_url, workspace, probe_key, _ADOPT_TIMEOUT_S)
        if not adopted:
            print(f"[probe_runner] probe {probe_key} not adopted within {_ADOPT_TIMEOUT_S}s.", file=sys.stderr)
        # status:not_ready + summary fires embed -> autowireNewTaskWholeGraph -> markEagerJudge.
        _post_status_with_summary(base_url, workspace, probe_key, "not_ready", question)
        # Settle for the funnel (candidate edges are weight-0 -> invisible until kept).
        _wait_for_autowire(base_url, workspace, probe_key, _AUTOWIRE_TIMEOUT_S)

        # BLIND keep decision (no gold, no evidence labels).
        kept_sids = _blind_keep_decision(question, candidates)
        diag["kept_sids"] = kept_sids

        # KEEP-ONLY: assert a judged context edge for each chosen session's note(s). Never
        # prune (OVERRIDE note-mqgwrh5a63x: pruned edges don't clear on an isolated workspace).
        #
        # We use createEdge, NOT keepEdge. keepEdge (lib/judge.js keepEdge) only PROMOTES a
        # PRE-EXISTING weight-0 autowire candidate (e.judged===false) to its cosine — if the
        # kept session's autowire cosine fell below SEMANTIC_AUTOWIRE_THRESHOLD (0.55), NO
        # candidate edge was ever seeded, so keepEdge no-ops and the session never surfaces in
        # the read. Observed live on the fixture's multi-hop q2: the blind judge correctly kept
        # session 2 (ciabatta), but keepEdge produced an empty /task/context. createEdge
        # (routes/judge.js) calls addEdge('context', weight) which UPSERTS: it promotes an
        # existing candidate AND creates a missing one, judged:true — so a kept session ALWAYS
        # becomes retrieval-visible regardless of its autowire score. This changes only the
        # edge-assert primitive; the blind judge still owns WHICH sessions are kept.
        kept_set = set(kept_sids)
        verdicts = []
        for c in candidates:
            if c.sid in kept_set:
                for nk in c.note_keys:
                    verdicts.append(
                        {"createEdge": {"from": nk, "to": probe_key, "weight": _KEEP_EDGE_WEIGHT}}
                    )
        if verdicts:
            post_verdict(base_url, workspace, verdicts)

        # READ: GET /task/context -> dependencySummaries (weight-0 edges filtered out).
        # NEVER GET /search?task_key= (RAG-fill leak on a provisional probe).
        ctx = get_task_context(base_url, workspace, probe_key)
        ctx_deps = [
            d
            for d in (ctx.get("dependencySummaries") or [])
            if d.get("via") == "context" and (d.get("weight") or 0) > 0
        ]
        diag["context_keys"] = [d.get("key") for d in ctx_deps]
        context_blocks = [str(d.get("summary") or "") for d in ctx_deps]

        diag["predicted"] = _answer_from_context(question, context_blocks)
    finally:
        _remove_probe_stub(workspace, probe_id)
    return diag


def run_search(base_url: str, workspace: str, probe: dict[str, Any]) -> dict[str, Any]:
    """ARM search: GET /search?q=<question> -> top-k session summaries -> answer.

    The retrieval-time control. Uses the SAME ingested graph; no probe task, no DAG read.
    """
    question = probe["question"]
    hits = kb_search(base_url, workspace, question, k=_SEARCH_K, gated=False)
    context_blocks = [str(h.get("summary") or "") for h in hits]
    return {
        "predicted": _answer_from_context(question, context_blocks),
        "hit_keys": [h.get("key") for h in hits],
    }


def run_cold(probe: dict[str, Any]) -> dict[str, Any]:
    """ARM cold: answer with NO memory at all (floor / rigging guard)."""
    return {"predicted": _answer_cold(probe["question"])}


# ---------------------------------------------------------------------------
# Orchestration: run all three arms for one (conv, probe)
# ---------------------------------------------------------------------------

def run_probe(
    base_url: str,
    workspace: str,
    conv_id: str,
    probe: dict[str, Any],
    candidates: list[_SessionCandidate],
) -> list[dict[str, Any]]:
    """Run all THREE arms for one probe and return one result record per arm.

    Each record: {arm, conv_id, qid, category, question, gold, predicted, ...diagnostics}.
    ``gold`` is recorded FOR THE SCORER ONLY; it never enters any prediction path above.
    """
    common = {
        "conv_id": conv_id,
        "qid": probe.get("qid"),
        "category": probe.get("category"),
        "question": probe.get("question"),
        "gold": probe.get("answer"),  # for the scorer; NOT used by any arm
    }
    records: list[dict[str, Any]] = []

    # ARM our-way (headline)
    ow = run_our_way(base_url, workspace, probe, candidates)
    records.append({
        "arm": "our-way",
        **common,
        "predicted": ow.get("predicted", ""),
        "kept_sids": ow.get("kept_sids"),
        "context_keys": ow.get("context_keys"),
        "candidate_sids": ow.get("candidate_sids"),
    })

    # ARM search (retrieval control)
    sr = run_search(base_url, workspace, probe)
    records.append({
        "arm": "search",
        **common,
        "predicted": sr.get("predicted", ""),
        "hit_keys": sr.get("hit_keys"),
    })

    # ARM cold (floor)
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
# Fixture end-to-end verify (against the live daemon)
# ---------------------------------------------------------------------------

def _verify(daemon: str = DEFAULT_DAEMON) -> int:
    """End-to-end verify: load LoCoMo fixture, ingest, run >=1 probe through all 3 arms.

    Asserts: all 3 arms return a non-empty answer; our-way's /task/context returns the kept
    session(s) and not the distractor; prints the 3 predictions vs gold. Returns 0 PASS / 1 FAIL.
    """
    import tempfile

    from datasets import load_locomo
    from ingest import ConversationIngester

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

    # Warm the embedder so no single hot path eats the cold-start latency.
    print("[verify] warming up embedder (may take up to 90s on cold start)…")
    try:
        warm_up(daemon, timeout=120)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: daemon unreachable during warm-up: {exc}")
        return 1
    print("[verify] warm-up OK")

    # Isolated temp workspace.
    ws_root = tempfile.mkdtemp(prefix="zonoid-probe-verify-")
    ingester = ConversationIngester(base_url=daemon, workspace_root=ws_root, timeout=120)
    workspace = ingester.workspace_for(conv_id)

    print(f"[verify] ingesting into workspace {workspace}")
    try:
        ingest_map = ingester.ingest(conv)
    except RuntimeError as exc:
        print(f"FAIL: ingestion failed: {exc}")
        return 1
    candidates = _build_session_candidates(conv, ingest_map)
    print(f"[verify] {len(candidates)} session candidates: " + ", ".join(
        f"sid={c.sid}({len(c.note_keys)} note(s))" for c in candidates
    ))

    # Pick a probe whose answer lives in a single identifiable session, so we can assert the
    # DAG read returns the right session and excludes a distractor. The fixture's q1
    # ("What bread did the user bake in the first session?" -> focaccia) lives in session 0;
    # sessions 1 & 2 are distractors-ish (still bread, but q1's evidence is session 0/t3).
    probe = conv["probes"][0]
    print(f"\n[verify] PROBE qid={probe['qid']} category={probe['category']}")
    print(f"[verify]   Q: {probe['question']}")
    print(f"[verify]   gold (scorer-only): {probe['answer']!r}")

    # ---- ARM our-way ----
    print("\n[verify] === ARM our-way (DAG read) ===")
    ow = run_our_way(daemon, workspace, probe, candidates)
    print(f"[verify]   probe task key:   {ow['probe_key']}")
    print(f"[verify]   candidate sids:   {ow['candidate_sids']}")
    print(f"[verify]   BLIND kept sids:  {ow['kept_sids']}  (judge saw NO gold / NO evidence labels)")
    print(f"[verify]   context dep keys: {ow['context_keys']}")
    print(f"[verify]   our-way answer:   {ow.get('predicted')!r}")

    # ---- ARM search ----
    print("\n[verify] === ARM search (retrieval control) ===")
    sr = run_search(daemon, workspace, probe)
    print(f"[verify]   search hit keys:  {sr.get('hit_keys')}")
    print(f"[verify]   search answer:    {sr.get('predicted')!r}")

    # ---- ARM cold ----
    print("\n[verify] === ARM cold (floor) ===")
    cd = run_cold(probe)
    print(f"[verify]   cold answer:      {cd.get('predicted')!r}")

    # ---- Assertions ----
    print("\n[verify] === assertions ===")
    ok = True

    for arm_name, pred in (("our-way", ow.get("predicted")), ("search", sr.get("predicted")), ("cold", cd.get("predicted"))):
        non_empty = bool(pred and str(pred).strip())
        print(f"[verify]   [{'PASS' if non_empty else 'FAIL'}] {arm_name} returned a non-empty answer")
        ok = ok and non_empty

    # our-way must have kept >=1 session and the read must surface it.
    kept = ow.get("kept_sids") or []
    ctx_keys = ow.get("context_keys") or []
    print(f"[verify]   [{'PASS' if kept else 'FAIL'}] blind judge kept >=1 session ({kept})")
    ok = ok and bool(kept)
    print(f"[verify]   [{'PASS' if ctx_keys else 'FAIL'}] /task/context returned the kept session(s) ({ctx_keys})")
    ok = ok and bool(ctx_keys)

    # The number of context keys must not exceed the kept-session note count (no distractor leak:
    # weight-0 unkept candidates must be filtered out of the read).
    kept_note_keys = set()
    for c in candidates:
        if c.sid in set(kept):
            kept_note_keys.update(c.note_keys)
    no_distractor = set(ctx_keys).issubset(kept_note_keys)
    print(
        f"[verify]   [{'PASS' if no_distractor else 'FAIL'}] read contains ONLY kept-session notes "
        f"(no distractor): ctx={set(ctx_keys)} subset-of kept_notes={kept_note_keys}"
    )
    ok = ok and no_distractor

    print("\n" + ("PASS" if ok else "FAIL"))
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
