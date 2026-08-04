"""DEV-ONLY *ceiling test* for EWM world-model synthesis. NEVER SHIPS.

The question this script answers: given the SAME 13 recorded ls20 transitions a weak local model
(qwen-coding) failed to model, can a *frontier* model — the local ``claude`` CLI via
:class:`~.dev_cli_llm.CliLlm` — drive the offline synthesis state machine
(:class:`~.synth_graph.SynthSession`) to a program that VALIDATES the full suite?

  * A PASS (report.ok, full suite) proves the *harness* is complete — the ANALYZE/PLAN/EDIT/FINAL
    machine, the acceptance/regression contract, and the synthesis grid contract are all sufficient
    to produce a correct model. The remaining gap is then purely *local model quality*.
  * A FAIL localizes the problem to the harness/acceptance design instead: even a strong model can't
    thread the current acceptance slices, so the acceptance machinery needs work.

It reuses the PRODUCTION synthesis path verbatim: an :class:`~.agent.EwmAgent` (constructed offline,
``env=None``) supplies :meth:`~.agent.EwmAgent._synthesis_grid_block` (the hardened grid/UNKNOWN/
stdlib/segment contract) and loads the suite, and :func:`~.deltas.summarize_suite` builds the ANALYZE
delta texts — exactly as :meth:`~.agent.EwmAgent._synthesize_graph` wires them at runtime.

Usage (from repo root):
    python -m bench.arc_agi3_zonoid.ewm.dev_ceiling [SUITE_JSON]
Default SUITE_JSON: out/ewm-runs/ls20-1783084398/transition-suite.json
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

from . import deltas as _deltas
from . import synth_graph as _synth_graph
from .agent import AgentConfig, EwmAgent
from .world_model import TransitionSuite, WorldModelProgram, validate

DEFAULT_SUITE = "out/ewm-runs/ls20-1783084398/transition-suite.json"


def load_suite(path: str) -> TransitionSuite:
    """Load a transition-suite JSON dump (a list of ``{before_grid, action, after_grid}``)."""

    with open(path, "r", encoding="utf-8") as fh:
        return TransitionSuite.from_json(fh.read())


def build_offline_agent(suite: TransitionSuite, game_id: str, llm: Any) -> EwmAgent:
    """A production :class:`EwmAgent`, constructed offline (``env=None``, ``kb=None``) and preloaded
    with ``suite``, so we can reuse its ``_synthesis_grid_block`` contract builder verbatim."""

    agent = EwmAgent(
        env=None,
        llm=llm,
        kb=None,
        vision_enabled=False,
        config=AgentConfig(game_id=game_id),
    )
    agent.suite = suite
    return agent


def build_synth_inputs(agent: EwmAgent, suite: TransitionSuite) -> tuple[list[str], str]:
    """Mirror :meth:`EwmAgent._synthesize_graph`: ANALYZE delta texts + the EDIT synth-context.

    ``deltas`` = per-action aggregate lines followed by per-transition delta lines.
    ``synth_context`` = the hardened grid/contract appendix built from the suite's first frame.
    """

    summary = _deltas.summarize_suite(suite)
    delta_texts = list(summary.get("per_action", [])) + list(summary.get("per_transition", []))
    # The frame the contract block is anchored on: the first transition's before_grid, wrapped in the
    # {"grid": ...} frame shape the agent's _frame_grid expects.
    first_frame = {"grid": suite[0].before_grid} if len(suite) else {"grid": []}
    synth_context = agent._synthesis_grid_block(first_frame)
    return delta_texts, synth_context


def run_session(
    game_id: str,
    suite: TransitionSuite,
    llm: Any,
    delta_texts: list[str],
    synth_context: str,
    artifacts_dir: str,
) -> dict[str, Any]:
    """Run one offline :class:`SynthSession` (graph OFF) with generous ceiling-test budgets.

    Budgets per the ceiling-test plan: up to 6 changes, 3 retries/change, NO wall cap, 8000-token
    EDIT budget. Each EDIT attempt's ``(prompt, raw, source, report, adopted)`` is written as an
    ``edit-NN.json`` artifact so rejected candidates are inspectable.
    """

    os.makedirs(artifacts_dir, exist_ok=True)
    edit_counter = {"n": 0}

    def _sink(edit: dict[str, Any]) -> None:
        edit_counter["n"] += 1
        report = edit.get("report")
        record = {
            "change": edit.get("change"),
            "adopted": bool(edit.get("adopted")),
            "prompt_text": edit.get("prompt_text"),
            "raw_text": edit.get("raw_text"),
            "source": edit.get("source"),
            "report": report.to_dict() if report is not None else None,
        }
        path = os.path.join(artifacts_dir, f"edit-{edit_counter['n']:02d}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(record, fh, indent=2)

    # Budgets default to the ceiling-test plan (6 changes, 3 retries). Because a single frontier-CLI
    # EDIT completion is ~7 min, a FULL 6x4-attempt session runs for hours; EWM_CEILING_MAX_CHANGES /
    # EWM_CEILING_MAX_RETRIES let a dev cap the session to a tractable slice while still exercising the
    # real ANALYZE -> PLAN -> EDIT -> FINAL path against the frontier model.
    def _env_int(name: str, default: int) -> int:
        val = os.environ.get(name)
        return int(val) if val and val.lstrip("-").isdigit() else default

    session = _synth_graph.SynthSession(
        game_id,
        suite,
        llm,
        graph=None,  # offline: all graph ops no-op'd, identical control flow
        on_edit=_sink,
        analyze_context=[],  # no KB hypothesis menu in the ceiling test
        synth_context=synth_context,
        config=_synth_graph.SynthConfig(
            max_changes=_env_int("EWM_CEILING_MAX_CHANGES", 6),
            max_retries_per_change=_env_int("EWM_CEILING_MAX_RETRIES", 3),
            edit_max_tokens=8000,
            max_session_seconds=0.0,  # NO wall cap — let the frontier model take its time
        ),
    )
    return session.run(deltas=delta_texts)


def single_shot(
    suite: TransitionSuite,
    llm: Any,
    synth_context: str,
    artifacts_dir: str,
) -> dict[str, Any]:
    """A structural fallback: one direct EDIT-style completion asking for a whole program, validated
    against the full suite. Used when the session path fails structurally (e.g. PLAN emits nothing),
    so we can still see whether the model can crack the physics in a single pass."""

    system = (
        "You are writing a single Python world-model program for an ARC-AGI-3 game. The program must "
        "define init_state(frame), step(state, action)->(state, events), render(state)->grid, "
        "is_win(state)->bool, legal_actions(state)->list. Return the COMPLETE program in ONE "
        "```python fenced block. Do not hardcode observed grids."
    )
    user = (
        f"Write a world-model program that replays all {len(suite)} observed transitions.\n"
        + synth_context
    )
    resp = llm.chat(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        max_tokens=8000,
        temperature=0.0,
    )
    raw = str(resp.get("content", "")) if isinstance(resp, dict) else str(resp)

    from .agent import extract_python

    source = extract_python(raw)
    if source is None:
        report = None
    else:
        try:
            program = WorldModelProgram.load(source)
            report = validate(program, suite)
        except Exception as exc:  # noqa: BLE001
            report = None
            source = f"# load error: {exc}\n{source}"
    record = {
        "raw_text": raw,
        "source": source,
        "report": report.to_dict() if report is not None else None,
    }
    with open(os.path.join(artifacts_dir, "single-shot.json"), "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=2)
    return record


def main(argv: list[str]) -> int:
    suite_path = argv[1] if len(argv) > 1 else DEFAULT_SUITE
    suite = load_suite(suite_path)
    suite_name = os.path.basename(os.path.dirname(os.path.abspath(suite_path))) or "suite"
    game_id = suite_name
    out_dir = os.path.join("out", "ewm-runs", f"ceiling-{suite_name}")
    os.makedirs(out_dir, exist_ok=True)

    # DEV-ONLY: the frontier-model CLI client. Imported here so a missing binary only breaks the
    # actual run, not module import / tests.
    from .dev_cli_llm import CliLlm

    llm = CliLlm()
    agent = build_offline_agent(suite, game_id, llm)
    delta_texts, synth_context = build_synth_inputs(agent, suite)

    print(f"[ceiling] suite={suite_path} transitions={len(suite)} game_id={game_id}", flush=True)
    print(f"[ceiling] out_dir={out_dir} cli_timeout_s={llm.timeout_s}", flush=True)

    # The session path may fail STRUCTURALLY (a CLI timeout/failure raises out of a _chat mid-session).
    # Catch it so we still fall through to the single-shot variant per the ceiling-test plan.
    try:
        result = run_session(game_id, suite, llm, delta_texts, synth_context, out_dir)
    except Exception as exc:  # noqa: BLE001 - a diagnostic run should never hard-crash before single-shot
        print(f"[ceiling] session path failed structurally: {exc!r}", flush=True)
        result = {"program_source": None, "report": {}, "steps": [], "error": repr(exc)}
    report = result.get("report") or {}

    session_path = os.path.join(out_dir, "session-result.json")
    with open(session_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2)

    print("[ceiling] SESSION ValidationReport:", flush=True)
    print(json.dumps(report, indent=2), flush=True)

    # If the session never adopted a program, try the single-shot structural fallback.
    if not report.get("ok"):
        print("[ceiling] session did not fully validate; trying single-shot fallback...", flush=True)
        shot = single_shot(suite, llm, synth_context, out_dir)
        shot_report = shot.get("report") or {}
        print("[ceiling] SINGLE-SHOT ValidationReport:", flush=True)
        print(json.dumps(shot_report, indent=2), flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
