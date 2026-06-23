"""bench/tb_zonoid/adapter.py — Zonoid Terminal-Bench AGENT ADAPTER.

(Lives in ``bench/tb_zonoid/``, NOT ``bench/terminal_bench/``: a local package named
``terminal_bench`` would shadow the PyPI ``terminal_bench`` harness on sys.path and make the
``from terminal_bench... import`` below resolve to itself. ``tb_zonoid`` is collision-free.)

This is the bridge between the Terminal-Bench (TB) harness and the Zonoid Bench SDK
(`bench/zonoid_bench/`). It defines two TB ``BaseAgent`` subclasses that the TB harness
loads via ``--agent-import-path``:

  - ``ZonoidAgent``     : the Zonoid-ON arm. Per TB task it DRIVES THE SDK
                          (``zonoid_bench.arms.run_agent_in_container``) to (a) mint the task as a
                          probe against the REAL bench daemon, (b) seed + judge autowire candidate
                          context edges with the PRODUCTION ``/judge/drain`` judge, and (c) build the
                          API-only ``AGENTS.md`` (live ``/task/context`` + ``/search`` + ``/overlay/*``
                          curl instructions). It writes that AGENTS.md into the TB container and runs
                          an in-container solver loop that consults the Zonoid KB while solving.
  - ``NoZonoidAgent``   : the no-zonoid A/B baseline. Identical solver loop, but NO KB injection, NO
                          daemon wiring, NO AGENTS.md — it solves with model knowledge only. This is
                          the contrast arm (same role as ``run_cold`` / the no-memory floor in
                          ``bench/zonoid_bench/smoke.py``).

WHAT TERMINAL-BENCH HANDS THE AGENT (the adapter contract)
----------------------------------------------------------
TB's agent interface (``terminal_bench/agents/base_agent.py``) is one abstract method::

    @abstractmethod
    def perform_task(
        self,
        instruction: str,            # the task instruction text TB read from task.yaml
        session: TmuxSession,        # a live shell INTO the task's Docker container
        logging_dir: Path | None = None,
    ) -> AgentResult:                # token counts + FailureMode (TB grades by the task's own tests)

  * ``instruction`` is the natural-language task description.
  * ``session`` (``terminal_bench/terminal/tmux_session.py``) is how the agent acts on the container:
      - ``session.send_keys([cmd, "Enter"], block=True, max_timeout_sec=...)`` — run a shell command.
      - ``session.capture_pane(capture_entire=True)`` — read the terminal buffer (command output).
      - ``session.container`` — the underlying ``docker.models.containers.Container`` (we use
        ``container.exec_run`` for clean, capturable command execution and to copy files in).
      - ``session.copy_to_container(local_path, container_dir=...)`` — push a file (the AGENTS.md).
  * The agent NEVER sees the gold solution or the task's tests — exactly why the Zonoid AGENTS.md is
    API-ONLY (curl instructions to the daemon), never raw KB summaries or answers. TB runs the task's
    hidden pytest suite AFTER ``perform_task`` returns and that pass/fail is the real metric.
  * ``AgentResult`` returns ``total_input_tokens`` / ``total_output_tokens`` / ``failure_mode``; TB
    pairs that with its own resolved/unresolved verdict.

HOW THE IN-CONTAINER AGENT REACHES THE ZONOID DAEMON
----------------------------------------------------
The Zonoid bench daemon runs on the HOST (``zonoid_bench.daemon.start`` → ``http://127.0.0.1:<port>``).
A TB container reaches host-published ports via ``host.docker.internal`` (Docker Desktop, and on Linux
when the container is started with ``--add-host=host.docker.internal:host-gateway``). So the AGENTS.md
the in-container agent reads points at ``http://host.docker.internal:<port>`` — see ``agent_url`` below.
The bench daemon's ``state.workspace`` is LIVE-BOUND to the per-task workspace dir (the eager-judge /
keepEdge prerequisite, note-mqgwrh5a63x), so the curl ``/task/context`` + ``/search`` the agent makes
resolve to the judged DAG for this task.

REUSE, NOT HAND-ROLL (handoff requirement)
------------------------------------------
The adapter does NOT hand-roll daemon calls or a judge. The entire ON-arm pipeline — probe mint,
autowire seed, the PRODUCTION ``/judge/drain`` judge, the AGENTS.md build — is ``arms.run_agent_in_container``
(which itself calls ``run_canonical_wiring``). The adapter only: (1) calls that one SDK function, (2)
moves its ``AGENTS.md`` output into the container, (3) runs a thin solver loop. The judge, the keep/prune
rubric, the search tiers — all live in production and are driven over HTTP by the SDK.

Runtime: this module imports ``terminal_bench`` (the TB package) and ``docker``; both are TB's own
dependencies, present whenever TB itself is installed. The Zonoid SDK half is stdlib-only.
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Make the Zonoid Bench SDK importable (bench/ on sys.path), mirroring the
# bootstrap in bench/zonoid_bench/smoke.py.
# ---------------------------------------------------------------------------
_HERE = os.path.dirname(os.path.abspath(__file__))        # bench/tb_zonoid/
_BENCH = os.path.dirname(_HERE)                            # bench/
if _BENCH not in sys.path:
    sys.path.insert(0, _BENCH)

from zonoid_bench.client import ZonoidClient            # noqa: E402
from zonoid_bench import arms as arms_mod               # noqa: E402
from zonoid_bench import judge as judge_mod             # noqa: E402

# ---------------------------------------------------------------------------
# Terminal-Bench imports. Deferred to call-time-safe module scope: if TB is not
# installed (the documented Windows blocker), importing this module for the
# offline contract/dry-run still works because we guard the TB import.
# ---------------------------------------------------------------------------
try:
    from terminal_bench.agents.base_agent import AgentResult, BaseAgent
    from terminal_bench.agents.failure_mode import FailureMode
    from terminal_bench.terminal.tmux_session import TmuxSession
    _TB_AVAILABLE = True
    _TB_IMPORT_ERROR: Optional[BaseException] = None
except Exception as _exc:  # noqa: BLE001 — TB optional for offline contract inspection
    _TB_AVAILABLE = False
    _TB_IMPORT_ERROR = _exc

    # Minimal shims so the classes below still *define* (subclassable signatures intact)
    # even without TB installed. They are never instantiated by the harness in that state.
    class BaseAgent:  # type: ignore[no-redef]
        def __init__(self, **kwargs: Any) -> None:
            self._version = kwargs.get("version")
            self._prompt_template = kwargs.get("prompt_template")

    class AgentResult:  # type: ignore[no-redef]
        def __init__(self, total_input_tokens: int = 0, total_output_tokens: int = 0,
                     failure_mode: Any = None, timestamped_markers: Any = None) -> None:
            self.total_input_tokens = total_input_tokens
            self.total_output_tokens = total_output_tokens
            self.failure_mode = failure_mode
            self.timestamped_markers = timestamped_markers or []

    class FailureMode:  # type: ignore[no-redef]
        NONE = "none"
        UNKNOWN_AGENT_ERROR = "unknown_agent_error"
        FATAL_LLM_PARSE_ERROR = "fatal_llm_parse_error"

    TmuxSession = Any  # type: ignore[assignment,misc]


# ---------------------------------------------------------------------------
# Tunables (env-overridable, same convention as the rest of the SDK)
# ---------------------------------------------------------------------------

# The host daemon base URL the in-container agent reaches (host.docker.internal gateway).
# The runner sets ZONOID_TB_AGENT_URL to http://host.docker.internal:<bench-port> before
# launching the TB harness; the agent reads it to point AGENTS.md curl at the daemon.
AGENT_URL_ENV = "ZONOID_TB_AGENT_URL"
# The host daemon base URL THIS process (host side) uses for the SDK wiring call.
DAEMON_URL_ENV = "ZONOID_TB_DAEMON_URL"
# The absolute per-task workspace the bench daemon is LIVE-BOUND to.
WORKSPACE_ENV = "ZONOID_TB_WORKSPACE"
# Where the file-drop task stub is written (CLAUDE_PLUGIN_DATA of the bench daemon).
DATA_DIR_ENV = "ZONOID_TB_DATA_DIR"

# Max solver turns inside the container (ReAct-style command/observe loop).
MAX_TURNS: int = int(os.environ.get("ZONOID_TB_MAX_TURNS", "12"))
# Per-command shell timeout inside the container.
CMD_TIMEOUT_S: float = float(os.environ.get("ZONOID_TB_CMD_TIMEOUT", "120"))
# Chars of terminal output to feed back to the solver each turn.
OBS_BUDGET: int = int(os.environ.get("ZONOID_TB_OBS_BUDGET", "4000"))


# ---------------------------------------------------------------------------
# In-container solver loop (shared by ON + baseline arms)
# ---------------------------------------------------------------------------

_SOLVER_SYSTEM = (
    "You are an autonomous terminal agent solving a task inside a Linux Docker container. "
    "You act ONLY by issuing shell commands. Each turn, respond with a STRICT JSON object:\n"
    '{"thought": "<brief reasoning>", "command": "<one shell command to run>", "done": false}\n'
    "Set \"done\": true (and command: \"\") ONLY when the task is fully complete. "
    "Do not wrap the JSON in markdown fences. One command per turn. Prefer non-interactive, "
    "idempotent commands. Inspect the filesystem before editing."
)

_KB_PREAMBLE = (
    "A Zonoid knowledge base relevant to this task has been mounted at /testbed/AGENTS.md inside "
    "this container. BEFORE solving, run `cat /testbed/AGENTS.md` and FOLLOW its instructions — it "
    "tells you how to curl task-scoped context and search the KB over HTTP. Use that KB; it may "
    "contain project-specific facts you cannot know otherwise."
)


def _exec(session: "TmuxSession", command: str) -> str:
    """Run *command* in the container via exec_run and return decoded combined output (clipped).

    We prefer ``container.exec_run`` over ``send_keys``+``capture_pane`` for the solver loop because
    it gives a clean, fully-captured stdout/stderr for one command without tmux pane-scroll loss.
    The TB grader still drives the *real* container; exec_run shares that same container handle
    (``session.container``), so all effects (files written, packages installed) persist for grading.
    """
    container = getattr(session, "container", None)
    if container is None:
        # Offline/shim path — never reached under a real TB run.
        return "(no container available)"
    res = container.exec_run(["bash", "-lc", command])
    out = res.output
    if isinstance(out, (bytes, bytearray)):
        out = out.decode(errors="replace")
    text = str(out or "")
    if len(text) > OBS_BUDGET:
        text = text[:OBS_BUDGET] + f"\n...(output truncated at {OBS_BUDGET} chars)"
    return text


def _solve_in_container(
    instruction: str,
    session: "TmuxSession",
    *,
    use_kb: bool,
    logging_dir: Optional[Path],
    model: Optional[str] = None,
) -> tuple[int, int, str]:
    """Run the ReAct-style command/observe loop. Returns (in_tokens, out_tokens, last_status).

    The SAME loop powers both arms; the ONLY difference is the ``use_kb`` preamble that tells the
    in-container agent the AGENTS.md exists. The KB injection itself (writing AGENTS.md into the
    container + driving the production judge) is the ON arm's job, done by the caller BEFORE this
    loop. This keeps the A/B honest: identical solver, identical task, identical container — the one
    variable is whether the Zonoid KB is present + advertised.
    """
    in_tokens = 0
    out_tokens = 0
    transcript: list[str] = []

    preamble = _KB_PREAMBLE + "\n\n" if use_kb else ""
    history = (
        f"{_SOLVER_SYSTEM}\n\n{preamble}TASK:\n{instruction}\n\n"
        "Begin. Respond with the first JSON action."
    )

    for turn in range(MAX_TURNS):
        text, usage = judge_mod.claude_p_with_usage(history, model=model)
        in_tokens += int(usage.get("input_tokens", 0))
        out_tokens += int(usage.get("output_tokens", 0))
        action = judge_mod.parse_strict_json(text or "")
        if not action:
            transcript.append(f"[turn {turn}] UNPARSEABLE: {text!r}")
            history += f"\n\nYour last reply was not valid JSON. Reply with ONLY the JSON action."
            continue

        cmd = str(action.get("command") or "").strip()
        done = bool(action.get("done"))
        thought = str(action.get("thought") or "")
        transcript.append(f"[turn {turn}] thought={thought!r} done={done} cmd={cmd!r}")

        if done or not cmd:
            transcript.append(f"[turn {turn}] solver signalled done")
            break

        observation = _exec(session, cmd)
        transcript.append(f"[turn {turn}] OBSERVATION:\n{observation}")
        history += (
            f"\n\nYou ran: {cmd}\nOutput:\n{observation}\n\n"
            "Respond with the next JSON action (set done:true when finished)."
        )

    if logging_dir is not None:
        try:
            (logging_dir / "zonoid_solver_transcript.txt").write_text(
                "\n\n".join(transcript), encoding="utf-8"
            )
        except Exception:  # noqa: BLE001 — logging is best-effort
            pass

    return in_tokens, out_tokens, (transcript[-1] if transcript else "")


# ---------------------------------------------------------------------------
# ON arm: ZonoidAgent
# ---------------------------------------------------------------------------

class ZonoidAgent(BaseAgent):
    """Zonoid-ON Terminal-Bench agent: DRIVE the SDK, inject the judged KB, then solve.

    TB constructs this via ``--agent-import-path bench.tb_zonoid.adapter:ZonoidAgent``. The
    per-task daemon URL / workspace / data_dir are passed via env (set by ``runner.py``) so the agent
    needs no harness-level kwargs beyond what TB already threads.
    """

    @staticmethod
    def name() -> str:
        return "zonoid"

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        # Resolve the bench daemon + workspace the runner stood up for this task.
        self._daemon_url = kwargs.get("daemon_url") or os.environ.get(DAEMON_URL_ENV)
        self._agent_url = (
            kwargs.get("agent_url")
            or os.environ.get(AGENT_URL_ENV)
            or self._daemon_url
        )
        self._workspace = kwargs.get("workspace") or os.environ.get(WORKSPACE_ENV)
        self._data_dir = kwargs.get("data_dir") or os.environ.get(DATA_DIR_ENV)
        self._model = kwargs.get("model_name") or os.environ.get("ZONOID_TB_MODEL")

    def perform_task(
        self,
        instruction: str,
        session: "TmuxSession",
        logging_dir: Optional[Path] = None,
    ) -> "AgentResult":
        if not _TB_AVAILABLE:  # pragma: no cover — guarded; harness never runs this without TB
            raise RuntimeError(
                f"terminal_bench is not importable: {_TB_IMPORT_ERROR!r}"
            )
        if not (self._daemon_url and self._workspace):
            raise RuntimeError(
                "ZonoidAgent requires a running bench daemon: set "
                f"{DAEMON_URL_ENV} and {WORKSPACE_ENV} (the runner does this). "
                f"daemon_url={self._daemon_url!r} workspace={self._workspace!r}"
            )

        client = ZonoidClient(self._daemon_url, workspace=self._workspace, timeout=180)

        # ---- 1. DRIVE THE SDK: mint probe → autowire → PROD /judge/drain → build AGENTS.md ----
        # run_agent_in_container is the canonical ON-arm executor (a). It returns the API-only
        # AGENTS.md (curl instructions, NO raw answers) + the judged context provenance. We do NOT
        # hand-roll any of this — the probe mint, the production judge, the search tiers are all the
        # SDK / the production daemon.
        unit_id = _task_unit_id(instruction)
        arm = arms_mod.run_agent_in_container(
            client,
            unit_id=unit_id,
            task_summary=_clip(instruction, 2000),
            agent_url=self._agent_url,          # what the IN-CONTAINER curl targets
            data_dir=self._data_dir,
        )
        agents_md = arm.agents_md
        wiring = arm.wiring

        # ---- 2. inject the AGENTS.md into the container ----
        self._inject_agents_md(session, agents_md)

        if logging_dir is not None:
            try:
                (logging_dir / "AGENTS.md").write_text(agents_md, encoding="utf-8")
                (logging_dir / "zonoid_wiring.txt").write_text(
                    "probe_task_key={}\njudge_idle={}\nkept_edges={}\ncandidates={}\n"
                    "judged={} kept={} pruned={} rounds={}\n".format(
                        getattr(wiring, "task_key", None),
                        getattr(wiring, "judge_idle", None),
                        getattr(wiring, "wired_edges", None),
                        [c.get("key") for c in (getattr(wiring, "candidates_seen", []) or [])],
                        getattr(wiring, "judged", 0), getattr(wiring, "kept", 0),
                        getattr(wiring, "pruned", 0), getattr(wiring, "rounds", 0),
                    ),
                    encoding="utf-8",
                )
            except Exception:  # noqa: BLE001
                pass

        # ---- 3. solve in-container WITH the KB advertised ----
        in_tok, out_tok, _ = _solve_in_container(
            instruction, session, use_kb=True, logging_dir=logging_dir, model=self._model
        )

        return AgentResult(
            total_input_tokens=in_tok,
            total_output_tokens=out_tok,
            failure_mode=FailureMode.NONE,
        )

    def _inject_agents_md(self, session: "TmuxSession", agents_md: str) -> None:
        """Write *agents_md* to /testbed/AGENTS.md inside the TB container.

        Strategy 1: ``session.copy_to_container`` (TB's own helper) from a host temp file.
        Strategy 2 (fallback): base64-pipe via ``exec_run`` so we never depend on a working-dir
        assumption. Either way the file lands at /testbed/AGENTS.md, the path the solver preamble
        and the AGENTS.md self-reference both name.
        """
        container = getattr(session, "container", None)
        # Strategy 1 — TB helper.
        tmp = None
        try:
            fd, tmp = tempfile.mkstemp(prefix="zonoid-agents-", suffix=".md")
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(agents_md)
            session.copy_to_container(
                Path(tmp), container_dir="/testbed", container_filename="AGENTS.md"
            )
            return
        except Exception as exc:  # noqa: BLE001 — fall through to exec_run pipe
            print(f"[zonoid-adapter] copy_to_container failed ({exc}); using base64 fallback",
                  file=sys.stderr)
        finally:
            if tmp and os.path.exists(tmp):
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        # Strategy 2 — base64 pipe.
        if container is not None:
            import base64
            b64 = base64.b64encode(agents_md.encode("utf-8")).decode("ascii")
            container.exec_run([
                "bash", "-lc",
                f"mkdir -p /testbed && echo {b64} | base64 -d > /testbed/AGENTS.md",
            ])


# ---------------------------------------------------------------------------
# Baseline arm: NoZonoidAgent (no KB injection — the A/B contrast)
# ---------------------------------------------------------------------------

class NoZonoidAgent(BaseAgent):
    """No-zonoid Terminal-Bench baseline: the SAME solver loop, but NO KB at all.

    No daemon wiring, no AGENTS.md, no /task/context, no /search. The agent solves with model
    knowledge only. This is the contrast arm for the A/B — same role as ``run_cold`` in
    ``bench/zonoid_bench/smoke.py``: if this scores as well as ZonoidAgent on a task, the Zonoid KB
    added nothing for that task (and any "win" would be rigged).
    """

    @staticmethod
    def name() -> str:
        return "no-zonoid"

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._model = kwargs.get("model_name") or os.environ.get("ZONOID_TB_MODEL")

    def perform_task(
        self,
        instruction: str,
        session: "TmuxSession",
        logging_dir: Optional[Path] = None,
    ) -> "AgentResult":
        if not _TB_AVAILABLE:  # pragma: no cover
            raise RuntimeError(f"terminal_bench is not importable: {_TB_IMPORT_ERROR!r}")
        in_tok, out_tok, _ = _solve_in_container(
            instruction, session, use_kb=False, logging_dir=logging_dir, model=self._model
        )
        return AgentResult(
            total_input_tokens=in_tok,
            total_output_tokens=out_tok,
            failure_mode=FailureMode.NONE,
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _clip(text: str, n: int) -> str:
    return (text or "")[:n]


def _task_unit_id(instruction: str) -> str:
    """Stable-ish unit id for the probe task: short hash of the instruction + a run nonce.

    The probe is per-task; the nonce avoids key collisions if the same task is wired twice in one
    daemon lifetime. The harness namespace prefixing happens inside workspace.drop_task_stub.
    """
    import hashlib
    h = hashlib.sha256((instruction or "").encode("utf-8")).hexdigest()[:8]
    return f"tb-{h}-{int(time.time()) % 100000}"


def contract_summary() -> str:
    """Return a human-readable summary of the TB agent-adapter contract this module implements.

    Used by ``runner.py --contract`` so the contract is inspectable WITHOUT a Docker/TB run (the
    documented Windows blocker). This is the same text the README §Contract documents.
    """
    return (
        "Terminal-Bench agent-adapter contract (terminal_bench package):\n"
        "  base class : terminal_bench.agents.base_agent.BaseAgent (ABC)\n"
        "  required   : @staticmethod name() -> str\n"
        "               perform_task(self, instruction: str, session: TmuxSession,\n"
        "                            logging_dir: Path | None = None) -> AgentResult\n"
        "  session    : terminal_bench.terminal.tmux_session.TmuxSession\n"
        "                 .send_keys([cmd, 'Enter'], block=True, max_timeout_sec=...)  # run cmd\n"
        "                 .capture_pane(capture_entire=True)                            # read buffer\n"
        "                 .container  -> docker Container (.exec_run, used by this adapter)\n"
        "                 .copy_to_container(local, container_dir=..., container_filename=...)\n"
        "  result     : AgentResult(total_input_tokens, total_output_tokens, failure_mode,\n"
        "                           timestamped_markers)  # TB grades by the task's hidden tests\n"
        "  register   : tb run --agent-import-path <module>:<ClassName> --task-id <id>\n"
        "               (Python: terminal_bench.harness.harness.Harness(agent_import_path=...))\n"
        "  net bridge : in-container agent reaches the host bench daemon at\n"
        "               http://host.docker.internal:<port> (Docker Desktop / host-gateway).\n"
    )


if __name__ == "__main__":
    # Offline contract inspection (no Docker/TB needed).
    print(contract_summary())
    print(f"\nterminal_bench importable: {_TB_AVAILABLE}")
    if not _TB_AVAILABLE:
        print(f"  import error: {_TB_IMPORT_ERROR!r}")
