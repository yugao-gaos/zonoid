"""Graph-native, multi-step program synthesis for the ARC-AGI-3 EWM agent.

This is the core of the synthesis redesign (design note "graph native synthesis relative
coordinates hypothesis menu design", extending the five-pillar spec). Program writing is no longer
one LLM completion: it is a small STATE MACHINE whose steps are each a zonoid task node.

    ANALYZE  -> gather wired context notes (hypothesis menu) + transition deltas,
                LLM emits a structured mechanics list.
    PLAN     -> LLM proposes an ORDERED list of small code changes (<= 6).
    EDIT     -> per change: claim a task, LLM (re)writes the SINGLE program source, accept only
                when the change's target transitions pass AND previously-passing indices do not
                regress (validation on index sub-suites). Up to 2 retries per change, then skip.
    FINAL    -> validate the full suite; return {program_source, report, steps}.

Every step optionally mints/claims/completes a task node and records notes through a thin ``graph``
client. When ``graph is None`` the *identical* state machine runs with all graph ops no-op'd, so
offline tests exercise the same control flow. The ``graph`` client is any object exposing:

    create_task(title, desc) -> key
    task_context(key)        -> list[str]   (wired note summaries)
    claim(key)               -> None
    complete(key, status, summary) -> None
    note(title, summary, wires_to) -> None

:class:`DaemonGraph` is a concrete client that talks to the Zonoid daemon over stdlib HTTP using
the same best-effort conventions as :mod:`.kb_protocol`: a daemon outage degrades synthesis to
"no-graph" behavior and NEVER crashes. All endpoint paths are configurable.

The mechanics list feeding ANALYZE is presented as OBJECT-LEVEL DELTA texts (``list[str]``) passed
in by the caller, so this module does not hard-import a ``deltas.py`` (a sibling task builds it).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol
from urllib import error, parse, request

from .world_model import (
    TransitionSuite,
    ValidationReport,
    WorldModelProgram,
    validate,
)

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------------------------------
# LLM extraction helpers (kept local so this module has no hard import cycle with agent.py)
# --------------------------------------------------------------------------------------------------

# agent.py owns the canonical fenced-block / JSON extractors. Import lazily inside the functions so
# a partially-built agent module (during tests) can't break importing this one, and so the offline
# state machine works even if agent.py is mid-edit.
def _extract_python(text: str) -> str | None:
    from .agent import extract_python

    return extract_python(text)


def _extract_json(text: str) -> Any | None:
    from .agent import extract_json

    return extract_json(text)


# --------------------------------------------------------------------------------------------------
# Sub-suite validation (acceptance slice + regression guard)
# --------------------------------------------------------------------------------------------------


def _sub_suite(suite: TransitionSuite, indices: list[int]) -> TransitionSuite:
    """A :class:`TransitionSuite` holding only ``suite[i]`` for each valid ``i`` in ``indices``."""

    out = TransitionSuite()
    n = len(suite)
    for i in indices:
        if isinstance(i, int) and 0 <= i < n:
            out.transitions.append(suite[i])
    return out


def _passing_indices(program: WorldModelProgram, suite: TransitionSuite) -> set[int]:
    """The set of transition indices ``program`` currently replays correctly (per-index, no stop)."""

    ok: set[int] = set()
    for i in range(len(suite)):
        report = validate(program, _sub_suite(suite, [i]))
        if report.ok:
            ok.add(i)
    return ok


# --------------------------------------------------------------------------------------------------
# Graph client protocol + the offline no-op default
# --------------------------------------------------------------------------------------------------


class GraphClient(Protocol):
    """The thin graph seam the synthesis state machine calls (see module docstring)."""

    def create_task(self, title: str, desc: str) -> str: ...
    def task_context(self, key: str) -> list[str]: ...
    def claim(self, key: str) -> None: ...
    def complete(self, key: str, status: str, summary: str) -> None: ...
    def note(self, title: str, summary: str, wires_to: list[str]) -> None: ...


class _NullGraph:
    """The graph=None fallback: every op is a no-op so the state machine runs offline unchanged."""

    def create_task(self, title: str, desc: str) -> str:
        return ""

    def task_context(self, key: str) -> list[str]:
        return []

    def claim(self, key: str) -> None:
        return None

    def complete(self, key: str, status: str, summary: str) -> None:
        return None

    def note(self, title: str, summary: str, wires_to: list[str]) -> None:
        return None


# --------------------------------------------------------------------------------------------------
# DaemonGraph — best-effort stdlib HTTP client against the Zonoid daemon
# --------------------------------------------------------------------------------------------------


@dataclass
class DaemonEndpoints:
    """Configurable daemon endpoint paths (all joined onto ``daemon_url``)."""

    sync: str = "/sync"
    status: str = "/overlay/status"
    note: str = "/overlay/note"
    context: str = "/task/context"


class DaemonGraph:
    """Best-effort daemon-backed :class:`GraphClient`.

    Task nodes are minted via the file-drop lane (write a stub JSON, then ``POST /sync``), claimed
    and completed via ``POST /overlay/status``, context is read via ``GET /task/context``, and notes
    are written via ``POST /overlay/note`` — the same endpoints the adapter + kb_protocol document.

    EVERY HTTP call is wrapped: a network/protocol failure is logged and swallowed so an outage
    degrades synthesis to no-graph behavior (create_task returns "", task_context returns []) and
    never raises into the state machine.

    Task minting writes a stub to ``<data_dir>/tasks/<workspace-key>/<harness>/<id>.json`` (the
    documented file-drop layout) then calls ``/sync`` to adopt it. When ``data_dir`` is not
    provided, minting degrades to no-graph (returns "") — the daemon status/note/context calls
    still work against pre-existing tasks.
    """

    def __init__(
        self,
        daemon_url: str,
        workspace: str,
        *,
        agent_id: str,
        session_id: str,
        harness: str = "local",
        data_dir: str | None = None,
        endpoints: DaemonEndpoints | None = None,
        timeout_s: int = 20,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self.daemon_url = daemon_url.rstrip("/")
        self.workspace = workspace
        self.agent_id = agent_id
        self.session_id = session_id
        self.harness = harness
        self.data_dir = data_dir
        self.endpoints = endpoints or DaemonEndpoints()
        self.timeout_s = timeout_s
        self._counter = 0
        self._id_factory = id_factory
        # Best-effort HTTP telemetry: every daemon call increments exactly one of these. A run reports
        # them (agent surfaces them under graph_ops_ok/graph_ops_failed) so a run's log tells whether
        # graph mode was actually LIVE — run 8 could not distinguish "graph wired" from "every call
        # 404'd and silently degraded to no-graph".
        self.graph_ops_ok = 0
        self.graph_ops_failed = 0
        # HTTP status of the last FAILED POST (None after a success, or a failure with no status
        # such as a connection refusal). Lets note() distinguish the daemon's phantom-node 404 (a
        # wires_to naming a task the daemon never adopted) from a real outage.
        self.last_post_error_code: int | None = None

    # -- HTTP primitives ---------------------------------------------------------------------------

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any] | None:
        url = f"{self.daemon_url}{path}"
        data = json.dumps(body).encode("utf-8")
        try:
            req = request.Request(
                url, data=data, method="POST", headers={"Content-Type": "application/json"}
            )
            with request.urlopen(req, timeout=self.timeout_s) as resp:
                out = json.loads(resp.read().decode("utf-8"))
            self.graph_ops_ok += 1
            self.last_post_error_code = None
            return out
        except (error.URLError, TimeoutError, ValueError, OSError) as exc:  # noqa: BLE001
            self.graph_ops_failed += 1
            self.last_post_error_code = getattr(exc, "code", None)
            logger.warning("daemon POST %s failed: %r", path, exc)
            return None

    def _get(self, path: str, query: dict[str, Any]) -> dict[str, Any] | None:
        url = f"{self.daemon_url}{path}?{parse.urlencode(query)}"
        try:
            req = request.Request(url, method="GET")
            with request.urlopen(req, timeout=self.timeout_s) as resp:
                out = json.loads(resp.read().decode("utf-8"))
            self.graph_ops_ok += 1
            return out
        except (error.URLError, TimeoutError, ValueError, OSError) as exc:  # noqa: BLE001
            self.graph_ops_failed += 1
            logger.warning("daemon GET %s failed: %r", path, exc)
            return None

    # -- file-drop stub minting --------------------------------------------------------------------

    def _next_id(self) -> str:
        if self._id_factory is not None:
            return self._id_factory()
        self._counter += 1
        return f"synth-{self._counter}"

    def _workspace_key(self) -> str:
        # Lockstep with lib/filedrop-tasks.js workspaceKey(): sanitized basename + first 16 hex of
        # sha1(abs workspace path).
        import hashlib
        import os
        import re

        h = hashlib.sha1(self.workspace.encode("utf-8")).hexdigest()[:16]
        base = os.path.basename(self.workspace) or "ws"
        base = re.sub(r"[^A-Za-z0-9._-]", "_", base)
        return f"{base}-{h}"

    def _drop_stub(self, task_id: str, subject: str, description: str) -> bool:
        """Write the file-drop stub atomically (``.tmp`` then rename). Best-effort -> bool."""

        if not self.data_dir:
            return False
        import os

        folder = os.path.join(
            self.data_dir, "tasks", self._workspace_key(), self.harness
        )
        stub = {
            "id": task_id,
            "subject": subject,
            "description": description,
            "status": "pending",
            "created_by": {"harness": self.harness, "agent_id": self.agent_id},
        }
        try:
            os.makedirs(folder, exist_ok=True)
            final = os.path.join(folder, f"{task_id}.json")
            tmp = final + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(stub, fh)
            os.replace(tmp, final)
            return True
        except OSError as exc:  # noqa: BLE001
            logger.warning("file-drop stub write failed for %r: %r", task_id, exc)
            return False

    # -- GraphClient surface -----------------------------------------------------------------------

    def create_task(self, title: str, desc: str) -> str:
        """Mint a task via file-drop + ``/sync``. Returns the ``<harness>/<id>`` key, or "" on any
        failure (outage / no data_dir) so the caller degrades to no-graph."""

        task_id = self._next_id()
        if not self._drop_stub(task_id, title, desc):
            return ""
        resp = self._post(self.endpoints.sync, {"workspace": self.workspace})
        key = f"{self.harness}/{task_id}"
        # Adoption is best-effort: even if /sync's response is unparseable, the stub is on disk and
        # the passive fs.watch pull will adopt it. Return the deterministic key regardless.
        if resp is None:
            logger.warning("sync after minting %r returned no response; key returned anyway", key)
        return key

    def task_context(self, key: str) -> list[str]:
        if not key:
            return []
        resp = self._get(self.endpoints.context, {"workspace": self.workspace, "key": key})
        if not isinstance(resp, dict):
            return []
        deps = resp.get("dependencySummaries")
        out: list[str] = []
        if isinstance(deps, list):
            for dep in deps:
                if isinstance(dep, dict):
                    summary = dep.get("summary")
                    if isinstance(summary, str) and summary.strip():
                        out.append(summary.strip())
        return out

    def claim(self, key: str) -> None:
        if not key:
            return None
        self._post(
            self.endpoints.status,
            {
                "workspace": self.workspace,
                "key": key,
                "status": "in_progress",
                "agent_id": self.agent_id,
                "session_id": self.session_id,
            },
        )
        return None

    def complete(self, key: str, status: str, summary: str) -> None:
        if not key:
            return None
        self._post(
            self.endpoints.status,
            {
                "workspace": self.workspace,
                "key": key,
                "status": status,
                "agent_id": self.agent_id,
                "session_id": self.session_id,
                "summary": summary,
            },
        )
        return None

    def note(self, title: str, summary: str, wires_to: list[str]) -> None:
        body: dict[str, Any] = {
            "workspace": self.workspace,
            "title": title,
            "summary": summary,
            "category": "arc-agi-3",
        }
        # Same synthetic-safety principle as KbClient (Run-30): never send an EMPTY wires_to — the
        # field is provenance wiring, and an empty list is a param the daemon does not need.
        wired = [w for w in wires_to if w]
        if wired:
            body["wires_to"] = wired
        resp = self._post(self.endpoints.note, body)
        if resp is None and "wires_to" in body and self.last_post_error_code == 404:
            # Run-36: the daemon's phantom-node guard 404s /overlay/note when wires_to names a task
            # it never adopted (file-drop adoption is best-effort, so a minted synth task key is not
            # guaranteed to exist daemon-side) — and the 404 LOSES the note body. Degrade gracefully:
            # retry once WITHOUT wires_to. Provenance wiring is best-effort; note durability is not.
            body.pop("wires_to")
            self._post(self.endpoints.note, body)
        return None


# --------------------------------------------------------------------------------------------------
# Config + step record
# --------------------------------------------------------------------------------------------------


@dataclass
class SynthConfig:
    """Tunables for one synthesis session."""

    max_changes: int = 6          # PLAN proposes at most this many code changes.
    max_retries_per_change: int = 2   # EDIT retries per change before skipping it.
    analyze_max_tokens: int = 2048
    plan_max_tokens: int = 1024
    edit_max_tokens: int = 4096
    context_wait_s: float = 5.0   # ANALYZE: bounded wait for graph wiring to attach notes.
    context_poll_s: float = 1.0   # poll interval within the bounded wait.
    temperature: float = 0.0
    # Per-session wall-clock cap (seconds). Checked between LLM calls: once the elapsed time since
    # session start exceeds this, the state machine stops issuing new completions and returns cleanly
    # with whatever program (if any) was already adopted. Bounds the run-8 pathology where a single
    # session burned the whole 1500s wall budget across ANALYZE/PLAN/6xEDIT-with-retries. 0 -> no cap
    # (tests keep it off so scripted FakeLlm runs are unaffected).
    max_session_seconds: float = 240.0


@dataclass
class Step:
    """One state-machine step's record (for the returned report + test assertions)."""

    name: str
    task_key: str = ""
    status: str = "done"
    detail: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "task_key": self.task_key,
            "status": self.status,
            "detail": self.detail,
        }


