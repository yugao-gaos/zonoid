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
from collections import Counter, deque
from dataclasses import dataclass, field
from typing import Any, Callable

from .llm_client import LlmError
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


def _grids_equal_lists(a: list[list[int]], b: list[list[int]]) -> bool:
    """True iff two rendered grids are cell-for-cell identical."""

    return [list(r) for r in a] == [list(r) for r in b]


def _grids_key(grid: list[list[int]]) -> tuple:
    """Hashable canonical form of a rendered grid (for BFS visited-set dedup)."""

    return tuple(tuple(row) for row in grid)


def _object_components(
    grid: list[list[int]],
) -> list[tuple[Any, frozenset[tuple[int, int]]]]:
    """4-connected same-color components of ``grid`` as ``(object_hash, cells)`` pairs.

    The hash is the segmentation module's translation-invariant color+shape signature, so two
    instances of the same object class share a hash. Background (color 0) is skipped by the caller,
    not here. Reuses the segmentation flood-fill so the hash matches ``segment_grid``."""

    from .segmentation import _object_hash  # local: keep the module's hashing single-source

    rows = len(grid)
    cols = len(grid[0]) if rows else 0
    seen = [[False] * cols for _ in range(rows)]
    out: list[tuple[Any, frozenset[tuple[int, int]]]] = []
    for sr in range(rows):
        for sc in range(cols):
            if seen[sr][sc]:
                continue
            color = grid[sr][sc]
            cells: set[tuple[int, int]] = set()
            stack = [(sr, sc)]
            seen[sr][sc] = True
            while stack:
                r, c = stack.pop()
                cells.add((r, c))
                for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                    nr, nc = r + dr, c + dc
                    if 0 <= nr < rows and 0 <= nc < cols and not seen[nr][nc] and grid[nr][nc] == color:
                        seen[nr][nc] = True
                        stack.append((nr, nc))
            out.append((_object_hash(cells, color), frozenset(cells)))
    return out


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
    # DIVERGENCE TOLERANCE (Run-18). Run-17 evidence: an ORIENT-recalled model that was otherwise
    # perfect (final live_pass_rate 1.0) still hit 3 TRANSIENT divergences confined to cells the
    # program already CANNOT model (or immediately adjacent to them). Each fired a futile REPAIR
    # (qwen repair 0-for-18 across runs 15-17), and every repair miss dropped fast-path trust and
    # strangled the LLM-free explorer at 2 batches / 20 actions. The fix is to make the loop tolerate
    # what it cannot fix and never interrupt a working model:
    #   (1) CLASSIFY a divergence: if the mismatched cells are confined to the program's known-
    #       unmodelable set (a MaskedProgram's mask) or ADJACENT to already-masked cells, auto-extend
    #       the mask (respecting mask_cap), count it tolerated, and CONTINUE with NO trust drop and NO
    #       repair — a transient in a region the model already declines to predict is not a defect.
    #   (2) GATE repair on the rolling live pass-rate window: REPAIR engages only once the window
    #       degrades below repair_trigger_pass_rate; an isolated transient while the window still holds
    #       never triggers repair.
    #   (3) SANITY-CAP repair per divergence SIGNATURE: after repair_sanity_cap consecutive candidates
    #       fail extract/compile for the SAME signature, stop repairing that signature for the rest of
    #       the game (logged for the dev-time pass) — trust restores when predictions resume passing.
    divergence_tolerance: bool = True
    repair_trigger_pass_rate: float = 0.85
    repair_sanity_cap: int = 2
    # HEALTHY-MODEL REPAIR SUPPRESSION (Run-28). Run 27 evidence: a WHOLE recalled program that
    # finished the game at live_pass_rate 1.0 still fired 6 REPAIRs (mostly ~60-120s qwen timeouts),
    # so only 13 actions ran in the 1500s budget and the LLM-free exploration phase never got any of
    # it. Root cause: `_handle_divergence` gated repair on `_live_pass_rate()` computed over the
    # window that ALREADY INCLUDES the current failing transition (it is appended in
    # `_record_transition` before the divergence handler runs). Early in a game, before the window
    # fills with passes, a single isolated transient drops the small-window rate below
    # `repair_trigger_pass_rate` and repair fires even though the model is healthy. The fix measures
    # health over the PRIOR window (excluding the failing tail) — the same "was the model healthy
    # JUST BEFORE this divergence" test `_try_tolerate_transient` already uses — and, when it holds,
    # suppresses repair and routes straight to the LLM-free exploration/reactive path.
    repair_suppress_when_healthy: bool = True
    # LLM-TIMEOUT BACKOFF (Run-28). A timed-out decide/repair call burns the FULL client timeout
    # (~60-120s) for nothing. After this many CONSECUTIVE timed-out decide calls, stop repairing for
    # the rest of the game and fall to the LLM-free exploration/reactive path — do not keep paying the
    # timeout. 0 disables the backoff.
    repair_timeout_backoff: int = 2
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
    # ORIENT RETRY (Run-17). The daemon KB search can TIME OUT under load (run 16: the daemon was
    # CPU-pegged, KB search failed x4, and ORIENT concluded "no stored program" and burned ~15 min in
    # a needless SYNTHESIZE cycle before a later retry finally recalled the run-15 program). A timeout
    # is RETRYABLE — the program may still be there — not an absence. When ORIENT's KB call fails on a
    # network error (KbClient.last_search_failed), retry up to ``orient_retries`` times with the
    # backoff schedule below; only after the retries are exhausted (or a real empty result comes back)
    # does ORIENT fall through to SYNTHESIZE. ``orient_kb_attempts`` telemetry counts total ORIENT KB
    # attempts this run. Set orient_retries=0 to disable (tests that assert single-shot behaviour).
    orient_retries: int = 3
    orient_retry_backoff: tuple[float, ...] = (5.0, 15.0, 30.0)
    # LLM-FREE EXPLORATION EXECUTOR (Run-17). Once the model is trusted (revalidation passed + the live
    # window is passing), GOAL DISCOVERY should loop CPU-plan -> execute frontier batch -> CPU-plan the
    # NEXT frontier batch with ZERO decide calls, re-entering the LLM only on an expect-mismatch or when
    # the frontier is exhausted. Run 16 still spent 1.91 LLM calls/action because each frontier turn ran
    # a fresh reflect and a multi-action batch never re-seeded single-step trust, so trust decayed and
    # decide/reflect cadence returned. This caps how many back-to-back zero-decide frontier batches one
    # turn runs (a budget guard so a broken explorer can't spin forever) before yielding to the loop.
    exploration_executor: bool = True
    max_frontier_batches_per_turn: int = 8
    # Live-confidence gate for GOAL DISCOVERY: the frontier explorer only engages once the live
    # pass-rate over a non-trivial window clears this floor (a trusted model is safe to drive on
    # long open-loop batches). Below it, the loop stays on the per-turn REPAIR/reactive path.
    goal_discovery_min_live_rate: float = 0.9
    goal_discovery_min_live_samples: int = 3
    frontier_max_depth: int = 24  # cap on the coverage-search action prefix length
    # INTERACTION DISCOVERY (Run-19). Run 18 exhausted the ls20 MOVEMENT frontier uninterrupted (80
    # actions, ~5% coverage, no level boundary): with a live-trusted model that only translates the
    # player, more movement never trips a win — the win needs an INTERACTION (a non-movement action
    # fired at the right context). When frontier exploration finds no NEW player cells to reach AND no
    # level boundary has been captured, the loop enters INTERACTION DISCOVERY instead of a blind
    # reactive probe: it enumerates untried (action, context) pairs — non-movement valid actions
    # (SPACE/ACTION5/ACTION6/...) fired with the player standing ADJACENT to each distinct segmented
    # object class — CPU-plans movement to the cheapest-to-reach context, fires the probe, and diffs
    # the real result against the known auto-changing region. Any change beyond that region is a
    # DISCOVERY: recorded as a game-scoped interaction note and counted. Probes are de-duplicated by
    # (action, object-hash) so each pair is tried at most once per run.
    interaction_discovery: bool = True
    # Consecutive frontier batches that add NO new coverage before the movement frontier is declared
    # exhausted (the Run-18 signal: explore_frontier keeps returning redundant plans that re-visit
    # already-covered ground). Small so discovery engages promptly instead of burning the budget.
    # Run-21: 2 -> 1. Runs 17-20 pegged the whole budget on frontier re-sweeps and never handed off to
    # bump/interaction discovery (the 80-action budget never reaches a 2-batch plateau). A single
    # no-new-coverage batch is already the honest exhaustion signal — trip on the first one.
    coverage_plateau_exhaust: int = 1
    # Per-turn cap on interaction probes fired before yielding control back to run() (a budget guard so
    # a large object/action product can't monopolise a turn). One probe == one movement-plan + one
    # non-movement action.
    max_interaction_probes_per_turn: int = 6
    # BUMP PROBES (Run-20). Run 19 proved ls20 exposes ONLY movement actions (non-movement vocabulary
    # empty), so _interaction_discovery found nothing to fire and the win — which is contact/positional
    # — was never probed. When the non-movement vocabulary is empty, interaction discovery falls back to
    # CONTACT probes: plan MOVEMENT INTO each adjacent distinct object class, repeating the bump
    # ``bump_probe_repeats`` times per target, and diff for ANY effect beyond blocked/no-op and the
    # auto-changing region (object moved/recolored/vanished, score delta, new reachable cells). Deduped
    # by (bump-marker, object_hash) through the same _fired_probes set (persisted across runs).
    bump_probes: bool = True
    bump_probe_repeats: int = 3
    # BUMP QUOTA INTERLEAVE (Run-22). Run 21 proved the frontier NEVER plateaus in-budget: every
    # frontier batch found a fresh crumb, so the exhaustion/plateau gate that hands off to bump
    # discovery never tripped and the contact win (which needs a bump) was never probed. Make contact
    # probing a FIRST-CLASS budget quota instead of an exhaustion-gated fallback: from the START of
    # exploration, the exploration executor alternates frontier batches and bump-probe batches so that
    # ~``bump_quota_fraction`` of executed exploration actions are contact bumps. The plateau/exhaustion
    # handoff (``coverage_plateau_exhaust`` + interaction/bump discovery) remains as a BONUS path.
    # 0.0 -> quota off (pre-Run-22 exhaustion-only behaviour).
    bump_quota_fraction: float = 0.4
    # Minimum contact-bump actions guaranteed this run even under a tight action budget: until this many
    # bumps have fired, the exploration executor prefers a bump batch regardless of the running ratio, so
    # a small ``--max-actions`` budget still gets its contact probes rather than spending everything on
    # frontier movement. Guaranteed floor; the ratio quota governs once the floor is met.
    exploration_min_bump_actions: int = 24
    # REACH PROBES (Run-39). Run 38 destroyed EVERY color-8 and color-11 object and the engine still
    # reported levels_completed=0 — contact alone is not the ls20 win. The remaining candidates are
    # RARE SPECIAL CELLS (ls20: 3 color-0 cells + 2 color-1 cells forming a plus shape around
    # (32, 21) inside the color-5 maze; the banked suite shows the mover footprint DID cover the
    # on-lattice color-0 cell (31, 21) with no win, but the off-lattice row-32/33 cells were only
    # ever swept OVER, never OCCUPIED at rest). A reach probe WALKS the mover onto such a cell to
    # test the navigate-to-target win hypothesis. A segmented object class is a reach target only
    # while its TOTAL cell count is <= reach_target_max_cells — rare by definition, so the big
    # background/maze/wall classes never qualify. 0 disables reach probing.
    reach_target_max_cells: int = 4
    # Colors excluded from reach targeting even when their class is rare: the trail/ground colors
    # the ls20 effect map established (9 = static decoration/trail, 3 = swept ground). Trail
    # fragments segment into tiny components that would otherwise masquerade as rare special cells.
    reach_exclude_colors: tuple[int, ...] = (9, 3)
    # CROSS-RUN COVERAGE PERSISTENCE (Run-20). At run end the agent persists the swept ground (visited
    # cells + fired probes + plateau) as a game-scoped KB note; on ORIENT it loads and RESUMES the
    # frontier so budgets never compound into a fresh re-sweep every run. Telemetry coverage_resumed_pct.
    # A KB read failure degrades gracefully to a fresh sweep. Off -> today's per-run coverage.
    coverage_persistence: bool = True
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
    # ORIENT RETRY telemetry (Run-17): total ORIENT KB attempts this run (>1 means a daemon timeout
    # was retried rather than conceded to SYNTHESIZE).
    orient_kb_attempts: int = 0
    # DIVERGENCE TOLERANCE telemetry (Run-18). `transients_tolerated` = divergences classified as
    # confined-to/adjacent-to the known-unmodelable set and tolerated with NO trust drop and NO
    # repair. `mask_auto_extensions` = tolerated divergences that actually grew the mask (new cells
    # masked UNKNOWN). `repair_skips` = repair engagements skipped because the divergence signature
    # had already hit the runtime sanity cap (repair_sanity_cap consecutive extract/compile failures).
    transients_tolerated: int = 0
    mask_auto_extensions: int = 0
    repair_skips: int = 0
    # HEALTHY-MODEL REPAIR SUPPRESSION + LLM-TIMEOUT BACKOFF telemetry (Run-28).
    # `repair_suppressed_healthy` = divergences where the PRIOR window (excluding the failing tail)
    # still held >= repair_trigger_pass_rate, so repair was suppressed and the loop went straight to
    # the LLM-free exploration/reactive path (the Run-27 storm this closes). `llm_timeouts` = decide
    # calls that failed on a client timeout (each burns the full ~60-120s). `repair_timeout_backoff_tripped`
    # = the run stopped repairing for the rest of the game after `repair_timeout_backoff` consecutive
    # timed-out decide calls.
    repair_suppressed_healthy: int = 0
    llm_timeouts: int = 0
    repair_timeout_backoff_tripped: bool = False
    # INTERACTION DISCOVERY telemetry (Run-19). `interactions_probed` = untried (action, context)
    # pairs actually fired (non-movement action with the player adjacent to a distinct object class);
    # `interactions_found` = probes whose real result changed cells BEYOND the known auto-changing
    # region — a genuine discovery recorded as a game-scoped interaction note.
    interactions_probed: int = 0
    interactions_found: int = 0
    # BUMP PROBES telemetry (Run-20). `bumps_probed` = contact bumps fired (movement INTO a distinct
    # object class, repeated per target) when the non-movement vocabulary was empty; `bumps_found` =
    # bumps whose real result changed cells beyond blocked/no-op and the auto-changing region (a moved/
    # recolored/vanished object, a score delta, or newly reachable ground) — a genuine contact mechanic.
    bumps_probed: int = 0
    bumps_found: int = 0
    # STRIDE-AGNOSTIC CONTACT DISCOVERY telemetry (Run-27). The old bump path hardcoded UNIT-STEP
    # adjacency (approach cell orthogonally adjacent to the object, unit bump direction), so a
    # STRIDE-N mover (ls20 steps ±5 per the adopted program) never lands adjacent -> _plan_to_cell
    # None -> bumps_probed=0 despite bump_due_batches>0. Contact is now the game's OWN movement
    # geometry: `movement_stride` is the inferred per-action delta magnitude (1 for a unit mover,
    # N for a stride-N mover); `reachable_cell_count` is the size of the model's movement lattice
    # (distinct player positions reachable from the current state); `contact_probes_probed` /
    # `contact_probes_found` count moves whose destination lands ON or whose swept path CROSSES a
    # distinct object class (a superset of the old bump counters — bumps_* still counts fired env
    # actions). For a unit mover the geometry reduces to the old adjacency behavior.
    movement_stride: int | None = None
    reachable_cell_count: int = 0
    contact_probes_probed: int = 0
    contact_probes_found: int = 0
    # CROSS-RUN COVERAGE PERSISTENCE telemetry (Run-20). `coverage_resumed_pct` = fraction of the board
    # RESUMED from a prior run's persisted coverage note at ORIENT (0.0 on a fresh sweep / KB miss).
    # `coverage_persisted` = True once this run's end-of-run coverage note write succeeded.
    coverage_resumed_pct: float = 0.0
    coverage_persisted: bool = False
    # BUMP DIAGNOSTICS (Run-23). Make a silent bump-quota drop IMPOSSIBLE to miss: every time the quota
    # says a bump is DUE but `_bump_discovery` fires nothing, record WHY (no player found, no bump
    # contexts, no movement action, unreachable, dedup-exhausted). `player_colors` echoes the inferred
    # player color set — a value that is NOT the live avatar color means the color-2 pathology returned.
    bump_due_batches: int = 0        # exploration batches where the quota said a bump was due
    bump_empty_batches: int = 0      # of those, batches where _bump_discovery fired nothing (None)
    bump_skip_reason: str | None = None  # last reason a due bump fired nothing (None once a bump fires)
    player_colors: list[int] | None = None  # inferred player color set (echoed for the config echo)
    # MIN-BUMP HOIST telemetry (Run-32). Runs 31-32 fired ZERO bumps (bump_due_batches=0 despite 76
    # and 102 actions) because exploration only ran when a plan came back empty AND goal discovery was
    # ready — a window ~97%-reactive runs never open (run 30 hit it once: bumps_probed=8, found=5).
    # `hoisted_bump_batches` = exploration batches run directly from the main turn loop IN PLACE of a
    # reactive/RECOVER turn to honor the `exploration_min_bump_actions` floor.
    hoisted_bump_batches: int = 0
    # FRONTIER HOIST telemetry (Run-38). Run-37 froze coverage at 13.01%: the Run-32 hoist only fired
    # while the min-bump floor was unmet, so once bumps were satisfied every hoist-eligible turn fell
    # back to reactive and the frontier never ran (frontier_batches=0). `hoisted_frontier_batches` =
    # exploration batches hoisted from the main turn loop AFTER the bump phase (floor met or bump
    # discovery exhausted) to keep growing coverage, with a 3-zero-growth-batch anti-spin standdown.
    hoisted_frontier_batches: int = 0
    # REACH PROBES telemetry (Run-39). `reach_probes` = executed reach attempts (an empirical walk
    # toward a rare special cell, plus the one step INTO the target direction when the walk settles
    # off-lattice); `reach_arrived` = attempts where the mover FOOTPRINT actually covered the target
    # cell on the OBSERVED frame — the navigate-to-target win hypothesis test.
    reach_probes: int = 0
    reach_arrived: int = 0
    # HOIST PHASE echo (Run-40). The LAST hoist phase that actually RAN this run — "bump", "reach"
    # or "frontier" — or "stood_down" when a hoist-eligible turn found every phase stood down. Run 39
    # was undiagnosable from the counters alone (reach_probes=0 could be "no targets" OR "the phase
    # never engaged"); this echo makes the dispatch visible. None until the hoist first decides.
    hoist_phase: str | None = None
    # EMPIRICAL APPROACH WALK (Run-27). The adopted program systematically mispredicts the player
    # mover, so ANY expect-gated approach walk aborts — the Run-26 single re-plan retry engaged and
    # ALSO diverged (run-27: bump_skip_reason="approach walk aborted before bump (diverged)" on both
    # due batches, bumps_probed=0). Approach walks are now per-step empirical (act ONE action with no
    # expect grids, observe, re-plan from the REAL frame); `approach_retries` counts the re-plans
    # taken during those walks (every plan beyond a walk's first).
    approach_retries: int = 0
    # CONFIG ECHO (Run-23). The EFFECTIVE knob values that actually reached the agent, so a dropped
    # config field (the Run-22 live-silent hypothesis) is visible in the summary FOREVER rather than
    # inferred from a zero counter. Populated by `_finalize_telemetry` from the live config.
    config_echo: dict[str, Any] | None = None

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
            "orient_kb_attempts": self.orient_kb_attempts,
            "transients_tolerated": self.transients_tolerated,
            "mask_auto_extensions": self.mask_auto_extensions,
            "repair_skips": self.repair_skips,
            "repair_suppressed_healthy": self.repair_suppressed_healthy,
            "llm_timeouts": self.llm_timeouts,
            "repair_timeout_backoff_tripped": self.repair_timeout_backoff_tripped,
            "interactions_probed": self.interactions_probed,
            "interactions_found": self.interactions_found,
            "bumps_probed": self.bumps_probed,
            "bumps_found": self.bumps_found,
            "movement_stride": self.movement_stride,
            "reachable_cell_count": self.reachable_cell_count,
            "contact_probes_probed": self.contact_probes_probed,
            "contact_probes_found": self.contact_probes_found,
            "coverage_resumed_pct": self.coverage_resumed_pct,
            "coverage_persisted": self.coverage_persisted,
            "bump_due_batches": self.bump_due_batches,
            "bump_empty_batches": self.bump_empty_batches,
            "bump_skip_reason": self.bump_skip_reason,
            "player_colors": list(self.player_colors) if self.player_colors else None,
            "hoisted_bump_batches": self.hoisted_bump_batches,
            "hoisted_frontier_batches": self.hoisted_frontier_batches,
            "reach_probes": self.reach_probes,
            "reach_arrived": self.reach_arrived,
            "hoist_phase": self.hoist_phase,
            "approach_retries": self.approach_retries,
            "config_echo": dict(self.config_echo) if self.config_echo else None,
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
        # LLM-TIMEOUT BACKOFF (Run-28): consecutive timed-out decide calls, and the latch that stops
        # repair for the rest of the game once `repair_timeout_backoff` consecutive timeouts fire. A
        # non-timeout LlmError or a successful decide resets the consecutive counter; the latch, once
        # set, stays set (a run that has proven the endpoint is timing out should not keep paying it).
        self._consecutive_llm_timeouts = 0
        self._repair_backoff_tripped = False
        # DIVERGENCE TOLERANCE runtime sanity cap (Run-18): per divergence SIGNATURE, the count of
        # consecutive REPAIR candidates that failed extract/compile; once a signature reaches
        # config.repair_sanity_cap it is halted (added to _repair_halted_signatures) and no further
        # repair is attempted for it this game. A signature clears from the failure map the moment a
        # repair candidate for it compiles, so the cap only bites identical-failure loops.
        self._repair_signature_failures: dict[str, int] = {}
        self._repair_halted_signatures: set[str] = set()
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
        # INTERACTION DISCOVERY (Run-19): fired-probe dedup set. Each entry is (action, object_hash)
        # so a given non-movement action is tried at most once against each distinct object class per
        # run. object_hash is None for the "no adjacent object" (probe in place) fallback context.
        self._fired_probes: set[tuple[str, Any]] = set()
        # BUMP re-probe guard (Run-25 fix): PER-RUN dedup for contact bumps only. Created fresh here every
        # run and NEVER persisted/loaded, so a fresh game instance re-probes each distinct object class once
        # even when the persisted coverage note already carries that object's bump key. object_hashes are
        # translation-invariant, so routing bump dedup through the persisted _fired_probes permanently
        # suppressed bumps across runs (we have never observed a bump effect); this set governs bump SKIP
        # within a single run instead.
        self._bump_attempted: set[Any] = set()
        # CROSS-RUN BUMP COMPOUNDING (Run-38): run-37 proved the persisted coverage note round-trips
        # with probes=[] — nothing ever wired fired bumps into _fired_probes after the Run-25 split,
        # so runs 33/34/37 each re-bumped the SAME 12 objects. `_fired_bump_objects` collects the
        # object_hash of every bump that actually FIRED this run (recorded in _fire_bump — the durable,
        # translation-invariant identity bump dedup keys on); _persist_coverage writes them as
        # (<bump>, object_hash) probe tokens. `_resumed_bump_probes` holds the object_hashes recalled
        # from prior runs' persisted probes. It is ADVISORY ORDERING context only (prefer-not-exclude):
        # _bump_contexts ranks resumed-probed objects LAST so untried objects go first, but they stay
        # bumpable when nothing new remains (the board can change) and NEVER feed _bump_attempted —
        # the Run-25 per-run dedup semantics are intact.
        self._fired_bump_objects: set[Any] = set()
        self._resumed_bump_probes: set[Any] = set()
        # REACH PROBES (Run-39) state, mirroring the bump sets above. `_reach_attempted` = PER-RUN
        # dedup of target hashes whose reach attempt executed (never persisted, so a fresh run
        # retries each rare target once). `_fired_reach_targets` = targets whose attempt actually
        # executed this run — _persist_coverage writes them as (<reach>, target_hash) probe tokens.
        # `_resumed_reach_probes` = target hashes recalled from prior runs' persisted tokens:
        # ADVISORY ORDERING only (prefer-not-exclude) — _reach_targets ranks them LAST so
        # compounding runs try new special cells first. `_reach_empty_streak` = consecutive reach
        # attempts that neither ARRIVED nor changed any non-auto cell; at 3 the reach phase stands
        # down for the REST OF THE RUN (no re-arm — a blocked mover cannot spin on reach walks).
        self._reach_attempted: set[Any] = set()
        self._fired_reach_targets: set[Any] = set()
        self._resumed_reach_probes: set[Any] = set()
        self._reach_empty_streak = 0
        # Movement-coverage plateau counter: consecutive frontier batches that added NO new coverage
        # cell. The movement frontier is EXHAUSTED once this reaches `coverage_plateau_exhaust` — the
        # honest signal that the reachable region is fully swept even though explore_frontier still
        # returns a (redundant) plan. Reset whenever a batch grows coverage.
        self._coverage_plateau = 0
        # BUMP QUOTA INTERLEAVE (Run-22): total env actions executed during frontier exploration
        # batches (movement). Paired with `summary.bumps_probed` (contact-bump actions), it drives the
        # running quota ratio that decides whether the NEXT exploration batch is frontier or bump.
        self._explore_frontier_actions = 0
        # MIN-BUMP HOIST anti-spin guard (Run-32): consecutive hoisted batches that fired NO new bump,
        # plus the bumps_probed watermark used to re-arm the hoist the moment ANY bump fires (hoisted
        # or not). At 3 consecutive empty hoisted batches the hoist stands down and the normal
        # reactive path runs, so an env with nothing left to bump cannot spin on exploration forever.
        self._hoist_empty_streak = 0
        self._hoist_bumps_seen = 0
        # FRONTIER HOIST anti-spin guard (Run-38), mirroring the bump guard above: consecutive hoisted
        # frontier batches that grew NO coverage, plus the coverage-cell watermark used to re-arm the
        # frontier hoist the moment ANY batch grows coverage (hoisted or not). At 3 consecutive
        # zero-growth hoisted frontier batches the frontier hoist stands down and the normal reactive
        # path runs, so a fully-swept board cannot spend every reactive turn re-entering exploration.
        self._frontier_hoist_empty_streak = 0
        self._hoist_coverage_seen = 0
        # PLAYER COLOR SET (Run-23): the color(s) the ACTIVE program's player unit renders as, inferred
        # model-agnostically from the program (the cells that MOVE when the program steps ARE the player)
        # and cached. `_player_position`/`_bump_player_cells` key off `_player_color_set`, not a
        # hardcoded color 2 — the Run-17..22 live silent-drop was that the color-2 scan returned None on
        # every live frame and bump discovery no-oped silently. None until first derived; falls back to
        # {2} (the toy/dev avatar) when no program can demonstrate a move. This PROGRAM-inferred set is
        # the fallback/candidate set only (Run-29): on ls20 it is over-broad ({9,12} where only color 12
        # actually moves), so `_player_color_set` narrows it to the OBSERVED mover colors once real
        # moves are measured.
        self._player_colors: frozenset[int] | None = None
        self._player_colors_for: Any = None  # the program identity the cached color set was derived from
        # MOVEMENT LATTICE (Run-27): per-adopted-program cache of the player's per-action deltas — the
        # full (dr, dc) each action translates the player by, NOT filtered to unit steps. The stride is
        # the min nonzero L-inf magnitude across those deltas (1 for a unit mover, N for a stride-N
        # mover). Contact probing keys off THIS geometry, so a sparse-lattice stride-N mover reaches
        # objects it can never stand adjacent to. Keyed on program identity so a drop/re-adopt (which
        # can change the mover) invalidates it. None until first derived.
        self._player_deltas: dict[tuple[int, int], Any] | None = None
        self._player_deltas_for: Any = None
        # OBSERVED delta map (Run-28): per-action player translations measured from REAL suite
        # transitions, never the model. Run 26 proved the adopted ls20 program systematically
        # mispredicts the 5-stride mover and run 28 proved the empirical walk chased into its step
        # cap because every geometry consumer above still steered by MODEL physics. When this map is
        # non-empty it takes precedence over the model BFS in _player_delta_map. Cache keyed on
        # suite length (so it refreshes as transitions accrue) plus program identity (the player
        # color set the measurement scans for is program-derived). None until first derived.
        self._observed_deltas: dict[Any, tuple[int, int]] | None = None
        self._observed_deltas_key: tuple[int, Any] | None = None
        # OBSERVED MOVER COLORS (Run-29): the subset of candidate (program-inferred) player colors
        # with at least one rigid move measured in the suite. Run 29 live proved the Run-23 program
        # inference is over-broad on ls20 ({9,12}): color 12 is the TRUE mover (perfect stride-5
        # rigid translations) while color 9 is 45 STATIC decoration cells that never move — the
        # union-based rigidity check therefore measured ZERO moves on 47 real transitions, and
        # _player_position planned every walk from a static color-9 cell. Measured per color in the
        # same pass as _observed_deltas and cached under the same key. None until first derived.
        self._observed_movers: frozenset[int] | None = None
        # Parallel single-step flags for the suite (Run-28): _observed_delta_map must measure only
        # SINGLE-action transitions — a multi-action batch is recorded as ONE grid-in/grid-out
        # transition, so its player delta is a COMPOUND of several moves (three stride-2 steps read
        # as a bogus stride-6 action). Indices missing from this list (transitions seeded directly
        # into the suite by tests/tools) are treated as single-step.
        self._suite_single_step: list[bool] = []
        # Fast-path trust flag: True while the last window of live predictions all passed. Toggling it
        # off restores full decide/reflect cadence + normal batch sizes on the very next turn.
        self._model_trusted = False
        # Level/score seen on the previous turn, to detect a boundary crossing during exploration.
        self._prev_level: Any = None
        self._prev_boundary_score: Any = None
        self._artifacts_ready = False  # lazily mkdir the artifacts dir on first write
        # ORIENT RETRY (Run-17): the sleep used between backoff attempts. Injectable so tests exercise
        # the retry loop without real wall-clock delays.
        self._sleep: Callable[[float], None] = time.sleep
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
        try:
            resp = client.chat(
                messages,
                max_tokens=self.config.decide_max_tokens if max_tokens is None else max_tokens,
                temperature=0.0,
            )
        except LlmError as exc:
            # Run-16 crash fix: a timed-out/failed decide call must degrade to an unusable response
            # — the callers already handle that (reactive falls back to a probe action; a SYNTHESIZE/
            # REPAIR candidate simply fails extract/compile) — never crash the whole run. Run 16's
            # first live attempt died 17 minutes in when one REPAIR decide hit the client timeout and
            # the LlmError propagated uncaught through _handle_divergence -> run().
            print(f"[ewm] decide LLM call failed (degrading): {exc!r}", file=sys.stderr)
            # LLM-TIMEOUT BACKOFF (Run-28): a timeout burns the FULL client timeout for nothing.
            # Track consecutive timeouts; a non-timeout error resets the streak. Once the streak
            # reaches config.repair_timeout_backoff, latch the backoff so _handle_divergence stops
            # entering REPAIR for the rest of the game and falls to the LLM-free path.
            if self._is_timeout_error(exc):
                self.summary.llm_timeouts += 1
                self._consecutive_llm_timeouts += 1
                backoff = max(0, self.config.repair_timeout_backoff)
                if backoff and self._consecutive_llm_timeouts >= backoff:
                    if not self._repair_backoff_tripped:
                        self._repair_backoff_tripped = True
                        self.summary.repair_timeout_backoff_tripped = True
            else:
                self._consecutive_llm_timeouts = 0
            return ""
        self._consecutive_llm_timeouts = 0
        return str(resp.get("content", "")) if isinstance(resp, dict) else str(resp)

    @staticmethod
    def _is_timeout_error(exc: LlmError) -> bool:
        """True iff an ``LlmError`` originates from a client TIMEOUT (vs any other transport failure).

        ``LlmClient.chat`` wraps the underlying exception both as ``__cause__`` (``raise ... from exc``)
        and textually in the message (``chat completion failed: TimeoutError(...)``). We check the
        cause chain first (authoritative) and fall back to the message text so a ``FakeLlm`` that
        raises ``LlmError("... timed out ...")`` in a test is classified without a real socket."""

        cause = exc.__cause__ or exc.__context__
        if isinstance(cause, TimeoutError):
            return True
        text = f"{exc!r}".lower()
        return "timeout" in text or "timed out" in text

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
        # Keep the single-step flag list aligned with the suite even when transitions were seeded
        # into it directly (tests/tools): missing indices count as single-step (Run-28).
        while len(self._suite_single_step) < len(self.suite):
            self._suite_single_step.append(True)
        self._suite_single_step.append(bool(single_step))
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

        ORIENT RETRY (Run-17): a KB call that FAILS on a daemon timeout (client.last_search_failed) is
        retryable — the stored program may still be there — not an absence. When ``_orient_once``
        returns no adoption AND the last KB call failed on a network error, retry up to
        ``orient_retries`` times with the ``orient_retry_backoff`` schedule; only after the retries are
        exhausted (or a real empty/rejecting result comes back) does ORIENT fall through to SYNTHESIZE.
        """

        if len(self.suite) == 0:
            self.summary.orient_diagnosis = "empty suite"
            return False
        attempts = max(0, self.config.orient_retries)
        for attempt in range(attempts + 1):
            self.summary.orient_kb_attempts += 1
            if self._orient_once(frame):
                return True
            # Retry only when the KB call actually FAILED on a network error (a retryable daemon
            # timeout). A genuine empty result (or a resolved-but-rejected program) is NOT retryable.
            if attempt >= attempts or not self._kb_call_failed():
                break
            backoff = self.config.orient_retry_backoff
            delay = backoff[attempt] if attempt < len(backoff) else (backoff[-1] if backoff else 0.0)
            self.summary.orient_diagnosis = (
                f"daemon timeout, retrying ORIENT (attempt {attempt + 1}/{attempts})"
            )
            if delay > 0:
                self._sleep(delay)
        return False

    def _kb_call_failed(self) -> bool:
        """True iff the KB client reports its LAST call failed on a network error (retryable daemon
        timeout), as opposed to a clean empty result. False when there is no client (offline)."""

        client = getattr(self.kb, "client", None) if self.kb is not None else None
        return bool(getattr(client, "last_search_failed", False))

    def _orient_once(self, frame: dict[str, Any]) -> bool:
        """A single ORIENT KB lookup + revalidation pass (no retry). Returns True on adoption."""

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

    @staticmethod
    def _divergence_signature(report: ValidationReport) -> str:
        """A stable key identifying WHICH divergence a repair is targeting, for the runtime sanity
        cap. Derived from the first-failure action + the first few mismatch cell coordinates, so two
        divergences on the same action failing on the same cells share a signature and their
        extract/compile failures accumulate together."""

        cells = tuple((m[0], m[1]) for m in (report.mismatches or [])[:4])
        return f"{report.fail_action!r}|{cells}"

    def _note_repair_extract_failure(self, signature: str) -> None:
        """Record one extract/compile failure for ``signature``; halt the signature once it reaches
        ``config.repair_sanity_cap`` consecutive failures (logged for the dev-time pass)."""

        count = self._repair_signature_failures.get(signature, 0) + 1
        self._repair_signature_failures[signature] = count
        if count >= self.config.repair_sanity_cap:
            self._repair_halted_signatures.add(signature)

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
        # RUNTIME REPAIR SANITY CAP (Run-18): a divergence SIGNATURE that has already burned
        # config.repair_sanity_cap consecutive extract/compile failures is halted for the game — no
        # further LLM repair is attempted for it (qwen was 0-for-18 across runs 15-17; identical
        # candidates fail identically). The signature clears the moment any candidate for it compiles.
        signature = self._divergence_signature(report)
        if (
            self.config.divergence_tolerance
            and signature in self._repair_halted_signatures
        ):
            self.summary.repair_skips += 1
            return False
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
                    self._note_repair_extract_failure(signature)
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
                self._note_repair_extract_failure(signature)
                if signature in self._repair_halted_signatures:
                    break
                continue
            # The candidate compiled: this signature is no longer stuck in an extract/compile loop.
            self._repair_signature_failures.pop(signature, None)
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

    def _player_color_set(self) -> frozenset[int]:
        """The color(s) of the player unit — OBSERVED-first (Run-29): when at least one candidate
        color has been SEEN to move rigidly in the suite, the player set is exactly those mover
        colors (:meth:`_observed_mover_colors`); otherwise the program-based inference
        (:meth:`_program_player_colors`) unchanged.

        Run 29 live proved the Run-23 program inference is over-broad on ls20: it returns {9,12},
        but offline analysis of the 47-transition suite shows color 12 is the TRUE mover (a 2x5
        block making perfect stride-5 rigid translations) while color 9 is 45 STATIC decoration
        cells board-wide that never move. The over-broad set broke two things: the union-based
        rigidity check merged static+moving cells ("non-rigid" -> empty observed map -> model
        fallback), and ``_player_position`` returned the FIRST player-colored cell in row order — a
        static color-9 cell — so every walk planned from a position that never moves.

        CACHE COHERENCE: the observed branch is keyed on suite length via the
        :meth:`_observed_mover_colors` cache, so an early empty-suite result never pins the
        program-inferred set — the moment a real move is measured, the set narrows to the mover."""

        movers = self._observed_mover_colors()
        if movers:
            return movers
        return self._program_player_colors()

    def _program_player_colors(self) -> frozenset[int]:
        """The color(s) the ACTIVE program's player unit renders as — inferred model-agnostically and
        cached (Run-23). Callers want :meth:`_player_color_set`, which narrows THIS candidate set to
        the OBSERVED mover colors once real moves are measured (Run-29 — on ls20 this inference is
        over-broad: {9,12} where only color 12 actually moves).

        THE LIVE WIRING GAP THIS CLOSES: the ls20 live player renders as color 12 (the dev program
        flood-fills the player from color 12 linked to color 9, so this inference reports {9,12}),
        NOT the ARC avatar color 2. The old color-2 scan in ``_player_position``/``_bump_player_cells``
        therefore returned None/empty on every live frame, so ``_bump_contexts`` was empty,
        ``_bump_discovery`` returned None, and the bump quota fired 0 bumps SILENTLY across
        Runs 17-22 while every toy test (avatar color 2) passed.

        Inference: step the program from its init state and diff the rendered before/after grids — the
        cells that CHANGE are exactly the moving player unit (the same model-agnostic principle
        ``_update_coverage`` already uses). Collect the colors on those cells. Falls back to ``{2}`` when
        no program is adopted or no action demonstrates a move (the toy/dev avatar)."""

        program = self.program
        # Cache keyed on the ACTIVE program identity: a drop/re-adopt (which can change the player
        # rendering) invalidates it, so a stale color set never outlives the program it was derived from.
        if self._player_colors is not None and self._player_colors_for is program:
            return self._player_colors
        colors: set[int] = set()
        if program is not None:
            try:
                frame = self._observe()
                grid0 = self._frame_grid(frame)
                start = program.init_state(grid0)
                base = program.render(start)
                for action in (frame.get("valid_actions") or []):
                    try:
                        ns, _ev = program.step(start, action)
                        after = program.render(ns)
                    except Exception:  # noqa: BLE001
                        continue
                    if _grid_shape(base) != _grid_shape(after):
                        continue
                    for brow, arow in zip(base, after):
                        for b, a in zip(brow, arow):
                            if b != a:
                                # Per-cell guard (Run-23 live finding): the ls20 program renders
                                # UNKNOWN sentinels at some moving cells; a non-int sentinel must
                                # discard THAT cell only, never the whole color set (int(UNKNOWN)
                                # raising out of this loop was the fallback-to-{2} failure observed
                                # live on run 23 — player_colors=[2] despite the {9,12} player).
                                for v in (b, a):
                                    if _is_unknown(v):
                                        continue
                                    try:
                                        iv = int(v)
                                    except Exception:  # noqa: BLE001 - non-int sentinel: skip cell
                                        continue
                                    if iv != 0:
                                        colors.add(iv)
            except Exception:  # noqa: BLE001 - inference must never crash the loop
                colors = set()
        self._player_colors = frozenset(colors) if colors else frozenset({2})
        self._player_colors_for = program
        return self._player_colors

    def _player_position(self, grid: list[list[int]]) -> tuple[int, int] | None:
        """The player unit's (row, col) in ``grid``. The player color(s) come from
        ``_player_color_set`` — NOT a hardcoded color 2 — so the live ls20 player is found rather
        than silently missed. Observed-first narrowing (Run-29) is what makes this the REAL mover:
        with the over-broad program set ({9,12}) the first player-colored cell in row order was a
        static color-9 decoration cell, so every walk planned from a position that never moves;
        once moves are observed the scan tracks only the mover color(s) (ls20: {12}). None when no
        player-colored cell exists."""

        colors = self._player_color_set()
        for r, row in enumerate(grid):
            for c, v in enumerate(row):
                if v in colors:
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
        coverage_resumed = False

        for turn in range(self.config.max_turns):
            self.summary.turns = turn + 1
            frame = self._observe()

            # Coverage denominator: the board cell count, captured on the first real observation.
            if not self._board_cell_count:
                self._board_cell_count = self._board_cells(frame)

            # CROSS-RUN COVERAGE RESUME (Run-20): once the board is known, load a prior run's persisted
            # coverage note ONCE so the frontier resumes instead of re-sweeping. Before ORIENT runs, so
            # a recalled program's frontier explorer never re-visits ground a prior run already swept.
            if not coverage_resumed:
                coverage_resumed = True
                self._resume_coverage(frame)

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
                # MIN-BUMP HOIST (Run-32): while the exploration_min_bump_actions floor is unmet,
                # spend this reactive turn on ONE exploration batch instead — runs 31-32 fired zero
                # bumps because ~97% of turns landed here and the plan-empty + goal-discovery-ready
                # exploration window below never opened (see _hoist_bump_batch).
                hoisted = self._hoist_bump_batch(frame)
                if hoisted is not None:
                    result, diverged = hoisted
                    if self._result_done(result):
                        self.summary.won = True
                        self.summary.stop_reason = "won"
                        break
                    if diverged:
                        self._handle_divergence(frame, decide_image)
                    prev_frame = frame
                    continue
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
                    result, diverged, last_frame = self._explore_frontier_loop(frame)
                    if self._result_done(result):
                        self.summary.won = True
                        self.summary.stop_reason = "won"
                        break
                    if diverged:
                        self._handle_divergence(last_frame, decide_image)
                    else:
                        self._repairs_this_divergence = 0
                        self._failure_cycles = 0
                    prev_frame = last_frame
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
                #
                # MIN-BUMP HOIST (Run-32): before burning this turn on a blind reactive probe, honor
                # the min-bump floor with ONE exploration batch — INDEPENDENT of _goal_discovery_ready
                # (runs 31-32: that gate never opened, so contact probing was luck-gated to zero).
                hoisted = self._hoist_bump_batch(frame)
                if hoisted is not None:
                    result, diverged = hoisted
                    if self._result_done(result):
                        self.summary.won = True
                        self.summary.stop_reason = "won"
                        break
                    if diverged:
                        self._handle_divergence(frame, decide_image)
                    elif self._live_diverged():
                        # Same live-divergence REPAIR engagement as the reactive fallback below
                        # (Run-14): an empirical bump batch carries no expect grids, so a
                        # mispredicting program only surfaces through the observed-transition check.
                        self._handle_divergence(frame, decide_image)
                    prev_frame = frame
                    continue
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
        # CROSS-RUN COVERAGE PERSISTENCE (Run-20): persist the swept ground (visited cells + fired
        # probes + plateau) so the next run resumes the frontier instead of re-sweeping. Best-effort.
        self._persist_coverage()
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

    def _explore_frontier_loop(
        self, frame: dict[str, Any]
    ) -> tuple[dict[str, Any], bool, dict[str, Any]]:
        """LLM-FREE EXPLORATION EXECUTOR (Run-17): loop CPU-plan -> execute frontier batch -> re-plan
        the NEXT frontier from the resulting frame, all with ZERO decide calls, while the model stays
        trusted. The LLM re-enters only on an expect-mismatch (``diverged``) or frontier exhaustion —
        both break the loop and return control to :meth:`run`, which then does the single strategy
        decide (REPAIR) or falls through. Reflect stays log-only throughout (skipped by the fast path
        while trusted). Bounded by ``max_frontier_batches_per_turn`` so a broken explorer can't spin.

        Returns ``(last_result, diverged, last_frame)``. When ``exploration_executor`` is off this runs
        exactly one batch (the Run-16 behaviour).

        BUMP QUOTA INTERLEAVE (Run-22): each batch is dispatched through :meth:`_explore_batch`, which
        runs a CONTACT-BUMP batch instead of a frontier batch whenever the running bump quota is due
        (:meth:`_bump_quota_due`). This makes bump probing a first-class share of the action budget from
        action 1 — not an exhaustion-gated fallback — so a frontier that never plateaus still probes the
        contact win.
        """

        result, diverged = self._explore_batch(frame)
        last_frame = frame
        if not self.config.exploration_executor:
            return result, diverged, last_frame
        batches = 1
        cap = max(1, self.config.max_frontier_batches_per_turn)
        # Keep looping zero-decide batches only while the model is still trusted, the last batch held
        # (no divergence), the run is not done, and we are under budget + the per-turn cap. Any of
        # those failing hands control back to run() — the LLM re-enters there if needed.
        while (
            batches < cap
            and not diverged
            and not self._result_done(result)
            and self._model_trusted
            and self._goal_discovery_ready()
        ):
            next_frame = self._observe()
            if next_frame.get("done") or self._out_of_budget(next_frame):
                last_frame = next_frame
                break
            last_frame = next_frame
            batches += 1
            result, diverged = self._explore_batch(next_frame)
        return result, diverged, last_frame

    def _explore_batch(self, frame: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        """Dispatch ONE exploration batch: a CONTACT-BUMP batch when the running quota is due, else a
        FRONTIER movement batch (Run-22).

        The bump-quota interleave makes contact probing a first-class share of the exploration action
        budget from the very first batch, rather than waiting for the frontier to plateau. When
        :meth:`_bump_quota_due` says the bump share has fallen below ``bump_quota_fraction`` (or the
        ``exploration_min_bump_actions`` floor is unmet), run :meth:`_bump_discovery`; a None result
        (nothing left to bump — every object class already deduped) falls through to a frontier batch so
        the turn still makes progress. Otherwise run the normal frontier batch. Frontier-batch action
        counts feed the quota denominator via ``_explore_frontier_actions``."""

        if self._bump_quota_due():
            # SILENT-DROP GUARD (Run-23): count every batch where the quota said a bump was DUE, and —
            # when the bump fires nothing — count that too and record WHY (set on self.summary by
            # _bump_discovery). A due batch that fires no bump is the exact live pathology (bumps_probed
            # stuck at 0 while the quota kept saying "due"); it is now visible in the summary, not silent.
            self.summary.bump_due_batches += 1
            before = self.summary.bumps_probed
            probed = self._bump_discovery(frame)
            if probed is not None and self.summary.bumps_probed > before:
                # A bump batch may open new ground: reset the plateau so the frontier re-sweeps.
                self._coverage_plateau = 0
                return probed
            # Nothing bumped: either dedup exhausted the object set, or (the live bug) the player/context
            # inference found nothing. bump_skip_reason (set in _bump_discovery) says which.
            self.summary.bump_empty_batches += 1
            if probed is not None:
                return probed
        return self._frontier_execute(frame)

    def _bump_quota_due(self) -> bool:
        """True iff the NEXT exploration batch should be a CONTACT-BUMP batch to hold the quota (Run-22).

        Two conditions make a bump due, checked against the running counts (``bumps_probed`` contact-bump
        actions vs ``_explore_frontier_actions`` frontier-movement actions):

        - MIN-BUMP GUARANTEE: fewer than ``exploration_min_bump_actions`` bumps have fired -> due, so a
          tight action budget still gets its guaranteed contact probes before the frontier eats it all.
        - RATIO QUOTA: the bump share of executed exploration actions has fallen below
          ``bump_quota_fraction`` -> due, so ~40% of actions are contact bumps from action 1.

        Returns False when bumping is disabled (``bump_probes`` off or ``bump_quota_fraction`` <= 0)."""

        if not self.config.bump_probes or self.config.bump_quota_fraction <= 0.0:
            return False
        bumps = self.summary.bumps_probed
        if bumps < max(0, self.config.exploration_min_bump_actions):
            return True
        total = bumps + self._explore_frontier_actions
        if total <= 0:
            return True  # nothing executed yet: seed the interleave with a bump batch
        return (bumps / total) < self.config.bump_quota_fraction

    def _hoist_bump_batch(
        self, frame: dict[str, Any]
    ) -> tuple[dict[str, Any], bool] | None:
        """EXPLORATION HOIST (Run-32 bumps, Run-38 frontier): run ONE exploration batch from the MAIN
        turn loop, in place of a reactive/RECOVER turn — a BUMP-phase batch while the
        ``exploration_min_bump_actions`` floor is unmet, then FRONTIER batches once the bump phase is
        satisfied or exhausted. Returns the batch's ``(result, diverged)``, or None when the hoist is
        not due this turn (no program, done/over-budget frame, or the active phase's anti-spin
        standdown).

        Run-32 evidence (runs 30-32): exploration previously ran ONLY when a plan came back empty AND
        :meth:`_goal_discovery_ready` held — the model mispredicts movement on nearly every planned
        action, so ~97% of turns are reactive and that window almost never opens (run 30 hit it once:
        bumps_probed=8, bumps_found=5; runs 31-32 never did: bump_due_batches=0 despite 76 and 102
        actions), leaving the Run-22 MIN-BUMP GUARANTEE vacuous. Hoisting the floor into :meth:`run`
        makes contact probing turn-driven, not luck-gated. The hoist is INDEPENDENT of
        _goal_discovery_ready; :meth:`_explore_batch` still dispatches bump-vs-frontier via
        :meth:`_bump_quota_due` (due below the floor), preserving every bump dedup/skip-reason
        semantic unchanged.

        ANTI-SPIN GUARD: 3 consecutive hoisted batches that fire no new bump stand the BUMP hoist down
        until ANY bump fires, so an env with nothing left to bump cannot spend every reactive turn
        re-entering bump discovery.

        FRONTIER HOIST (Run-38): once the bump phase is SATISFIED (the floor is met) or EXHAUSTED
        (the bump anti-spin stood down — nothing left to bump), hoisted turns CONTINUE as FRONTIER
        batches instead of standing down entirely. Run-37 evidence: coverage froze at 13.01% with
        frontier_batches=0 because the hoist only fired below the min-bump floor and the plan-empty +
        goal-discovery-ready exploration window never opened — the same luck-gate Run-32 closed for
        bumps, re-opened for the frontier. The dispatch still goes through :meth:`_explore_batch`
        (which falls through to :meth:`_frontier_execute` when the bump quota is not due), preserving
        every quota/dedup/skip-reason semantic. A mirrored anti-spin guard stands the frontier hoist
        down after 3 consecutive hoisted batches with zero coverage growth, re-armed by ANY coverage
        growth.

        REACH PHASE (Run-39): between the bump phase and the frontier — once the bump floor is
        met/exhausted, hoisted turns first spend themselves LANDING the mover on rare special cells
        (:meth:`_reach_discovery`) while untried targets remain; only when reach finds nothing to do
        (targets exhausted, or its own 3-empty-attempt standdown tripped) does the turn fall through
        to the frontier phase. Run 38 destroyed every color-8/color-11 object with no level, so the
        remaining ls20 win hypothesis is navigate-to-target: occupy the rare color-0/color-1 cells.

        BUMP EXHAUSTION ADVANCES THE PHASE (Run-40): the bump phase dispatches
        :meth:`_bump_discovery` DIRECTLY (mirroring :meth:`_explore_batch`'s bump half
        counter-for-counter), not through :meth:`_explore_batch` — whose empty-bump fall-through
        runs a FRONTIER batch and so BYPASSES the reach phase. Run 39 live: bumps_probed=12 <
        min(24) kept every hoisted turn in the bump phase while bump discovery was exhausted, so
        each one ended in that internal bump->frontier jump: reach_probes=0,
        hoisted_frontier_batches=0, and the run's frontier_batches=2 ran INSIDE hoisted bump
        batches. A due bump batch that finds NOTHING to bump while under the min floor SATISFIES
        the bump phase: the SAME hoisted turn advances to REACH (while untried targets remain),
        then to the frontier — each phase keeping its own anti-spin. ``summary.hoist_phase``
        echoes the phase that actually ran ("bump"/"reach"/"frontier", or "stood_down")."""

        # Re-arm on ANY bump fired since the last check — a bump from the goal-discovery exploration
        # path also clears the standdown.
        if self.summary.bumps_probed > self._hoist_bumps_seen:
            self._hoist_empty_streak = 0
        self._hoist_bumps_seen = self.summary.bumps_probed
        # Re-arm the frontier hoist on ANY coverage growth since the last check (same watermark shape).
        if len(self._coverage_cells) > self._hoist_coverage_seen:
            self._frontier_hoist_empty_streak = 0
        self._hoist_coverage_seen = len(self._coverage_cells)
        if self.program is None:
            return None
        if frame.get("done") or self._out_of_budget(frame):
            return None
        bump_phase = (
            self.summary.bumps_probed < max(0, self.config.exploration_min_bump_actions)
            and self._bump_quota_due()  # False when bump probing is disabled
            and self._hoist_empty_streak < 3  # bump anti-spin standdown -> bump phase exhausted
        )
        bump_exhausted_now = False
        if bump_phase:
            self.summary.hoisted_bump_batches += 1
            # Direct bump dispatch (Run-40), mirroring _explore_batch's bump half exactly: the
            # SILENT-DROP due/empty counters, and the plateau reset when a bump opens new ground.
            # Routing through _explore_batch is what starved reach on run 39 — its empty-bump
            # fall-through runs a frontier batch, skipping the reach phase between them.
            self.summary.bump_due_batches += 1
            before = self.summary.bumps_probed
            probed = self._bump_discovery(frame)
            if probed is not None and self.summary.bumps_probed > before:
                # A bump batch may open new ground: reset the plateau so the frontier re-sweeps.
                self._coverage_plateau = 0
                self._hoist_empty_streak = 0
                self._hoist_bumps_seen = self.summary.bumps_probed
                self.summary.hoist_phase = "bump"
                return probed
            # No bump fired: dedup/objects exhausted, or the approach walk aborted. The empty batch
            # stays visible (Run-23 guard) and still advances the bump anti-spin streak (3 empties
            # stand the bump phase down across turns, as before).
            self.summary.bump_empty_batches += 1
            self._hoist_empty_streak += 1
            self._hoist_bumps_seen = self.summary.bumps_probed
            if probed is not None:
                # Env actions WERE executed (an approach walk ended the batch after an earlier
                # fired bump): the turn is spent — return it as the bump batch it was.
                self.summary.hoist_phase = "bump"
                return probed
            # EXHAUSTED (nothing to bump this turn): under the min floor this SATISFIES the bump
            # phase — fall THROUGH to reach, then the frontier, in this SAME hoisted turn (Run-40;
            # run 39 burned every hoisted turn here with reach_probes=0).
            bump_exhausted_now = True
        # REACH phase (Run-39): bump floor met / exhausted / disabled — while untried rare special
        # cells remain (and the reach anti-spin has not stood the phase down), spend this hoisted
        # turn landing the mover on one. Falls through to the frontier when there is nothing to reach.
        reached = self._reach_discovery(frame)
        if reached is not None:
            self.summary.hoist_phase = "reach"
            return reached
        if bump_exhausted_now:
            # Nothing to reach either: run the frontier batch the empty bump batch fell through to
            # pre-Run-40, with the SAME attribution (part of the bump batch — NOT a hoisted
            # FRONTIER batch, so the frontier phase's own anti-spin bookkeeping stays untouched).
            self.summary.hoist_phase = "frontier"
            return self._frontier_execute(frame)
        # FRONTIER phase: the bump floor is met / exhausted / disabled — keep hoisting to grow coverage.
        if self._frontier_hoist_empty_streak >= 3:
            self.summary.hoist_phase = "stood_down"
            return None  # anti-spin standdown: wait for coverage growth before hoisting again
        self.summary.hoist_phase = "frontier"
        self.summary.hoisted_frontier_batches += 1
        before_cov = len(self._coverage_cells)
        before_bumps = self.summary.bumps_probed
        result, diverged = self._explore_batch(frame)
        if len(self._coverage_cells) > before_cov:
            self._frontier_hoist_empty_streak = 0
        elif self.summary.bumps_probed == before_bumps:
            # Zero growth AND no bump fired: a genuinely empty batch. (A batch the ratio quota spent
            # on bumps is progress, not frontier spin — it must not advance the frontier standdown.)
            self._frontier_hoist_empty_streak += 1
        self._hoist_coverage_seen = len(self._coverage_cells)
        return result, diverged

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
        # BUMP-FIRST (Run-21): when a prior run's coverage was RESUMED, the frontier explorer's next
        # batch can be pure re-sweep — every cell it would visit is already in _coverage_cells. Running
        # that batch wastes an env step AND advances the plateau by only one, compounding the Run-17..20
        # pathology where the budget drains on known ground before discovery ever engages. If the whole
        # predicted batch is already-covered ground, trip the plateau NOW so we hand off to bump/
        # interaction discovery immediately instead of re-sweeping. Only fires when coverage was resumed
        # (a fresh run legitimately sweeps its first batch onto empty coverage).
        if (
            self.summary.coverage_resumed_pct > 0.0
            and frontier is not None
            and frontier.actions
            and self._frontier_fully_covered(frame, frontier)
        ):
            self._coverage_plateau = max(
                self._coverage_plateau, max(1, self.config.coverage_plateau_exhaust)
            )
        # MOVEMENT FRONTIER EXHAUSTED when no action moves the player at all (explore_frontier returned
        # None) OR the reachable region has been fully swept — the Run-18 pathology, where the explorer
        # keeps returning redundant plans that re-visit already-covered ground (coverage plateaus) yet
        # never trips a boundary. When exhausted with no level boundary captured, the win is gated
        # behind an INTERACTION: enter INTERACTION DISCOVERY instead of a blind reactive probe.
        plateaued = self._coverage_plateau >= max(1, self.config.coverage_plateau_exhaust)
        exhausted = frontier is None or not frontier.actions or plateaued
        if exhausted:
            if (
                self.config.interaction_discovery
                and not self.summary.level_boundary_captured
            ):
                probed = self._interaction_discovery(frame)
                if probed is not None:
                    self._coverage_plateau = 0  # a probe may have opened new ground; re-sweep
                    return probed
            if frontier is None or not frontier.actions:
                result = self._reactive_turn(frame, None)
                return result, False
            # No interaction discovery engaged (disabled/nothing new to probe): fall through and run
            # the (redundant) movement batch so the loop still makes an env step and re-evaluates.
        self.summary.frontier_batches += 1
        # Cap the open-loop batch by the budget guard (and the trusted fast-path cap when trusted).
        cap = self.config.fast_path_batch_cap if self._model_trusted else self.config.frontier_max_depth
        frontier = self._cap_plan(frontier, cap)
        before_cov = len(self._coverage_cells)
        result, diverged = self._execute(frontier, frame)
        # BUMP QUOTA denominator (Run-22): count the frontier-movement actions actually executed so the
        # running bump share (bumps_probed / (bumps_probed + frontier actions)) stays honest.
        self._explore_frontier_actions += len(self._executed_actions(result, frontier.actions))
        # Track the coverage plateau: a batch that added no new covered cell advances the counter; any
        # new ground resets it. This is the honest exhaustion signal (real coverage, not predicted).
        if len(self._coverage_cells) > before_cov:
            self._coverage_plateau = 0
        else:
            self._coverage_plateau += 1
        return result, diverged

    def _frontier_fully_covered(
        self, frame: dict[str, Any], frontier: PlanResult
    ) -> bool:
        """True iff EVERY player cell the frontier batch would visit is already in ``_coverage_cells``.

        Bump-first gate (Run-21): the player cell at each predicted step is inferred model-agnostically
        as the cells that DIFFER from the prior grid (same inference as :meth:`_update_coverage`), keyed
        by (level, r, c). If the frontier predicts at least one player cell and ALL of them are already
        covered, the batch is a pure re-sweep of resumed ground — the caller trips the plateau so the
        loop hands off to bump/interaction discovery instead of re-walking known cells. Conservative: an
        empty prediction, a shape mismatch, or any single uncovered cell returns False (do NOT skip a
        batch that might open new ground)."""

        grids = list(frontier.predicted_grids or [])
        if not grids:
            return False
        level = frame.get("level")
        prev = self._frame_grid(frame)
        seen_any = False
        for grid in grids:
            if _grid_shape(prev) != _grid_shape(grid):
                # A shape change is a level/boundary event, never pure re-sweep — bail conservatively.
                return False
            for r, (brow, arow) in enumerate(zip(prev, grid)):
                for c, (b, a) in enumerate(zip(brow, arow)):
                    if b != a:
                        seen_any = True
                        if (level, r, c) not in self._coverage_cells:
                            return False
            prev = grid
        return seen_any

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

    # -- INTERACTION DISCOVERY (Run-19) ------------------------------------------------------------

    @staticmethod
    def _safe_render(program: Any, state: Any) -> list[list[int]]:
        """``program.render(state)`` that returns an empty grid instead of raising."""

        try:
            return program.render(state)
        except Exception:  # noqa: BLE001
            return []

    def _non_movement_actions(self, frame: dict[str, Any]) -> list[Any]:
        """Valid actions that are NOT movement, per the ACTIVE model: an action that moves the player
        (changes the render) in NO reachable state. The frontier explorer has already exhausted every
        action that DOES translate the player; what remains is the interaction vocabulary
        (SPACE/ACTION5/ACTION6/... — whatever the game exposes that is not a translation).

        A translation action can be BLOCKED from the current cell (an edge/wall), so classifying by a
        single init-state step gives false positives. Instead we sample a handful of reachable states
        (a shallow BFS over the model) and call an action MOVEMENT if it changes the render in ANY of
        them; the rest are non-movement. Model-agnostic — no hard-coded action names, so it transfers
        across games."""

        program = self.program
        valid = list(frame.get("valid_actions") or [])
        if program is None:
            return valid
        try:
            start = program.init_state(self._frame_grid(frame))
        except Exception:  # noqa: BLE001
            return valid
        # Shallow BFS to collect a few distinct reachable states to test each action against.
        states = [start]
        seen = {_grids_key(self._safe_render(program, start))}
        frontier = [start]
        for _depth in range(4):
            nxt: list[Any] = []
            for st in frontier:
                for action in valid:
                    try:
                        ns, _ev = program.step(st, action)
                        key = _grids_key(program.render(ns))
                    except Exception:  # noqa: BLE001
                        continue
                    if key not in seen:
                        seen.add(key)
                        states.append(ns)
                        nxt.append(ns)
                        if len(states) >= 24:
                            frontier = []
                            break
                if not frontier:
                    break
            frontier = nxt
            if not frontier:
                break
        moves: set[str] = set()
        for st in states:
            try:
                base = program.render(st)
            except Exception:  # noqa: BLE001
                continue
            for action in valid:
                if str(action) in moves:
                    continue
                try:
                    ns, _ev = program.step(st, action)
                    after = program.render(ns)
                except Exception:  # noqa: BLE001
                    continue
                if not _grids_equal_lists(base, after):
                    moves.add(str(action))
        return [a for a in valid if str(a) not in moves]

    def _adjacent_object_contexts(
        self, grid: list[list[int]]
    ) -> list[tuple[Any, tuple[int, int], int]]:
        """INTERESTING contexts to probe from: for each DISTINCT segmented object class the player is
        NOT already part of, the (object_hash, target_player_cell, reach_cost) to stand adjacent to
        one instance of it.

        Segments the board, then for each object whose translation-invariant hash is distinct, finds
        the empty (background 0) cell orthogonally adjacent to the object that is CLOSEST to the
        player (Manhattan reach cost, a cheap proxy for movement-plan length). Returns one context per
        distinct object hash, sorted CHEAPEST-first so the loop probes the nearest contexts before the
        far ones. The player's own object and the background are skipped."""

        player = self._player_position(grid)
        if player is None:
            return []
        rows = len(grid)
        cols = len(grid[0]) if rows else 0
        player_color = grid[player[0]][player[1]]
        contexts: dict[Any, tuple[int, int, int]] = {}
        for obj_hash, cells in _object_components(grid):
            sample = next(iter(cells))
            color = grid[sample[0]][sample[1]]
            if color == 0 or color == player_color:
                continue  # skip background and the player's own class
            # Empty cells orthogonally adjacent to any cell of this object.
            best: tuple[int, tuple[int, int]] | None = None
            for (br, bc) in cells:
                for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                    ar, ac = br + dr, bc + dc
                    if 0 <= ar < rows and 0 <= ac < cols and grid[ar][ac] == 0:
                        cost = abs(ar - player[0]) + abs(ac - player[1])
                        if best is None or cost < best[0]:
                            best = (cost, (ar, ac))
            if best is None:
                continue
            cost, target = best
            prev = contexts.get(obj_hash)
            if prev is None or cost < prev[2]:
                contexts[obj_hash] = (target[0], target[1], cost)
        out = [
            (obj_hash, (tr, tc), cost)
            for obj_hash, (tr, tc, cost) in contexts.items()
        ]
        out.sort(key=lambda item: item[2])  # cheapest reach first
        return out

    def _movement_direction_map(self, frame: dict[str, Any]) -> dict[tuple[int, int], Any]:
        """Map each axis-aligned player delta ``(dr, dc)`` to the valid action that translates the
        player by it, derived empirically from the ACTIVE model (no hard-coded action names or stride,
        so it transfers across games AND across movers of any stride).

        STRIDE-AGNOSTIC (Run-27): the delta is the model's OWN per-action translation, captured at its
        real magnitude — ``(-1, 0)`` for a unit mover, ``(-5, 0)`` for a stride-5 mover (ls20). The old
        version filtered to ``(abs(dr), abs(dc)) in ((1, 0), (0, 1))`` (unit steps only); for a stride-N
        mover EVERY delta was discarded, the map came back empty, and ``_bump_discovery`` skipped every
        object with "no movement action drives the bump direction". We now keep any axis-aligned delta
        (one of ``dr``/``dc`` zero) at its true magnitude.

        A translation action can be BLOCKED from any single cell (an edge/wall), so probing only the
        init state misses directions the boxed-in avatar cannot demonstrate there. We sample a handful of
        reachable states (a shallow BFS over the model) and, for each, record the ``(dr, dc)`` each action
        moves the player by — so a direction is captured as long as SOME reachable cell can demonstrate
        it. Cached per adopted program (see :meth:`_player_delta_map`). First action seen for a delta
        wins (they are equivalent translations)."""

        return self._player_delta_map(frame)

    def _observed_delta_map(self) -> dict[Any, tuple[int, int]]:
        """Per-action player deltas measured from OBSERVED suite transitions — the REAL movement
        geometry, never the model's (Run-28) — detected PER COLOR (Run-29).

        Run 26 proved the adopted ls20 program systematically mispredicts the 5-stride mover, and
        run 28 proved the empirical walk executes fine but chases into its step cap because it
        steers by MODEL physics. The suite meanwhile holds real ``(before_grid, action,
        after_grid)`` transitions including real moves — so measure the geometry there. Run 29
        proved the measurement must be PER COLOR: the Run-23 program inference is over-broad on
        ls20 ({9,12} where color 9 is 45 static decoration cells), and requiring the UNION of
        player-colored cells to translate rigidly measured ZERO moves on 47 real transitions (the
        static cells never move with the mover, so the union is always "non-rigid"). For each
        candidate color (the program-inferred set) SEPARATELY: where that color's cells TRANSLATED
        rigidly by a single axis-aligned ``(dr, dc) != (0, 0)`` (same cell count, uniform offset),
        record ``action -> delta``; each action maps to its MOST-COMMON observed delta
        (deterministic tie-break by delta). Actions never observed to move are omitted, so an empty
        map means "no real move measured yet" and callers fall back to the model path. Defensive:
        transitions with a shape mismatch (level boundaries) or zero cells of a color are skipped,
        and only SINGLE-step transitions are measured (a multi-action batch is one grid-in/grid-out
        record whose delta compounds several moves — see ``_suite_single_step``).
        Cached keyed on suite length (refreshes as transitions accrue) + program identity (the
        candidate color set scanned for is program-derived)."""

        self._measure_observed_moves()
        return self._observed_deltas or {}

    def _observed_mover_colors(self) -> frozenset[int]:
        """The subset of candidate (program-inferred) player colors with at least one observed
        rigid move in the suite (Run-29) — ls20: {12}, never the static decoration color 9. Empty
        until a real move is measured, so ``_player_color_set`` falls back to the program
        inference. Cached coherently with :meth:`_observed_delta_map` (same suite-length + program
        key), so it refreshes as transitions accrue."""

        self._measure_observed_moves()
        return self._observed_movers or frozenset()

    def _measure_observed_moves(self) -> None:
        """The shared cached measurement behind :meth:`_observed_delta_map` and
        :meth:`_observed_mover_colors` (Run-29): one per-color rigid-translation pass over the
        suite's single-step transitions, filling ``_observed_deltas`` + ``_observed_movers`` under
        one key so the two views can never fall out of sync."""

        key = (len(self.suite), self.program)
        if self._observed_deltas is not None and self._observed_deltas_key == key:
            return
        # Candidates are the PROGRAM-inferred colors, never the observed-first set — the
        # observed-first _player_color_set consumes THIS measurement (circularity guard).
        candidates = self._program_player_colors()
        counts: dict[Any, Counter] = {}
        movers: set[int] = set()
        flags = self._suite_single_step
        for idx, transition in enumerate(self.suite):
            if idx < len(flags) and not flags[idx]:
                # A multi-action batch (or level-crossing) transition: its player delta is a
                # COMPOUND of several moves, not one action's translation — never measure it.
                continue
            before, after = transition.before_grid, transition.after_grid
            if _grid_shape(before) != _grid_shape(after):
                continue  # a level boundary, not a translation
            b_by_color: dict[int, set[tuple[int, int]]] = {}
            for r, row in enumerate(before):
                for c, v in enumerate(row):
                    if v in candidates:
                        b_by_color.setdefault(v, set()).add((r, c))
            a_by_color: dict[int, set[tuple[int, int]]] = {}
            for r, row in enumerate(after):
                for c, v in enumerate(row):
                    if v in candidates:
                        a_by_color.setdefault(v, set()).add((r, c))
            # PER COLOR (Run-29): a static decoration color must never veto the true mover's
            # rigid translation, so each candidate color is tested for rigidity on its own.
            for color in sorted(b_by_color):
                b_cells = b_by_color[color]
                a_cells = a_by_color.get(color, set())
                if len(b_cells) != len(a_cells):
                    continue  # appeared/vanished cells: nothing rigid to measure for this color
                # min() of a rigidly-translated cell set is the translated min, so the offset
                # between the two mins IS the candidate delta; the set equality below verifies
                # rigidity.
                (br, bc), (ar, ac) = min(b_cells), min(a_cells)
                dr, dc = ar - br, ac - bc
                if (dr == 0) == (dc == 0):
                    continue  # no move, or diagonal (not modeled by the contact geometry)
                if {(r + dr, c + dc) for (r, c) in b_cells} != a_cells:
                    continue  # not a uniform translation of this color's whole block
                try:
                    counts.setdefault(transition.action, Counter())[(dr, dc)] += 1
                except TypeError:  # noqa: PERF203 - unhashable action payload: skip defensively
                    break  # unhashable for every color of this transition
                movers.add(color)
        self._observed_deltas = {
            action: max(counter.items(), key=lambda kv: (kv[1], kv[0]))[0]
            for action, counter in counts.items()
        }
        self._observed_movers = frozenset(movers)
        self._observed_deltas_key = key

    def _player_delta_map(self, frame: dict[str, Any]) -> dict[tuple[int, int], Any]:
        """Per-action axis-aligned player deltas at TRUE magnitude — OBSERVED-first (Run-28), with
        the model BFS (:meth:`_model_delta_map`) filling only the actions no real move has measured.

        Run 28's step-cap chase was every geometry consumer steering by a model that systematically
        mispredicts the ls20 mover, so an action WITH observed data contributes its OBSERVED delta
        and its (empirically wrong) model delta is dropped. Actions with no observed measurement yet
        keep their model delta — a half-measured map (only DOWN observed so far) must not blind the
        walk to the other directions; each wrong model delta self-corrects the first time its action
        is seen to really move. Deterministic: sorted key order, first (str-sorted) action wins a
        shared delta. Reduces to the pure model map on an empty suite, and to pure observed geometry
        once every moving action has been measured."""

        observed = self._observed_delta_map()
        model = self._model_delta_map(frame)
        if not observed:
            return model
        merged: dict[tuple[int, int], Any] = {}
        for action in sorted(observed, key=str):  # deterministic when actions share a delta
            merged.setdefault(observed[action], action)
        observed_actions = {str(action) for action in observed}
        for delta, action in model.items():
            if str(action) in observed_actions:
                continue  # empirically superseded: the observed delta replaced this action's
            merged.setdefault(delta, action)
        # Sorted key order so consumers that iterate deltas (tie-breaks in _bump_contexts) stay
        # deterministic across runs.
        return {delta: merged[delta] for delta in sorted(merged)}

    def _model_delta_map(self, frame: dict[str, Any]) -> dict[tuple[int, int], Any]:
        """The MODEL's per-action deltas, cached per adopted program: shallow-BFS over the model to
        gather a few reachable states, then for each state record the ``(dr, dc)`` each valid action
        moves the player by (any axis-aligned translation, whatever the stride). Empty when no
        program is adopted or no action demonstrates a move. Callers want
        :meth:`_player_delta_map`, which overlays OBSERVED geometry on this (Run-28)."""

        program = self.program
        if (
            self._player_deltas is not None
            and self._player_deltas_for is program
        ):
            return self._player_deltas
        out: dict[tuple[int, int], Any] = {}
        if program is None:
            self._player_deltas = out
            self._player_deltas_for = program
            return out
        valid = list(frame.get("valid_actions") or [])
        try:
            start = program.init_state(self._frame_grid(frame))
        except Exception:  # noqa: BLE001
            self._player_deltas = out
            self._player_deltas_for = program
            return out
        # Shallow BFS to collect a few distinct reachable states to probe each action from.
        states = [start]
        seen = {_grids_key(self._safe_render(program, start))}
        frontier = [start]
        for _depth in range(6):
            nxt: list[Any] = []
            for st in frontier:
                for action in valid:
                    try:
                        ns, _ev = program.step(st, action)
                        key = _grids_key(program.render(ns))
                    except Exception:  # noqa: BLE001
                        continue
                    if key not in seen:
                        seen.add(key)
                        states.append(ns)
                        nxt.append(ns)
                        if len(states) >= 32:
                            frontier = []
                            break
                if not frontier:
                    break
            frontier = nxt
            if not frontier:
                break
        for st in states:
            try:
                base = program.render(st)
            except Exception:  # noqa: BLE001
                continue
            p0 = self._player_position(base)
            if p0 is None:
                continue
            for action in valid:
                try:
                    ns, _ev = program.step(st, action)
                    p1 = self._player_position(program.render(ns))
                except Exception:  # noqa: BLE001
                    continue
                if p1 is None or p1 == p0:
                    continue
                dr, dc = p1[0] - p0[0], p1[1] - p0[1]
                # Keep only axis-aligned translations (one component zero) — a diagonal delta would
                # be a compound move the swept-path contact geometry does not model. Any magnitude.
                if (dr == 0) == (dc == 0):
                    continue  # both zero (no move) or both nonzero (diagonal)
                if (dr, dc) not in out:
                    out[(dr, dc)] = action
        self._player_deltas = out
        self._player_deltas_for = program
        return out

    def _movement_stride(self, frame: dict[str, Any]) -> int:
        """The inferred movement STRIDE: the number of cells one action translates the player by along
        an axis, model-derived (:meth:`_player_delta_map`). The min nonzero L-inf magnitude across the
        per-action deltas — 1 for a unit mover, N for a stride-N mover (ls20 is 5). Defaults to 1 when
        no program demonstrates a move (the toy/dev avatar), so contact probing reduces to the old
        unit-step adjacency behavior."""

        deltas = self._player_delta_map(frame)
        mags = [max(abs(dr), abs(dc)) for (dr, dc) in deltas if (dr, dc) != (0, 0)]
        stride = min(mags) if mags else 1
        self.summary.movement_stride = stride
        return stride

    def _reachable_player_cells(self, frame: dict[str, Any]) -> set[tuple[int, int]]:
        """The MOVEMENT LATTICE: the set of player positions reachable from the current state by
        replaying the model's own moves (``planner.explore_frontier`` semantics, but collecting player
        CELLS rather than a plan). Model-derived, no assumed stride: a stride-N mover yields a sparse
        lattice on an N-spacing, a unit mover a dense one. Bounded by the plan budget; deterministic.

        This is what makes contact probing stride-agnostic: an object's contact probe must be planned to
        a LATTICE cell (one the player can actually occupy), never an arbitrary distance-1 approach cell
        the sparse mover can never stand on."""

        # EMPIRICAL-FIRST (Run-28): when real moves have been observed, generate the lattice by
        # stepping the observed-first merged deltas (:meth:`_player_delta_map`) from the player's
        # REAL position across in-bounds cells — no passability filtering (the empirical walk
        # verifies arrival, so an over-approximate lattice costs at most a skipped approach), and
        # crucially no model BFS over states: the ls20 model mispredicts the mover, so a
        # model-derived lattice misplaces every approach cell. Same node budget as the model path
        # below, which remains the empty-suite fallback.
        if self._observed_delta_map():
            grid = self._frame_grid(frame)
            rows = len(grid)
            cols = len(grid[0]) if rows else 0
            cells: set[tuple[int, int]] = set()
            p0 = self._player_position(grid) if rows else None
            if p0 is not None:
                deltas = sorted(self._player_delta_map(frame))
                cells.add(p0)
                queue: deque[tuple[int, int]] = deque([p0])
                expanded = 0
                while queue and expanded < self.config.plan_max_nodes:
                    r, c = queue.popleft()
                    expanded += 1
                    for dr, dc in deltas:
                        nr, nc = r + dr, c + dc
                        if 0 <= nr < rows and 0 <= nc < cols and (nr, nc) not in cells:
                            cells.add((nr, nc))
                            queue.append((nr, nc))
            self.summary.reachable_cell_count = len(cells)
            return cells
        program = self.program
        if program is None:
            return set()
        try:
            start = program.init_state(self._frame_grid(frame))
        except Exception:  # noqa: BLE001
            return set()
        p0 = self._player_position(self._safe_render(program, start))
        cells: set[tuple[int, int]] = set()
        if p0 is not None:
            cells.add(p0)
        valid = list(frame.get("valid_actions") or [])
        seen = {_grids_key(self._safe_render(program, start))}
        queue: deque[Any] = deque([start])
        expanded = 0
        while queue and expanded < self.config.plan_max_nodes:
            st = queue.popleft()
            expanded += 1
            for action in valid:
                try:
                    ns, _ev = program.step(st, action)
                    grid = program.render(ns)
                except Exception:  # noqa: BLE001
                    continue
                key = _grids_key(grid)
                if key in seen:
                    continue
                seen.add(key)
                pos = self._player_position(grid)
                if pos is not None:
                    cells.add(pos)
                queue.append(ns)
        self.summary.reachable_cell_count = len(cells)
        return cells

    def _bump_contexts(
        self, grid: list[list[int]]
    ) -> list[tuple[Any, tuple[int, int], tuple[int, int], int]]:
        """CONTACT contexts for BUMP PROBES, STRIDE-AGNOSTIC (Run-27): for each distinct segmented
        object class the player is not part of, the ``(object_hash, approach_cell, bump_direction,
        reach_cost)`` to stand on a LATTICE-reachable cell from which ONE move lands on / sweeps
        through the object.

        Contact is the game's OWN movement geometry, read off the model's per-action deltas
        (:meth:`_player_delta_map`) and its reachable lattice (:meth:`_reachable_player_cells`):

        * For each object cell and each movement delta ``(dr, dc)`` (any stride), we walk BACKWARDS
          from the object cell in ``-(dr, dc)`` steps to find the FIRST lattice cell — the cell the
          sparse mover can actually occupy from which the single move ``(dr, dc)`` drives the player
          ONTO the object (unit mover: the adjacent cell) or THROUGH it (stride-N mover: a cell N away
          whose swept path crosses the object). The swept path (all cells strictly between the approach
          cell and the destination, inclusive of the destination) must contain an object cell.
        * ``approach_cell`` is that lattice cell; ``bump_direction`` is the model delta ``(dr, dc)`` (at
          its true magnitude, NOT a unit step); ``reach_cost`` is Manhattan distance from the player.

        For a UNIT mover the backwards walk stops at distance 1 and this reduces to the old adjacency
        behavior. One context per distinct object hash, cheapest reach first. Skips background and the
        player's own class. Returns [] when no program/lattice/deltas are available (degrades safely)."""

        player = self._player_position(grid)
        if player is None:
            return []
        rows = len(grid)
        cols = len(grid[0]) if rows else 0
        frame = self._observe()
        deltas = list(self._player_delta_map(frame).keys())
        if not deltas:
            return []
        lattice = self._reachable_player_cells(frame)
        # Exclude EVERY player color (Run-23): a multi-color player unit must not bump-probe its own
        # second colored segment as if it were an external object. With observed-first narrowing
        # (Run-29) the set holds only the TRUE mover color(s) (ls20: {12}), so a static decoration
        # color (ls20's color 9) correctly becomes a bumpable external object class.
        player_colors = self._player_color_set()
        object_cells = {
            (r, c)
            for r in range(rows)
            for c in range(cols)
            if grid[r][c] != 0 and grid[r][c] not in player_colors
        }

        def _lattice_approach(
            obr: int, obc: int, dr: int, dc: int
        ) -> tuple[int, int] | None:
            """The nearest lattice cell BEHIND object cell ``(obr, obc)`` from which the single move
            ``(dr, dc)`` sweeps a path crossing that object cell.

            Walks back ONE CELL at a time along the delta's unit direction — the target lattice cell can
            sit fewer than a full stride behind an object the move only CROSSES (a stride-2 mover's
            approach cell is 1 cell behind an object it crosses, not 2). Bounded by one full stride: no
            farther lattice cell's swept path can still reach this object cell."""

            udr = (dr > 0) - (dr < 0)
            udc = (dc > 0) - (dc < 0)
            stride_len = max(abs(dr), abs(dc))
            for k in range(1, stride_len + 1):  # within one stride behind the object
                ar, ac = obr - udr * k, obc - udc * k
                if not (0 <= ar < rows and 0 <= ac < cols):
                    break
                if (ar, ac) not in lattice:
                    continue  # the mover cannot stand here (sparse lattice) — keep walking back
                # Swept path of the full-magnitude move from this lattice cell.
                dest = (ar + dr, ac + dc)
                swept = self._swept_path((ar, ac), dest)
                if any(cell in object_cells for cell in swept):
                    return (ar, ac)
            return None

        contexts: dict[Any, tuple[int, tuple[int, int], tuple[int, int]]] = {}
        for obj_hash, cells in _object_components(grid):
            sample = next(iter(cells))
            color = grid[sample[0]][sample[1]]
            if color == 0 or color in player_colors:
                continue
            best: tuple[int, tuple[int, int], tuple[int, int]] | None = None
            for (br, bc) in cells:
                for (dr, dc) in deltas:
                    approach = _lattice_approach(br, bc, dr, dc)
                    if approach is None:
                        continue
                    cost = abs(approach[0] - player[0]) + abs(approach[1] - player[1])
                    if best is None or cost < best[0]:
                        best = (cost, approach, (dr, dc))
            if best is None:
                continue
            cost, approach, bump = best
            prev = contexts.get(obj_hash)
            if prev is None or cost < prev[0]:
                contexts[obj_hash] = (cost, approach, bump)
        out = [
            (obj_hash, approach, bump, cost)
            for obj_hash, (cost, approach, bump) in contexts.items()
        ]
        # CROSS-RUN ORDERING (Run-38): objects a PRIOR run already bump-probed (persisted probes,
        # resumed into _resumed_bump_probes) rank LAST — untried objects go first so compounding runs
        # spend their bump budget on new ground. Prefer-not-exclude: a resumed-probed object is still
        # bumpable when nothing new remains (the board can change); within each group, cheapest first.
        out.sort(key=lambda item: (item[0] in self._resumed_bump_probes, item[3]))
        return out

    @staticmethod
    def _swept_path(
        src: tuple[int, int], dest: tuple[int, int]
    ) -> list[tuple[int, int]]:
        """The cells a single axis-aligned move from ``src`` to ``dest`` passes through, EXCLUDING the
        source and INCLUDING every intermediate cell up to and including ``dest``. For a unit move this
        is just ``[dest]``; for a stride-N move it is the N cells the player crosses — the geometry a
        stride-N contact probe collides with. Empty for a zero/diagonal move."""

        sr, sc = src
        dr_total, dc_total = dest[0] - sr, dest[1] - sc
        if (dr_total == 0) == (dc_total == 0):
            return []  # no move, or diagonal (not modeled)
        step_r = (dr_total > 0) - (dr_total < 0)
        step_c = (dc_total > 0) - (dc_total < 0)
        length = max(abs(dr_total), abs(dc_total))
        return [(sr + step_r * k, sc + step_c * k) for k in range(1, length + 1)]

    def _plan_to_cell(
        self, frame: dict[str, Any], target: tuple[int, int]
    ) -> PlanResult | None:
        """CPU-plan a movement path that puts the player on ``target`` (BFS over the model), or None
        when the model can't reach it. Zero LLM calls. When the player is already on target, returns
        an empty plan (no movement needed)."""

        program = self.program
        if program is None:
            return None

        def at_target(state: Any) -> bool:
            try:
                grid = program.render(state)
            except Exception:  # noqa: BLE001
                return False
            return self._player_position(grid) == target

        try:
            return plan(
                program,
                self._frame_grid(frame),
                at_target,
                max_depth=self.config.plan_max_depth,
                max_nodes=self.config.plan_max_nodes,
            )
        except Exception:  # noqa: BLE001 - a broken program must not crash discovery
            return None

    def _interaction_discovery(
        self, frame: dict[str, Any]
    ) -> tuple[dict[str, Any], bool] | None:
        """Movement frontier exhausted with no boundary: probe untried (action, context) pairs.

        Enumerate non-movement actions from ``valid_actions`` fired at interesting contexts (player
        adjacent to each distinct object class), cheapest-to-reach first. For each untried pair not
        already in ``_fired_probes``: CPU-plan movement to the context, execute the movement (if any),
        then fire the single non-movement probe action. Diff the probe's real transition against the
        known auto-changing region — any changed cell OUTSIDE that region is a DISCOVERY, recorded as
        a game-scoped interaction note and counted. Dedup by (action, object_hash).

        Returns the LAST executed ``(result, diverged)`` like :meth:`_frontier_execute`, or None when
        there was nothing new to probe (the caller then falls back to a reactive probe)."""

        actions = self._non_movement_actions(frame)
        if not actions:
            # BUMP PROBES (Run-20): ls20's non-movement vocabulary is EMPTY (run 19 finding), so there
            # is nothing to fire in place — the win is contact/positional. Fall back to CONTACT probing:
            # move INTO each adjacent distinct object class and diff for an effect.
            if self.config.bump_probes:
                return self._bump_discovery(frame)
            return None
        cur_frame = frame
        last: tuple[dict[str, Any], bool] | None = None
        cap = max(1, self.config.max_interaction_probes_per_turn)
        fired = 0
        for probe_action in actions:
            if fired >= cap:
                break
            contexts = self._adjacent_object_contexts(self._frame_grid(cur_frame))
            # Always include the current position as a fallback context (obj_hash None) so a game with
            # no distinct adjacent object still gets each non-movement action tried once in place.
            targets: list[tuple[Any, tuple[int, int] | None]] = [
                (obj_hash, target) for (obj_hash, target, _cost) in contexts
            ]
            targets.append((None, None))
            for obj_hash, target in targets:
                if fired >= cap:
                    break
                key = (str(probe_action), obj_hash)
                if key in self._fired_probes:
                    continue
                self._fired_probes.add(key)
                # Move to the context (skip if in place / already there / unreachable-in-place ok).
                if target is not None:
                    mv = self._plan_to_cell(cur_frame, target)
                    if mv is None:
                        continue  # model can't reach this context; try the next
                    if mv.actions:
                        result, diverged = self._execute(mv, cur_frame)
                        last = (result, diverged)
                        cur_frame = self._observe()
                        if diverged or cur_frame.get("done") or self._out_of_budget(cur_frame):
                            return last
                # Fire the single non-movement probe and score the effect.
                last = self._fire_probe(cur_frame, probe_action, obj_hash)
                fired += 1
                cur_frame = self._observe()
                if cur_frame.get("done") or self._out_of_budget(cur_frame):
                    return last
                break  # one context per action per turn-pass; re-segment for the next action
        return last

    def _fire_probe(
        self, frame: dict[str, Any], action: Any, obj_hash: Any
    ) -> tuple[dict[str, Any], bool]:
        """Fire one non-movement probe action, ingest the transition, and classify the effect.

        A change is a DISCOVERY when the probe changed cells OUTSIDE the known auto-changing region
        (the every-action-changing HUD/timer cells) — a real new dynamic, not the background churn.
        Records a game-scoped interaction note on discovery. Returns ``(result, diverged)``."""

        self.summary.interactions_probed += 1
        before_grid = self._frame_grid(frame)
        result = self._act([action])
        self._ingest_result(frame, [action], result)
        after_frame = self._result_frame(result)
        after_grid = self._frame_grid(after_frame) if after_frame else before_grid
        changed = self._changed_cells(before_grid, after_grid)
        auto = self._auto_changing_cells()
        novel = changed - auto
        diverged = self._stop_reason(result) == "expect_mismatch"
        if novel:
            self.summary.interactions_found += 1
            self._record_interaction(frame, action, obj_hash, novel, result)
        return result, diverged

    # BUMP PROBES marker: the dedup token for a contact bump against an object class. A leading angle
    # bracket can never be a real action name, so ("<bump>", obj_hash) never collides with a
    # non-movement probe key ("SPACE", obj_hash) in the shared _fired_probes set.
    _BUMP_MARKER = "<bump>"

    def _bump_discovery(
        self, frame: dict[str, Any]
    ) -> tuple[dict[str, Any], bool] | None:
        """CONTACT BUMP discovery (Run-20): the non-movement vocabulary is empty, so probe the win by
        MOVING INTO each adjacent distinct object class.

        For each distinct object class (cheapest reach first, deduped by ``(<bump>, object_hash)`` via
        the persisted ``_fired_probes`` set): CPU-plan movement onto the empty approach cell next to the
        object, then fire the movement action that steps INTO the object ``bump_probe_repeats`` times.
        Diff each bump for ANY effect beyond blocked/no-op and the auto-changing region — an object that
        moved/recolored/vanished, a score delta, or newly reachable ground. A found effect is recorded as
        a game-scoped interaction note and extends the exploration frontier (coverage plateau reset by the
        caller). Returns the LAST executed ``(result, diverged)``, or None when nothing new to bump."""

        cur_frame = frame
        last: tuple[dict[str, Any], bool] | None = None
        cap = max(1, self.config.max_interaction_probes_per_turn)
        fired = 0
        # SILENT-DROP DIAGNOSTIC (Run-23): record the player color set + the reason NO bump fired, so the
        # Run-17..22 pathology (bumps_probed stuck at 0) is never invisible again. Overwritten to None the
        # moment a bump actually fires below.
        self.summary.player_colors = sorted(self._player_color_set())
        # STRIDE-AGNOSTIC telemetry (Run-27): record the inferred movement stride + reachable lattice
        # size the moment contact discovery engages, so a stride-N mover's geometry is visible on the
        # summary (movement_stride=1 for a unit mover, N for a stride-N mover; ls20 is 5).
        self._movement_stride(cur_frame)
        self._reachable_player_cells(cur_frame)
        if self._player_position(self._frame_grid(cur_frame)) is None:
            self.summary.bump_skip_reason = (
                f"no player cell on live grid (player_colors={self.summary.player_colors})"
            )
            return None
        # Re-SEGMENT each pass from the CURRENT frame: moving the avatar between probes shifts reach
        # costs and the closest approach cell, so a context computed once up front goes stale. Each pass
        # picks the cheapest un-fired object, plans to its approach cell, and bumps — then breaks to
        # re-segment for the next. Bounded by the probe cap.
        while fired < cap:
            contexts = self._bump_contexts(self._frame_grid(cur_frame))
            if not contexts:
                self.summary.bump_skip_reason = "no bump contexts (no distinct adjacent object class)"
            picked = None
            for ctx in contexts:
                if ctx[0] not in self._bump_attempted:
                    picked = ctx
                    break
            if picked is None:
                if contexts:
                    self.summary.bump_skip_reason = "all bump contexts already deduped (this run)"
                break  # every distinct object class already bumped THIS run (per-run dedup)
            obj_hash, approach, bump_dir, _cost = picked
            # Record the PER-RUN dedup key up front so a SKIP (no bump action / unreachable) does not spin on
            # the same object every pass; it is an in-run attempt record whether or not the bump lands. This
            # is deliberately NOT the persisted _fired_probes set — bump discovery is per-run (Run-25 fix).
            self._bump_attempted.add(obj_hash)
            # Resolve which valid action drives the player in the bump direction (empirically, off the
            # model). No such action (the model can't move that way) -> skip this object class.
            dir_map = self._movement_direction_map(cur_frame)
            bump_action = dir_map.get(bump_dir)
            if bump_action is None:
                self.summary.bump_skip_reason = "no movement action drives the bump direction"
                continue
            # CPU-plan movement onto the approach cell (skip when already there / unreachable -> skip).
            mv = self._plan_to_cell(cur_frame, approach)
            if mv is None:
                self.summary.bump_skip_reason = "bump approach cell unreachable"
                continue
            # EMPIRICAL APPROACH WALK (Run-27 live): the adopted program systematically mispredicts
            # the player mover, so the old expect-gated walk (_execute, plus the Run-26 single
            # re-plan retry) aborted EVERY approach — retry included (run-27: both due batches ended
            # bump_skip_reason="approach walk aborted before bump (diverged)", bumps_probed=0).
            # Contact discovery is empirical probing and must not require a movement-accurate model:
            # walk per-step with NO expect grids, exactly the _fire_bump act convention, re-planning
            # each step from the OBSERVED frame. The pre-check plan above only catches model-
            # unreachable targets early and sizes the step cap (2*len+2 leaves room for correction).
            walked_frame, outcome = self._empirical_walk(
                cur_frame, approach, max_steps=2 * len(mv.actions) + 2
            )
            if outcome == "unreachable":
                # A mid-walk re-plan found no path from where the player REALLY is; un-poison the
                # dedup so a later due batch can retry this never-bumped object.
                self.summary.bump_skip_reason = "bump approach cell unreachable (empirical walk)"
                self._bump_attempted.discard(obj_hash)
                continue
            if outcome != "arrived":
                # APPROACH-WALK ABORT (Run-25 live, Run-27 outcomes): the walk TOWARD the object
                # ended the batch before any bump fired — silence here (bumps_probed unchanged, no
                # skip reason) was the run-25 shape. Record WHY, and un-poison the per-run dedup: it
                # should only hold objects whose bump actually FIRED or was structurally skipped, so
                # the next due batch can retry this never-bumped object. `last` may still be None —
                # the caller treats None as fall-through to the frontier, which is correct.
                cause = (
                    "step cap" if outcome == "step cap"
                    else "done" if walked_frame.get("done") else "out of budget"
                )
                self.summary.bump_skip_reason = (
                    f"approach walk aborted before bump ({cause})"
                )
                self._bump_attempted.discard(obj_hash)
                return last
            cur_frame = walked_frame
            # Fire the bump into the object, repeated, diffing each for a contact effect.
            last = self._fire_bump(cur_frame, bump_action, bump_dir, obj_hash)
            fired += 1
            cur_frame = self._observe()
            if cur_frame.get("done") or self._out_of_budget(cur_frame):
                return last
        return last

    def _empirical_walk(
        self, frame: dict[str, Any], target_cell: tuple[int, int], max_steps: int
    ) -> tuple[dict[str, Any], str]:
        """Walk the player onto ``target_cell`` EMPIRICALLY: steer, act ONE step, observe, re-steer.

        No expect grids are passed (same act convention as :meth:`_fire_bump`), so a mispredicting
        model can never abort the walk — each step's REAL transition is ingested (it still reaches
        the suite and the repair path via :meth:`_ingest_result`) and the next step is chosen from
        the OBSERVED frame, converging by correction rather than by prediction. Returns the last
        observed ``(frame, outcome)`` where outcome is one of: ``"arrived"`` (the player is on
        target), ``"unreachable"`` (no plan / no player from the current frame), ``"stopped"``
        (done or out of budget mid-walk), ``"step cap"`` (``max_steps`` steps executed without
        arriving — a never-converging chase). Every re-plan beyond a walk's first counts in
        ``summary.approach_retries``.

        STEERING IS EMPIRICAL-FIRST (Run-28): run 28 live proved the walk executes fine but chases
        into the step cap when it steers by :meth:`_plan_to_cell` (a BFS over the MODEL — the ls20
        program systematically mispredicts the mover). While :meth:`_observed_delta_map` is
        non-empty each step is picked GREEDILY over the observed-first merged delta map
        (:meth:`_player_delta_map`): the action whose delta most reduces L1 distance to the target,
        tie-broken by sorted action name. Two memos keep the greedy walk from grinding or cycling
        on obstacles the deltas alone cannot see: an action observed to no-op from the current cell
        (blocked) is ranked behind every other candidate, and among equally-close candidates the
        destination visited fewer times THIS walk wins (a tabu tie-break — without it the walk
        oscillates between the two cells flanking a wall). Neither memo filters an action out
        entirely, so a fully-boxed walk still steps and terminates via the step cap rather than
        spinning. The model-plan stepping below survives only as the empty-map fallback."""

        cur = frame
        steps = 0
        # (cell, action) pairs observed to no-op THIS walk — the empirical blocked-move memo.
        blocked: set[tuple[tuple[int, int], str]] = set()
        # How often each cell was stood on THIS walk — the anti-cycling tabu penalty.
        visits: Counter = Counter()
        while True:
            if steps:
                self.summary.approach_retries += 1
            observed = self._observed_delta_map()  # refreshed as walk steps ingest transitions
            if observed:
                grid = self._frame_grid(cur)
                pos = self._player_position(grid)
                if pos == target_cell:
                    return cur, "arrived"
                if pos is None:
                    return cur, "unreachable"
                if steps >= max_steps:
                    return cur, "step cap"
                visits[pos] += 1
                dmap = self._player_delta_map(cur)  # observed-first, model fills unobserved actions

                def _rank(item: tuple[tuple[int, int], Any]) -> tuple[bool, int, int, str]:
                    (dr, dc), action = item
                    dest = (pos[0] + dr, pos[1] + dc)
                    dist = abs(dest[0] - target_cell[0]) + abs(dest[1] - target_cell[1])
                    return ((pos, str(action)) in blocked, dist, visits[dest], str(action))

                _delta, action = min(dmap.items(), key=_rank)  # str(action) is the deterministic tie-break
            else:
                plan_result = self._plan_to_cell(cur, target_cell)
                if plan_result is None:
                    return cur, "unreachable"
                if not plan_result.actions:
                    return cur, "arrived"
                if steps >= max_steps:
                    return cur, "step cap"
                pos = None
                action = plan_result.actions[0]
            result = self._act([action])
            self._ingest_result(cur, [action], result)
            cur = self._observe()
            steps += 1
            if pos is not None and self._player_position(self._frame_grid(cur)) == pos:
                blocked.add((pos, str(action)))  # the move no-oped from that cell: deprioritize it there
            if cur.get("done") or self._out_of_budget(cur):
                return cur, "stopped"

    def _fire_bump(
        self,
        frame: dict[str, Any],
        action: Any,
        bump_dir: tuple[int, int],
        obj_hash: Any,
    ) -> tuple[dict[str, Any], bool]:
        """Fire a CONTACT bump (movement INTO an object) ``bump_probe_repeats`` times, ingesting each
        transition and classifying the effect (Run-20).

        A bump is a DISCOVERY when a repeat changed cells OUTSIDE the auto-changing region (the object
        moved/recolored/vanished, new ground opened) OR a level/score boundary followed — a real contact
        mechanic, not a blocked no-op. Records a game-scoped interaction note on the first discovery and
        stops early once found. Returns the LAST ``(result, diverged)``."""

        repeats = max(1, self.config.bump_probe_repeats)
        result: dict[str, Any] = {}
        diverged = False
        found = False
        cur = frame
        # A bump IS firing: clear any pending skip reason so the summary reflects that discovery engaged.
        self.summary.bump_skip_reason = None
        # STRIDE-AGNOSTIC telemetry (Run-27): one _fire_bump call IS one CONTACT PROBE (a move whose
        # destination lands on / whose swept path crosses the object), independent of how many env
        # repeats it takes. bumps_* count fired env actions; contact_probes_* count probes.
        self.summary.contact_probes_probed += 1
        # CROSS-RUN BUMP COMPOUNDING (Run-38): a bump FIRING is the durable event — record its
        # translation-invariant object identity so _persist_coverage writes it as a (<bump>, hash)
        # probe token and the NEXT run's _bump_contexts ranks this object last (probed, not excluded).
        self._fired_bump_objects.add(obj_hash)
        for _ in range(repeats):
            self.summary.bumps_probed += 1
            before_grid = self._frame_grid(cur)
            result = self._act([action])
            self._ingest_result(cur, [action], result)
            after_frame = self._result_frame(result)
            after_grid = self._frame_grid(after_frame) if after_frame else before_grid
            changed = self._changed_cells(before_grid, after_grid)
            auto = self._auto_changing_cells()
            # A bump that only translated the player (movement) is not a contact effect: exclude the
            # player's own before/after cells so only the OBJECT's response (or new ground) counts.
            player_cells = self._bump_player_cells(before_grid, after_grid)
            novel = changed - auto - player_cells
            diverged = self._stop_reason(result) == "expect_mismatch"
            boundary = self._boundary_crossed(cur, result)
            if novel or boundary:
                if not found:
                    self.summary.bumps_found += 1
                    self.summary.contact_probes_found += 1
                    effect_cells = novel or self._changed_cells(before_grid, after_grid)
                    self._record_interaction(cur, f"bump {action}", obj_hash, effect_cells, result)
                found = True
                break
            cur = self._observe()
            if diverged or cur.get("done") or self._out_of_budget(cur):
                break
        return result, diverged

    def _bump_player_cells(
        self, before: list[list[int]], after: list[list[int]]
    ) -> set[tuple[int, int]]:
        """The player's own vacated + occupied cells across a bump, so a pure translation is not
        mistaken for a contact effect. On a shape mismatch (a level transition) returns empty — every
        changed cell is then significant (new level ground).

        The player color(s) are the inferred set (Run-23), not a hardcoded color 2 — otherwise on the
        live ls20 board a translation's own cells would count as a false contact effect. Observed-first
        narrowing (Run-29) makes this the true MOVER's cells only (ls20: {12}), which is safe: the
        excluded set must cover exactly the cells a pure translation changes, and static decoration
        cells (ls20's color 9) never change."""

        if _grid_shape(before) != _grid_shape(after):
            return set()
        colors = self._player_color_set()
        cells: set[tuple[int, int]] = set()
        for r, (brow, arow) in enumerate(zip(before, after)):
            for c, (b, a) in enumerate(zip(brow, arow)):
                if b != a and (b in colors or a in colors):  # player vacated/occupied this cell
                    cells.add((r, c))
        return cells

    # REACH PROBES marker (Run-39): the persisted dedup token for a reach attempt against a rare
    # special-cell class. Same opaque (marker, hash) pair shape as _BUMP_MARKER, so it rides the
    # coverage codec unchanged and can never collide with a real action name in _fired_probes.
    _REACH_MARKER = "<reach>"

    def _reach_targets(
        self, grid: list[list[int]]
    ) -> list[tuple[Any, tuple[int, int]]]:
        """REACH targets (Run-39): the rare special-cell classes worth landing the mover on, as an
        ordered ``(target_hash, cell)`` list — one representative cell per distinct segmented class
        (the same translation-invariant hashes :meth:`_bump_contexts` keys on).

        A class qualifies while its TOTAL cell count across the grid is <=
        ``config.reach_target_max_cells`` (ls20: the 3 color-0 + 2 color-1 special cells; never the
        big maze/wall classes), EXCLUDING the mover's own colors (:meth:`_player_color_set`), the
        trail/ground colors in ``config.reach_exclude_colors`` (the ls20 effect map: 9 trail,
        3 ground — trail fragments segment into tiny components that would otherwise pass the
        rarity bar), and the BACKGROUND class. Background is the DOMINANT color, never a hardcoded
        color 0: the ls20 special cells ARE color 0 while the visual background is color 4, so the
        ``color == 0`` skip _bump_contexts uses would exclude the very cells this probe tests.

        Deterministic order: untried-before-resumed (targets a PRIOR run already reach-probed rank
        LAST — prefer-not-exclude, the bump-ordering convention), then cheapest reach cost
        (Manhattan distance from the player), then cell."""

        max_cells = self.config.reach_target_max_cells
        if max_cells <= 0:
            return []
        rows = len(grid)
        cols = len(grid[0]) if rows else 0
        if not rows or not cols:
            return []
        player = self._player_position(grid)
        if player is None:
            return []
        player_colors = self._player_color_set()
        excluded = set(self.config.reach_exclude_colors)
        color_counts = Counter(v for row in grid for v in row)
        # The background class is the DOMINANT color (deterministic tie-break: smaller color wins).
        excluded.add(min(color_counts, key=lambda color: (-color_counts[color], color)))
        class_cells: dict[Any, set[tuple[int, int]]] = {}
        for obj_hash, cells in _object_components(grid):
            sample = next(iter(cells))
            color = grid[sample[0]][sample[1]]
            if color in player_colors or color in excluded:
                continue
            class_cells.setdefault(obj_hash, set()).update(cells)
        ranked: list[tuple[bool, int, tuple[int, int], Any]] = []
        for obj_hash, cells in class_cells.items():
            if len(cells) > max_cells:
                continue  # not rare: the big background/maze/wall classes never qualify
            cell = min(cells)  # deterministic representative cell for the class
            cost = abs(cell[0] - player[0]) + abs(cell[1] - player[1])
            ranked.append((obj_hash in self._resumed_reach_probes, cost, cell, obj_hash))
        ranked.sort(key=lambda item: (item[0], item[1], item[2], str(item[3])))
        return [(obj_hash, cell) for (_resumed, _cost, cell, obj_hash) in ranked]

    def _footprint_covers(self, grid: list[list[int]], cell: tuple[int, int]) -> bool:
        """True iff the mover FOOTPRINT occupies ``cell`` on ``grid`` — the reach arrival test.

        The footprint is every player-colored cell (the ls20 mover is a 2x5 block), so coverage is
        read off the OBSERVED frame, never via :meth:`_player_position` (the footprint's top-left,
        which can never equal an off-anchor cell the block still covers — banked-suite evidence:
        the mover covered the color-0 cell (31, 21) while anchored at lattice cell (30, 19))."""

        r, c = cell
        rows = len(grid)
        cols = len(grid[0]) if rows else 0
        if not (0 <= r < rows and 0 <= c < cols):
            return False
        return grid[r][c] in self._player_color_set()

    def _step_into_action(
        self, frame: dict[str, Any], target: tuple[int, int]
    ) -> Any | None:
        """The valid action that drives the mover ONE move INTO ``target`` from where it stands —
        the off-lattice half of a reach attempt (the greedy walk settles on the nearest lattice
        anchor; this fires the single step toward the target the lattice cannot express, the same
        firing convention as a bump). Direction is measured from the FOOTPRINT cell nearest the
        target; among the per-action deltas (:meth:`_player_delta_map`) the one pointing into the
        LARGER axis gap wins, tie-broken by action name. None when no delta points at the target."""

        grid = self._frame_grid(frame)
        colors = self._player_color_set()
        cells = [
            (r, c) for r, row in enumerate(grid) for c, v in enumerate(row) if v in colors
        ]
        if not cells:
            return None
        near = min(
            cells, key=lambda cell: (abs(cell[0] - target[0]) + abs(cell[1] - target[1]), cell)
        )
        gap_r, gap_c = target[0] - near[0], target[1] - near[1]
        best: tuple[tuple[int, str], Any] | None = None
        for (dr, dc), action in self._player_delta_map(frame).items():
            if dr and gap_r * dr > 0:
                score = abs(gap_r)
            elif dc and gap_c * dc > 0:
                score = abs(gap_c)
            else:
                continue  # this delta does not point INTO the target
            key = (-score, str(action))
            if best is None or key < best[0]:
                best = (key, action)
        return best[1] if best is not None else None

    def _reach_discovery(
        self, frame: dict[str, Any]
    ) -> tuple[dict[str, Any], bool] | None:
        """REACH PROBES (Run-39): land the mover ON a rare special cell to test the
        navigate-to-target win hypothesis (run 38 destroyed every color-8/color-11 object and the
        engine still reported levels_completed=0 — contact alone is not the ls20 win).

        For each untried target from :meth:`_reach_targets` (per-run dedup by target hash):
        :meth:`_empirical_walk` to the target cell ITSELF — greedy steering means an off-lattice
        cell settles the walk on the nearest lattice anchor at the step cap — then check ARRIVAL as
        footprint coverage on the OBSERVED frame (:meth:`_footprint_covers`). When the settled
        footprint does NOT cover the target (off-lattice), fire ONE step INTO the target direction
        with the bump-firing convention (:meth:`_act` + :meth:`_ingest_result`, no expect grids)
        and re-observe. Every step's transition is ingested normally, so the driver's existing
        level_transition/boundary detection IS the win signal — no new detection here.

        ANTI-SPIN: 3 consecutive attempts that neither arrive nor change any non-auto cell stand
        the reach phase down for the REST OF THE RUN (a boxed-in mover must not spend every hoisted
        turn re-walking unreachable targets). Returns the LAST executed ``(result, diverged)``, or
        None when there was nothing to reach (targets exhausted / standdown / no player)."""

        if self._reach_empty_streak >= 3:
            return None  # anti-spin standdown: reach is over for this run
        cur_frame = frame
        last: tuple[dict[str, Any], bool] | None = None
        cap = max(1, self.config.max_interaction_probes_per_turn)
        fired = 0
        while fired < cap and self._reach_empty_streak < 3:
            grid = self._frame_grid(cur_frame)
            picked: tuple[Any, tuple[int, int]] | None = None
            for target_hash, cell in self._reach_targets(grid):
                if target_hash not in self._reach_attempted:
                    picked = (target_hash, cell)
                    break
            if picked is None:
                break  # every rare target already attempted this run
            target_hash, target = picked
            pos = self._player_position(grid)
            if pos is None:
                break  # no mover on the live grid: nothing to walk
            self._reach_attempted.add(target_hash)
            # Step cap sized off the REAL geometry (distance / stride), not a model plan — a rare
            # special cell is typically a wall to the mispredicting model, so the bump precheck
            # idiom (_plan_to_cell sizing) has no path to size by here.
            stride = max(1, self._movement_stride(cur_frame))
            dist = abs(pos[0] - target[0]) + abs(pos[1] - target[1])
            attempt_before = grid
            walked_frame, outcome = self._empirical_walk(
                cur_frame, target, max_steps=2 * (dist // stride) + 4
            )
            if outcome == "unreachable":
                # No path from where the player REALLY is; un-poison the dedup so a later hoisted
                # turn can retry this never-walked target (the bump-abort convention).
                self._reach_attempted.discard(target_hash)
                break
            if outcome == "stopped":
                return last  # done / out of budget mid-walk
            # The attempt EXECUTED (arrived, or settled at the step cap): count it and record the
            # durable identity for cross-run persistence/ordering.
            self.summary.reach_probes += 1
            self._fired_reach_targets.add(target_hash)
            cur_frame = walked_frame
            result: dict[str, Any] = {}
            diverged = False
            arrived = self._footprint_covers(self._frame_grid(cur_frame), target)
            if not arrived:
                # Off-lattice settle: ONE step INTO the target direction, bump-firing convention.
                action = self._step_into_action(cur_frame, target)
                if action is not None:
                    result = self._act([action])
                    self._ingest_result(cur_frame, [action], result)
                    diverged = self._stop_reason(result) == "expect_mismatch"
                    cur_frame = self._observe()
                    arrived = self._footprint_covers(self._frame_grid(cur_frame), target)
            if arrived:
                self.summary.reach_arrived += 1
            last = (result, diverged)
            # ANTI-SPIN bookkeeping: an attempt that neither arrived nor changed any non-auto cell
            # (the mover never even moved) advances the standdown streak; any progress resets it.
            changed = (
                self._changed_cells(attempt_before, self._frame_grid(cur_frame))
                - self._auto_changing_cells()
            )
            if arrived or changed:
                self._reach_empty_streak = 0
            else:
                self._reach_empty_streak += 1
            fired += 1
            if cur_frame.get("done") or self._out_of_budget(cur_frame):
                return last
        return last

    def _record_interaction(
        self,
        frame: dict[str, Any],
        action: Any,
        obj_hash: Any,
        novel_cells: set[tuple[int, int]],
        result: dict[str, Any],
    ) -> None:
        """Record a game-scoped interaction note (best-effort). Standalone-token body describing the
        action, the object-class context, and the observed effect."""

        if self.kb is None:
            return
        boxes = self._changing_boxes(set(novel_cells))
        where = "; ".join(
            f"{self._range_str(r0, r1, 'row', 'rows')} {self._range_str(c0, c1, 'col', 'cols')}"
            for (r0, c0, r1, c1) in boxes
        )
        boundary = self._stop_reason(result) == "level_transition" or self._boundary_crossed(
            frame, result
        )
        context = (
            f"player adjacent to object class {obj_hash}"
            if obj_hash is not None
            else "player in place (no distinct adjacent object)"
        )
        effect = (
            f"changed {len(novel_cells)} cells beyond the auto-changing region at {where}"
            + ("; a level boundary followed" if boundary else "")
        )
        try:
            self.kb.begin_turn()
            out = self.kb.write_interaction(self.config.game_id, action, context, effect)
            if isinstance(out, dict) and out.get("ok"):
                self.summary.kb_writes += 1
        except Exception:  # noqa: BLE001 - note write is advisory; never crash the loop
            pass

    # -- CROSS-RUN COVERAGE PERSISTENCE (Run-20) ---------------------------------------------------

    def _kb_client(self) -> Any:
        """The underlying KbClient behind the WriteGate (``self.kb.client``), or None when offline."""

        return getattr(self.kb, "client", None) if self.kb is not None else None

    # LOCAL COVERAGE-STATE FILE (Run-40): the PRIMARY cross-run store. Three DISTINCT KB retrieval
    # failure modes have each broken the same coverage round-trip live (the chunk flood, the
    # corroboration gate, and — run 38 — the daemon source-cluster rewrite gutting the note), and
    # the agent's OWN state needs no retrieval stack. The file carries the codec body VERBATIM
    # inside a tiny JSON envelope, so the file and KB paths round-trip the IDENTICAL state dict
    # through the SAME codec (`encode_coverage_state`/`decode_coverage_state`). The KB note remains
    # a best-effort write-through for observability only.

    def _coverage_state_file(self) -> str:
        """The game's local coverage-state file, relative to the CWD the driver runs from."""

        return os.path.join("out", "ewm-state", f"{self.config.game_id}-coverage.json")

    def _write_coverage_file(self, body: str) -> bool:
        """ATOMIC local write (temp + rename) of the encoded coverage body. False on any failure."""

        try:
            path = self._coverage_state_file()
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = f"{path}.tmp.{os.getpid()}"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"version": 1, "game_id": self.config.game_id, "body": body}, fh)
            os.replace(tmp, path)  # atomic: a concurrent reader sees the old or new file, never half
            return True
        except Exception:  # noqa: BLE001 - persistence is advisory; never crash a completed run
            return False

    def _read_coverage_file(self) -> dict[str, Any] | None:
        """Decode the local coverage-state file, or None when absent/unusable (degrade to the KB)."""

        try:
            with open(self._coverage_state_file(), encoding="utf-8") as fh:
                data = json.load(fh)
            body = data.get("body") if isinstance(data, dict) else None
            if not isinstance(body, str):
                return None
            from .kb_protocol import decode_coverage_state

            state = decode_coverage_state(body)
            if not (state.get("visited") or state.get("probes") or state.get("board")):
                return None  # no recoverable ground: treat as unusable -> KB fallback
            return state
        except Exception:  # noqa: BLE001 - a corrupt/foreign file must degrade, never crash
            return None

    def _resume_coverage(self, frame: dict[str, Any]) -> None:
        """RESUME the swept frontier from a prior run's persisted coverage state (Run-20).

        Run-40: reads the LOCAL STATE FILE first (the primary store); the KB path
        (:func:`kb_protocol.read_coverage_state`) runs only when the file is absent or unusable.
        Seeds the visited-cell set + fired-probe dedup set + plateau counter from the recovered
        state and records ``coverage_resumed_pct`` (fraction of the board already swept). Budgets
        never compound: the next run never re-sweeps persisted ground. A corrupt file degrades to
        the KB, and a KB miss/outage degrades to a fresh sweep — never a crash."""

        if not self.config.coverage_persistence:
            return
        state = self._read_coverage_file()
        if state is None:
            client = self._kb_client()
            if client is None:
                return
            try:
                from .kb_protocol import read_coverage_state

                state = read_coverage_state(client, self.config.game_id)
            except Exception:  # noqa: BLE001 - a KB outage must never block gameplay
                state = None
        if not state:
            return
        self._coverage_cells |= set(state.get("visited") or set())
        # Load persisted NON-bump probes (coverage cells + non-movement interaction probes) but EXCLUDE any
        # _BUMP_MARKER-tagged entries from _fired_probes: bump discovery is PER-RUN (Run-25 fix), so a prior
        # run's bump intent must never gate this run's bumps. object_hashes are translation-invariant, so
        # persisted bump keys match ls20 objects across runs and would permanently suppress bumps. Bump
        # dedup lives in the per-run self._bump_attempted set instead. Persisted bump keys DO seed
        # _resumed_bump_probes (Run-38): a cross-run ORDERING hint only — _bump_contexts ranks these
        # already-probed objects last so a compounding run tries new objects first, without ever
        # excluding a resumed object from re-probing.
        persisted = set(state.get("probes") or set())
        bump_keys = {
            key for key in persisted
            if isinstance(key, tuple) and len(key) == 2 and key[0] == self._BUMP_MARKER
        }
        # REACH tokens (Run-39) resume the same way bump tokens do: an ADVISORY ORDERING set only
        # (_reach_targets ranks resumed targets last, prefer-not-exclude) — never _fired_probes and
        # never the per-run _reach_attempted dedup, so a fresh run retries each rare target once.
        reach_keys = {
            key for key in persisted
            if isinstance(key, tuple) and len(key) == 2 and key[0] == self._REACH_MARKER
        }
        self._fired_probes |= persisted - bump_keys - reach_keys
        self._resumed_bump_probes |= {obj_hash for (_marker, obj_hash) in bump_keys}
        self._resumed_reach_probes |= {target_hash for (_marker, target_hash) in reach_keys}
        board = self._board_cell_count or self._board_cells(frame) or state.get("board") or 0
        if not self._board_cell_count and board:
            self._board_cell_count = board
        self.summary.coverage_resumed_pct = (
            round(len(self._coverage_cells) / board, 4) if board else 0.0
        )

    def _persist_coverage(self) -> None:
        """Persist this run's swept ground: the LOCAL STATE FILE first, then the KB note (Run-20/40).

        Encodes the visited cells + fired probes + plateau via :func:`kb_protocol.encode_coverage_state`
        and writes it to the local coverage-state file (Run-40: the PRIMARY store, atomic
        temp+rename), then writes the chunked coverage note (superseding the prior one so ground
        ACCUMULATES across runs rather than forking) as the best-effort observability write-through.
        Best-effort throughout: a file/KB failure or a WriteGate without the coverage writer is
        swallowed so end-of-run persistence never crashes a completed run."""

        if not self.config.coverage_persistence:
            return
        try:
            from .kb_protocol import encode_coverage_state

            # CROSS-RUN BUMP COMPOUNDING (Run-38): the persisted probes are the non-movement
            # interaction probes PLUS every bump that fired — this run's (_fired_bump_objects) union
            # the resumed prior-run set, so bump provenance ACCUMULATES across runs (run-37 shape:
            # probes=[] on the live note despite 12 bumps fired, so every run re-bumped the same
            # 12 objects first).
            probes = self._fired_probes | {
                (self._BUMP_MARKER, obj_hash)
                for obj_hash in (self._fired_bump_objects | self._resumed_bump_probes)
            } | {
                # REACH tokens (Run-39): this run's executed reach targets union the resumed
                # prior-run set, so reach provenance ACCUMULATES across runs like bumps do.
                (self._REACH_MARKER, target_hash)
                for target_hash in (self._fired_reach_targets | self._resumed_reach_probes)
            }
            body = encode_coverage_state(
                self._coverage_cells,
                probes,
                board_cells=self._board_cell_count,
                coverage_plateau=self._coverage_plateau,
            )
        except Exception:  # noqa: BLE001 - persistence is advisory; never crash a completed run
            return
        # PRIMARY (Run-40): the local state file — the store _resume_coverage reads first.
        if self._write_coverage_file(body):
            self.summary.coverage_persisted = True
        # BEST-EFFORT KB write-through (observability; the resume path no longer depends on it).
        if self.kb is None:
            return
        writer = getattr(self.kb, "write_coverage_state", None)
        if not callable(writer):
            return
        try:
            # Supersede the prior coverage note (if any) so the accumulated ground replaces it in-place.
            prior = None
            client = self._kb_client()
            if client is not None:
                try:
                    from .kb_protocol import _search_full_content, _is_game_scoped, _is_chunk_note, _tokens

                    q = " ".join(["game", *_tokens(self.config.game_id), "coverage", "state"])
                    hits = _search_full_content(client, q, k=20)
                    for h in hits:
                        if _is_game_scoped(h, self.config.game_id) and not _is_chunk_note(h):
                            prior = h.get("key") or h.get("id")
                            break
                except Exception:  # noqa: BLE001
                    prior = None
            out = writer(self.config.game_id, body, supersedes=prior)
            if isinstance(out, dict) and out.get("ok"):
                self.summary.coverage_persisted = True
                self.summary.kb_writes += 1
        except Exception:  # noqa: BLE001 - persistence is advisory; never crash a completed run
            pass

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
        # CONFIG ECHO (Run-23): the EFFECTIVE exploration/discovery knob values that actually reached the
        # agent this run. A dropped config field (the Run-22 live-silent hypothesis: live_run building
        # AgentConfig without a new field) is now visible in the summary forever — no more inferring a
        # silent drop from a zero counter. Also echo the inferred player color set, whose value being the
        # live avatar color is direct proof the color-2 pathology is closed.
        cfg = self.config
        self.summary.config_echo = {
            "bump_probes": cfg.bump_probes,
            "bump_quota_fraction": cfg.bump_quota_fraction,
            "bump_probe_repeats": cfg.bump_probe_repeats,
            "exploration_min_bump_actions": cfg.exploration_min_bump_actions,
            "coverage_persistence": cfg.coverage_persistence,
            "coverage_plateau_exhaust": cfg.coverage_plateau_exhaust,
            "interaction_discovery": cfg.interaction_discovery,
            "exploration_executor": cfg.exploration_executor,
            "graph_synthesis": cfg.graph_synthesis,
            "repair_suppress_when_healthy": cfg.repair_suppress_when_healthy,
            "repair_timeout_backoff": cfg.repair_timeout_backoff,
            "player_colors": sorted(self._player_color_set()),
        }

    # -- divergence classification (Run-18) --------------------------------------------------------

    def _last_divergence_cells(self) -> set[tuple[int, int]] | None:
        """The cells where the active program's INNER render mispredicts the most recent observed
        transition, or ``None`` when there is nothing usable to classify (no program, empty suite,
        or a crash/shape-mismatch — those are real model breakage, never a maskable transient).

        Compared against the UNWRAPPED inner program so a MaskedProgram's mask does not hide the very
        cells we are trying to classify. Cells the inner render already declines to predict (UNKNOWN)
        are excluded — a decline is not a mismatch."""

        program = self.program
        if program is None or len(self.suite) == 0:
            return None
        inner = program.inner if isinstance(program, MaskedProgram) else program
        transition = self.suite[-1]
        before = transition.before_grid
        after = transition.after_grid
        try:
            state = inner.init_state(before)
            next_state, _events = inner.step(state, transition.action)
            got = inner.render(next_state)
        except Exception:  # noqa: BLE001 - a crash predicts nothing: real breakage, not a transient
            return None
        if _grid_shape(after) != _grid_shape(got):
            return None
        cells: set[tuple[int, int]] = set()
        for r, (arow, grow) in enumerate(zip(after, got)):
            for c, (a, g) in enumerate(zip(arow, grow)):
                if _is_unknown(g) or _is_unknown(a):
                    continue
                if a != g:
                    cells.add((r, c))
        return cells

    @staticmethod
    def _cells_adjacent_to(cell: tuple[int, int], mask: set[tuple[int, int]]) -> bool:
        """True iff ``cell`` is in ``mask`` or 8-neighbour-adjacent to a masked cell."""

        r, c = cell
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if (r + dr, c + dc) in mask:
                    return True
        return False

    def _try_tolerate_transient(self, frame: dict[str, Any]) -> bool:
        """Classify the latest divergence; if it is a TRANSIENT confined to the program's known-
        unmodelable set (a MaskedProgram's mask) or adjacent to already-masked cells, auto-extend the
        mask (respecting ``mask_cap``) and tolerate it: NO trust drop, NO repair. Returns True when the
        divergence was tolerated (the caller then CONTINUES exploration), False otherwise.

        Only a MaskedProgram carries a known-unmodelable set, so tolerance only applies to partial
        adoptions — a whole-program divergence has no mask to be confined to and routes to repair."""

        if not self.config.divergence_tolerance:
            return False
        program = self.program
        if not isinstance(program, MaskedProgram):
            return False
        # Tolerance is for an ISOLATED transient on a model PROVEN healthy. Measured over the window
        # EXCLUDING the current (failing) tail: there must be prior passing evidence AND that prior
        # history must hold >= repair_trigger_pass_rate. A model with no prior evidence, or one whose
        # window has already degraded (e.g. a mover mispredicting EVERY step, dragging the rate to ~0),
        # is not showing a transient — it is a persistent defect that must route to REPAIR, never be
        # masked away forever.
        prior = list(self._live_results)[:-1] if self._live_results else []
        if not prior:
            return False
        prior_rate = sum(1 for ok in prior if ok) / len(prior)
        if prior_rate < self.config.repair_trigger_pass_rate:
            return False
        cells = self._last_divergence_cells()
        # None (crash/shape-mismatch/no evidence) or empty is not a maskable transient.
        if not cells:
            return False
        mask = set(program.mask_cells)
        if not all(self._cells_adjacent_to(cell, mask) for cell in cells):
            return False
        # Confined/adjacent: auto-extend the mask, respecting the board mask-cap.
        new_mask = mask | cells
        board = self._board_cells(frame)
        if board <= 0 or (len(new_mask) / board) > self.config.mask_cap:
            # Over the cap: refuse to grow the model into mostly holes. Not tolerated -> repair path.
            return False
        extended = bool(cells - mask)
        if extended:
            program.mask_cells = new_mask
            self.summary.mask_cells = len(new_mask)
            self.summary.mask_auto_extensions += 1
        self.summary.transients_tolerated += 1
        # A tolerated transient must NOT drop trust: the last live result mispredicted the (now-masked)
        # cell, so re-score it as a pass against the extended mask and refresh trust.
        if self._live_results:
            self._live_results[-1] = True
        self._refresh_model_trust()
        # A tolerated divergence resets the per-divergence repair budget — the model held.
        self._repairs_this_divergence = 0
        return True

    def _prior_window_healthy(self) -> bool:
        """True iff the live window EXCLUDING the current (failing) tail shows a healthy model — i.e.
        there is prior scored evidence and its pass-rate holds >= ``repair_trigger_pass_rate`` (Run-28).

        This is the "was the model healthy JUST BEFORE this divergence" test. It excludes the failing
        tail so a single isolated transient on a small/partly-filled window does not itself pull the
        rate under the threshold and fire repair on a model that is actually working (the Run-27 storm:
        a whole recalled program finished at live_pass_rate 1.0 yet fired 6 repairs). Distinct from
        _try_tolerate_transient's identical prior test in that it applies to WHOLE programs too — it
        gates the repair-vs-explore routing, not the mask-extension tolerance."""

        prior = list(self._live_results)[:-1] if self._live_results else []
        if not prior:
            return False
        prior_rate = sum(1 for ok in prior if ok) / len(prior)
        return prior_rate >= self.config.repair_trigger_pass_rate

    def _handle_divergence(self, frame: dict[str, Any], image_url: str | None) -> None:
        """On an expect-mismatch: first try to TOLERATE it as a transient confined to the program's
        known-unmodelable set (auto-extend the mask, no trust drop, no repair). Otherwise GATE repair
        on the rolling live pass-rate window — REPAIR only engages once the window degrades below
        ``repair_trigger_pass_rate`` — then enforce the repair caps and live pass-rate floor. A
        program whose live pass-rate collapses (or which burns its repair budget) is DROPPED and the
        loop switches to reactive; never keep planning from a dead model."""

        # (1) DIVERGENCE CLASSIFICATION: tolerate a transient in the known-unmodelable region.
        if self._try_tolerate_transient(frame):
            self._failure_cycles = 0
            return

        unrepaired_partial = (
            isinstance(self.program, MaskedProgram) and not self._partial_repaired
        )

        # (2) HEALTHY-MODEL REPAIR SUPPRESSION (Run-28): route an isolated transient on a model that
        # was healthy JUST BEFORE this divergence straight to the LLM-free exploration/reactive path,
        # never into REPAIR. The Run-27 storm was `window_holds` below measuring the pass-rate over a
        # window that ALREADY includes the current failing tail — early, before the window fills, a
        # single transient drags the small-window rate under repair_trigger_pass_rate and repair fires
        # on a model that finishes at 1.0. Measure health over the PRIOR window (excluding the failing
        # tail), the same test _try_tolerate_transient already uses. Never applies to an un-live-repaired
        # partial (its divergence comes from the authoritative unwrapped inner expect — the Run-10 hole).
        if (
            self.config.repair_suppress_when_healthy
            and self.config.divergence_tolerance
            and not unrepaired_partial
            and self._prior_window_healthy()
        ):
            self.summary.repair_suppressed_healthy += 1
            self._repairs_this_divergence = 0
            self._failure_cycles = 0
            return

        # (3) LLM-TIMEOUT BACKOFF (Run-28): once the endpoint has timed out on `repair_timeout_backoff`
        # consecutive decide calls, a repair decide would just burn another full client timeout. Stop
        # repairing for the rest of the game and fall to the LLM-free exploration/reactive path.
        if self._repair_backoff_tripped:
            self._repairs_this_divergence = 0
            self._failure_cycles = 0
            return

        # (4) REPAIR GATING: while the rolling window still holds, an isolated transient does NOT
        # trigger repair — the model is working, so do not interrupt it. The live window scores the
        # ACTIVE program; for a partial adoption that wrapper renders UNKNOWN over its mask, so the
        # window understates a real inner defect (the Run-10 hole). An un-live-repaired partial's
        # divergence came from the UNWRAPPED inner ``expect``, so it is authoritative — never gate it.
        window_holds = (
            self.config.divergence_tolerance
            and not unrepaired_partial
            and len(self._live_results) >= 1
            and self._live_pass_rate() >= self.config.repair_trigger_pass_rate
        )
        if window_holds:
            self._repairs_this_divergence = 0
            self._failure_cycles = 0
            return

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
