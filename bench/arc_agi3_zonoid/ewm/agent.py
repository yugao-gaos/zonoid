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
import os
import re
import sys
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable

from .planner import PlanResult, explore_frontier, plan
from .world_model import (
    ALLOWED_IMPORTS,
    MaskedProgram,
    SandboxError,
    TransitionSuite,
    ValidationReport,
    WorldModelProgram,
    _grid_shape,
    _is_unknown,
    masked_program,
    mismatch_mask,
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

# Terse re-ask when a SYNTHESIZE/REPAIR response contained NO fenced block at all (prose only).
SYNTH_RETRY_PROMPT = (
    "Return ONLY one fenced python block implementing the five-function contract "
    "(init_state, step, render, is_win, legal_actions). No prose, no explanation — just the "
    "```python code block."
)

# Hard contract paragraph appended to every SYNTHESIZE/REPAIR user prompt: the model must PARSE the
# real grid (never hardcode one) and render at the input's dimensions. This is the exact defect the
# ls20 candidates showed — they hand-read the IMAGE into a 5x7 grid while real frames are 64x64.
# The exact stdlib import whitelist the sandbox enforces (world_model.ALLOWED_IMPORTS). Derived
# from the loader's own frozenset so the prompt can NEVER advertise a module the sandbox rejects:
# ls20 candidates died on "import of 'numpy' is not permitted" because nothing told them what WAS
# available. numpy/pandas are third-party and never importable in the sandbox.
_STDLIB_WHITELIST_LINE = (
    "Only these stdlib modules may be imported: "
    + ", ".join(sorted(ALLOWED_IMPORTS))
    + ". numpy/pandas are NOT available."
)

SYNTH_GRID_CONTRACT = (
    "CONTRACT: init_state(grid) receives the grid DIRECTLY as a list of rows of ints (NOT a dict — "
    "do not index it with strings) and MUST parse it — never hardcode a grid. Each row of the grid "
    "is a list of ints. render(state) MUST return a grid with exactly the same dimensions as the "
    "input grid. "
    "step(state, action) MUST return a (state, events) tuple — never a bare state.\n"
    + _STDLIB_WHITELIST_LINE
    + "\n"
    "PARTIAL FIDELITY: the name UNKNOWN is already injected into your program's namespace (use the "
    "bare name UNKNOWN — do not import or define it). render(state) MAY place UNKNOWN in any cell "
    "the program cannot model; the validator SKIPS every UNKNOWN cell, so an unmodelable region "
    "never fails validation. If a board region changes after every action regardless of which "
    "action (e.g. an energy/timer/progress bar), either model it EXACTLY or mark those cells "
    "UNKNOWN — do NOT assume it stays constant.\n"
    "OBJECTS: segment(grid) is already injected into your namespace (bare name — do not import or "
    "define it). It returns {nodes, adjacency_list}; each node has color, pixels, boundary, and "
    "children. PREFER expressing mechanics relative to objects rather than absolute cell indices: "
    "e.g. locate the avatar by its color with segment(grid) each step and move it (dr, dc), instead "
    "of hardcoding a row/col — absolute indices break on new levels where the same object sits "
    "elsewhere. Purely cellular games (no discrete movable objects) may still use direct grid logic."
)

def build_synth_context(
    grid: list[list[int]],
    object_summary: str,
    transitions_text: str,
    auto_changing_text: str,
    *,
    object_cap: int = 20,
) -> str:
    """Assemble the full synthesis-contract appendix — the single source of truth shared by the
    single-shot SYNTHESIZE/REPAIR prompts and the graph-native :class:`~.synth_graph.SynthSession`
    EDIT prompts.

    Emits, in order: the raw grid rows (with dimensions), the object summary, the sampled observed
    transitions, the auto-changing-cells hint, and :data:`SYNTH_GRID_CONTRACT` (which carries the
    UNKNOWN teaching, the stdlib import whitelist, the step-tuple rule, and the segment() paragraph).
    Best-effort inputs: any empty section is omitted, but the contract is ALWAYS appended so no EDIT
    prompt can drop it (that omission is exactly why run 8's SynthSession candidates imported numpy).
    """

    height = len(grid)
    width = len(grid[0]) if height else 0
    parts = ["\n--- SYNTHESIS DATA (parse this; do not hardcode) ---"]
    parts.append(f"Current frame grid is {height} rows x {width} cols:")
    parts.append(EwmAgent._grid_rows_text(grid))
    if object_summary:
        parts.append(f"\nObject summary (segment_grid, up to {object_cap}):\n{object_summary}")
    if transitions_text:
        parts.append(f"\nObserved transitions (before/action/after):\n{transitions_text}")
    if auto_changing_text:
        parts.append("\n" + auto_changing_text)
    parts.append("\n" + SYNTH_GRID_CONTRACT)
    return "\n".join(parts) + "\n"


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
    # Hard per-game ceiling on SYNTHESIZE cycles. A cycle that gives up (max_synth_attempts
    # exhausted with no adoption) burns one; once this many cycles have failed, modelability is
    # judged poor and the loop stays reactive for the rest of the game. This bounds the failure
    # mode where synthesis loops back-to-back and eats the whole wall-clock budget with almost no
    # game actions (the ls20 run: 9 attempts, 4 game actions, modes_visited=[SYNTHESIZE]).
    max_synth_attempts_per_game: int = 9
    # Graph-native session pacing (config.graph_synthesis path). A SynthSession is a whole
    # ANALYZE->PLAN->EDIT-chain->FINAL cycle and can burn minutes; run 8 had ~11 games spend the
    # whole 1500s wall budget on sessions with only 5 game actions. Two independent brakes:
    #   - max_synth_sessions_per_game: hard ceiling on graph SynthSessions per game. Once hit,
    #     modelability is judged poor and the loop stays reactive for the rest of the game.
    #   - synth_session_wall_seconds: per-session wall cap handed to SynthConfig.max_session_seconds;
    #     a session checks elapsed time between LLM calls and stops cleanly when it is exceeded.
    max_synth_sessions_per_game: int = 3
    synth_session_wall_seconds: float = 240.0
    # Probe-first seeding: on a fresh game, execute a discriminating probe batch (one of each
    # distinct valid action) BEFORE SYNTHESIZE so a program is never adopted against an empty
    # suite. A program is only trusted once it predicts real observed transitions.
    min_probe_transitions: int = 4
    # Repair engagement + fallback floor: on divergence, REPAIR up to these caps; a program whose
    # live pass-rate (last N observed transitions vs its predictions) falls below the floor, or
    # which exhausts its repair budget, is dropped and the loop switches to reactive play.
    max_repairs_per_divergence: int = 2
    max_repairs_per_game: int = 6
    min_live_pass_rate: float = 0.5
    # Partial adoption (Run-9 fix): stop demanding a perfectly-passing program before the planner
    # gets ANY model. When synthesis produces no fully-passing program, the BEST candidate whose
    # full-suite pass_rate >= min_partial_adopt_rate is adopted with its persistently-wrong cells
    # masked UNKNOWN — provided that mask covers at most mask_cap of the board (else the "model" is
    # mostly holes and is refused). REPAIR keeps shrinking the mask as the underlying program
    # improves. Set min_partial_adopt_rate to 1.0 to disable partial adoption.
    min_partial_adopt_rate: float = 0.6
    mask_cap: float = 0.15
    live_window: int = 20   # N: observed transitions the live pass-rate is measured over
    plan_max_depth: int = 40
    plan_max_nodes: int = 20000
    # GOAL DISCOVERY (Run-16). When a program is adopted, live-trusted, and ``is_win`` never fires
    # (no banked level boundary — the Run-15 blocker), the loop plans FRONTIER EXPLORATION instead of
    # falling back to a blind reactive probe: BFS over the model's reachable-state graph for the
    # action prefix that visits the most NEW player cells (planner.explore_frontier), executed in long
    # budget-guarded batches. Every real transition is watched for a level/score boundary; the first
    # one captures the pre-boundary player position, writes a game-scoped goal note, and re-derives
    # ``is_win`` as a goal-contact predicate so subsequent planning can actually target the win.
    goal_discovery: bool = True
    # Live-confidence gate for GOAL DISCOVERY: the frontier explorer only engages once the live
    # pass-rate over a non-trivial window clears this floor (a trusted model is safe to drive on
    # long open-loop batches). Below it, the loop stays on the per-turn REPAIR/reactive path.
    goal_discovery_min_live_rate: float = 0.9
    goal_discovery_min_live_samples: int = 3
    frontier_max_depth: int = 24  # cap on the coverage-search action prefix length
    # MODEL-TRUSTED FAST PATH (Run-16). While the last ``fast_path_trust_window`` live single-step
    # predictions ALL pass, the model is trusted: the reflect LLM call is skipped (reflection becomes
    # log-only; the suite still appends every transition) and the planned batch is extended toward the
    # budget-guard cap so more ground is covered per decide. ANY expect-mismatch (or a scored live
    # miss) instantly restores full decide/reflect cadence and normal batch sizes.
    fast_path: bool = True
    fast_path_trust_window: int = 3   # consecutive passing live predictions before trusting
    fast_path_batch_cap: int = 16     # extended planned-batch length while trusted
    reactive_batch: int = 1       # actions per reactive probe when the LLM gives nothing usable
    decide_max_tokens: int = 1024
    # SYNTHESIZE/REPAIR decide calls author a whole world-model program (many functions + parsing);
    # 1024 truncated every ls20 candidate mid-docstring, so those calls get a larger budget. Gameplay
    # (RECOVER/ORIENT decide) stays at decide_max_tokens — it only emits a small action batch.
    synth_max_tokens: int = 4096
    reflect_max_tokens: int = 256
    game_id: str = "unknown"
    # Optional per-role model: SYNTHESIZE and REPAIR decide calls route here when set; every other
    # call (ORIENT/RECOVER decide, reflect) stays on the main llm. None -> falls back to the main llm.
    synth_llm: Any = None
    # Optional artifacts directory. None (default) = off: nothing is written. When set, the agent
    # writes per-attempt world-model synthesis/repair artifacts (the prompt, raw LLM response,
    # extracted program source, and validation report) plus an end-of-run transition-suite dump and
    # the final adopted program, so REJECTED candidates are inspectable instead of discarded.
    artifacts_dir: str | None = None
    # Graph-native multi-step synthesis: when True, SYNTHESIZE delegates to a synth_graph.SynthSession
    # (ANALYZE -> PLAN -> EDIT chain -> FINAL) instead of the single-shot _synthesize completion. One
    # session == one synthesis cycle; adoption still requires the session's FINAL full-suite validate
    # to pass on a NON-EMPTY suite. Default False so tests/smoke keep the single-shot path.
    graph_synthesis: bool = False
    # Chunked program-note recall (FALLBACK path, default OFF). When True, ORIENT treats a stored
    # program-index note carrying `chunk count:` + `source length:` as a CHUNKED program: it fetches
    # each `game <id> program chunk n of N` note by exact title, reassembles the source in order, and
    # verifies the byte length before load/validate/adopt. This existed to work around the daemon's
    # note-body truncation (a >~1000-char program note is clipped on write, capped on full_content
    # read, and — worst — REWRITTEN to a stub by the long-note source-clusterer). It is left OFF by
    # default because retrieval of freshly-written chunk notes is unreliable under daemon indexing lag,
    # and the intended production fix is a native daemon endpoint that returns a note's FULL body
    # (reassembling any source-cluster chunks) in one call.
    # TODO(daemon): replace this whole chunked-note fallback with the native reassembling note-read
    #   endpoint (`GET /note/get?key=...` returning the full untruncated body). Once that lands, ORIENT
    #   reads the single program note directly and this flag + the chunk writer/reassembler can be
    #   retired. See kb_protocol.write_program_revision_chunked / reassemble_chunks.
    chunked_program_notes: bool = False
    # Native full-body note read (PREFERRED path, default ON). When True, ORIENT resolves a stored
    # program by fetching the index-note's FULL body from the daemon's native `GET /note/get?key=...`
    # endpoint (kb_protocol.KbClient.get_note_full), which reassembles any source-cluster chunks
    # server-side in one call, then extracts the fenced program source from that body. This is the
    # production fix the chunked_program_notes TODO pointed at: it supersedes the harness-side
    # chunk-fetch-by-title reassembly. On any miss (no key, endpoint absent/errored, empty body, no
    # fenced source) ORIENT falls back to the flagged chunk scheme, then to the legacy inline body —
    # so a daemon without /note/get degrades cleanly instead of losing warm-start entirely.
    native_note_get: bool = True


# --------------------------------------------------------------------------------------------------
# Defensive parsing of LLM output
# --------------------------------------------------------------------------------------------------

# Opening fence: ```python (or bare ```), optionally with trailing junk on that line, then a
# newline. The block body runs to the NEXT closing ``` OR to end-of-text (a truncated response
# whose closing fence never arrived). Capturing to end-of-text is deliberate: the ls20 failures
# were all truncations (decide_max_tokens too small) where the old "must have a closing fence"
# regex matched NOTHING, so the loop fell through to a prose-substring fallback and handed the raw
# ```python line (or plain prose) to the compiler as source. See _extract_fenced_blocks.
_FENCE_OPEN_RE = re.compile(r"```[ \t]*(?:python|py)?[^\n]*\n", re.IGNORECASE)


def _extract_fenced_blocks(text: str) -> list[str]:
    """Return the body of every ```python (or bare ```) fenced block, fence lines stripped.

    A block runs from just after its opening fence line to the next ``` (closing fence) or, if the
    response was truncated before a closing fence, to end-of-text. Empty bodies are dropped.
    """

    blocks: list[str] = []
    pos = 0
    while True:
        open_m = _FENCE_OPEN_RE.search(text, pos)
        if not open_m:
            break
        body_start = open_m.end()
        close = text.find("```", body_start)
        if close == -1:
            body = text[body_start:]
            pos = len(text)
        else:
            body = text[body_start:close]
            pos = close + 3
        body = body.strip("\n").rstrip()
        if body.strip():
            blocks.append(body)
    return blocks


def _search_int(pattern: "re.Pattern[str]", text: str) -> int | None:
    """First integer captured by ``pattern`` in ``text`` (group 1), or ``None``. Used to read the
    ``chunk count:`` / ``source length:`` fields off a chunked ORIENT index-note body."""

    if not text:
        return None
    m = pattern.search(text)
    if not m:
        return None
    try:
        return int(m.group(1))
    except (ValueError, IndexError):
        return None


def _compiles(source: str) -> bool:
    try:
        compile(source, "<extract>", "exec")
        return True
    except SyntaxError:
        return False


def extract_python(text: str) -> str | None:
    """Extract program source from ``text``: the LAST compiling fenced block that defines the model.

    Collect every complete ```python fenced block (fence lines stripped), then select in priority
    order (models often emit reasoning + fragments + a final program, so the WHOLE-program block is
    the answer, not merely the last compiling fragment):

    1. The LAST compiling block that contains ``def init_state`` — the program's entry point, so a
       block defining it is the actual model rather than a helper/fragment block.
    2. If no single block both compiles AND contains ``def init_state``, try CONCATENATING
       consecutive fenced blocks (in emission order): a model may split one program across adjacent
       blocks. Prefer the LAST such concatenation that compiles and contains ``def init_state``.
    3. Fallback: the LAST block that compiles (accurate for a single-block program with no
       init_state marker, e.g. tests exercising the compile path).
    4. Last resort: the LAST block as-is, so ``validate`` reports the real compile error instead of
       a spurious "no program".

    If NO fenced block exists at all, return ``None`` — prose must NEVER become program source (the
    ls20 U+2014 failure). The caller treats ``None`` as a parse failure and retries once with a
    terse "one fenced block" prompt.
    """

    if not text:
        return None
    blocks = _extract_fenced_blocks(text)
    if not blocks:
        return None
    # 1. Last compiling block that defines the program entry point.
    for block in reversed(blocks):
        if "def init_state" in block and _compiles(block):
            return block
    # 2. No single block qualifies: try concatenating consecutive blocks (in order). Prefer the LAST
    #    contiguous run that, joined, compiles and contains init_state.
    for start in range(len(blocks)):
        for end in range(len(blocks), start + 1, -1):
            joined = "\n".join(blocks[start:end])
            if "def init_state" in joined and _compiles(joined):
                return joined
    # 3. Fallback: last compiling block (single-block program with no init_state marker).
    for block in reversed(blocks):
        if _compiles(block):
            return block
    # 4. Last resort: last block as-is, for accurate compile-error reporting.
    return blocks[-1]


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
    synthesis_attempts: int = 0
    repair_attempts: int = 0
    suite_size: int = 0
    live_pass_rate: float = 1.0
    stop_reason: str = "max_turns"
    # Partial adoption telemetry: True once the active program was adopted via the masked-candidate
    # path, and the count of cells currently masked UNKNOWN (shrinks as REPAIR improves the model).
    program_adopted_partial: bool = False
    mask_cells: int = 0
    # Changed-cells accuracy of the program at adoption time (the fraction of the cells the
    # transition actually MOVES that the model predicts right). This is the metric the partial
    # adoption floor is measured over — it makes the ~97%-static-background whole-board rate
    # non-vacuous. None until a program is adopted.
    changed_cells_accuracy: float | None = None
    # Warm-start ORIENT telemetry. `orient_adopted` is True once a stored program was adopted (whole
    # or partial) straight from the KB. `orient_diagnosis` records the OUTCOME of the last ORIENT
    # attempt in a stable vocabulary the driver surfaces — so a run that failed to warm-start says WHY
    # (e.g. a missing/corrupt chunk, a length mismatch, a stored program that would not validate)
    # instead of silently falling through to SYNTHESIZE. None until ORIENT runs.
    orient_adopted: bool = False
    orient_diagnosis: str | None = None
    # Warm-start hypothesis-trust revalidation (Run-14). Records the OUTCOME of validating a recalled
    # KB program against the FRESH probe batch (live transitions seeded this game), through the same
    # changed-cells floor SYNTHESIZE uses — so a vacuously-"valid" UNKNOWN-heavy program (Run-13: the
    # recalled ls20 ceiling passed validate() only because every predicted cell was UNKNOWN and thus
    # skipped) is not trusted on the strength of a skip. `probes` = transitions revalidated against;
    # `pass_rate` = changed-cells accuracy over them (the non-vacuous metric); `adopted_as` is one of
    # "whole" / "partial" / "rejected". None until ORIENT resolves a program to revalidate.
    orient_revalidation: dict[str, Any] | None = None
    # GOAL DISCOVERY + FAST PATH telemetry (Run-16).
    # `coverage_pct` = fraction of the board's cells the player unit occupied across the run (the
    # frontier-exploration objective). `actions_per_minute` = throughput (env actions / wall minutes).
    # `llm_calls_per_action` = (decide + reflect) LLM calls per executed action (the fast path drives
    # this down by skipping reflect while the model is trusted). `frontier_batches` = frontier-explore
    # executions; `fast_path_batches` = trusted planned batches run; `reflect_skipped` = reflect calls
    # skipped by the fast path. `level_boundary_captured` = a real level/score boundary was observed
    # and captured; `goal_note_written` = a goal-evidence note was recorded; `is_win_rederived` = the
    # goal-contact predicate replaced the vacuous is_win.
    coverage_pct: float = 0.0
    actions_per_minute: float = 0.0
    llm_calls_per_action: float = 0.0
    frontier_batches: int = 0
    fast_path_batches: int = 0
    reflect_skipped: int = 0
    level_boundary_captured: bool = False
    goal_note_written: bool = False
    is_win_rederived: bool = False

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
            "synthesis_attempts": self.synthesis_attempts,
            "repair_attempts": self.repair_attempts,
            "suite_size": self.suite_size,
            "live_pass_rate": self.live_pass_rate,
            "stop_reason": self.stop_reason,
            "program_adopted_partial": self.program_adopted_partial,
            "mask_cells": self.mask_cells,
            "changed_cells_accuracy": self.changed_cells_accuracy,
            "orient_adopted": self.orient_adopted,
            "orient_diagnosis": self.orient_diagnosis,
            "orient_revalidation": self.orient_revalidation,
            "coverage_pct": self.coverage_pct,
            "actions_per_minute": self.actions_per_minute,
            "llm_calls_per_action": self.llm_calls_per_action,
            "frontier_batches": self.frontier_batches,
            "fast_path_batches": self.fast_path_batches,
            "reflect_skipped": self.reflect_skipped,
            "level_boundary_captured": self.level_boundary_captured,
            "goal_note_written": self.goal_note_written,
            "is_win_rederived": self.is_win_rederived,
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
        graph: Any = None,
    ) -> None:
        self.env = env
        self.llm = llm
        self.kb = kb
        self.config = config or AgentConfig()
        # Optional synth_graph.GraphClient for graph-native synthesis (config.graph_synthesis). None
        # -> the SynthSession runs offline (all graph ops no-op'd) but the state machine is identical.
        self.graph = graph
        self.vision_enabled = bool(vision_enabled) and self._vision_available()

        self.suite = TransitionSuite()
        self.program: WorldModelProgram | None = None
        self.summary = RunSummary()
        self._failure_cycles = 0
        # Count of SYNTHESIZE cycles that gave up this game (each == one full max_synth_attempts
        # burst with no adoption). Once it reaches config.max_synth_attempts_per_game the loop stays
        # reactive (modelability poor) for the rest of the game.
        self._synth_cycles_this_game = 0
        # Count of graph-native SynthSessions run this game (config.graph_synthesis path). Once it
        # reaches config.max_synth_sessions_per_game the loop judges modelability poor and stays
        # reactive for the rest of the game.
        self._synth_sessions_this_game = 0
        # Repair engagement + live pass-rate floor bookkeeping.
        self._repairs_this_game = 0
        self._repairs_this_divergence = 0
        # Partial-adoption divergence engagement (Run-10 fix): a masked program masks exactly the
        # cells its inner source gets wrong, so the ``expect``-grid check (which treats masked cells
        # as wildcards) would NEVER see a divergence in the modeled-wrong region and REPAIR would
        # never fire. Until the FIRST live repair on a partial adoption, EXECUTE feeds the UNWRAPPED
        # inner program's predictions as ``expect`` so the real board divergence trips
        # ``expect_mismatch`` and routes to REPAIR before any reactive fallback. Cleared on adopt.
        self._partial_repaired = False
        self._probed = False           # probe batch runs at most once (fresh-game seeding)
        self._modelability_poor = False  # once set, the loop stays reactive (never re-plans a program)
        # The `note:` key of the KB program ORIENT adopted this game (None when the active program was
        # synthesized, not recalled). Threaded into `write_program_revision(supersedes=...)` so an
        # accepted live REPAIR of a recalled program COMPOUNDS: the improved program supersedes the
        # note it came from (Run-14 Req 3) instead of piling up a parallel note. Cleared on drop.
        self._orient_note_key: str | None = None
        # Rolling window of the last `live_window` observed transitions vs the ACTIVE program's
        # predictions (True == the program predicted the real transition). Empty when no program.
        self._live_results: deque[bool] = deque(maxlen=max(1, self.config.live_window))
        # Compact recap of the IMMEDIATE previous step only (never accumulated history). Empty until
        # the first action lands; refreshed after every action result. Fed into the decide prompt so
        # each call stays stateless [system, user] with at most one step of context.
        self._prev_step: dict[str, Any] | None = None
        self._prev_score: Any = None
        # Per-attempt artifact counter (zero-padded in the filename). Only used when
        # config.artifacts_dir is set; every SYNTHESIZE/REPAIR candidate — adopted or rejected —
        # increments it so rejected programs are inspectable rather than discarded.
        self._artifact_counter = 0
        # Run-16 GOAL DISCOVERY + FAST PATH state.
        # Wall-clock start (set at run()), used for actions_per_minute.
        self._run_start = time.monotonic()
        # Distinct player-occupied cells seen across the run (coverage objective). Keyed by
        # (level, r, c) so re-visiting the same cell on a new level still counts as new ground.
        self._coverage_cells: set[tuple[Any, int, int]] = set()
        # Board cell count captured at the first observation (denominator for coverage_pct).
        self._board_cell_count = 0
        # A goal-contact predicate re-derived from a captured level boundary; when set it OVERRIDES
        # the program's vacuous is_win for planning (see :meth:`_plan`). None until a boundary fires.
        self._goal_predicate: Callable[[Any], bool] | None = None
        # Player positions that immediately preceded an observed level/score boundary (goal contact).
        self._goal_positions: set[tuple[int, int]] = set()
        # Fast-path trust flag: True while the last window of live predictions all passed. Toggling it
        # off restores full decide/reflect cadence + normal batch sizes on the very next turn.
        self._model_trusted = False
        # Level/score seen on the previous turn, to detect a boundary crossing during exploration.
        self._prev_level: Any = None
        self._prev_boundary_score: Any = None
        self._artifacts_ready = False  # lazily mkdir the artifacts dir on first write
        # Graph-native synthesis telemetry (config.graph_synthesis): accumulated across all
        # SynthSession cycles this run so the driver can report truthful per-change stats — changes
        # proposed/passed/skipped and the FINAL full-suite pass rate observed each cycle.
        self._graph_synth_stats: dict[str, Any] = {
            "sessions": 0,
            "changes_proposed": 0,
            "changes_passed": 0,
            "changes_skipped": 0,
            "final_pass_rates": [],  # one (pass_count, total) per FINAL, in cycle order
        }

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
        # Synthesis-only grid dump: SYNTHESIZE/REPAIR are one-shot code tasks that MUST parse the
        # real grid, so they get the actual frame grid, a segmentation object summary, sample
        # transitions, and the dimension contract. The gameplay (decide) prompt is left unchanged —
        # the dump goes ONLY to synthesis calls (flat-context policy: no rolling grids in play).
        if mode in ("SYNTHESIZE", "REPAIR"):
            user_text = user_text + self._synthesis_grid_block(frame)
        return [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": self._content_with_image(user_text, image_url)},
        ]

    # -- synthesis grid dump (SYNTHESIZE/REPAIR only) ----------------------------------------------

    _SYNTH_GRID_CELL_CAP = 4096   # dump raw rows up to this many cells (qwen-coding has 64k ctx)
    _SYNTH_OBJECT_CAP = 20        # cap the segmentation object summary at this many objects
    _SYNTH_TRANSITION_CAP = 3     # sample this many suite transitions as before/action/after
    # Auto-changing-cells hint: only compute once the suite has this many observed transitions (a
    # smaller sample would flag cells that merely coincided). Explicit cells are listed up to the cap;
    # a wider changing region is summarized by bounding boxes only.
    _AUTO_CHANGING_MIN_TRANSITIONS = 3
    _AUTO_CHANGING_CELL_CAP = 200

    @staticmethod
    def _grid_rows_text(grid: list[list[int]]) -> str:
        """Render a grid as digit row-strings, one row per line (single-digit cells packed, else
        space-joined so ints >9 stay readable)."""

        lines = []
        for row in grid:
            if all(0 <= int(v) <= 9 for v in row):
                lines.append("".join(str(int(v)) for v in row))
            else:
                lines.append(" ".join(str(int(v)) for v in row))
        return "\n".join(lines)

    def _object_summary_text(self, grid: list[list[int]]) -> str:
        """Per-object summary from segment_grid: color, pixels, bbox, id (capped)."""

        try:
            from . import segmentation

            seg = segmentation.segment_grid(grid)
        except Exception:  # noqa: BLE001 - segmentation must never crash prompt building
            return ""
        nodes = seg.get("nodes") or []
        lines = []
        for node in nodes[: self._SYNTH_OBJECT_CAP]:
            boundary = node.get("boundary") or []
            if boundary:
                rows = [p[0] for p in boundary]
                cols = [p[1] for p in boundary]
                bbox = [min(rows), min(cols), max(rows), max(cols)]
            else:
                bbox = None
            lines.append(
                f"- id={node.get('id')} color={node.get('color')} "
                f"pixels={node.get('pixels')} bbox={bbox}"
            )
        return "\n".join(lines)

    def _sample_transitions_text(self) -> str:
        """2-3 suite transitions rendered as before/action/after row-strings."""

        if len(self.suite) == 0:
            return ""
        transitions = list(self.suite)[-self._SYNTH_TRANSITION_CAP :]
        blocks = []
        for i, t in enumerate(transitions):
            blocks.append(
                f"transition {i} action={t.action!r}\n"
                f"before:\n{self._grid_rows_text(t.before_grid)}\n"
                f"after:\n{self._grid_rows_text(t.after_grid)}"
            )
        return "\n\n".join(blocks)

    def _auto_changing_cells(self) -> set[tuple[int, int]]:
        """The set of (row, col) cells whose value differs between before and after in EVERY observed
        transition — an every-action-changing region (e.g. an energy/timer/progress bar) the model
        cannot spot in a raw transition dump. Empty until the suite holds
        ``_AUTO_CHANGING_MIN_TRANSITIONS`` transitions; a cell that changes in only SOME transitions
        is excluded (set intersection)."""

        transitions = list(self.suite)
        if len(transitions) < self._AUTO_CHANGING_MIN_TRANSITIONS:
            return set()
        common: set[tuple[int, int]] | None = None
        for t in transitions:
            changed: set[tuple[int, int]] = set()
            for r, (before_row, after_row) in enumerate(zip(t.before_grid, t.after_grid)):
                for c, (b, a) in enumerate(zip(before_row, after_row)):
                    if int(b) != int(a):
                        changed.add((r, c))
            common = changed if common is None else (common & changed)
            if not common:
                return set()
        return common or set()

    @staticmethod
    def _range_str(lo: int, hi: int, singular: str, plural: str) -> str:
        """"row 40" when lo==hi else "rows 40-43"."""

        return f"{singular} {lo}" if lo == hi else f"{plural} {lo}-{hi}"

    def _changing_boxes(self, cells: set[tuple[int, int]]) -> list[tuple[int, int, int, int]]:
        """Group contiguous (4-connected) changing cells into connected components and return each
        component's bounding box (r0, c0, r1, c1)."""

        remaining = set(cells)
        boxes: list[tuple[int, int, int, int]] = []
        while remaining:
            seed = next(iter(remaining))
            stack = [seed]
            remaining.discard(seed)
            comp = [seed]
            while stack:
                r, c = stack.pop()
                for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                    nb = (r + dr, c + dc)
                    if nb in remaining:
                        remaining.discard(nb)
                        stack.append(nb)
                        comp.append(nb)
            rows = [p[0] for p in comp]
            cols = [p[1] for p in comp]
            boxes.append((min(rows), min(cols), max(rows), max(cols)))
        return sorted(boxes)

    def _auto_changing_cells_text(self) -> str:
        """The SYNTHESIZE/REPAIR hint naming the every-action-changing region as bounding-box row/col
        ranges. Empty string when there is nothing to report (suite too small or no common cell)."""

        cells = self._auto_changing_cells()
        if not cells:
            return ""
        boxes = self._changing_boxes(cells)
        ranges = "; ".join(
            f"{self._range_str(r0, r1, 'row', 'rows')} {self._range_str(c0, c1, 'col', 'cols')}"
            for (r0, c0, r1, c1) in boxes
        )
        if len(cells) > self._AUTO_CHANGING_CELL_CAP:
            ranges = f"{ranges} ({len(cells)} cells across {len(boxes)} boxes)"
        return (
            "OBSERVED AUTO-CHANGING CELLS (changed in every observed transition regardless of "
            f"action): {ranges}. Model these exactly or render them UNKNOWN; do NOT model them as "
            "static."
        )

    def _synthesis_grid_block(self, frame: dict[str, Any]) -> str:
        """Build the SYNTHESIZE/REPAIR-only appendix: grid rows, object summary, sample transitions,
        and the hard dimension contract. Best-effort — a build failure degrades to just the contract
        rather than crashing prompt construction.

        This is the single source of truth for the synthesis contract: single-shot SYNTHESIZE/REPAIR
        prompts append it here, and graph-native synthesis passes the SAME string into each
        :class:`~.synth_graph.SynthSession` EDIT prompt (see :meth:`_synthesize_graph`), so both paths
        teach the model the identical grid/UNKNOWN/stdlib/segment contract."""

        grid = self._frame_grid(frame)
        return build_synth_context(
            grid,
            self._object_summary_text(grid),
            self._sample_transitions_text(),
            self._auto_changing_cells_text(),
            object_cap=self._SYNTH_OBJECT_CAP,
        )

    def _reflect_messages(
        self, result: dict[str, Any], image_url: str | None
    ) -> list[dict[str, Any]]:
        user_text = REFLECT_PROMPT.format(result=json.dumps(result, default=str))
        return [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": self._content_with_image(user_text, image_url)},
        ]

    def _synth_retry_messages(
        self, frame: dict[str, Any], image_url: str | None
    ) -> list[dict[str, Any]]:
        """Terse re-ask after a prose-only (no fenced block) synthesis/repair response. Keeps the
        synthesis grid dump + contract so the retry still has the data it must parse."""

        user_text = SYNTH_RETRY_PROMPT + "\n" + self._synthesis_grid_block(frame)
        return [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": self._content_with_image(user_text, image_url)},
        ]

    # -- LLM wrappers -------------------------------------------------------------------------------

    def _decide(
        self, messages: list[dict[str, Any]], client: Any = None, max_tokens: int | None = None
    ) -> str:
        self.summary.decide_calls += 1
        client = client or self.llm
        resp = client.chat(
            messages,
            max_tokens=self.config.decide_max_tokens if max_tokens is None else max_tokens,
            temperature=0.0,
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

    # -- artifacts ---------------------------------------------------------------------------------
    # Best-effort persistence of per-attempt world-model candidates so rejected programs (and why
    # they were rejected) are inspectable. Every write is wrapped: a failure only logs to stderr and
    # NEVER crashes the loop.

    @staticmethod
    def _prompt_text(messages: list[dict[str, Any]]) -> str:
        """Pull the plain user text out of a built decide-messages list (image parts dropped)."""

        if not messages:
            return ""
        content = messages[-1].get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    return str(part.get("text", ""))
        return ""

    @staticmethod
    def _validation_report_dict(report: ValidationReport | None) -> dict[str, Any] | None:
        """Compact, JSON-safe validation report for an artifact (mismatches capped to 20)."""

        if report is None:
            return None
        return {
            "ok": report.ok,
            "fail_index": report.fail_index,
            "fail_action": report.fail_action,
            "error": report.error,
            "mismatches": [list(m) for m in report.mismatches[:20]],
            "pass_count": report.pass_count,
            "total": report.total,
            "pass_rate": report.pass_rate,
        }

    def _write_attempt_artifact(
        self,
        mode: str,
        frame: dict[str, Any],
        prompt_text: str,
        raw_llm_response: str,
        extracted_program_source: str | None,
        report: ValidationReport | None,
        adopted: bool,
    ) -> None:
        """Write one ``NN-{mode}.json`` per synthesis/repair attempt (best-effort)."""

        if not self.config.artifacts_dir:
            return
        self._artifact_counter += 1
        try:
            if not self._artifacts_ready:
                os.makedirs(self.config.artifacts_dir, exist_ok=True)
                self._artifacts_ready = True
            payload = {
                "mode": mode,
                "timestamp_step": frame.get("step"),
                "prompt_text": prompt_text,
                "raw_llm_response": raw_llm_response,
                "extracted_program_source": extracted_program_source,
                "validation_report": self._validation_report_dict(report),
                "adopted": bool(adopted),
            }
            name = f"{self._artifact_counter:02d}-{mode}.json"
            path = os.path.join(self.config.artifacts_dir, name)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=2, default=str)
        except Exception as exc:  # noqa: BLE001 - artifact persistence must never crash the loop
            print(f"[ewm] artifact write failed ({mode}): {exc!r}", file=sys.stderr)

    def _write_run_artifacts(self) -> None:
        """At run end: dump the transition suite and, if adopted, the final program (best-effort)."""

        if not self.config.artifacts_dir:
            return
        try:
            os.makedirs(self.config.artifacts_dir, exist_ok=True)
            suite_path = os.path.join(self.config.artifacts_dir, "transition-suite.json")
            with open(suite_path, "w", encoding="utf-8") as fh:
                fh.write(self.suite.to_json(indent=2))
        except Exception as exc:  # noqa: BLE001
            print(f"[ewm] transition-suite dump failed: {exc!r}", file=sys.stderr)
        if self.program is not None:
            try:
                prog_path = os.path.join(self.config.artifacts_dir, "final-program.py")
                with open(prog_path, "w", encoding="utf-8") as fh:
                    fh.write(getattr(self.program, "source", "") or "")
            except Exception as exc:  # noqa: BLE001
                print(f"[ewm] final-program dump failed: {exc!r}", file=sys.stderr)

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
        self,
        before: dict[str, Any],
        action: Any,
        after_grid: list[list[int]],
        *,
        single_step: bool = True,
    ) -> None:
        before_grid = self._frame_grid(before)
        after = [list(r) for r in after_grid]
        # Live pass-rate: score this real transition against the ACTIVE program BEFORE appending it
        # (so a program with a near-zero live rate can be detected and dropped rather than kept).
        # Only SINGLE-action transitions have a well-defined one-step model prediction; a multi-action
        # batch recorded as one grid-in/grid-out transition would spuriously "mispredict" even a
        # correct model, so those are excluded from the live window.
        if self.program is not None and single_step:
            self._live_results.append(self._predicts_transition(before_grid, action, after))
        self.suite.append(before_grid, action, after)
        self.summary.transitions += 1
        self._refresh_model_trust()

    def _refresh_model_trust(self) -> None:
        """Update the fast-path trust flag: trusted iff the last ``fast_path_trust_window`` live
        single-step predictions ALL passed. Any miss (a False in the tail window, or too few samples)
        drops trust immediately, restoring full decide/reflect cadence + normal batch sizes."""

        if not self.config.fast_path or self.program is None:
            self._model_trusted = False
            return
        window = max(1, self.config.fast_path_trust_window)
        recent = list(self._live_results)[-window:]
        self._model_trusted = len(recent) >= window and all(recent)

    # -- program lifecycle -------------------------------------------------------------------------

    def _adopt_program(self, candidate: WorldModelProgram) -> None:
        """Adopt ``candidate`` as the active world model and reset its live-tracking window."""

        self.program = candidate
        self.summary.program_accepted = True
        self._live_results.clear()
        # A fresh adoption has no live evidence yet: distrust until the window re-fills.
        self._model_trusted = False
        # A fully-passing adoption is NOT partial: clear any prior partial-adoption telemetry.
        self.summary.program_adopted_partial = False
        self.summary.mask_cells = 0
        # A fresh adoption has not been live-repaired yet: EXECUTE feeds inner predictions as
        # ``expect`` on the first divergence (only meaningful while the program stays masked).
        self._partial_repaired = False

    def _board_cells(self, frame: dict[str, Any]) -> int:
        """Cell count of the current board (rows*cols), used for the mask-cap fraction. Falls back
        to the first observed transition's grid when the frame has no grid."""

        grid = self._frame_grid(frame)
        if not grid and len(self.suite) > 0:
            grid = [list(row) for row in self.suite[0].before_grid]
        return sum(len(row) for row in grid)

    @staticmethod
    def _changed_cells(before: list[list[int]], after: list[list[int]]) -> set[tuple[int, int]]:
        """Cells that DIFFER between ``before`` and ``after`` (the cells the transition actually
        moves). On a shape mismatch every after-cell counts as changed — there is no aligned
        before-cell to compare against."""

        if _grid_shape(before) != _grid_shape(after):
            return {(r, c) for r, row in enumerate(after) for c in range(len(row))}
        changed: set[tuple[int, int]] = set()
        for r, (brow, arow) in enumerate(zip(before, after)):
            for c, (b, a) in enumerate(zip(brow, arow)):
                if b != a:
                    changed.add((r, c))
        return changed

    def _cell_pass_rate(self, program: Any) -> float:
        """Prediction accuracy of ``program`` over the CHANGED cells of the suite.

        The partial-adoption floor is measured over CHANGED cells only — per transition, the cells
        where the before-grid and after-grid differ — NOT the whole board. A 64x64 board is ~97%
        static background, so whole-board cell accuracy is vacuous: a program that copies the
        background unchanged but mispredicts the moving region (Run-10: right structure, +/-1 moves
        where truth is +/-5) still scored ~0.99 whole-board and cleared the 0.6 floor, admitting a
        model that got 0/5 transitions. Scoring only the cells that actually move makes the floor
        bite: such a model scores near 0 on the changed cells and is refused.

        A candidate wrong on the SAME small region in every transition (Run-9 #13) still scores
        high, because most changed cells (the correctly-moved object) match — so the changed-cells
        floor keeps the partial-adoption behaviour it was built for while closing the vacuous-metric
        hole. A changed cell the program renders UNKNOWN is a decline-to-predict (an already-masked
        cell) and is excluded — it is not evidence of accuracy. A crashing or shape-mismatched
        transition contributes its changed cells as all-wrong (it predicted nothing usable)."""

        correct = 0
        total = 0
        for transition in self.suite:
            after = transition.after_grid
            before = transition.before_grid
            changed = self._changed_cells(before, after)
            if not changed:
                continue
            try:
                state = program.init_state(before)
                next_state, _events = program.step(state, transition.action)
                got = program.render(next_state)
            except Exception:  # noqa: BLE001 - a crash predicts nothing: every changed cell is wrong
                total += len(changed)
                continue
            if _grid_shape(after) != _grid_shape(got):
                total += len(changed)
                continue
            for (r, c) in changed:
                # A changed cell the model renders UNKNOWN is a decline-to-predict (already masked):
                # excluded from the accuracy, matching the mask semantics.
                if _is_unknown(got[r][c]):
                    continue
                total += 1
                if not _is_unknown(after[r][c]) and after[r][c] == got[r][c]:
                    correct += 1
        return correct / total if total else 0.0

    def _try_partial_adopt(self, frame: dict[str, Any], source: str) -> bool:
        """Partial adoption of a best-but-imperfect candidate (Run-9 fix).

        Adopt ``source`` — which passes only part of the suite — by masking its persistently-wrong
        cells UNKNOWN, iff ALL of:

        1. its CELL-level accuracy >= ``config.min_partial_adopt_rate`` (below the floor the
           candidate does not model enough real mechanics to trust). Cell accuracy — not a
           per-transition rate — is used because a candidate wrong on the same small region in
           EVERY transition still models the mechanics well (Run-9 #13) yet would score 0 on a
           transition-level rate;
        2. the mismatch mask covers at most ``config.mask_cap`` of the board (else it is mostly
           holes, not a model);
        3. the MASKED program then passes the full suite (masking the mismatch cells must actually
           resolve every failure — a crash or shape mismatch cannot be masked away).

        On success the active program is a :class:`~.world_model.MaskedProgram` wrapping the compiled
        source; REPAIR later works against the UNWRAPPED source and recomputes (shrinks) the mask.
        Returns True on partial adoption.
        """

        if len(self.suite) == 0:
            return False
        try:
            inner = WorldModelProgram.load(source)
        except SandboxError:
            return False
        changed_acc = self._cell_pass_rate(inner)
        if changed_acc < self.config.min_partial_adopt_rate:
            return False
        mask = mismatch_mask(inner, self.suite)
        if not mask:
            # Nothing to mask: the program already passes — adopt it whole, not partially.
            self._adopt_program(inner)
            self.summary.changed_cells_accuracy = changed_acc
            return True
        board = self._board_cells(frame)
        if board <= 0 or (len(mask) / board) > self.config.mask_cap:
            return False
        wrapped = masked_program(inner, mask)
        masked_report = validate(wrapped, self.suite)
        if not (masked_report.ok and masked_report.total > 0):
            return False
        self._adopt_program(wrapped)
        self.summary.program_adopted_partial = True
        self.summary.mask_cells = len(mask)
        # Telemetry: the changed-cells accuracy that cleared the floor at adoption time.
        self.summary.changed_cells_accuracy = changed_acc
        return True

    def _drop_program(self, reason: str) -> None:
        """Drop the active program and flip to reactive: modelability is poor, so never keep
        planning from a model with a near-zero live pass-rate (the vision-ls20 failure)."""

        self.program = None
        self._modelability_poor = True
        self._live_results.clear()
        self._repairs_this_divergence = 0
        self._orient_note_key = None
        # A dropped program cannot be trusted or plan toward a re-derived goal.
        self._model_trusted = False
        self._goal_predicate = None

    def _predicts_transition(
        self, before_grid: list[list[int]], action: Any, after_grid: list[list[int]]
    ) -> bool:
        """True iff the ACTIVE program predicts ``before --action--> after`` (one-transition replay)."""

        program = self.program
        if program is None:
            return False
        one = TransitionSuite()
        one.append(before_grid, action, after_grid)
        try:
            return validate(program, one).ok
        except Exception:  # noqa: BLE001 - a crashing program simply did not predict it
            return False

    def _live_pass_rate(self) -> float:
        """Pass-rate over the last ``live_window`` observed transitions vs the program (1.0 empty)."""

        if not self._live_results:
            return 1.0
        return sum(1 for ok in self._live_results if ok) / len(self._live_results)

    def _live_diverged(self) -> bool:
        """True iff the MOST RECENT observed single-step transition mispredicted the active program.

        The live window (:attr:`_live_results`) is appended one entry per scored single-step
        transition in :meth:`_record_transition` (True == the program predicted it). Its tail is the
        latest such transition, so a False tail means the last real board move diverged from the
        recalled model — the signal that routes an unplannable-but-adopted program (Run-13: ls20
        ``is_win`` hard-False, so no plan ever reaches the EXECUTE expect-mismatch) into REPAIR off
        the live evidence rather than a blind reactive probe. False when the window is empty (nothing
        scored yet) or no program is active."""

        if self.program is None or not self._live_results:
            return False
        return not self._live_results[-1]

    # -- probe-first seeding -----------------------------------------------------------------------

    def _probe_batch(self, frame: dict[str, Any]) -> None:
        """Seed the suite on a fresh game with one probe per distinct valid action.

        Runs at most once. Each distinct valid action is executed on its own so its real transition
        is recorded (one probe == one observed transition), giving SYNTHESIZE a non-empty,
        discriminating suite to validate against instead of an empty one. Budget-guarded: probing
        stops early when ``remaining_actions`` runs low so it never burns the whole action budget.
        """

        self._probed = True
        valid = frame.get("valid_actions") or []
        # Distinct actions, order-preserving.
        distinct: list[Any] = []
        for a in valid:
            if a not in distinct:
                distinct.append(a)
        for action in distinct:
            if len(self.suite) >= self.config.min_probe_transitions:
                break
            cur = self._observe()
            if cur.get("done") or self._out_of_budget(cur):
                break
            remaining = cur.get("remaining_actions")
            # Keep at least one action in reserve for real play after probing.
            if isinstance(remaining, (int, float)) and remaining <= 1:
                break
            self._act_and_ingest(cur, [action])

    def _act_and_ingest(self, before: dict[str, Any], batch: list[Any]) -> dict[str, Any]:
        """Apply a small batch (no ``expect``) and ingest the result (records + reflects)."""

        result = self._act(batch)
        self._ingest_result(before, batch, result)
        return result

    # -- modes -------------------------------------------------------------------------------------

    def _orient(self, frame: dict[str, Any]) -> bool:
        """Look up a stored program and adopt it only if it validates against a NON-EMPTY suite.

        Returns True if a stored program was adopted. A program is never adopted against an empty
        suite: with zero observed transitions there is nothing to validate against, so we defer
        adoption until the probe batch has seeded at least one real transition.
        """

        if len(self.suite) == 0:
            self.summary.orient_diagnosis = "empty suite"
            return False
        hits = self._kb_search("ORIENT")
        if not hits:
            self.summary.orient_diagnosis = "no stored program"
            return False
        diagnosis = "no stored program"
        for hit in hits:
            source, resolve_diag, path = self._resolve_orient_source(hit)
            if not source:
                # A chunk-resolution failure (missing/corrupt chunk, length mismatch) is a MORE
                # informative diagnosis than a plain "no source", so let it win over the default.
                if resolve_diag:
                    diagnosis = resolve_diag
                continue
            # `path` names which resolver served the source (native / chunks / inline) so
            # orient_diagnosis records HOW the warm-start program was recovered, not just that it was.
            path_tag = f" ({path})" if path else ""
            try:
                candidate = WorldModelProgram.load(source)
            except SandboxError:
                diagnosis = "stored program did not compile"
                continue
            report = validate(candidate, self.suite)
            # Hypothesis-trust gate (Run-14): validate() skips UNKNOWN cells, so a recalled program
            # that renders unmodelable regions UNKNOWN can pass report.ok VACUOUSLY — it asserted
            # nothing where it declined to predict. Run-13's recalled ls20 ceiling did exactly this:
            # it translated the object unconditionally (no wall/collision) but rendered everything it
            # could not model UNKNOWN, so on the fresh probe suite validate() returned ok and it was
            # adopted WHOLE and trusted — then diverged on 31 live transitions. Before trusting a whole
            # pass, re-measure the CHANGED-cells accuracy over the fresh probes (the same non-vacuous
            # metric partial adoption uses): the fraction of the cells transitions actually MOVE that
            # the program predicts right, with declined-to-predict UNKNOWN cells excluded. A program
            # that clears the partial-adopt floor there has earned whole adoption; one that does not is
            # routed through the partial path so its wrong cells are masked (or it is refused), never
            # trusted whole on the strength of a skip.
            changed_acc = self._cell_pass_rate(candidate)
            probes = len(self.suite)
            if report.ok and report.total > 0 and (
                changed_acc >= self.config.min_partial_adopt_rate
            ):
                self._adopt_program(candidate)
                # Remember the note this program was recalled from so an accepted live REPAIR
                # supersedes it (compounding) rather than forking a parallel note.
                self._orient_note_key = self._hit_key(hit)
                self.summary.orient_adopted = True
                self.summary.orient_diagnosis = f"adopted whole{path_tag}"
                self.summary.orient_revalidation = {
                    "probes": probes,
                    "pass_rate": round(changed_acc, 4),
                    "adopted_as": "whole",
                }
                return True
            # A stored program that passes only PART of the live suite (or passes it only vacuously)
            # is still worth adopting IFF it clears the changed-cells floor: the dev-time ls20 ceiling
            # is 12/13 (one auto-changing region it deliberately leaves unmodeled), so a full-pass-only
            # gate would discard the very warm-start program this pillar-5 path exists to recall. Use
            # the same changed-cells partial-adopt floor SYNTHESIZE uses: mask the persistently-wrong
            # cells UNKNOWN and adopt iff the masked program then passes and clears the floor + mask cap.
            if self._try_partial_adopt(frame, source):
                self._orient_note_key = self._hit_key(hit)
                self.summary.orient_adopted = True
                self.summary.orient_diagnosis = f"adopted partial{path_tag}"
                self.summary.orient_revalidation = {
                    "probes": probes,
                    "pass_rate": round(self.summary.changed_cells_accuracy or changed_acc, 4),
                    "adopted_as": "partial",
                }
                return True
            diagnosis = "stored program failed validation"
            # Record WHY a resolved-but-untrusted program was refused (vacuous whole pass below the
            # changed-cells floor, or a partial adoption that could not clear floor+mask cap), so the
            # run surfaces that ORIENT recalled a program but declined to trust it.
            self.summary.orient_revalidation = {
                "probes": probes,
                "pass_rate": round(changed_acc, 4),
                "adopted_as": "rejected",
            }
        self.summary.orient_diagnosis = diagnosis
        return False

    def _resolve_orient_source(
        self, hit: dict[str, Any]
    ) -> tuple[str | None, str | None, str | None]:
        """Resolve program source for an ORIENT hit.

        Returns ``(source, diagnosis, path)`` where ``path`` names the resolver that produced the
        source (``"native"`` / ``"chunks"`` / ``"inline"``) so ORIENT can record HOW the warm-start
        program was recovered. ``diagnosis`` is only meaningful when ``source`` is None; ``path`` is
        None on failure.

        Resolution order (best → fallback):

        1. NATIVE (preferred, config.native_note_get): fetch the index note's FULL body from the
           daemon's ``GET /note/get?key=...`` endpoint (server-side chunk reassembly) and extract the
           fenced program source. This supersedes the harness-side chunk fetch.
        2. CHUNKS (fallback, config.chunked_program_notes): a CHUNKED index note (body carries
           ``chunk count:`` + ``source length:``) drives a fetch of every ``game <id> world model
           program chunk n of N`` note by EXACT title, an ordered reassembly, and a byte-length check.
           A missing/corrupt/short chunk is a clean refusal, never a partial program.
        3. INLINE (legacy, small program): pull source straight out of the hit body
           (:meth:`_program_source_from_hit`).
        """

        from . import kb_protocol

        # 1. Native full-body note read (preferred). Only fires with a key + a client that offers the
        #    endpoint; any miss falls through to the chunk/inline paths below so a daemon without
        #    /note/get still warm-starts via the older schemes.
        if self.config.native_note_get:
            native_source, native_diag = self._native_orient_source(hit)
            if native_source:
                return native_source, None, "native"
            # native_diag is advisory; keep resolving so a native miss never blocks fallback.

        # 2. Chunked reassembly (fallback), gated behind config.chunked_program_notes.
        if self.config.chunked_program_notes:
            index_body = self._hit_body_text(hit)
            chunk_count = _search_int(kb_protocol._INDEX_CHUNKS_RE, index_body)
            source_length = _search_int(kb_protocol._INDEX_LENGTH_RE, index_body)
            if chunk_count is not None and source_length is not None:
                src, diag = self._reassemble_orient_chunks(chunk_count, source_length)
                if src:
                    return src, None, "chunks"
                return None, diag, None

        # 3. Legacy inline body.
        inline = self._program_source_from_hit(hit)
        if inline:
            return inline, None, "inline"
        return None, "no source in hit", None

    def _native_orient_source(
        self, hit: dict[str, Any]
    ) -> tuple[str | None, str | None]:
        """Fetch the hit note's FULL body via the daemon's native ``GET /note/get`` and extract the
        fenced program source. Returns ``(source, diagnosis)``; source is None on any miss.

        The index note's ``full_body`` carries the program in a fenced ```python block (the
        WriteGate write_program_revision format). We reassemble server-side, then run the same
        ``extract_python`` (with a ``program source:`` marker fallback) the inline path uses.
        """

        client = getattr(self.kb, "client", None)
        get_full = getattr(client, "get_note_full", None)
        if not callable(get_full):
            return None, "no note/get client"
        key = self._hit_key(hit)
        if not key:
            return None, "no note key"
        try:
            resp = get_full(key)
        except Exception:  # noqa: BLE001 - a note/get failure is a clean fallback, never a crash
            return None, "note/get failed"
        if not isinstance(resp, dict) or not resp.get("ok"):
            return None, "note/get miss"
        body = resp.get("full_body")
        if not isinstance(body, str) or not body.strip():
            return None, "note/get empty body"
        # Prefer a fenced block; fall back to the `program source:` marker the inline path honors.
        source = extract_python(body)
        if not source:
            marker = "program source:"
            idx = body.lower().find(marker)
            if idx != -1:
                tail = body[idx + len(marker):].strip()
                if tail:
                    source = tail
        if not source:
            return None, "no fenced source in note body"
        return source, None

    # A cluster-artifact key embeds its parent note id as the trailing `note-<id>` segment (the
    # daemon's long-note splitter builds the doc/section/chunk ids from the note's bare id — see
    # lib/note-source-cluster.js). ORIENT's keyed search often surfaces those `knowledge:source_doc:
    # note-<id> ... evidence` artifacts INSTEAD of the index note itself (the index note's own summary
    # is compacted to a stub at write time, so the evidence node outranks it on the program query).
    # /note/get only resolves `note:` keys, so we recover the parent note key from the artifact.
    _NOTE_ID_RE = re.compile(r"(note-[0-9a-z]+)")

    @classmethod
    def _hit_key(cls, hit: dict[str, Any]) -> str | None:
        """The `note:` key to read via native /note/get for a /search hit.

        Returns the hit's own key when it is already a `note:` key; otherwise, when the hit is a
        `knowledge:source_*` cluster artifact (or any key embedding a `note-<id>` token), derives the
        parent `note:<id>` key so the native full-body read resolves the real note rather than 404ing
        on the unreadable artifact key.
        """

        for field in ("key", "id", "note_key"):
            value = hit.get(field)
            if not isinstance(value, str) or not value.strip():
                continue
            raw = value.strip()
            if raw.startswith("note:"):
                return raw
            if raw.startswith("knowledge:"):
                m = cls._NOTE_ID_RE.search(raw)
                if m:
                    return f"note:{m.group(1)}"
                continue
            return raw
        return None

    def _reassemble_orient_chunks(
        self, chunk_count: int, source_length: int
    ) -> tuple[str | None, str | None]:
        """Fetch the N chunk notes by exact title, reassemble, and verify the byte length."""

        from . import kb_protocol

        client = getattr(self.kb, "client", None)
        if client is None:
            return None, "no kb client for chunks"
        chunk_bodies: list[str] = []
        for n in range(1, chunk_count + 1):
            title = kb_protocol.program_chunk_title(self.config.game_id, n, chunk_count)
            try:
                # k is generous: the daemon prepends ~5 system notes (score 1.0) ahead of memory hits,
                # so an exact-title chunk can sit past rank 5. We pull a pool and match the EXACT
                # title; we NEVER fall back to a non-exact hit — a wrong chunk body would silently
                # corrupt the reassembly, and a clean refusal is strictly better.
                hits = client.search(title, k=12, full_content=True)
            except Exception:  # noqa: BLE001 - a chunk fetch failure is a clean refusal, never a crash
                return None, "chunk fetch failed"
            body = None
            for h in hits:
                if str(h.get("title", "")).strip() == title:
                    body = self._hit_body_text(h)
                    break
            if not body:
                return None, f"missing chunk {n} of {chunk_count}"
            chunk_bodies.append(body)
        source = kb_protocol.reassemble_chunks(
            chunk_bodies, expected_count=chunk_count, expected_length=source_length
        )
        if source is None:
            return None, "chunk reassembly corrupt"
        return source, None

    @staticmethod
    def _hit_body_text(hit: dict[str, Any]) -> str:
        """The fullest body text a hit carries: prefer the full_content ``content`` field, then the
        clipped ``summary``/``body``. Chunk retrieval sets full_content so ``content`` holds the whole
        ≤1200-char chunk; a plain hit only has the 200-char ``summary``."""

        for key in ("content", "summary", "body", "text"):
            value = hit.get(key)
            if isinstance(value, str) and value.strip():
                return value
        return ""

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
        """Ask the LLM for program source; accept only when it passes the FULL, NON-EMPTY suite.

        A program must never be adopted against an empty suite — validating against zero observed
        transitions is vacuous, and a vacuously-"valid" model has never been shown to predict
        anything real (the failure that wasted the vision ls20 run). The acceptance gate is:
        ``validate()`` passes AND the suite is non-empty at acceptance time. A failing candidate
        feeds its ValidationReport back into the next attempt (repair-style), up to
        ``max_synth_attempts``. Returns True on acceptance.
        """

        if len(self.suite) == 0:
            # Nothing observed yet to validate against: refuse to synthesize a vacuous program.
            return False
        if self.config.graph_synthesis:
            return self._synthesize_graph(frame)
        kb_hits = self._kb_search(
            "SYNTHESIZE", vocabulary=self._vocabulary(frame)
        )
        report: ValidationReport | None = None
        # Best compiling candidate across attempts (highest full-suite pass_count) for the
        # partial-adoption fallback when no attempt fully passes.
        best_source: str | None = None
        best_report: ValidationReport | None = None
        for _ in range(self.config.max_synth_attempts):
            self.summary.synthesis_attempts += 1
            messages = self._decide_messages(
                "SYNTHESIZE", frame, kb_hits, report, image_url
            )
            text = self._decide(
                messages, self._synth_client(), max_tokens=self.config.synth_max_tokens
            )
            source = extract_python(text)
            if source is None:
                # No fenced block at all (prose only): retry ONCE with a terse "one fenced block"
                # prompt, then bail out of synthesis.
                messages = self._synth_retry_messages(frame, image_url)
                text = self._decide(
                    messages, self._synth_client(), max_tokens=self.config.synth_max_tokens
                )
                source = extract_python(text)
                if source is None:
                    self._write_attempt_artifact(
                        "SYNTHESIZE", frame, self._prompt_text(messages), text, None, None, False
                    )
                    break
            try:
                candidate = WorldModelProgram.load(source)
            except SandboxError as exc:
                report = ValidationReport(
                    ok=False, pass_count=0, total=len(self.suite), error=str(exc)
                )
                self._write_attempt_artifact(
                    "SYNTHESIZE", frame, self._prompt_text(messages), text, source, report, False
                )
                continue
            report = validate(candidate, self.suite)
            # Acceptance requires a real pass over a NON-EMPTY suite: a program is only trusted once
            # it predicts every observed transition. (report.total == len(suite) > 0 here.)
            adopted = bool(report.ok and report.total > 0)
            self._write_attempt_artifact(
                "SYNTHESIZE", frame, self._prompt_text(messages), text, source, report, adopted
            )
            if adopted:
                self._adopt_program(candidate)
                self._maybe_write_program(frame, report)
                return True
            if best_report is None or report.pass_count > best_report.pass_count:
                best_source, best_report = source, report
        # No fully-passing program: fall back to partial adoption of the best candidate (mask its
        # persistently-wrong cells UNKNOWN) when it clears the pass-rate floor and mask cap.
        if best_source is not None and best_report is not None:
            if self._try_partial_adopt(frame, best_source):
                self._maybe_write_program(frame, best_report)
                return True
        return False

    # -- graph-native multi-step synthesis (config.graph_synthesis) --------------------------------

    def _synthesize_graph(self, frame: dict[str, Any]) -> bool:
        """Delegate one synthesis cycle to a graph-native :class:`~.synth_graph.SynthSession`.

        The session runs ANALYZE -> PLAN -> EDIT chain -> FINAL over the observed suite, fed the
        object-level deltas from :func:`~.deltas.summarize_suite` and (when a KB is present) the
        cross-game hypothesis menu as ANALYZE context. Adoption is UNCHANGED from single-shot
        synthesis: adopt only when the session's FINAL full-suite validate passes on a NON-EMPTY
        suite. Each EDIT attempt writes the same ``NN-{mode}.json`` artifact via the on_edit hook.
        Returns True on adoption.
        """

        from . import deltas as _deltas
        from . import synth_graph as _synth_graph

        # Per-game session cap: once this game has run its budget of SynthSessions, judge modelability
        # poor and stay reactive for the rest of the game rather than launch another minutes-long
        # session (the run-8 pathology: whole wall budget on sessions, ~5 game actions).
        if self._synth_sessions_this_game >= self.config.max_synth_sessions_per_game:
            self._drop_program("synth_session_cap_game")
            return False

        summary = _deltas.summarize_suite(self.suite)
        delta_texts = list(summary.get("per_action", [])) + list(summary.get("per_transition", []))
        menu_lines = self._hypothesis_menu_lines(frame)

        def _sink(edit: dict[str, Any]) -> None:
            self._write_attempt_artifact(
                "SYNTHESIZE",
                frame,
                edit.get("prompt_text", ""),
                edit.get("raw_text", ""),
                edit.get("source"),
                edit.get("report"),
                bool(edit.get("adopted")),
            )

        session = _synth_graph.SynthSession(
            self.config.game_id,
            self.suite,
            self._synth_client(),
            graph=self.graph,
            on_edit=_sink,
            analyze_context=menu_lines,
            # Feed the SAME contract text the single-shot path uses into every EDIT prompt, so
            # session-authored programs get the hardened grid/UNKNOWN/stdlib/segment contract (run 8:
            # 24/27 session candidates imported numpy because EDIT prompts lacked it). EDIT budget is
            # the large synth_max_tokens (4096), not the small default — the truncation fix.
            synth_context=self._synthesis_grid_block(frame),
            config=_synth_graph.SynthConfig(
                edit_max_tokens=self.config.synth_max_tokens,
                max_session_seconds=self.config.synth_session_wall_seconds,
            ),
        )
        self._synth_sessions_this_game += 1
        self.summary.synthesis_attempts += 1
        try:
            result = session.run(deltas=delta_texts)
        except Exception:  # noqa: BLE001 - a synthesis session must never crash the loop
            return False

        self._accumulate_graph_stats(result)
        source = result.get("program_source")
        report_dict = result.get("report") or {}
        adopted = bool(source) and bool(report_dict.get("ok")) and int(report_dict.get("total", 0)) > 0
        if adopted and isinstance(source, str):
            try:
                candidate = WorldModelProgram.load(source)
            except SandboxError:
                candidate = None
            if candidate is not None:
                # Re-validate on the live suite before trusting the session's FINAL verdict.
                report = validate(candidate, self.suite)
                if report.ok and report.total > 0:
                    self._adopt_program(candidate)
                    self._maybe_write_program(frame, report)
                    return True
        # FINAL produced no fully-passing program: partially adopt the session's best candidate
        # (highest-pass-count across the EDIT chain) by masking its wrong cells UNKNOWN.
        best_source = result.get("best_source")
        if isinstance(best_source, str) and best_source.strip():
            if self._try_partial_adopt(frame, best_source):
                best_dict = result.get("best_report") or {}
                best_report = ValidationReport(
                    ok=bool(best_dict.get("ok")),
                    pass_count=int(best_dict.get("pass_count", 0)),
                    total=int(best_dict.get("total", len(self.suite))),
                )
                self._maybe_write_program(frame, best_report)
                return True
        return False

    def _accumulate_graph_stats(self, result: dict[str, Any]) -> None:
        """Fold one SynthSession result's step records into the run's graph-synthesis telemetry:
        changes proposed (EDIT steps), passed (EDIT tested), skipped (EDIT failed), and the FINAL
        full-suite (pass_count, total)."""

        stats = self._graph_synth_stats
        stats["sessions"] += 1
        for step in result.get("steps", []):
            if step.get("name") == "EDIT":
                stats["changes_proposed"] += 1
                if step.get("status") == "tested":
                    stats["changes_passed"] += 1
                else:
                    stats["changes_skipped"] += 1
        report = result.get("report") or {}
        stats["final_pass_rates"].append(
            [int(report.get("pass_count", 0)), int(report.get("total", 0))]
        )

    def _hypothesis_menu_lines(self, frame: dict[str, Any]) -> list[str]:
        """The KB cross-game hypothesis menu as ANALYZE context lines (empty when no KB)."""

        if self.kb is None or getattr(self.kb, "client", None) is None:
            return []
        from . import kb_protocol

        try:
            menu = kb_protocol.hypothesis_menu(
                self.config.game_id,
                self._vocabulary(frame),
                client=self.kb.client,
            )
        except Exception:  # noqa: BLE001 - a KB miss must never crash synthesis
            return []
        formatted = menu.get("formatted") if isinstance(menu, dict) else None
        if isinstance(formatted, str) and formatted.strip():
            return [formatted]
        return []

    def _repair(self, frame: dict[str, Any], image_url: str | None) -> bool:
        """Patch the current program from the first-failure report and re-validate.

        Assumes the failing transition is already in the suite. Returns True if the patched program
        passes the full suite (or is re-adopted partially with a strictly SMALLER mask).

        Partial adoption interaction: when the active program is a masked partial adoption, REPAIR
        works against the UNWRAPPED source — it validates the inner program (whose real mismatches
        the mask hides) so the LLM patches the actual defect, and re-adopts through the mask-aware
        path so the mask SHRINKS as the model improves.
        """

        if self.program is None:
            return False
        # Validate against the UNWRAPPED inner program under partial adoption, so the report exposes
        # the real mismatches to repair (the masked wrapper would report ok=True and skip repair).
        inner = self.program.inner if isinstance(self.program, MaskedProgram) else self.program
        was_partial = isinstance(self.program, MaskedProgram)
        report = validate(inner, self.suite)
        if report.ok:
            return True
        kb_hits = self._kb_search(
            "REPAIR", divergence=self._divergence_text(report)
        )
        for _ in range(self.config.max_repair_attempts):
            self.summary.repair_attempts += 1
            messages = self._decide_messages("REPAIR", frame, kb_hits, report, image_url)
            text = self._decide(
                messages, self._synth_client(), max_tokens=self.config.synth_max_tokens
            )
            source = extract_python(text)
            if source is None:
                # No fenced block at all (prose only): retry ONCE with a terse re-ask.
                messages = self._synth_retry_messages(frame, image_url)
                text = self._decide(
                    messages, self._synth_client(), max_tokens=self.config.synth_max_tokens
                )
                source = extract_python(text)
                if source is None:
                    self._write_attempt_artifact(
                        "REPAIR", frame, self._prompt_text(messages), text, None, None, False
                    )
                    break
            try:
                candidate = WorldModelProgram.load(source)
            except SandboxError as exc:
                self._write_attempt_artifact(
                    "REPAIR",
                    frame,
                    self._prompt_text(messages),
                    text,
                    source,
                    ValidationReport(ok=False, pass_count=0, total=len(self.suite), error=str(exc)),
                    False,
                )
                continue
            report = validate(candidate, self.suite)
            adopted = bool(report.ok and report.total > 0)
            self._write_attempt_artifact(
                "REPAIR", frame, self._prompt_text(messages), text, source, report, adopted
            )
            if adopted:
                self._adopt_program(candidate)
                self._maybe_write_program(frame, report)
                return True
            # Under partial adoption, a candidate need not fully pass to be an improvement: accept it
            # if partial re-adoption yields a strictly SMALLER mask than the one currently active
            # (the mask shrinks as the model improves). A repair that does not shrink the mask is
            # rejected (state restored), so REPAIR never stalls re-adopting an equally-holed model.
            if was_partial:
                prev_program = self.program
                prev_partial = self.summary.program_adopted_partial
                prev_mask = self.summary.mask_cells
                if self._try_partial_adopt(frame, source) and (
                    self.summary.mask_cells < prev_mask
                ):
                    # Mask recomputed to the improved (smaller) set. This partial adoption HAS now
                    # been live-repaired: subsequent EXECUTE uses the recomputed masked wrapper, so
                    # the newly-modeled cells are checked and only the still-unmodelable remainder
                    # stays wildcard.
                    self._partial_repaired = True
                    self._maybe_write_program(frame, report)
                    return True
                # Restore the prior (better-or-equal) partial adoption.
                self.program = prev_program
                self.summary.program_adopted_partial = prev_partial
                self.summary.mask_cells = prev_mask
        return False

    def _plan(self, frame: dict[str, Any]) -> PlanResult | None:
        """Plan toward ``is_win`` with the current program. Zero LLM calls."""

        if self.program is None:
            return None
        program = self.program
        rederived = self._goal_predicate

        def goal(state: Any) -> bool:
            try:
                if program.is_win(state):
                    return True
            except Exception:  # noqa: BLE001
                pass
            # A goal-contact predicate re-derived from a captured level boundary (GOAL DISCOVERY):
            # once we have SEEN a win, planning targets that goal even if the program's own is_win
            # stays vacuously False (the Run-15 blocker: no banked boundary, so is_win never fired).
            if rederived is not None:
                try:
                    return bool(rederived(state))
                except Exception:  # noqa: BLE001
                    return False
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

    def _expect_grids(
        self, plan_result: PlanResult, frame: dict[str, Any]
    ) -> list[Any]:
        """The per-action ``expect`` grids for EXECUTE.

        Normally the plan's own ``predicted_grids`` (rendered by the active program). While the
        active program is a partial adoption that has NOT yet been live-repaired, we reveal the
        UNWRAPPED inner program's prediction on the cells the model says MOVE, so a real divergence
        in the modeled dynamics actually trips ``expect_mismatch`` -> REPAIR (see :meth:`_execute`).

        We do NOT simply swap in the whole inner render: that would also un-mask STATIC masked cells
        (a persistently-wrong background region — the Run-9 case partial adoption is built to
        tolerate), spuriously tripping repair on a harmless constant. Instead, per step we keep the
        masked wrapper's grid (UNKNOWN over the mask) and OVERRIDE only the cells that inner's step
        actually CHANGES (before[r][c] != inner_after[r][c]) with inner's real value. So:
          * a moved object the model mispredicts (Run-10: wrong magnitude) -> revealed -> divergence;
          * a static masked cell (Run-9: wrong constant) -> stays UNKNOWN wildcard -> no divergence.
        """

        program = self.program
        if not (isinstance(program, MaskedProgram) and not self._partial_repaired):
            return list(plan_result.predicted_grids)
        inner = program.inner
        try:
            state = inner.init_state(self._frame_grid(frame))
            # Baseline is inner's OWN render of the start state, NOT the real frame: we want the
            # cells inner's STEP moves (inner_before -> inner_after), not the cells where inner
            # merely disagrees with the real input (that static disagreement is exactly the masked
            # region we must keep as a wildcard).
            before = inner.render(state)
            grids: list[Any] = []
            for index, action in enumerate(plan_result.actions):
                state, _events = inner.step(state, action)
                inner_after = inner.render(state)
                # Base = the plan's masked grid for this step (UNKNOWN over the mask). Fall back to
                # inner_after if the plan produced no aligned predicted grid.
                masked = (
                    plan_result.predicted_grids[index]
                    if index < len(plan_result.predicted_grids)
                    else inner_after
                )
                grid = [list(row) for row in masked]
                if _grid_shape(before) == _grid_shape(inner_after) == _grid_shape(grid):
                    for r, (brow, arow) in enumerate(zip(before, inner_after)):
                        for c, (b, a) in enumerate(zip(brow, arow)):
                            if b != a:  # a cell inner claims MOVES: check it against reality
                                grid[r][c] = a
                grids.append(grid)
                before = inner_after
        except Exception:  # noqa: BLE001 - a broken inner replay must not crash the loop
            return list(plan_result.predicted_grids)
        return grids

    def _execute(
        self, plan_result: PlanResult, frame: dict[str, Any]
    ) -> tuple[dict[str, Any], bool]:
        """Run a plan through ``env.act`` with ``expect`` predicted grids (divergence-abort path).

        Records every executed transition into the suite. Returns ``(last_result, diverged)`` where
        ``diverged`` is True iff the environment deviated from the model (expect-mismatch) — the
        caller then routes to REPAIR. Zero LLM (decide) calls happen here.

        Partial-adoption engagement (Run-10 fix): the plan's ``predicted_grids`` come from the ACTIVE
        program, which for a partial adoption is the MASKED wrapper — it renders UNKNOWN over exactly
        the cells the inner source gets wrong, so the env's UNKNOWN-aware ``expect`` check treats the
        modeled-wrong region as wildcards and a real divergence there is NEVER detected (Run-10: 14
        reactive fallbacks, 0 repair attempts). Until the first live repair, we re-derive ``expect``
        from the UNWRAPPED inner program so the wrong cells are actually compared and the first
        divergence trips ``expect_mismatch`` -> REPAIR, before any reactive fallback.
        """

        expect = self._expect_grids(plan_result, frame)
        result = self._act(list(plan_result.actions), expect=expect)
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
            # Only score SINGLE-action transitions that do NOT cross a level boundary against the
            # model: a multi-action batch or a level-transition after-grid (the NEXT level's initial
            # frame) has no well-defined one-step prediction, so scoring it would falsely penalize a
            # correct model.
            crossed_level = self._stop_reason(result) == "level_transition"
            single_step = len(executed) <= 1 and not crossed_level
            self._record_transition(before, action_key, after_grid, single_step=single_step)

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
        # Track player-cell coverage from this real transition (the frontier-exploration objective).
        self._update_coverage(before, after_grid)
        # Watch every real transition for a level/score boundary; the first one seeds GOAL DISCOVERY.
        self._maybe_capture_boundary(before, actions, result)
        # MODEL-TRUSTED FAST PATH: while the model is trusted, SKIP the reflect LLM call — reflection
        # becomes log-only (the suite still appended the transition above). Any expect-mismatch has
        # already dropped trust via _refresh_model_trust, so this only skips when the model held.
        if self.config.fast_path and self._model_trusted:
            self.summary.reflect_skipped += 1
            reflect_text = ""
        else:
            try:
                reflect_text = self._reflect(self._reflect_messages(struct, image_url))
            except Exception:  # noqa: BLE001 - reflection is advisory; never crash the loop on it
                reflect_text = ""
        self._maybe_write_from_reflection(before, result, reflect_text)

    # -- GOAL DISCOVERY: coverage + level-boundary capture -----------------------------------------

    def _update_coverage(
        self, before: dict[str, Any], after_grid: list[list[int]]
    ) -> None:
        """Add the player-occupied cells of ``after_grid`` to the run's coverage set.

        Player cells are inferred model-agnostically as the cells that DIFFER from the before-grid
        (the moving unit is exactly what an action changes). Keyed by (level, r, c) so the same cell
        on a new level is fresh ground. Feeds ``coverage_pct`` telemetry."""

        before_grid = self._frame_grid(before)
        level = before.get("level")
        if _grid_shape(before_grid) != _grid_shape(after_grid):
            for r, row in enumerate(after_grid):
                for c in range(len(row)):
                    self._coverage_cells.add((level, r, c))
            return
        for r, (brow, arow) in enumerate(zip(before_grid, after_grid)):
            for c, (b, a) in enumerate(zip(brow, arow)):
                if b != a:
                    self._coverage_cells.add((level, r, c))

    def _boundary_crossed(self, before: dict[str, Any], result: dict[str, Any]) -> bool:
        """True iff this transition crossed a level/score boundary — an explicit
        ``level_transition`` stop reason, a level counter increment, or a score jump."""

        if self._stop_reason(result) == "level_transition":
            return True
        after_level = self._result_after_level(result)
        before_level = before.get("level")
        if (
            isinstance(after_level, (int, float))
            and isinstance(before_level, (int, float))
            and after_level > before_level
        ):
            return True
        after_score = self._result_after_score(result)
        before_score = before.get("score")
        if (
            isinstance(after_score, (int, float))
            and isinstance(before_score, (int, float))
            and after_score > before_score
        ):
            return True
        return False

    @staticmethod
    def _result_after_level(result: dict[str, Any]) -> Any:
        frame = result.get("current_frame")
        if isinstance(frame, dict) and frame.get("level") is not None:
            return frame.get("level")
        ar = result.get("action_result")
        return ar.get("level") if isinstance(ar, dict) else result.get("level")

    @staticmethod
    def _result_after_score(result: dict[str, Any]) -> Any:
        frame = result.get("current_frame")
        if isinstance(frame, dict) and frame.get("score") is not None:
            return frame.get("score")
        ar = result.get("action_result")
        if isinstance(ar, dict) and ar.get("score") is not None:
            return ar.get("score")
        return result.get("score")

    def _player_position(self, grid: list[list[int]]) -> tuple[int, int] | None:
        """The player unit's (row, col) in ``grid``, taken as the position of the ARC avatar color 2
        (the mover in every ls20 suite and the toy game). None when no such cell exists."""

        for r, row in enumerate(grid):
            for c, v in enumerate(row):
                if v == 2:
                    return (r, c)
        return None

    def _maybe_capture_boundary(
        self, before: dict[str, Any], actions: list[Any], result: dict[str, Any]
    ) -> None:
        """On the FIRST observed level/score boundary, capture the pre-boundary player position,
        record a game-scoped goal-evidence note, and re-derive ``is_win`` as a goal-contact predicate
        so subsequent planning can target the win the agent has now SEEN (the Run-15 blocker)."""

        if not self.config.goal_discovery:
            return
        if not self._boundary_crossed(before, result):
            return
        before_grid = self._frame_grid(before)
        pos = self._player_position(before_grid)
        # The player pos that immediately preceded the boundary IS the goal-contact evidence.
        if pos is not None:
            self._goal_positions.add(pos)
        first_boundary = not self.summary.level_boundary_captured
        self.summary.level_boundary_captured = True
        # Re-derive is_win: a state is a win when the player unit contacts a captured goal position.
        if self._goal_positions and self._goal_predicate is None:
            self._install_goal_predicate()
        if not first_boundary:
            return
        # Record the goal-evidence note (best-effort; a live daemon persists it for future runs).
        if self.kb is not None:
            try:
                self.kb.begin_turn()
                insight = (
                    f"level cleared by driving avatar into goal from {pos}; "
                    f"actions {self._executed_actions(result, actions)}"
                )
                out = self.kb.write_goal_evidence(
                    self.config.game_id, before.get("level"), pos, insight
                )
                if isinstance(out, dict) and out.get("ok"):
                    self.summary.kb_writes += 1
                    self.summary.goal_note_written = True
            except Exception:  # noqa: BLE001 - note write is advisory; never crash the loop
                pass

    def _install_goal_predicate(self) -> None:
        """Set ``_goal_predicate`` to a goal-contact predicate over the captured player positions.

        The program renders states; a state is a WIN once the player unit (avatar color 2) sits on a
        cell we observed the player occupy IMMEDIATELY BEFORE a real boundary. Rendering is wrapped
        so a broken program simply never satisfies the predicate rather than crashing the planner."""

        goal_positions = frozenset(self._goal_positions)
        program = self.program

        def contacts_goal(state: Any) -> bool:
            if program is None or not goal_positions:
                return False
            try:
                grid = program.render(state)
            except Exception:  # noqa: BLE001
                return False
            return self._player_position(grid) in goal_positions

        self._goal_predicate = contacts_goal
        self.summary.is_win_rederived = True

    # -- KB writes (acceptance events) -------------------------------------------------------------

    def _maybe_write_program(self, frame: dict[str, Any], report: ValidationReport) -> None:
        if self.kb is None:
            return
        try:
            self.kb.begin_turn()
            # Compounding (Run-14 Req 3): when this program was recalled from a KB note and then
            # improved by a live REPAIR, supersede that note so the improved program REPLACES the
            # recalled one in the KB (temporal supersede — the old note is retired, not forked). A
            # freshly-synthesized program has no recalled note (_orient_note_key is None) and writes a
            # new revision as before.
            out = self.kb.write_program_revision(
                self.config.game_id,
                f"world model revision at level {frame.get('level')}",
                self.program.source if self.program else "",
                f"{report.pass_count}/{report.total}",
                supersedes=self._orient_note_key,
            )
            if isinstance(out, dict) and out.get("ok"):
                self.summary.kb_writes += 1
                # The revision now IS the canonical note; a subsequent repair supersedes THIS write's
                # note, not the original again. Adopt the new key when the write reports one.
                new_key = out.get("key") or out.get("note_key")
                if isinstance(new_key, str) and new_key.strip():
                    self._orient_note_key = new_key.strip()
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
        self._run_start = time.monotonic()

        for turn in range(self.config.max_turns):
            self.summary.turns = turn + 1
            frame = self._observe()

            # Coverage denominator: the board cell count, captured on the first real observation.
            if not self._board_cell_count:
                self._board_cell_count = self._board_cells(frame)

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

            # Model-based path: PROBE -> ORIENT -> SYNTHESIZE -> PLAN -> EXECUTE (-> REPAIR).
            if self.program is None:
                # Probe-first seeding: on a fresh, under-seeded game, run a discriminating probe
                # batch so SYNTHESIZE validates against real transitions, never an empty suite.
                if not self._probed and len(self.suite) < self.config.min_probe_transitions:
                    self._probe_batch(frame)
                    frame = self._observe()  # probing consumed actions and moved the avatar
                    if frame.get("done") or self._out_of_budget(frame):
                        self.summary.stop_reason = (
                            "budget" if self._out_of_budget(frame) else "done"
                        )
                        if self._result_done_frame(frame):
                            self.summary.won = True
                            self.summary.stop_reason = "won"
                        break
                if not self._orient(frame):
                    if not self._synthesize(frame, decide_image):
                        # A synthesis cycle gave up. Count it toward the per-game ceiling; once the
                        # ceiling is hit, judge modelability poor and stay reactive for the rest of
                        # the game (never re-enter SYNTHESIZE). This is the primary guard against the
                        # ls20 pathology: synthesis cycles looping back-to-back until the wall-clock
                        # budget is gone with almost no game actions taken.
                        self._failure_cycles += 1
                        self._synth_cycles_this_game += 1
                        if (
                            self._synth_cycles_this_game
                            >= self.config.max_synth_attempts_per_game
                        ):
                            self._drop_program("synth_cap_game")
                            prev_frame = frame
                            continue
                        # Synthesis pacing: even before the ceiling, never re-enter SYNTHESIZE
                        # directly off a failed cycle. Take at least one reactive turn (RECOVER
                        # path) so the loop actually gathers a transition/score between synthesis
                        # cycles instead of burning the budget on synthesis alone. Record RECOVER in
                        # modes_visited so the telemetry shows the SYNTHESIZE/RECOVER interleave
                        # rather than a run of bare SYNTHESIZE.
                        self.summary.modes.append("RECOVER")
                        result = self._reactive_turn(frame, decide_image)
                        if self._result_done(result):
                            self.summary.won = True
                            self.summary.stop_reason = "won"
                            break
                        prev_frame = frame
                        continue
                    self._failure_cycles = 0

            plan_result = self._plan(frame)
            if plan_result is None or not plan_result.actions:
                # GOAL DISCOVERY (Run-16): a live-trusted program with no goal plan has never SEEN a
                # win (is_win vacuously False — no banked level boundary). Instead of a blind reactive
                # probe, drive FRONTIER EXPLORATION: BFS the model's reachable-state graph for the
                # prefix that visits the most NEW player cells, execute it in one long budget-guarded
                # batch, and watch each real transition for a level/score boundary (captured +
                # goal-noted in _ingest_result). Only when the model is trusted enough to open-loop.
                if self._goal_discovery_ready():
                    result, diverged = self._frontier_execute(frame)
                    if self._result_done(result):
                        self.summary.won = True
                        self.summary.stop_reason = "won"
                        break
                    if diverged:
                        self._handle_divergence(frame, decide_image)
                    else:
                        self._repairs_this_divergence = 0
                        self._failure_cycles = 0
                    prev_frame = frame
                    continue
                # No plan (e.g. already-at-goal empty plan or unreachable): reactive probe.
                #
                # Live-divergence REPAIR engagement (Run-14): a recalled program can be plannable-blind
                # — Run-13's ls20 ceiling hard-codes ``is_win`` False, so ``_plan`` NEVER finds a goal
                # and the loop reaches HERE every turn, gathering live transitions the program
                # mispredicts (live_pass_rate 0.05) yet never entering REPAIR (that only fired from the
                # planned-EXECUTE expect-mismatch, which an unplannable program never reaches). Result:
                # 31 live divergences, 0 repair attempts. Before falling back to a blind reactive
                # probe, check whether the ACTIVE program actually predicted the last observed
                # transition; if it diverged, route to REPAIR so the failing live transition (already
                # in the suite) + the recalled source reach the model — the evidence that lets it add
                # the missing wall/collision blocking. Reactive fallback only if there is nothing to
                # repair (no program, or the model held).
                reactive = self._reactive_turn(frame, decide_image)
                if self._result_done(reactive):
                    self.summary.won = True
                    self.summary.stop_reason = "won"
                    break
                if self.program is not None and self._live_diverged():
                    self._handle_divergence(frame, decide_image)
                prev_frame = frame
                continue

            # MODEL-TRUSTED FAST PATH: while trusted, extend the planned batch toward the budget-guard
            # cap so more ground is covered per decide (a short goal plan is run whole; a longer one is
            # capped at fast_path_batch_cap). Untrusted, the batch stays as planned.
            if self.config.fast_path and self._model_trusted:
                self.summary.fast_path_batches += 1
                plan_result = self._cap_plan(plan_result, self.config.fast_path_batch_cap)
            result, diverged = self._execute(plan_result, frame)
            if self._result_done(result):
                self.summary.won = True
                self.summary.stop_reason = "won"
                break

            if diverged:
                self._handle_divergence(frame, decide_image)
            else:
                # A clean plan execution: the model held for this batch — reset per-divergence budget.
                self._repairs_this_divergence = 0
                self._failure_cycles = 0

            prev_frame = frame

        self.summary.suite_size = len(self.suite)
        self.summary.transitions = len(self.suite)
        self.summary.live_pass_rate = self._live_pass_rate()
        self._finalize_telemetry()
        # End-of-run persistence (any stop reason): the observed suite + the final adopted program.
        self._write_run_artifacts()
        out = self.summary.to_dict()
        if self.config.graph_synthesis:
            out["graph_synth_stats"] = dict(self._graph_synth_stats)
            # Report whether graph mode was actually LIVE this run: a DaemonGraph counts every
            # daemon HTTP call as ok/failed. All-zero or all-failed means the run silently degraded
            # to no-graph — the run-8 blind spot (404s on /task/context + /overlay/note went
            # unreported). A _NullGraph / None client has no counters (offline by construction).
            ok = getattr(self.graph, "graph_ops_ok", None)
            failed = getattr(self.graph, "graph_ops_failed", None)
            if ok is not None or failed is not None:
                out["graph_ops_ok"] = int(ok or 0)
                out["graph_ops_failed"] = int(failed or 0)
        return out

    # -- GOAL DISCOVERY: frontier exploration + telemetry ------------------------------------------

    def _goal_discovery_ready(self) -> bool:
        """True iff GOAL DISCOVERY should drive frontier exploration this turn: enabled, a program is
        adopted, and its live pass-rate over a non-trivial window clears the confidence floor (a
        trusted model is safe to drive on long open-loop batches). Below the floor, the loop stays on
        the per-turn REPAIR/reactive path so a shaky model is not open-looped into the weeds."""

        if not self.config.goal_discovery or self.program is None:
            return False
        samples = len(self._live_results)
        if samples < self.config.goal_discovery_min_live_samples:
            return False
        return self._live_pass_rate() >= self.config.goal_discovery_min_live_rate

    def _frontier_execute(self, frame: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        """Plan and run one FRONTIER EXPLORATION batch: the action prefix that visits the most NEW
        player cells (planner.explore_frontier), executed open-loop with ``expect`` divergence-abort.

        Returns ``(result, diverged)`` like :meth:`_execute`. Falls back to a reactive probe when the
        explorer finds no move (nothing to explore)."""

        program = self.program
        try:
            frontier = explore_frontier(
                program,
                self._frame_grid(frame),
                max_depth=min(self.config.frontier_max_depth, self.config.plan_max_depth),
                max_nodes=self.config.plan_max_nodes,
            )
        except Exception:  # noqa: BLE001 - a broken program must not crash the loop
            frontier = None
        if frontier is None or not frontier.actions:
            result = self._reactive_turn(frame, None)
            return result, False
        self.summary.frontier_batches += 1
        # Cap the open-loop batch by the budget guard (and the trusted fast-path cap when trusted).
        cap = self.config.fast_path_batch_cap if self._model_trusted else self.config.frontier_max_depth
        frontier = self._cap_plan(frontier, cap)
        return self._execute(frontier, frame)

    @staticmethod
    def _cap_plan(plan_result: PlanResult, cap: int) -> PlanResult:
        """A copy of ``plan_result`` truncated to at most ``cap`` actions (and aligned grids)."""

        cap = max(1, cap)
        if len(plan_result.actions) <= cap:
            return plan_result
        return PlanResult(
            actions=list(plan_result.actions[:cap]),
            predicted_grids=list(plan_result.predicted_grids[:cap]),
        )

    def _finalize_telemetry(self) -> None:
        """Compute end-of-run coverage_pct, actions_per_minute, llm_calls_per_action."""

        board = self._board_cell_count or 0
        self.summary.coverage_pct = (
            round(len(self._coverage_cells) / board, 4) if board else 0.0
        )
        elapsed = max(1e-9, time.monotonic() - self._run_start)
        actions = len(self.suite)  # one recorded transition per executed action/batch
        self.summary.actions_per_minute = round(actions / (elapsed / 60.0), 4)
        llm_calls = self.summary.decide_calls + self.summary.reflect_calls
        self.summary.llm_calls_per_action = (
            round(llm_calls / actions, 4) if actions else 0.0
        )

    def _handle_divergence(self, frame: dict[str, Any], image_url: str | None) -> None:
        """On an expect-mismatch: engage REPAIR, but enforce the repair caps and live pass-rate
        floor. A program whose live pass-rate has collapsed (or which has burned its repair budget)
        is DROPPED and the loop switches to reactive — never keep planning from a dead model."""

        self._repairs_this_divergence += 1
        self._repairs_this_game += 1
        repaired = self._repair(frame, image_url)
        if repaired:
            self._failure_cycles = 0
        else:
            self._failure_cycles += 1

        live_rate = self._live_pass_rate()
        floor_breached = (
            len(self._live_results) >= 1 and live_rate < self.config.min_live_pass_rate
        )
        cap_per_divergence = self._repairs_this_divergence >= self.config.max_repairs_per_divergence
        cap_per_game = self._repairs_this_game >= self.config.max_repairs_per_game
        if floor_breached or cap_per_divergence or cap_per_game:
            reason = (
                "live_pass_rate" if floor_breached
                else "repair_cap_game" if cap_per_game
                else "repair_cap_divergence"
            )
            self._drop_program(reason)

    def _result_done_frame(self, frame: dict[str, Any]) -> bool:
        """True iff an OBSERVED frame (not an action result) reports the game done/won."""

        return bool(frame.get("done"))

    def _select_mode(self) -> str:
        """Pick the mode for this turn. Flips to RECOVER after K failed synth/repair cycles, or
        once modelability has been judged poor (a dropped program stays reactive)."""

        if self._modelability_poor:
            return "RECOVER"
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