# --------------------------------------------------------------------------------------------------
# Prompt construction
# --------------------------------------------------------------------------------------------------

_ANALYZE_SYSTEM = (
    "You are analyzing an ARC-AGI-3 game's observed state transitions to enumerate its mechanics. "
    "You are given context notes (some may be cross-game HYPOTHESES to test — a menu, not facts; "
    "any, all, or none may apply) and object-level transition deltas. "
    "Return ONLY a JSON array of mechanics, each {\"name\": str, \"description\": str}. No prose."
)

_PLAN_SYSTEM = (
    "You are planning a world-model program for an ARC-AGI-3 game as an ORDERED list of small code "
    "changes. Given the mechanics and the current program (may be empty), return ONLY a JSON array "
    "of at most %d changes, each {\"name\": str, \"description\": str, "
    "\"target_transitions\": [int indices]}. Order them so earlier changes are prerequisites. "
    "No prose."
)

_EDIT_SYSTEM = (
    "You are writing a single Python world-model program for an ARC-AGI-3 game. The program must "
    "define init_state(frame), step(state, action)->(state, events), render(state)->grid, "
    "is_win(state)->bool, legal_actions(state)->list. Apply the requested change to the CURRENT "
    "program (shown below; may be empty) and return the COMPLETE revised program in ONE ```python "
    "fenced block. Do not hardcode observed grids."
)


