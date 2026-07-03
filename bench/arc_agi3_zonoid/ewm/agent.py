"""EWM agent loop: the mode machine that wires the five pillars into a playing agent.

This module is the integrator. The pillar modules already exist and are not modified here; the
agent drives them:

* :mod:`.world_model` — ``WorldModelProgram`` (LLM-authored, sandboxed), ``TransitionSuite`` (every
  real transition becomes a regression test), and ``validate`` (replay, first-failure report).
* :mod:`.planner` — ``plan`` (BFS to a goal predicate, zero LLM tokens) + ``rollout_search``.
* :mod:`.kb_protocol` — mode-scoped ``search_for_mode`` and acceptance-event ``WriteGate``.
* :mod:`.vision` — ``composite_data_url`` (one composite image per LLM call; PIL-optional).

Mode machine (per the five-pillar spec):

    ORIENT     — KB lookup for a stored program; validate it against live frames; adopt if it passes.
    SYNTHESIZE — LLM writes program source; accept only when validate() passes the full suite;
                 a failing source triggers a repair-style retry with the ValidationReport in the
                 prompt, up to ``max_synth_attempts``.
    PLAN       — planner.plan toward is_win (or an LLM-supplied goal grid predicate). Zero LLM calls.
    EXECUTE    — feed PlanResult.actions with expect=predicted_grids through env.act; on an
                 expect-mismatch, divert to DIVERGE.
    REPAIR     — append the failing transition to the suite, LLM patches the program with the
                 first-failure report, re-validate.
    RECOVER    — after K failed syntheses/repairs (or a poor modelability verdict): a Duck-style
                 reactive turn — the decide call returns a small action batch directly.

Two LLM calls per decision turn: ``decide`` (system prompt + program summary + mode-scoped KB
context + BEFORE|CURRENT composite when vision is on) and ``reflect`` (CURRENT|RESULT composite +
structured action result), whose output feeds the suite append and optional acceptance writes.

Every real transition observed — from ANY mode, including reactive — is appended to the suite.
All LLM output is parsed defensively: fenced ``python`` blocks for program source, JSON for action
batches; on a parse failure the agent retries once, then falls back to a reactive no-op probe.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable

from .planner import PlanResult, plan
from .world_model import (
    SandboxError,
    TransitionSuite,
    ValidationReport,
    WorldModelProgram,
    validate,
)

try:  # Vision is optional: the whole loop must run PIL-free.
    from . import vision as _vision
except Exception:  # noqa: BLE001 - defensive; the import itself does not need PIL
    _vision = None  # pragma: no cover


# --------------------------------------------------------------------------------------------------
# Prompts (module constants). ARC-GENERAL: no game-specific hints. They encode the world-model
# discipline (revise the model before acting) and steer away from goal hallucination.
# --------------------------------------------------------------------------------------------------

SYSTEM_PROMPT = (
    "You are an agent playing an unknown grid puzzle game (ARC-AGI-3 family). You do not know the "
    "rules in advance; you infer them from observed frames.\n\n"
    "CORE DISCIPLINE: maintain an executable world model of the game as a small Python program. "
    "BEFORE you act, revise the model so it explains every transition you have already seen; only "
    "then plan actions against it. A correct model lets a search planner solve levels with zero "
    "guessing.\n\n"
    "The world-model program must define exactly these functions:\n"
    "    init_state(frame) -> state\n"
    "    step(state, action) -> (state, events)\n"
    "    render(state) -> grid\n"
    "    is_win(state) -> bool\n"
    "    legal_actions(state) -> list[action]\n"
    "Grids are lists of lists of ints 0..15. If you cannot model a region, render the UNKNOWN "
    "sentinel there (it is provided in scope) rather than guessing.\n\n"
    "ANTI-GOAL-HALLUCINATION: timers, step counters, score readouts, and other HUD/status bars are "
    "NOT objectives. Do not plan toward changing a countdown or a meter. The objective is the game "
    "state defined by is_win; if you are unsure what winning means, model the mechanics faithfully "
    "and let the planner search. Never invent a goal the frames do not support."
)

DECIDE_PROMPT = (
    "Decision turn. Current mode: {mode}.\n"
    "Frame: level={level} step={step} score={score} valid_actions={valid_actions} "
    "remaining_actions={remaining_actions}.\n"
    "{prev_step_block}"
    "{kb_block}"
    "{program_block}"
    "{report_block}"
    "Respond as instructed for this mode:\n"
    "- If asked for a world-model program, return ONE fenced ```python code block defining the "
    "five contract functions. Revise the model to explain ALL observed transitions.\n"
    "- If asked for actions (reactive play), return a JSON object like "
    '{{"actions": ["ACTION1", "ACTION2"]}} choosing only from valid_actions. Keep the batch small.'
)

REFLECT_PROMPT = (
    "Reflect on the action you just took. Structured result: {result}.\n"
    "The CURRENT|RESULT composite (if provided) shows the board before and after. State briefly "
    "whether your world model predicted this transition and, if not, which mechanic it missed. "
    'Return a JSON object like {{"prediction_ok": true, "note": "..."}}; keep note to one sentence '
    "and do NOT paste raw grids."
)


# --------------------------------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------------------------------


@dataclass
class AgentConfig:
    """Tunable knobs for the agent loop. Defaults are small so tests stay fast and deterministic."""

    max_turns: int = 200
    max_synth_attempts: int = 3   # SYNTHESIZE tries before giving up this cycle
    max_repair_attempts: int = 3  # REPAIR tries before giving up this cycle
    reactive_after_failures: int = 3  # K: failed synth/repair cycles before RECOVER/reactive
    plan_max_depth: int = 40
    plan_max_nodes: int = 20000
    reactive_batch: int = 1       # actions per reactive probe when the LLM gives nothing usable
    decide_max_tokens: int = 1024
    reflect_max_tokens: int = 256
    game_id: str = "unknown"
    # Optional per-role model: SYNTHESIZE and REPAIR decide calls route here when set; every other
    # call (ORIENT/RECOVER decide, reflect) stays on the main llm. None -> falls back to the main llm.
    synth_llm: Any = None


# --------------------------------------------------------------------------------------------------
# Defensive parsing of LLM output
# --------------------------------------------------------------------------------------------------

_FENCE_RE = re.compile(r"```(?:python)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)


def extract_python(text: str) -> str | None:
    """Extract the FIRST fenced python block from ``text`` (or ``None`` if there is none)."""

    if not text:
        return None
    match = _FENCE_RE.search(text)
    if match:
        code = match.group(1).strip()
        return code or None
    # Fallback: if the whole message already looks like the contract (no fences), accept it.
    if "def init_state" in text and "def step" in text:
        return text.strip()
    return None


def extract_json(text: str) -> Any | None:
    """Extract the first balanced JSON object/array from ``text`` (or ``None``)."""

    if not text:
        return None
    # Prefer a fenced json block if present.
    fence = re.search(r"```(?:json)?\s*\n(.*?)```", text, re.DOTALL | re.IGNORECASE)
    candidates = []
    if fence:
        candidates.append(fence.group(1).strip())
    candidates.append(text.strip())
    # Also try the first {...} or [...] span.
    span = re.search(r"[\{\[].*[\}\]]", text, re.DOTALL)
    if span:
        candidates.append(span.group(0))
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except (ValueError, TypeError):
            continue
    return None


def extract_action_batch(text: str, valid_actions: list[Any]) -> list[Any]:
    """Parse a reactive action batch from an LLM message, filtered to ``valid_actions``.

    Accepts ``{"actions": [...]}`` or a bare JSON list. Unknown actions are dropped; an empty or
    unparseable response yields ``[]`` (the caller then falls back to a no-op probe).
    """

    data = extract_json(text)
    raw: list[Any]
    if isinstance(data, dict) and isinstance(data.get("actions"), list):
        raw = data["actions"]
    elif isinstance(data, list):
        raw = data
    else:
        return []
    valid = set(str(a) for a in valid_actions) if valid_actions else None
    out: list[Any] = []
    for item in raw:
        name = item.get("action") if isinstance(item, dict) else item
        name = str(name).strip()
        if not name:
            continue
        if valid is not None and name not in valid:
            continue
        out.append(name)
    return out


# --------------------------------------------------------------------------------------------------
# Agent
# --------------------------------------------------------------------------------------------------


@dataclass
class RunSummary:
    """Returned by :meth:`EwmAgent.run` — a compact record of what the loop did."""

    won: bool = False
    turns: int = 0
    modes: list[str] = field(default_factory=list)
    decide_calls: int = 0
    reflect_calls: int = 0
    transitions: int = 0
    program_accepted: bool = False
    reactive_turns: int = 0
    kb_writes: int = 0
    stop_reason: str = "max_turns"

    def to_dict(self) -> dict[str, Any]:
        return {
            "won": self.won,
            "turns": self.turns,
            "modes": list(self.modes),
            "decide_calls": self.decide_calls,
            "reflect_calls": self.reflect_calls,
            "transitions": self.transitions,
            "program_accepted": self.program_accepted,
            "reactive_turns": self.reactive_turns,
            "kb_writes": self.kb_writes,
            "stop_reason": self.stop_reason,
        }


class EwmAgent:
    """The EWM decision loop over a callback ``env`` seam.

    ``env`` must expose:
        ``observe() -> {grid, level, step, valid_actions, score}``
        ``act(actions) -> result`` where result is the ``step_env_callback`` shape
            ``{current_frame, action_result, valid_actions?, remaining_seconds?, done?}``.

    ``llm`` is any object with ``chat(messages, max_tokens, temperature) -> {content, ...}``
    (:class:`~.llm_client.LlmClient` or :class:`~.llm_client.FakeLlm`). ``kb`` is an optional
    :class:`~.kb_protocol.WriteGate` (its ``.client`` is used for mode-scoped search). Vision is
    auto-disabled when ``vision_enabled`` is false OR Pillow is not importable.
    """

    def __init__(
        self,
        env: Any,
        llm: Any,
        kb: Any = None,
        vision_enabled: bool = True,
        config: AgentConfig | None = None,
    ) -> None:
        self.env = env
        self.llm = llm
        self.kb = kb
        self.config = config or AgentConfig()
        self.vision_enabled = bool(vision_enabled) and self._vision_available()

        self.suite = TransitionSuite()
        self.program: WorldModelProgram | None = None
        self.summary = RunSummary()
        self._failure_cycles = 0
        # Compact recap of the IMMEDIATE previous step only (never accumulated history). Empty until
        # the first action lands; refreshed after every action result. Fed into the decide prompt so
        # each call stays stateless [system, user] with at most one step of context.
        self._prev_step: dict[str, Any] | None = None
        self._prev_score: Any = None

    # -- vision ------------------------------------------------------------------------------------

    @staticmethod
    def _vision_available() -> bool:
        if _vision is None:
            return False
        try:  # Probe PIL exactly the way vision._require_pil does, without rendering.
            _vision._require_pil()
        except Exception:  # noqa: BLE001
            return False
        return True

    def _composite_url(self, frame_a: Any, frame_b: Any, label_a: str, label_b: str) -> str | None:
        """Best-effort composite data URL; returns ``None`` if vision is off or rendering fails."""

        if not self.vision_enabled or _vision is None:
            return None
        try:
            return _vision.composite_data_url(frame_a, frame_b, label_a=label_a, label_b=label_b)
        except Exception:  # noqa: BLE001 - a render failure must never crash the loop
            return None

    # -- message building ---------------------------------------------------------------------------

    def _content_with_image(self, text: str, image_url: str | None) -> Any:
        if image_url is None:
            return text
        return [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": image_url}},
        ]

    def _decide_messages(
        self,
        mode: str,
        frame: dict[str, Any],
        kb_hits: list[dict[str, Any]],
        report: ValidationReport | None,
        image_url: str | None,
    ) -> list[dict[str, Any]]:
        kb_block = ""
        if kb_hits:
            lines = []
            for hit in kb_hits[:5]:
                title = str(hit.get("title", "")).strip()
                if not title:
                    continue
                summary = str(hit.get("summary", "")).strip()
                summary = summary[:300]
                lines.append(f"- {title}: {summary}" if summary else f"- {title}")
            if lines:
                kb_block = "KB context:\n" + "\n".join(lines) + "\n"
        prev_step_block = ""
        prev = getattr(self, "_prev_step", None)
        if prev:
            prev_step_block = (
                "Previous step: "
                f"action={prev.get('action')} executed_count={prev.get('executed_count')} "
                f"stop_reason={prev.get('stop_reason')} board_changed={prev.get('board_changed')} "
                f"score_delta={prev.get('score_delta')}.\n"
            )
        program_block = ""
        if self.program is not None:
            program_block = "Current world-model program is loaded (revise it if it mispredicts).\n"
        report_block = ""
        if report is not None and not report.ok:
            report_block = (
                f"Validation FAILED at transition {report.fail_index} "
                f"(action={report.fail_action!r}); first mismatches (row,col,expected,got): "
                f"{report.mismatches[:8]}; error={report.error}. "
                "Fix the model so this transition passes.\n"
            )
        user_text = DECIDE_PROMPT.format(
            mode=mode,
            level=frame.get("level"),
            step=frame.get("step"),
            score=frame.get("score"),
            valid_actions=frame.get("valid_actions"),
            remaining_actions=frame.get("remaining_actions"),
            prev_step_block=prev_step_block,
            kb_block=kb_block,
            program_block=program_block,
            report_block=report_block,
        )
        return [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": self._content_with_image(user_text, image_url)},
        ]

    def _reflect_messages(
        self, result: dict[str, Any], image_url: str | None
    ) -> list[dict[str, Any]]:
        user_text = REFLECT_PROMPT.format(result=json.dumps(result, default=str))
        return [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": self._content_with_image(user_text, image_url)},
        ]

    # -- LLM wrappers -------------------------------------------------------------------------------

    def _decide(self, messages: list[dict[str, Any]], client: Any = None) -> str:
        self.summary.decide_calls += 1
        client = client or self.llm
        resp = client.chat(
            messages, max_tokens=self.config.decide_max_tokens, temperature=0.0
        )
        return str(resp.get("content", "")) if isinstance(resp, dict) else str(resp)

    def _synth_client(self) -> Any:
        """The model for SYNTHESIZE/REPAIR decide calls: ``config.synth_llm`` or the main llm."""

        return self.config.synth_llm or self.llm

    def _reflect(self, messages: list[dict[str, Any]]) -> str:
        self.summary.reflect_calls += 1
        resp = self.llm.chat(
            messages, max_tokens=self.config.reflect_max_tokens, temperature=0.0
        )
        return str(resp.get("content", "")) if isinstance(resp, dict) else str(resp)

    # -- KB ----------------------------------------------------------------------------------------

    def _kb_search(self, mode: str, **kw: Any) -> list[dict[str, Any]]:
        """Mode-scoped KB search; only fires when a KB WriteGate (with a client) was provided."""

        if self.kb is None or getattr(self.kb, "client", None) is None:
            return []
        from . import kb_protocol

        try:
            return kb_protocol.search_for_mode(
                mode, self.config.game_id, client=self.kb.client, **kw
            )
        except Exception:  # noqa: BLE001 - a KB miss must never crash the loop
            return []

    # -- environment adapters ----------------------------------------------------------------------

    @staticmethod
    def _frame_grid(frame: dict[str, Any]) -> list[list[int]]:
        return [list(row) for row in frame.get("grid", [])]

    def _act(self, actions: list[Any], expect: list[Any] | None = None) -> dict[str, Any]:
        """Apply an action batch through ``env.act`` and normalize the result.

        ``env.act`` accepts the batch (optionally with ``expect`` predicted grids for the REPL
        divergence-abort path) and returns the ``step_env_callback`` shape. We normalize it to
        ``{current_frame, action_result, done, valid_actions, ...}``.
        """

        try:
            result = self.env.act(actions, expect=expect)
        except TypeError:
            # env.act may not accept expect (plain env); retry without it.
            result = self.env.act(actions)
        return result if isinstance(result, dict) else {}

    # -- transition bookkeeping --------------------------------------------------------------------

    def _record_transition(
        self, before: dict[str, Any], action: Any, after_grid: list[list[int]]
    ) -> None:
        self.suite.append(self._frame_grid(before), action, [list(r) for r in after_grid])
        self.summary.transitions += 1

    # -- modes -------------------------------------------------------------------------------------

    def _orient(self, frame: dict[str, Any]) -> bool:
        """Look up a stored program and adopt it if it validates against the live suite/frame.

        Returns True if a stored program was adopted. If the suite is empty we cannot validate a
        stored program, so we defer adoption until we have at least one observed transition.
        """

        hits = self._kb_search("ORIENT")
        for hit in hits:
            source = self._program_source_from_hit(hit)
            if not source:
                continue
            try:
                candidate = WorldModelProgram.load(source)
            except SandboxError:
                continue
            if len(self.suite) == 0:
                # No transitions yet to validate against; adopt provisionally.
                self.program = candidate
                self.summary.program_accepted = True
                return True
            report = validate(candidate, self.suite)
            if report.ok:
                self.program = candidate
                self.summary.program_accepted = True
                return True
        return False

    @staticmethod
    def _program_source_from_hit(hit: dict[str, Any]) -> str | None:
        """Pull program source out of a KB hit body (``program source:`` marker or a fenced block)."""

        for key in ("summary", "body", "text", "content"):
            body = hit.get(key)
            if not isinstance(body, str):
                continue
            marker = "program source:"
            idx = body.lower().find(marker)
            if idx != -1:
                source = body[idx + len(marker):].strip()
                if source:
                    return source
            fenced = extract_python(body)
            if fenced:
                return fenced
        # A hit may carry source directly.
        source = hit.get("program_source") or hit.get("source")
        return source if isinstance(source, str) and source.strip() else None

    def _synthesize(self, frame: dict[str, Any], image_url: str | None) -> bool:
        """Ask the LLM for program source; accept only when it passes the FULL suite.

        A failing candidate feeds its ValidationReport back into the next attempt (repair-style),
        up to ``max_synth_attempts``. Returns True on acceptance.
        """

        kb_hits = self._kb_search(
            "SYNTHESIZE", vocabulary=self._vocabulary(frame)
        )
        report: ValidationReport | None = None
        for _ in range(self.config.max_synth_attempts):
            messages = self._decide_messages(
                "SYNTHESIZE", frame, kb_hits, report, image_url
            )
            text = self._decide(messages, self._synth_client())
            source = extract_python(text)
            if source is None:
                # Parse failure: retry once with the same context, then bail out of synthesis.
                text = self._decide(
                    self._decide_messages("SYNTHESIZE", frame, kb_hits, report, image_url),
                    self._synth_client(),
                )
                source = extract_python(text)
                if source is None:
                    break
            try:
                candidate = WorldModelProgram.load(source)
            except SandboxError as exc:
                report = ValidationReport(
                    ok=False, pass_count=0, total=len(self.suite), error=str(exc)
                )
                continue
            report = validate(candidate, self.suite) if len(self.suite) else ValidationReport(
                ok=True, pass_count=0, total=0
            )
            if report.ok:
                self.program = candidate
                self.summary.program_accepted = True
                self._maybe_write_program(frame, report)
                return True
        return False

    def _repair(self, frame: dict[str, Any], image_url: str | None) -> bool:
        """Patch the current program from the first-failure report and re-validate.

        Assumes the failing transition is already in the suite. Returns True if the patched program
        passes the full suite.
        """

        if self.program is None:
            return False
        report = validate(self.program, self.suite)
        if report.ok:
            return True
        kb_hits = self._kb_search(
            "REPAIR", divergence=self._divergence_text(report)
        )
        for _ in range(self.config.max_repair_attempts):
            messages = self._decide_messages("REPAIR", frame, kb_hits, report, image_url)
            text = self._decide(messages, self._synth_client())
            source = extract_python(text)
            if source is None:
                text = self._decide(
                    self._decide_messages("REPAIR", frame, kb_hits, report, image_url),
                    self._synth_client(),
                )
                source = extract_python(text)
                if source is None:
                    break
            try:
                candidate = WorldModelProgram.load(source)
            except SandboxError:
                continue
            report = validate(candidate, self.suite)
            if report.ok:
                self.program = candidate
                self._maybe_write_program(frame, report)
                return True
        return False

    def _plan(self, frame: dict[str, Any]) -> PlanResult | None:
        """Plan toward ``is_win`` with the current program. Zero LLM calls."""

        if self.program is None:
            return None
        program = self.program

        def goal(state: Any) -> bool:
            try:
                return bool(program.is_win(state))
            except Exception:  # noqa: BLE001
                return False

        try:
            return plan(
                program,
                self._frame_grid(frame),
                goal,
                max_depth=self.config.plan_max_depth,
                max_nodes=self.config.plan_max_nodes,
            )
        except Exception:  # noqa: BLE001 - a broken program must not crash the loop
            return None

    def _execute(
        self, plan_result: PlanResult, frame: dict[str, Any]
    ) -> tuple[dict[str, Any], bool]:
        """Run a plan through ``env.act`` with ``expect`` predicted grids (divergence-abort path).

        Records every executed transition into the suite. Returns ``(last_result, diverged)`` where
        ``diverged`` is True iff the environment deviated from the model (expect-mismatch) — the
        caller then routes to REPAIR. Zero LLM (decide) calls happen here.
        """

        result = self._act(list(plan_result.actions), expect=list(plan_result.predicted_grids))
        self._ingest_result(frame, plan_result.actions, result)
        stop_reason = self._stop_reason(result)
        diverged = stop_reason == "expect_mismatch"
        return result, diverged

    def _reactive_turn(
        self, frame: dict[str, Any], image_url: str | None
    ) -> dict[str, Any]:
        """Duck-style reactive play: the decide call returns a small action batch directly."""

        self.summary.reactive_turns += 1
        kb_hits = self._kb_search("RECOVER", vocabulary=self._vocabulary(frame))
        messages = self._decide_messages("RECOVER", frame, kb_hits, None, image_url)
        text = self._decide(messages)
        batch = extract_action_batch(text, frame.get("valid_actions") or [])
        if not batch:
            # Parse failure: retry once, then fall back to a no-op probe (first valid action).
            text = self._decide(messages)
            batch = extract_action_batch(text, frame.get("valid_actions") or [])
        if not batch:
            valid = frame.get("valid_actions") or []
            batch = [valid[0]] if valid else []
        batch = batch[: max(1, self.config.reactive_batch)]
        result = self._act(batch)
        self._ingest_result(frame, batch, result)
        return result

    # -- result ingestion --------------------------------------------------------------------------

    def _ingest_result(
        self, before: dict[str, Any], actions: list[Any], result: dict[str, Any]
    ) -> None:
        """Append the observed transition(s) to the suite and run the reflect LLM call.

        The action-path result may report ``executed`` actions and a final ``current_frame``. We
        record the whole batch as ONE observed transition (before -> after) keyed on the first
        executed action, matching the suite's grid-in/grid-out contract, then reflect on it.
        """

        after_frame = self._result_frame(result)
        after_grid = self._frame_grid(after_frame) if after_frame else self._frame_grid(before)
        executed = self._executed_actions(result, actions)
        action_key = executed[0] if executed else (actions[0] if actions else None)
        if action_key is not None:
            self._record_transition(before, action_key, after_grid)

        # Reflect: CURRENT|RESULT composite + structured action result.
        image_url = self._composite_url(
            self._frame_grid(before), after_grid, "CURRENT", "RESULT"
        )
        struct = self._result_struct(result)
        # Refresh the single-step recap for the NEXT decide call (exactly one step back).
        score = struct.get("score")
        score_delta = None
        if isinstance(score, (int, float)) and isinstance(self._prev_score, (int, float)):
            score_delta = score - self._prev_score
        self._prev_step = {
            "action": action_key,
            "executed_count": struct.get("executed_count"),
            "stop_reason": struct.get("stop_reason"),
            "board_changed": struct.get("board_changed"),
            "score_delta": score_delta,
        }
        if isinstance(score, (int, float)):
            self._prev_score = score
        try:
            reflect_text = self._reflect(self._reflect_messages(struct, image_url))
        except Exception:  # noqa: BLE001 - reflection is advisory; never crash the loop on it
            reflect_text = ""
        self._maybe_write_from_reflection(before, result, reflect_text)

    # -- KB writes (acceptance events) -------------------------------------------------------------

    def _maybe_write_program(self, frame: dict[str, Any], report: ValidationReport) -> None:
        if self.kb is None:
            return
        try:
            self.kb.begin_turn()
            out = self.kb.write_program_revision(
                self.config.game_id,
                f"world model revision at level {frame.get('level')}",
                self.program.source if self.program else "",
                f"{report.pass_count}/{report.total}",
            )
            if isinstance(out, dict) and out.get("ok"):
                self.summary.kb_writes += 1
        except Exception:  # noqa: BLE001
            pass

    def _maybe_write_from_reflection(
        self, before: dict[str, Any], result: dict[str, Any], reflect_text: str
    ) -> None:
        """On a win/level-transition acceptance event, write a level solution note (gated)."""

        if self.kb is None:
            return
        stop_reason = self._stop_reason(result)
        won = self._result_done(result) or stop_reason == "level_transition"
        if not won:
            return
        try:
            self.kb.begin_turn()
            insight = self._one_line(reflect_text) or "level cleared"
            out = self.kb.write_level_solution(
                self.config.game_id,
                before.get("level"),
                self._executed_actions(result, []),
                insight,
            )
            if isinstance(out, dict) and out.get("ok"):
                self.summary.kb_writes += 1
        except Exception:  # noqa: BLE001
            pass

    # -- result-shape helpers ----------------------------------------------------------------------

    @staticmethod
    def _result_frame(result: dict[str, Any]) -> dict[str, Any] | None:
        frame = result.get("current_frame")
        if isinstance(frame, dict):
            return frame
        # REPL-style action_result carries the final state under state/last frame; fall back.
        return None

    @staticmethod
    def _result_struct(result: dict[str, Any]) -> dict[str, Any]:
        """A compact, JSON-safe view of the action result for the reflect prompt (no raw grids)."""

        ar = result.get("action_result")
        ar = ar if isinstance(ar, dict) else {}
        return {
            "stop_reason": result.get("stop_reason") or ar.get("stop_reason"),
            "executed_count": result.get("executed_count") or ar.get("executed_count"),
            "board_changed": result.get("board_changed", ar.get("board_changed")),
            "level": result.get("level", ar.get("level")),
            "done": EwmAgent._result_done(result),
            "score": (ar.get("last_action_result") or {}).get("score")
            if isinstance(ar.get("last_action_result"), dict)
            else result.get("score"),
        }

    @staticmethod
    def _stop_reason(result: dict[str, Any]) -> str | None:
        if "stop_reason" in result:
            return result.get("stop_reason")
        ar = result.get("action_result")
        if isinstance(ar, dict):
            return ar.get("stop_reason")
        return None

    @staticmethod
    def _result_done(result: dict[str, Any]) -> bool:
        if bool(result.get("done")):
            return True
        ar = result.get("action_result")
        if isinstance(ar, dict) and bool(ar.get("done")):
            return True
        inner = ar.get("last_action_result") if isinstance(ar, dict) else None
        if isinstance(inner, dict) and bool(inner.get("done")):
            return True
        return False

    @staticmethod
    def _executed_actions(result: dict[str, Any], fallback: list[Any]) -> list[Any]:
        executed = result.get("executed")
        if isinstance(executed, list):
            names = [
                e.get("action") if isinstance(e, dict) else e for e in executed
            ]
            return [n for n in names if n is not None]
        ar = result.get("action_result")
        if isinstance(ar, dict) and isinstance(ar.get("executed"), list):
            names = [
                e.get("action") if isinstance(e, dict) else e for e in ar["executed"]
            ]
            return [n for n in names if n is not None]
        return list(fallback)

    def _vocabulary(self, frame: dict[str, Any]) -> list[str]:
        """Cheap segmentation-vocabulary proxy: the distinct cell values present in the frame."""

        seen: list[str] = []
        for row in frame.get("grid", []):
            for value in row:
                token = f"color{value}"
                if token not in seen:
                    seen.append(token)
        return seen

    @staticmethod
    def _divergence_text(report: ValidationReport) -> str:
        return (
            f"transition {report.fail_index} action {report.fail_action} mispredicted; "
            f"{len(report.mismatches)} cells wrong"
        )

    @staticmethod
    def _one_line(text: str) -> str:
        data = extract_json(text)
        if isinstance(data, dict) and data.get("note"):
            return str(data["note"]).strip()
        return (text or "").strip().splitlines()[0] if (text or "").strip() else ""

    # -- main loop ---------------------------------------------------------------------------------

    def _observe(self) -> dict[str, Any]:
        frame = self.env.observe()
        return frame if isinstance(frame, dict) else {}

    def run(self) -> dict[str, Any]:
        """Play until win, budget exhaustion, or ``max_turns``. Returns a run-summary dict."""

        prev_frame: dict[str, Any] | None = None

        for turn in range(self.config.max_turns):
            self.summary.turns = turn + 1
            frame = self._observe()

            if frame.get("done") or self._out_of_budget(frame):
                self.summary.stop_reason = "budget" if self._out_of_budget(frame) else "done"
                break

            decide_image = self._composite_url(
                self._frame_grid(prev_frame) if prev_frame else self._frame_grid(frame),
                self._frame_grid(frame),
                "BEFORE",
                "CURRENT",
            )

            mode = self._select_mode()
            self.summary.modes.append(mode)

            if mode == "RECOVER":
                result = self._reactive_turn(frame, decide_image)
                if self._result_done(result):
                    self.summary.won = True
                    self.summary.stop_reason = "won"
                    break
                prev_frame = frame
                continue

            # Model-based path: ORIENT -> SYNTHESIZE -> PLAN -> EXECUTE (-> REPAIR on divergence).
            if self.program is None:
                if not self._orient(frame):
                    if not self._synthesize(frame, decide_image):
                        self._failure_cycles += 1
                        prev_frame = frame
                        continue
                    self._failure_cycles = 0

            plan_result = self._plan(frame)
            if plan_result is None or not plan_result.actions:
                # No plan (e.g. already-at-goal empty plan or unreachable): reactive probe.
                result = self._reactive_turn(frame, decide_image)
                if self._result_done(result):
                    self.summary.won = True
                    self.summary.stop_reason = "won"
                    break
                prev_frame = frame
                continue

            result, diverged = self._execute(plan_result, frame)
            if self._result_done(result):
                self.summary.won = True
                self.summary.stop_reason = "won"
                break

            if diverged:
                # The environment deviated from the model: REPAIR on the failing transition.
                if not self._repair(frame, decide_image):
                    self._failure_cycles += 1
                else:
                    self._failure_cycles = 0

            prev_frame = frame

        self.summary.transitions = len(self.suite)
        return self.summary.to_dict()

    def _select_mode(self) -> str:
        """Pick the mode for this turn. Flips to RECOVER after K failed synth/repair cycles."""

        if self._failure_cycles >= self.config.reactive_after_failures:
            return "RECOVER"
        if self.program is None:
            return "SYNTHESIZE"
        return "EXECUTE"

    def _out_of_budget(self, frame: dict[str, Any]) -> bool:
        remaining_actions = frame.get("remaining_actions")
        remaining_seconds = frame.get("remaining_seconds")
        if isinstance(remaining_actions, (int, float)) and remaining_actions <= 0:
            return True
        if isinstance(remaining_seconds, (int, float)) and remaining_seconds <= 0:
            return True
        return False