def _mechanics_to_text(mechanics: list[dict[str, Any]]) -> str:
    lines = []
    for i, m in enumerate(mechanics):
        name = m.get("name", f"mechanic {i}")
        desc = m.get("description", "")
        lines.append(f"- {name}: {desc}")
    return "\n".join(lines) if lines else "(none)"


# --------------------------------------------------------------------------------------------------
# The session state machine
# --------------------------------------------------------------------------------------------------


class SynthSession:
    """Graph-native multi-step synthesis of a world-model program for one game.

    ``suite`` is the observed :class:`TransitionSuite` (the regression tests). ``llm`` is any object
    with ``chat(messages, max_tokens, temperature) -> {content, ...}`` (see :class:`.llm_client`).
    ``graph`` is an optional :class:`GraphClient`; ``None`` -> the state machine runs identically
    with all graph ops no-op'd. Each LLM call is STATELESS: a fresh ``[system, user]`` message list
    (between-step context comes from graph notes, never rolling chat).
    """

    def __init__(
        self,
        game_id: str,
        suite: TransitionSuite,
        llm: Any,
        graph: GraphClient | None = None,
        config: SynthConfig | None = None,
        *,
        sleep: Callable[[float], None] | None = None,
        on_edit: Callable[[dict[str, Any]], None] | None = None,
        analyze_context: list[str] | None = None,
        synth_context: str | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.game_id = game_id
        self.suite = suite
        self.llm = llm
        self.graph: GraphClient = graph if graph is not None else _NullGraph()
        self.config = config or SynthConfig()
        # The hardened synthesis contract (grid dims + UNKNOWN teaching + stdlib import whitelist +
        # step-tuple rule + segment() paragraph + observed-data blocks), built once by the caller via
        # agent.build_synth_context and appended VERBATIM to every EDIT prompt. Without it, EDIT
        # candidates hallucinate `import numpy` (rejected by the sandbox) and hardcode grids — the run
        # 8 pathology. None -> EDIT prompts carry only the generic five-function reminder.
        self._synth_context = synth_context or ""
        # Context notes fed to ANALYZE DIRECTLY (in addition to any graph-wired notes) — e.g. the KB
        # hypothesis menu. Presented under the same HYPOTHESES framing as wired notes. Used when the
        # caller has the context in hand and cannot rely on graph task-wiring (no daemon-minted key).
        self._analyze_context = list(analyze_context) if analyze_context else []
        # Optional per-EDIT-attempt hook: fired once per proposed candidate with
        # {change, prompt_text, raw_text, source, report, adopted} so the caller can persist the
        # same NN-*.json artifact shape it writes for single-shot synthesis. None -> no artifacts.
        self._on_edit = on_edit
        # Injectable sleep so the bounded ANALYZE wait is instant in tests.
        if sleep is not None:
            self._sleep = sleep
        else:
            import time as _time

            self._sleep = _time.sleep
        # Injectable monotonic clock for the per-session wall-cap (tests script elapsed time). Reads
        # once at run() start to fix the session's t0.
        if clock is not None:
            self._clock = clock
        else:
            import time as _time2

            self._clock = _time2.monotonic
        self._deadline: float | None = None  # set in run(): t0 + max_session_seconds (None -> no cap)
        self.wall_capped = False             # True once the wall-cap stopped the session early
        self.steps: list[Step] = []
        self.source: str | None = None
        # Best-candidate tracking for PARTIAL ADOPTION. Across the EDIT chain we remember the single
        # highest full-suite pass_count candidate seen — even one the regression guard REJECTED (it
        # improves some indices while regressing another). FINAL may fail (no fully-passing program),
        # but the caller can still partially adopt this best source by masking its persistently-wrong
        # cells UNKNOWN. None until the first compiling candidate is scored.
        self.best_source: str | None = None
        self.best_report: ValidationReport | None = None
        self._best_index_pass: int = -1  # per-index passing count of best_source (-1 == none yet)

    def _wall_exceeded(self) -> bool:
        """True once the session's wall-clock deadline has passed (no cap -> never)."""

        if self._deadline is None:
            return False
        if self._clock() >= self._deadline:
            self.wall_capped = True
            return True
        return False

    # -- LLM helper --------------------------------------------------------------------------------

    def _chat(self, system: str, user: str, max_tokens: int) -> str:
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        resp = self.llm.chat(
            messages, max_tokens=max_tokens, temperature=self.config.temperature
        )
        if isinstance(resp, dict):
            return str(resp.get("content", ""))
        return str(resp or "")

    # -- ANALYZE -----------------------------------------------------------------------------------

    def _analyze(self, deltas: list[str]) -> list[dict[str, Any]]:
        key = self.graph.create_task(
            f"game {self.game_id} analyze transitions",
            "Enumerate mechanics from observed transition deltas and wired hypothesis notes.",
        )
        # Bounded wait for graph wiring to attach context notes to the ANALYZE task, plus any notes
        # the caller supplied directly (e.g. the KB hypothesis menu, when there is no minted key).
        notes = list(self._analyze_context) + self._wait_for_context(key)

        user_parts: list[str] = []
        if notes:
            user_parts.append(
                "Context notes (cross-game entries are HYPOTHESES to test — a menu, not facts):"
            )
            for n in notes:
                user_parts.append(f"- {n}")
        user_parts.append("\nObserved transition deltas (object-level):")
        if deltas:
            user_parts.extend(f"- {d}" for d in deltas)
        else:
            user_parts.append("- (none)")
        user = "\n".join(user_parts)

        text = self._chat(_ANALYZE_SYSTEM, user, self.config.analyze_max_tokens)
        mechanics = self._parse_mechanics(text)

        self.graph.note(
            f"game {self.game_id} mechanics",
            "Mechanics enumerated from transition deltas:\n" + _mechanics_to_text(mechanics),
            wires_to=[key] if key else [],
        )
        self.graph.complete(
            key, "tested", f"analyzed {len(mechanics)} mechanic(s)"
        )
        self.steps.append(
            Step(
                name="ANALYZE",
                task_key=key,
                status="tested",
                detail={"mechanics": mechanics, "notes_seen": len(notes)},
            )
        )
        return mechanics

    def _wait_for_context(self, key: str) -> list[str]:
        """Poll ``task_context(key)`` up to ``context_wait_s`` for wired notes to appear."""

        if not key:
            return []
        waited = 0.0
        notes = self.graph.task_context(key)
        while not notes and waited < self.config.context_wait_s:
            self._sleep(self.config.context_poll_s)
            waited += self.config.context_poll_s
            notes = self.graph.task_context(key)
        return notes

    @staticmethod
    def _parse_mechanics(text: str) -> list[dict[str, Any]]:
        data = _extract_json(text)
        out: list[dict[str, Any]] = []
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    out.append(
                        {
                            "name": str(item.get("name", "")),
                            "description": str(item.get("description", "")),
                        }
                    )
        return out

    # -- PLAN --------------------------------------------------------------------------------------

    def _plan(self, mechanics: list[dict[str, Any]]) -> list[dict[str, Any]]:
        key = self.graph.create_task(
            f"game {self.game_id} plan program changes",
            "Propose an ordered list of small code changes for the world-model program.",
        )
        self.graph.claim(key)
        user = (
            "Mechanics:\n"
            + _mechanics_to_text(mechanics)
            + "\n\nCurrent program:\n"
            + (self.source or "(empty)")
            + f"\n\nSuite has {len(self.suite)} transitions (indices 0..{len(self.suite) - 1})."
        )
        system = _PLAN_SYSTEM % self.config.max_changes
        text = self._chat(system, user, self.config.plan_max_tokens)
        changes = self._parse_changes(text)
        self.graph.complete(key, "tested", f"planned {len(changes)} change(s)")
        self.steps.append(
            Step(
                name="PLAN",
                task_key=key,
                status="tested",
                detail={"changes": changes},
            )
        )
        return changes

    def _parse_changes(self, text: str) -> list[dict[str, Any]]:
        data = _extract_json(text)
        out: list[dict[str, Any]] = []
        if isinstance(data, list):
            for item in data:
                if not isinstance(item, dict):
                    continue
                targets = item.get("target_transitions")
                targets = [t for t in targets if isinstance(t, int)] if isinstance(targets, list) else []
                out.append(
                    {
                        "name": str(item.get("name", "")),
                        "description": str(item.get("description", "")),
                        "target_transitions": targets,
                    }
                )
        return out[: self.config.max_changes]

    # -- EDIT chain --------------------------------------------------------------------------------

    def _edit_chain(self, changes: list[dict[str, Any]]) -> None:
        for idx, change in enumerate(changes):
            # Wall-cap: stop before issuing another EDIT completion once the session deadline passed.
            # Whatever was already adopted into self.source is kept; FINAL still validates it.
            if self._wall_exceeded():
                break
            self._apply_change(idx, change)

    def _apply_change(self, idx: int, change: dict[str, Any]) -> None:
        name = change.get("name", f"change {idx}")
        targets: list[int] = change.get("target_transitions", [])
        key = self.graph.create_task(
            f"game {self.game_id} edit {name}",
            change.get("description", ""),
        )
        self.graph.claim(key)

        # Baseline: which indices does the CURRENT source already pass? Those must not regress.
        baseline_pass = self._current_passing()

        attempt = 0
        accepted_source: str | None = None
        last_report: ValidationReport | None = None
        while attempt <= self.config.max_retries_per_change:
            candidate, prompt_text, raw_text = self._propose_edit(change)
            attempt += 1
            if candidate is None:
                self._emit_edit(change, prompt_text, raw_text, None, None, False)
                continue
            ok, report = self._accepts(candidate, targets, baseline_pass)
            last_report = report
            self._emit_edit(change, prompt_text, raw_text, candidate, report, ok)
            if ok:
                accepted_source = candidate
                break

        if accepted_source is not None:
            self.source = accepted_source
            self.graph.complete(key, "tested", f"applied change {name} in {attempt} attempt(s)")
            self.steps.append(
                Step(
                    name="EDIT",
                    task_key=key,
                    status="tested",
                    detail={"change": name, "attempts": attempt, "targets": targets},
                )
            )
        else:
            # Skip: leave self.source unchanged, record a failed-repair note + failed step.
            self.graph.note(
                f"game {self.game_id} failed repair {name}",
                f"Change '{name}' could not be applied without regressing the passing set after "
                f"{attempt} attempt(s). Last validation: "
                + (json.dumps(last_report.to_dict()) if last_report else "no candidate parsed"),
                wires_to=[key] if key else [],
            )
            self.graph.complete(key, "failed", f"skipped change {name} after {attempt} attempt(s)")
            self.steps.append(
                Step(
                    name="EDIT",
                    task_key=key,
                    status="failed",
                    detail={"change": name, "attempts": attempt, "targets": targets},
                )
            )

    def _emit_edit(
        self,
        change: dict[str, Any],
        prompt_text: str,
        raw_text: str,
        source: str | None,
        report: ValidationReport | None,
        adopted: bool,
    ) -> None:
        """Fire the optional per-EDIT-attempt artifact hook (best-effort; never raises)."""

        if self._on_edit is None:
            return
        try:
            self._on_edit(
                {
                    "change": change.get("name", ""),
                    "prompt_text": prompt_text,
                    "raw_text": raw_text,
                    "source": source,
                    "report": report,
                    "adopted": bool(adopted),
                }
            )
        except Exception:  # noqa: BLE001 - an artifact hook must never crash synthesis
            logger.warning("on_edit hook failed", exc_info=True)

    def _current_passing(self) -> set[int]:
        """Indices the current source passes (empty when there is no compiling source yet)."""

        if not self.source:
            return set()
        try:
            program = WorldModelProgram.load(self.source)
        except Exception:  # noqa: BLE001 - a non-loading current source passes nothing.
            return set()
        return _passing_indices(program, self.suite)

    def _propose_edit(self, change: dict[str, Any]) -> tuple[str | None, str, str]:
        """Return ``(source_or_None, prompt_text, raw_text)`` for one EDIT completion."""

        user = (
            f"Change to apply: {change.get('name', '')}\n"
            f"Description: {change.get('description', '')}\n"
            f"Target transition indices: {change.get('target_transitions', [])}\n\n"
            "Current program:\n"
            + (self.source or "(empty)")
            # The hardened contract + observed data, verbatim from agent.build_synth_context. Every
            # EDIT prompt carries it so session candidates honor the stdlib whitelist / grid dims.
            + (("\n" + self._synth_context) if self._synth_context else "")
        )
        text = self._chat(_EDIT_SYSTEM, user, self.config.edit_max_tokens)
        return _extract_python(text), user, text

    def _accepts(
        self, candidate: str, targets: list[int], baseline_pass: set[int]
    ) -> tuple[bool, ValidationReport]:
        """Acceptance slice: the change's ``targets`` must ALL pass AND no baseline-passing index
        may regress. Returns ``(ok, report)`` where ``report`` is the full-suite validation."""

        try:
            program = WorldModelProgram.load(candidate)
        except Exception as exc:  # noqa: BLE001 - a non-loading candidate is rejected.
            return False, ValidationReport(
                ok=False, pass_count=0, total=len(self.suite), error=f"load: {exc}"
            )

        # Regression guard: every index that USED to pass must still pass.
        target_set = {t for t in targets if isinstance(t, int) and 0 <= t < len(self.suite)}
        must_pass = baseline_pass | target_set
        now_pass = _passing_indices(program, self.suite)
        ok = must_pass.issubset(now_pass)
        report = validate(program, self.suite)
        # Partial-adoption bookkeeping: remember the candidate passing the MOST individual
        # transitions, regardless of whether the regression guard accepted it — a candidate that
        # models real mechanics but regresses one index is exactly what partial adoption rescues.
        # Rank by per-index passing count (not report.pass_count, which stops at the first failure
        # and so under-ranks a candidate whose early transition fails).
        self._track_best(candidate, report, len(now_pass))
        return ok, report

    def _track_best(
        self, candidate: str, report: ValidationReport, index_pass_count: int
    ) -> None:
        """Keep the candidate passing the most individual transitions across the EDIT chain."""

        if index_pass_count > self._best_index_pass:
            self._best_index_pass = index_pass_count
            self.best_source = candidate
            self.best_report = report

    # -- FINAL -------------------------------------------------------------------------------------

    def _final(self) -> ValidationReport:
        if not self.source:
            report = ValidationReport(
                ok=False, pass_count=0, total=len(self.suite), error="no program synthesized"
            )
        else:
            try:
                program = WorldModelProgram.load(self.source)
                report = validate(program, self.suite)
            except Exception as exc:  # noqa: BLE001
                report = ValidationReport(
                    ok=False, pass_count=0, total=len(self.suite), error=f"load: {exc}"
                )
        self.steps.append(
            Step(name="FINAL", status="tested" if report.ok else "failed", detail=report.to_dict())
        )
        return report

    # -- run ---------------------------------------------------------------------------------------

    def run(self, deltas: list[str] | None = None) -> dict[str, Any]:
        """Drive ANALYZE -> PLAN -> EDIT chain -> FINAL and return the result.

        ``deltas`` is the precomputed object-level delta text list fed to ANALYZE (defaults to []).
        Returns ``{program_source, report, steps}`` where ``program_source`` is the adopted source
        or ``None`` when nothing validated.
        """

        deltas = deltas or []
        # Fix the per-session deadline at t0 (None -> no cap). Checked between LLM calls (before PLAN
        # and before each EDIT change) so a slow session stops cleanly with whatever it has adopted.
        cap = self.config.max_session_seconds
        self._deadline = (self._clock() + cap) if cap and cap > 0 else None
        mechanics = self._analyze(deltas)
        if not self._wall_exceeded():
            changes = self._plan(mechanics)
            self._edit_chain(changes)
        report = self._final()
        return {
            # program_source is the adopted source (may be a partial program that explains only a
            # subset — the report carries the pass rate); None only when nothing was ever adopted.
            "program_source": self.source,
            "report": report.to_dict(),
            # Best candidate across the EDIT chain by full-suite pass_count (may be a source the
            # regression guard rejected). The caller uses this for PARTIAL ADOPTION when FINAL
            # failed: mask its persistently-wrong cells UNKNOWN and re-validate. None when no
            # candidate ever compiled.
            "best_source": self.best_source,
            "best_report": self.best_report.to_dict() if self.best_report else None,
            "steps": [s.to_dict() for s in self.steps],
            # True when the per-session wall-cap stopped the session early (fewer EDIT changes ran).
            "wall_capped": self.wall_capped,
        }
