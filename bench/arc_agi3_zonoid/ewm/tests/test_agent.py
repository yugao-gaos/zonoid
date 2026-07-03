"""Tests for the EWM agent loop (mode machine, decide/reflect, suite growth, reactive fallback).

The scripted ``ToyEnv`` reuses the world-model kit's toy-game pattern (avatar=2 moves on 0-cells,
walls=1 block, goal=3). ``FakeLlm`` scripts the decide/reflect calls, and a ``FakeKb`` stands in for
the KB WriteGate. All tests run without any real LLM or daemon; the PIL-free test forces vision off.
"""

from __future__ import annotations

import unittest

from bench.arc_agi3_zonoid.ewm import agent as agent_mod
from bench.arc_agi3_zonoid.ewm.agent import (
    AgentConfig,
    EwmAgent,
    extract_action_batch,
    extract_python,
)
from bench.arc_agi3_zonoid.ewm.llm_client import FakeLlm
from bench.arc_agi3_zonoid.ewm.tests.test_world_model import TOY_GAME_SOURCE, WRONG_GAME_SOURCE


DELTAS = {"UP": (-1, 0), "DOWN": (1, 0), "LEFT": (0, -1), "RIGHT": (0, 1)}


def _grid(*rows: str) -> list[list[int]]:
    out = []
    for row in rows:
        out.append([0 if ch == "." else int(ch) for ch in row])
    return out


def _grids_equal(a, b) -> bool:
    return [list(r) for r in a] == [list(r) for r in b]


class ToyEnv:
    """A faithful in-process toy game with the ``observe``/``act`` seam the agent expects.

    ``act(actions, expect=None)`` applies the batch one action at a time; if a per-action ``expect``
    grid is supplied and the real next grid disagrees, it stops with ``stop_reason='expect_mismatch'``
    (mirroring the REPL budget guard) so the agent routes to DIVERGE/REPAIR. ``deviate`` optionally
    swaps LEFT/RIGHT so the environment deviates from a model that assumes the standard mapping.
    """

    def __init__(self, rows, deviate: bool = False, budget: int = 50) -> None:
        grid = [list(r) for r in rows]
        self._rows = len(grid)
        self._cols = len(grid[0]) if grid else 0
        self._walls = frozenset(
            (r, c) for r in range(self._rows) for c in range(self._cols) if grid[r][c] == 1
        )
        self._avatar = next(
            (r, c) for r in range(self._rows) for c in range(self._cols) if grid[r][c] == 2
        )
        self._goal = next(
            (r, c) for r in range(self._rows) for c in range(self._cols) if grid[r][c] == 3
        )
        self.deviate = deviate
        self.remaining_actions = budget

    def _grid(self):
        # Render exactly like the toy game: walls, then goal, then avatar on top.
        grid = [[0] * self._cols for _ in range(self._rows)]
        for (r, c) in self._walls:
            grid[r][c] = 1
        gr, gc = self._goal
        grid[gr][gc] = 3
        ar, ac = self._avatar
        grid[ar][ac] = 2
        return grid

    def _at_goal(self) -> bool:
        return self._avatar == self._goal

    def observe(self):
        return {
            "grid": self._grid(),
            "level": 1,
            "step": 0,
            "valid_actions": ["UP", "DOWN", "LEFT", "RIGHT"],
            "score": 0,
            "remaining_actions": self.remaining_actions,
        }

    def _apply_one(self, action: str) -> bool:
        deltas = dict(DELTAS)
        if self.deviate:
            deltas["LEFT"], deltas["RIGHT"] = DELTAS["RIGHT"], DELTAS["LEFT"]
        dr, dc = deltas[action]
        ar, ac = self._avatar
        nr, nc = ar + dr, ac + dc
        if 0 <= nr < self._rows and 0 <= nc < self._cols and (nr, nc) not in self._walls:
            self._avatar = (nr, nc)
            return True
        return False

    def act(self, actions, expect=None):
        executed = []
        stop_reason = "completed"
        done = False
        for index, action in enumerate(actions):
            name = action.get("action") if isinstance(action, dict) else action
            before = self._grid()
            self.remaining_actions = max(0, self.remaining_actions - 1)
            self._apply_one(str(name))
            executed.append(name)
            after = self._grid()
            if expect is not None and index < len(expect) and expect[index] is not None:
                if not _grids_equal(expect[index], after):
                    stop_reason = "expect_mismatch"
                    break
            if self._at_goal():
                done = True
                stop_reason = "done"
                break
        return {
            "current_frame": {
                "grid": self._grid(),
                "level": 1,
                "step": 0,
            },
            "action_result": {"score": 0, "done": done},
            "valid_actions": ["UP", "DOWN", "LEFT", "RIGHT"],
            "remaining_actions": self.remaining_actions,
            "executed": executed,
            "stop_reason": stop_reason,
            "done": done,
        }


class FakeKb:
    """Stands in for a WriteGate; records write_* calls and enforces the per-turn cap like the real
    gate. ``client`` is None so mode-scoped search is skipped (kept out of these unit tests)."""

    def __init__(self, max_writes_per_turn: int = 2) -> None:
        self.client = None
        self.max_writes_per_turn = max_writes_per_turn
        self._this_turn = 0
        self.writes: list[tuple] = []

    def begin_turn(self) -> None:
        self._this_turn = 0

    def _write(self, kind, *args):
        if self._this_turn >= self.max_writes_per_turn:
            return {"ok": False, "reason": "write cap"}
        self._this_turn += 1
        self.writes.append((kind, args))
        return {"ok": True}

    def write_program_revision(self, *args, **kw):
        return self._write("program_revision", *args)

    def write_level_solution(self, *args, **kw):
        return self._write("level_solution", *args)

    def write_failed_repair(self, *args, **kw):
        return self._write("failed_repair", *args)


class FakeKbClient:
    """Minimal KbClient stand-in: returns scripted /search hits, records queries."""

    def __init__(self, hits: list[dict]) -> None:
        self.hits = hits
        self.queries: list[tuple] = []

    def search(self, q, k, gated=False):
        self.queries.append((q, k, gated))
        return list(self.hits)


class SearchKb(FakeKb):
    """A FakeKb whose ``client`` returns stored-program hits, so ORIENT can adopt from the KB."""

    def __init__(self, hits, max_writes_per_turn: int = 2) -> None:
        super().__init__(max_writes_per_turn=max_writes_per_turn)
        self.client = FakeKbClient(hits)


def _fenced(source: str) -> str:
    return f"Here is the model:\n```python\n{source}\n```\n"


def _no_pil_config():
    return AgentConfig(game_id="toy", max_turns=20, min_probe_transitions=1)


class ParsingTests(unittest.TestCase):
    def test_extract_python_fenced(self):
        code = extract_python("prose\n```python\ndef init_state(f):\n    return f\n```")
        self.assertIn("def init_state", code)

    def test_extract_python_unfenced_prose_rejected(self):
        # Prose that merely mentions the contract functions is NOT a fenced block -> rejected. This
        # is the ls20 U+2014 failure: reasoning text with "def init_state" in it must never become
        # program source.
        code = extract_python("def init_state(f):\n    return f\ndef step(s,a):\n    return s,{}")
        self.assertIsNone(code)

    def test_extract_python_none(self):
        self.assertIsNone(extract_python("no code here"))

    def test_extract_python_picks_last_compiling_block(self):
        # Reasoning + a broken draft block + a final correct block: the LAST compiling block wins.
        text = (
            "Here is a draft:\n```python\ndef init_state(f)\n    return f\n```\n"
            "Fixed:\n```python\ndef init_state(f):\n    return f\n```\n"
        )
        code = extract_python(text)
        self.assertEqual(code, "def init_state(f):\n    return f")

    def test_extract_python_strips_fence_lines(self):
        # The opening ```python line and closing ``` must never survive into the source (the ls20
        # "invalid syntax line 1" failure).
        code = extract_python("```python\ndef init_state(f):\n    return f\n```")
        self.assertNotIn("```", code)
        self.assertTrue(code.startswith("def init_state"))

    def test_extract_python_truncated_block_no_closing_fence(self):
        # A response truncated before its closing fence (the ls20 token-budget failure): the block
        # still runs to end-of-text, fence line stripped, so validate can report the real error.
        code = extract_python('```python\ndef init_state(f):\n    """doc\n')
        self.assertIsNotNone(code)
        self.assertNotIn("```", code)
        self.assertTrue(code.startswith("def init_state"))

    def test_extract_python_uses_last_block_when_none_compile(self):
        # No block compiles but blocks exist -> return the LAST block (so the compile error is
        # reported accurately), never None.
        text = "```python\nx =\n```\n```python\ny ==\n```"
        code = extract_python(text)
        self.assertEqual(code, "y ==")

    def test_extract_python_prefers_init_state_block_over_later_fragment(self):
        # The main program block (with def init_state) comes FIRST; a later compiling helper
        # fragment (no init_state) comes after. Block selection must pick the init_state block, not
        # merely the last compiling block. This is the ls20 "missing contract functions" defect:
        # extract picked a compiling fragment instead of the main program.
        text = (
            "Here is the model:\n"
            "```python\ndef init_state(f):\n    return f\ndef step(s, a):\n    return s, {}\n```\n"
            "And a helper I used while reasoning:\n"
            "```python\ndef helper():\n    return 1\n```\n"
        )
        code = extract_python(text)
        self.assertIn("def init_state", code)
        self.assertNotIn("def helper", code)

    def test_extract_python_concatenates_consecutive_blocks(self):
        # The program is split across two consecutive fenced blocks: the FIRST block has def
        # init_state but is syntactically incomplete on its own (open paren, no body yet); only the
        # concatenation (in order) compiles. No single block both compiles AND has init_state, so the
        # concatenation path must fire.
        text = (
            "First half:\n"
            "```python\ndef init_state(f):\n    return (\n```\n"
            "Second half:\n"
            "```python\n        f\n    )\ndef step(s, a):\n    return s, {}\n```\n"
        )
        code = extract_python(text)
        self.assertIsNotNone(code)
        self.assertIn("def init_state", code)
        self.assertIn("def step", code)
        # The concatenation compiles as one program.
        compile(code, "<test>", "exec")

    def test_extract_action_batch_object(self):
        out = extract_action_batch('{"actions": ["UP", "LEFT"]}', ["UP", "DOWN", "LEFT", "RIGHT"])
        self.assertEqual(out, ["UP", "LEFT"])

    def test_extract_action_batch_filters_invalid(self):
        out = extract_action_batch('{"actions": ["UP", "JUMP"]}', ["UP", "DOWN"])
        self.assertEqual(out, ["UP"])

    def test_extract_action_batch_bad_json(self):
        self.assertEqual(extract_action_batch("garbage", ["UP"]), [])


class VisionDisabledTests(unittest.TestCase):
    def test_pil_free_loop_runs(self):
        # Force vision off (both the flag AND the availability probe) so the entire loop is PIL-free.
        env = ToyEnv(_grid("2.3"))
        # decide(synthesize) + reflect(after execute) ; execute uses zero decide calls.
        llm = FakeLlm([_fenced(TOY_GAME_SOURCE), '{"prediction_ok": true, "note": "moved right"}'])
        original = EwmAgent._vision_available
        EwmAgent._vision_available = staticmethod(lambda: False)
        try:
            ag = EwmAgent(env, llm, kb=None, vision_enabled=True, config=_no_pil_config())
            self.assertFalse(ag.vision_enabled)
            # Pre-seed one transition so the suite meets the probe minimum (min_probe_transitions=1)
            # and probing is skipped: this test exercises the PIL-free SYNTHESIZE->EXECUTE path.
            ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
            summary = ag.run()
        finally:
            EwmAgent._vision_available = original
        self.assertTrue(summary["won"])
        # No composite images were ever attached (vision off): decide/reflect messages are strings.
        for call in llm.received:
            for msg in call["messages"]:
                self.assertIsInstance(msg["content"], str)


class OrientTests(unittest.TestCase):
    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def test_orient_adopts_valid_stored_program_and_skips_synthesis(self):
        EwmAgent._vision_available = staticmethod(lambda: False)
        env = ToyEnv(_grid("2.3"))
        # KB returns a stored program in a note body (the WriteGate write_program_revision format).
        hit = {
            "title": "game toy world model program",
            "summary": (
                "handles avatar movement\n\npass rate: 2/2\n\n"
                f"program source:\n{TOY_GAME_SOURCE}"
            ),
        }
        kb = SearchKb([hit])
        # Only reflect calls are scripted — NO synthesize decide call should happen, because
        # ORIENT adopts the stored program directly.
        llm = FakeLlm(['{"prediction_ok": true}'] * 6)
        ag = EwmAgent(env, llm, kb=kb, config=AgentConfig(game_id="toy", max_turns=10))
        # Seed a transition the stored program must satisfy to be adopted.
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        summary = ag.run()
        self.assertTrue(summary["program_accepted"])
        self.assertTrue(summary["won"])
        # ORIENT means zero decide (synthesis) calls: the model came straight from the KB.
        self.assertEqual(summary["decide_calls"], 0)
        # ORIENT actually queried the KB.
        self.assertTrue(kb.client.queries)
        self.assertEqual(kb.client.queries[0][1], 1)  # k=1 keyed lookup

    def test_orient_rejects_stored_program_that_fails_validation(self):
        EwmAgent._vision_available = staticmethod(lambda: False)
        env = ToyEnv(_grid("2.3"))
        # Stored program is WRONG (swaps LEFT/RIGHT) -> fails the seeded RIGHT transition, so ORIENT
        # must NOT adopt it; the agent falls through to SYNTHESIZE (which we script correctly).
        hit = {"title": "game toy world model program", "summary": f"program source:\n{WRONG_GAME_SOURCE}"}
        kb = SearchKb([hit])
        llm = FakeLlm([_fenced(TOY_GAME_SOURCE), '{"prediction_ok": true}'])
        # Pre-seeded suite already meets the probe minimum, so probing is skipped here (this test
        # exercises ORIENT rejection + SYNTHESIZE fallthrough, not probe-first seeding).
        ag = EwmAgent(
            env, llm, kb=kb,
            config=AgentConfig(game_id="toy", max_turns=10, min_probe_transitions=1),
        )
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        summary = ag.run()
        self.assertTrue(summary["program_accepted"])
        # Fell through to synthesis: exactly one decide call.
        self.assertEqual(summary["decide_calls"], 1)


class SynthesizeExecuteTests(unittest.TestCase):
    def _agent(self, env, llm, **kw):
        # Disable vision so these tests don't depend on Pillow. The pre-seeded suite already meets
        # the probe minimum (min_probe_transitions=1), so probing is skipped: these tests exercise
        # SYNTHESIZE acceptance/retry, not probe-first seeding.
        EwmAgent._vision_available = staticmethod(lambda: False)
        return EwmAgent(
            env, llm,
            config=AgentConfig(game_id="toy", max_turns=20, min_probe_transitions=1),
            **kw,
        )

    def tearDown(self):
        # Restore the real probe for other tests.
        import importlib

        importlib.reload(agent_mod)

    def test_synthesize_accepts_and_execute_wins_zero_decide_during_execute(self):
        # Seed one observed transition so validate() has something to check the model against.
        env = ToyEnv(_grid("2.3"))
        llm = FakeLlm([_fenced(TOY_GAME_SOURCE), '{"prediction_ok": true}'])
        ag = self._agent(env, llm)
        # Pre-seed a transition so SYNTHESIZE must produce a suite-passing program.
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        summary = ag.run()
        self.assertTrue(summary["won"])
        self.assertTrue(summary["program_accepted"])
        # Exactly ONE decide call (the synthesis); EXECUTE consumed zero decide calls.
        self.assertEqual(summary["decide_calls"], 1)
        self.assertGreaterEqual(summary["reflect_calls"], 1)

    def test_synthesize_retries_on_failing_source_then_accepts(self):
        env = ToyEnv(_grid("2.3"))
        # First candidate is WRONG (swaps LEFT/RIGHT -> fails the seeded RIGHT transition); second
        # candidate is correct. The failing report must feed the retry.
        llm = FakeLlm(
            [_fenced(WRONG_GAME_SOURCE), _fenced(TOY_GAME_SOURCE), '{"prediction_ok": true}']
        )
        ag = self._agent(env, llm)
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        summary = ag.run()
        self.assertTrue(summary["program_accepted"])
        self.assertTrue(summary["won"])
        # The second decide message must carry the ValidationReport from the first failure.
        second_decide_text = llm.received[1]["messages"][-1]["content"]
        self.assertIn("Validation FAILED", second_decide_text)


class RepairTests(unittest.TestCase):
    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def test_forced_divergence_triggers_repair_with_failing_transition(self):
        # The env DEVIATES (LEFT/RIGHT swapped), so the standard model mispredicts during EXECUTE.
        # Seed a transition consistent with the STANDARD model so synthesis accepts it, then the
        # live env diverges and REPAIR fires with the failing transition in the prompt.
        EwmAgent._vision_available = staticmethod(lambda: False)
        env = ToyEnv(_grid("2..3"), deviate=True)
        # 1: synthesize (standard, passes seeded transition)
        # 2: reflect after diverging execute
        # 3..: repair attempts (we let them fail to keep the test focused on the REPAIR prompt)
        repaired = TOY_GAME_SOURCE  # a valid program (still standard) — repair may or may not hold
        llm = FakeLlm(
            [
                _fenced(TOY_GAME_SOURCE),          # synthesize
                '{"prediction_ok": false}',         # reflect after execute
                _fenced(repaired),                  # repair attempt 1
                '{"prediction_ok": false}',         # reflect (if another execute happens)
                _fenced(repaired),
                '{"prediction_ok": false}',
                _fenced(repaired),
                '{"prediction_ok": false}',
                _fenced(repaired),
                '{"prediction_ok": false}',
                _fenced(repaired),
            ]
            + ['{"actions": ["RIGHT"]}'] * 40  # reactive tail if it flips over
        )
        # Pre-seeded suite meets the probe minimum so probing is skipped; this test targets the
        # divergence -> REPAIR path, not probe-first seeding.
        ag = EwmAgent(
            env, llm, config=AgentConfig(game_id="toy", max_turns=6, min_probe_transitions=1)
        )
        ag.suite.append(_grid("2..3"), "RIGHT", _grid(".2.3"))
        ag.run()
        # A repair decide call must have been made carrying the first-failure report.
        repair_texts = [
            c["messages"][-1]["content"]
            for c in llm.received
            if isinstance(c["messages"][-1]["content"], str)
            and "Current mode: REPAIR" in c["messages"][-1]["content"]
        ]
        self.assertTrue(repair_texts, "expected at least one REPAIR decide call")
        self.assertIn("Validation FAILED", repair_texts[0])
        # The failing transition was appended to the suite (grew beyond the seed).
        self.assertGreater(len(ag.suite), 1)


class VacuousAcceptanceTests(unittest.TestCase):
    """A program must NEVER be adopted against an empty suite, even if validate() is trivially ok.

    This is the vacuous-acceptance hole that wasted the vision ls20 run: the model authored a
    program, adopted it against an EMPTY TransitionSuite, then mispredicted every real transition.
    """

    def setUp(self):
        EwmAgent._vision_available = staticmethod(lambda: False)

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def test_synthesize_refuses_adoption_against_empty_suite(self):
        env = ToyEnv(_grid("2.3"))
        # The LLM returns a valid program, but the suite is empty -> synthesize must refuse and make
        # ZERO decide calls (no point asking for a program with nothing to validate it against).
        llm = FakeLlm([_fenced(TOY_GAME_SOURCE)])
        ag = EwmAgent(env, llm, config=AgentConfig(game_id="toy", max_turns=1))
        self.assertEqual(len(ag.suite), 0)
        accepted = ag._synthesize(ag._observe(), None)
        self.assertFalse(accepted)
        self.assertIsNone(ag.program)
        self.assertFalse(ag.summary.program_accepted)
        # No decide call was spent on a vacuous synthesis.
        self.assertEqual(ag.summary.decide_calls, 0)

    def test_orient_refuses_adoption_against_empty_suite(self):
        env = ToyEnv(_grid("2.3"))
        # A stored program is available, but with an empty suite ORIENT cannot validate it and must
        # NOT adopt it provisionally.
        hit = {"title": "toy program", "summary": f"program source:\n{TOY_GAME_SOURCE}"}
        kb = SearchKb([hit])
        llm = FakeLlm(['{"prediction_ok": true}'] * 4)
        ag = EwmAgent(env, llm, kb=kb, config=AgentConfig(game_id="toy", max_turns=1))
        self.assertEqual(len(ag.suite), 0)
        self.assertFalse(ag._orient(ag._observe()))
        self.assertIsNone(ag.program)


class ProbeSeedingTests(unittest.TestCase):
    """Probe-first seeding: on a fresh game the probe batch records one transition per distinct
    valid action, up to min_probe_transitions, before any SYNTHESIZE."""

    def setUp(self):
        EwmAgent._vision_available = staticmethod(lambda: False)

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def test_probe_batch_seeds_one_transition_per_distinct_action(self):
        # 5-wide board: the goal (col4) is NOT reached by any single probe action, so all four
        # distinct actions run and each records exactly one observed transition.
        env = ToyEnv(_grid("2...3"), budget=50)
        llm = FakeLlm(['{"prediction_ok": true}'] * 8)  # reflect after each probe
        ag = EwmAgent(
            env, llm, config=AgentConfig(game_id="toy", max_turns=10, min_probe_transitions=4)
        )
        self.assertEqual(len(ag.suite), 0)
        ag._probe_batch(ag._observe())
        # One transition per distinct valid action (UP/DOWN/LEFT/RIGHT).
        self.assertEqual(len(ag.suite), 4)
        recorded_actions = [t.action for t in ag.suite]
        self.assertEqual(recorded_actions, ["UP", "DOWN", "LEFT", "RIGHT"])
        self.assertTrue(ag._probed)

    def test_probe_batch_budget_guard_skips_when_actions_low(self):
        # remaining_actions==1 -> probing keeps a reserve and records nothing.
        env = ToyEnv(_grid("2...3"), budget=1)
        llm = FakeLlm(['{"prediction_ok": true}'] * 8)
        ag = EwmAgent(
            env, llm, config=AgentConfig(game_id="toy", max_turns=10, min_probe_transitions=4)
        )
        ag._probe_batch(ag._observe())
        self.assertEqual(len(ag.suite), 0)

    def test_run_probes_before_synthesize_so_suite_is_nonempty_at_acceptance(self):
        # End-to-end: a fresh game (empty suite) probes first, then SYNTHESIZE validates against the
        # seeded transitions and adopts. Program is never adopted against an empty suite.
        env = ToyEnv(_grid("2...3"), budget=50)
        # Content-aware fake: author the program on a SYNTHESIZE decide, reflect otherwise, so the
        # probe reflects don't consume the synthesis response positionally.
        class _Fake(FakeLlm):
            def __init__(self):
                super().__init__([])

            def chat(self, messages, max_tokens=1024, temperature=0.0):
                self.received.append({"messages": messages, "max_tokens": max_tokens,
                                      "temperature": temperature})
                self.calls += 1
                last = messages[-1]["content"]
                text = last if isinstance(last, str) else ""
                if "Current mode: SYNTHESIZE" in text or "Current mode: REPAIR" in text:
                    return {"content": _fenced(TOY_GAME_SOURCE), "finish_reason": None, "raw": ""}
                return {"content": '{"prediction_ok": true}', "finish_reason": None, "raw": ""}

        ag = EwmAgent(
            env, _Fake(), config=AgentConfig(game_id="toy", max_turns=20, min_probe_transitions=4)
        )
        summary = ag.run()
        self.assertTrue(summary["program_accepted"])
        self.assertTrue(summary["won"])
        # The suite was non-empty at acceptance (probe seeded >= min_probe_transitions).
        self.assertGreaterEqual(summary["suite_size"], 4)
        self.assertGreaterEqual(summary["synthesis_attempts"], 1)


class FallbackFloorTests(unittest.TestCase):
    """A program whose live pass-rate collapses, or which exhausts its repair budget, is dropped
    and the loop switches to reactive — never keep planning from a program with pass_rate ~0."""

    def setUp(self):
        EwmAgent._vision_available = staticmethod(lambda: False)

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def test_live_pass_rate_floor_drops_program_to_reactive(self):
        ag = EwmAgent(
            ToyEnv(_grid("2.3")),
            FakeLlm([]),
            config=AgentConfig(game_id="toy", min_live_pass_rate=0.5, live_window=20),
        )
        # Simulate an ACTIVE program mispredicting every recent observed transition.
        ag.program = object()  # sentinel; _handle_divergence never calls into it here
        ag._live_results.extend([False] * 5)
        self.assertLess(ag._live_pass_rate(), 0.5)
        # A divergence with a collapsed live rate must drop the program and set modelability poor.
        ag._repair = lambda frame, image: False  # repair fails, program stays until floor drops it
        ag._handle_divergence({"grid": [[2, 0, 3]], "valid_actions": ["UP"]}, None)
        self.assertIsNone(ag.program)
        self.assertTrue(ag._modelability_poor)
        self.assertEqual(ag._select_mode(), "RECOVER")

    def test_repair_cap_per_game_drops_program_to_reactive(self):
        ag = EwmAgent(
            ToyEnv(_grid("2.3")),
            FakeLlm([]),
            config=AgentConfig(
                game_id="toy",
                max_repairs_per_divergence=99,   # not the trigger here
                max_repairs_per_game=2,
                min_live_pass_rate=0.0,          # floor never fires -> isolate the cap
            ),
        )
        ag.program = object()
        ag._repair = lambda frame, image: False
        frame = {"grid": [[2, 0, 3]], "valid_actions": ["UP"]}
        # First divergence: under the per-game cap, program survives.
        ag._handle_divergence(frame, None)
        self.assertIsNotNone(ag.program)
        # Second divergence hits max_repairs_per_game=2 -> program dropped, reactive.
        ag._handle_divergence(frame, None)
        self.assertIsNone(ag.program)
        self.assertTrue(ag._modelability_poor)

    def test_dropped_program_stays_reactive_and_never_replans(self):
        ag = EwmAgent(
            ToyEnv(_grid("2.3")),
            FakeLlm([]),
            config=AgentConfig(game_id="toy"),
        )
        ag._drop_program("test")
        # Even with no program, the mode machine stays RECOVER (modelability poor) rather than
        # returning to SYNTHESIZE.
        self.assertEqual(ag._select_mode(), "RECOVER")


class ReactiveFallbackTests(unittest.TestCase):
    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def test_k_failed_syntheses_flip_to_reactive(self):
        EwmAgent._vision_available = staticmethod(lambda: False)
        env = ToyEnv(_grid("2.3"))
        # Every synthesis returns unusable output (no fenced block) so synthesis fails K times,
        # then the loop flips to RECOVER (reactive) which returns an action batch directly.
        bad = "sorry, I cannot produce code"
        script = [bad, bad, bad]  # 3 failed synth cycles (K=3) -> RECOVER
        # reactive turn: decide returns actions, then reflect.
        script += ['{"actions": ["RIGHT"]}', '{"prediction_ok": true}']
        script += ['{"actions": ["RIGHT"]}', '{"prediction_ok": true}'] * 10
        llm = FakeLlm(script)
        ag = EwmAgent(
            env,
            llm,
            config=AgentConfig(game_id="toy", max_turns=12, reactive_after_failures=3),
        )
        # Seed a transition so synthesis is forced to validate (and its parse-failure path fires).
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        summary = ag.run()
        self.assertGreaterEqual(summary["reactive_turns"], 1)
        self.assertIn("RECOVER", summary["modes"])
        # Reactive play still grows the suite from real transitions.
        self.assertGreater(summary["transitions"], 1)

    def test_reactive_parse_failure_falls_back_to_noop_probe(self):
        EwmAgent._vision_available = staticmethod(lambda: False)
        env = ToyEnv(_grid("2.3"))
        # Force straight into reactive with unparseable decide output; agent retries once then
        # probes the first valid action.
        script = ["nope", "nope", "nope"]  # fail synth K times
        script += ["still no json", "still no json", '{"prediction_ok": true}']  # reactive: 2 fails -> probe, reflect
        script += ["x", "x", "y"] * 20
        llm = FakeLlm(script)
        ag = EwmAgent(
            env, llm, config=AgentConfig(game_id="toy", max_turns=8, reactive_after_failures=3)
        )
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        summary = ag.run()
        self.assertGreaterEqual(summary["reactive_turns"], 1)


class SynthesisPacingTests(unittest.TestCase):
    """A failed SYNTHESIZE cycle must NOT loop straight back into SYNTHESIZE: the loop interleaves at
    least one reactive turn between synthesis cycles, and a per-game ceiling
    (max_synth_attempts_per_game) flips the loop to reactive permanently. This bounds the ls20
    pathology where synthesis cycles ran back-to-back and ate the whole budget with almost no game
    actions (modes_visited=[SYNTHESIZE], never reactive)."""

    def setUp(self):
        EwmAgent._vision_available = staticmethod(lambda: False)

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    class _ModeFake(FakeLlm):
        """Content-aware fake: SYNTHESIZE/REPAIR decide -> unusable prose (synthesis always fails);
        RECOVER decide -> a valid action batch; anything else (reflect) -> a reflection JSON."""

        def __init__(self):
            super().__init__([])
            self.synth_calls = 0
            self.recover_calls = 0

        def chat(self, messages, max_tokens=1024, temperature=0.0):
            self.received.append(
                {"messages": messages, "max_tokens": max_tokens, "temperature": temperature}
            )
            self.calls += 1
            last = messages[-1]["content"]
            text = last if isinstance(last, str) else ""
            if "Current mode: SYNTHESIZE" in text or "Current mode: REPAIR" in text:
                self.synth_calls += 1
                return {"content": "sorry, no code here", "finish_reason": None, "raw": ""}
            if "Return ONLY one fenced python block" in text:
                # terse re-ask after prose-only -> still no code, so synthesis gives up this cycle.
                return {"content": "still no code", "finish_reason": None, "raw": ""}
            if "Current mode: RECOVER" in text:
                self.recover_calls += 1
                return {"content": '{"actions": ["DOWN"]}', "finish_reason": None, "raw": ""}
            return {"content": '{"prediction_ok": true}', "finish_reason": None, "raw": ""}

    def test_failed_synth_cycle_interleaves_reactive_turn(self):
        # A single failed synthesis cycle must be followed by a reactive (RECOVER) turn before the
        # next SYNTHESIZE — modes_visited shows the interleave, and a real reactive turn ran.
        env = ToyEnv(_grid("2.3", "111"))  # DOWN into the wall row is a no-op; RECOVER emits DOWN so it never wins
        llm = self._ModeFake()
        ag = EwmAgent(
            env, llm,
            config=AgentConfig(
                game_id="toy", max_turns=4, min_probe_transitions=1,
                max_synth_attempts=1, max_synth_attempts_per_game=9,
            ),
        )
        ag.suite.append(_grid("2.3", "111"), "DOWN", _grid("2.3", "111"))
        summary = ag.run()
        # At least one reactive turn ran, and RECOVER appears interleaved with SYNTHESIZE.
        self.assertGreaterEqual(summary["reactive_turns"], 1)
        self.assertIn("SYNTHESIZE", summary["modes"])
        self.assertIn("RECOVER", summary["modes"])
        # The reactive turn immediately follows a SYNTHESIZE in the mode trace (interleave, not a run
        # of bare SYNTHESIZE).
        modes = summary["modes"]
        self.assertTrue(
            any(modes[i] == "SYNTHESIZE" and modes[i + 1] == "RECOVER" for i in range(len(modes) - 1)),
            f"expected a SYNTHESIZE->RECOVER interleave in {modes}",
        )
        # A RECOVER decide call actually happened (the reactive turn was executed, not skipped).
        self.assertGreaterEqual(llm.recover_calls, 1)

    def test_per_game_synth_cap_flips_to_reactive_permanently(self):
        # With the ceiling set low, the loop must stop re-entering SYNTHESIZE once it is hit and stay
        # reactive (modelability poor) for the rest of the game.
        env = ToyEnv(_grid("2.3", "111"))
        llm = self._ModeFake()
        ag = EwmAgent(
            env, llm,
            config=AgentConfig(
                game_id="toy", max_turns=30, min_probe_transitions=1,
                max_synth_attempts=1, max_synth_attempts_per_game=2,
            ),
        )
        ag.suite.append(_grid("2.3", "111"), "DOWN", _grid("2.3", "111"))
        summary = ag.run()
        # Exactly max_synth_attempts_per_game synthesis cycles were attempted, then the loop stopped
        # trying to synthesize.
        self.assertEqual(ag._synth_cycles_this_game, 2)
        self.assertTrue(ag._modelability_poor)
        self.assertIsNone(ag.program)
        self.assertEqual(ag._select_mode(), "RECOVER")
        # After the cap, every subsequent mode is RECOVER (never SYNTHESIZE again).
        modes = summary["modes"]
        last_synth = max(i for i, m in enumerate(modes) if m == "SYNTHESIZE")
        self.assertNotIn("SYNTHESIZE", modes[last_synth + 1 :])

    def test_synth_cap_config_default(self):
        self.assertEqual(AgentConfig().max_synth_attempts_per_game, 9)


class ContextPolicyTests(unittest.TestCase):
    """The user's context policy: KB summaries (not just titles) in the prompt, at most the
    IMMEDIATE previous step recapped, and calls stay stateless [system, user]."""

    def setUp(self):
        EwmAgent._vision_available = staticmethod(lambda: False)

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _agent(self, env=None):
        env = env or ToyEnv(_grid("2.3"))
        llm = FakeLlm([])
        return EwmAgent(env, llm, kb=None, config=_no_pil_config())

    def test_kb_block_carries_summaries_not_just_titles(self):
        ag = self._agent()
        hits = [
            {"title": "avatar movement", "summary": "avatar moves one cell per action on 0-cells"},
            {"title": "wall blocks", "summary": "cells valued 1 block movement"},
        ]
        frame = {"grid": [[2, 0, 3]], "valid_actions": ["UP"], "level": 1, "step": 0}
        messages = ag._decide_messages("SYNTHESIZE", frame, hits, None, None)
        user_text = messages[-1]["content"]
        self.assertIn("- avatar movement: avatar moves one cell per action", user_text)
        self.assertIn("- wall blocks: cells valued 1 block movement", user_text)

    def test_kb_block_truncates_summary_and_caps_hits(self):
        ag = self._agent()
        long_summary = "x" * 500
        hits = [{"title": f"note{i}", "summary": long_summary} for i in range(8)]
        frame = {"grid": [[2, 0, 3]], "valid_actions": ["UP"], "level": 1, "step": 0}
        messages = ag._decide_messages("SYNTHESIZE", frame, hits, None, None)
        user_text = messages[-1]["content"]
        # At most 5 hits are rendered.
        self.assertEqual(user_text.count("- note"), 5)
        # Each summary is truncated to ~300 chars (never the full 500).
        self.assertNotIn("x" * 400, user_text)

    def test_prev_step_block_absent_turn1_present_turn2(self):
        ag = self._agent()
        frame = {"grid": [[2, 0, 3]], "valid_actions": ["UP"], "level": 1, "step": 0}
        # Turn 1: no previous step yet.
        first = ag._decide_messages("RECOVER", frame, [], None, None)[-1]["content"]
        self.assertNotIn("Previous step:", first)
        # Simulate a landed action result, refreshing the single-step recap.
        ag._prev_step = {
            "action": "RIGHT",
            "executed_count": 1,
            "stop_reason": "completed",
            "board_changed": True,
            "score_delta": 0,
        }
        second = ag._decide_messages("RECOVER", frame, [], None, None)[-1]["content"]
        self.assertIn("Previous step:", second)
        self.assertIn("action=RIGHT", second)
        self.assertIn("stop_reason=completed", second)

    def test_stateless_two_message_calls_with_prev_step(self):
        # Even with a previous-step recap set, a decide call is exactly [system, user] — no
        # accumulated assistant/history turns.
        ag = self._agent()
        ag._prev_step = {"action": "RIGHT", "executed_count": 1, "stop_reason": "completed",
                         "board_changed": True, "score_delta": 1}
        frame = {"grid": [[2, 0, 3]], "valid_actions": ["UP"], "level": 1, "step": 0}
        messages = ag._decide_messages("SYNTHESIZE", frame, [], None, None)
        self.assertEqual([m["role"] for m in messages], ["system", "user"])

    def test_prev_step_refreshed_end_to_end_across_reactive_turns(self):
        # Drive the reactive path so real action results refresh _prev_step; the second RECOVER
        # decide call must carry the previous-step recap the first one lacked.
        env = ToyEnv(_grid("2..3"))  # goal far enough that a single RIGHT does not win
        script = ["nope", "nope", "nope"]  # fail synth K=3 -> RECOVER
        # reactive turns: each is decide(actions) + reflect.
        script += ['{"actions": ["RIGHT"]}', '{"prediction_ok": true}'] * 8
        llm = FakeLlm(script)
        # Pre-seeded suite meets the probe minimum so probing is skipped: this test's premise is
        # that NO real action lands before the first RECOVER decide (probe would break that).
        ag = EwmAgent(
            env, llm,
            config=AgentConfig(
                game_id="toy", max_turns=8, reactive_after_failures=3, min_probe_transitions=1
            ),
        )
        ag.suite.append(_grid("2..3"), "RIGHT", _grid(".2.3"))
        ag.run()
        recover_decides = [
            c["messages"][-1]["content"]
            for c in llm.received
            if isinstance(c["messages"][-1]["content"], str)
            and "Current mode: RECOVER" in c["messages"][-1]["content"]
        ]
        self.assertGreaterEqual(len(recover_decides), 2)
        # The FIRST reactive decide runs before any action has landed -> no previous-step recap.
        self.assertNotIn("Previous step:", recover_decides[0])
        # Once a real action result lands, a LATER reactive decide carries the single-step recap.
        self.assertTrue(
            any("Previous step:" in t for t in recover_decides[1:]),
            "expected a later RECOVER decide to carry the previous-step recap",
        )


class PerRoleModelTests(unittest.TestCase):
    """SYNTHESIZE/REPAIR decide calls route to config.synth_llm; ORIENT/RECOVER decide and reflect
    stay on the main llm."""

    def setUp(self):
        EwmAgent._vision_available = staticmethod(lambda: False)

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def test_synthesize_routes_to_synth_llm_reflect_stays_main(self):
        env = ToyEnv(_grid("2.3"))
        main = FakeLlm(['{"prediction_ok": true}'] * 6)  # reflect only
        synth = FakeLlm([_fenced(TOY_GAME_SOURCE)])       # the synthesis decide
        ag = EwmAgent(
            env, main,
            config=AgentConfig(
                game_id="toy", max_turns=10, synth_llm=synth, min_probe_transitions=1
            ),
        )
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        summary = ag.run()
        self.assertTrue(summary["program_accepted"])
        self.assertTrue(summary["won"])
        # The SYNTHESIZE decide landed on synth, not main.
        self.assertEqual(synth.calls, 1)
        synth_text = synth.received[0]["messages"][-1]["content"]
        self.assertIn("Current mode: SYNTHESIZE", synth_text)
        # Reflect ran on the main llm.
        self.assertGreaterEqual(main.calls, 1)
        for call in main.received:
            self.assertNotIn(
                "Current mode:", call["messages"][-1]["content"]
            )  # main saw only reflect prompts

    def test_repair_routes_to_synth_llm(self):
        env = ToyEnv(_grid("2..3"), deviate=True)  # env diverges -> REPAIR fires
        main = FakeLlm(['{"prediction_ok": false}'] * 20)
        synth = FakeLlm(
            [_fenced(TOY_GAME_SOURCE)]        # synthesize (on synth)
            + [_fenced(TOY_GAME_SOURCE)] * 12  # repair attempts (on synth)
        )
        ag = EwmAgent(
            env, main,
            config=AgentConfig(
                game_id="toy", max_turns=6, synth_llm=synth, min_probe_transitions=1
            ),
        )
        ag.suite.append(_grid("2..3"), "RIGHT", _grid(".2.3"))
        ag.run()
        synth_modes = [c["messages"][-1]["content"] for c in synth.received]
        self.assertTrue(any("Current mode: SYNTHESIZE" in t for t in synth_modes))
        self.assertTrue(any("Current mode: REPAIR" in t for t in synth_modes))
        # No decide (SYNTHESIZE/REPAIR) call ever hit the main llm.
        for call in main.received:
            self.assertNotIn("Current mode: SYNTHESIZE", call["messages"][-1]["content"])
            self.assertNotIn("Current mode: REPAIR", call["messages"][-1]["content"])

    def test_recover_decide_stays_on_main_llm(self):
        # Reactive (RECOVER) decide calls are NOT routed to synth_llm.
        env = ToyEnv(_grid("2.3"))
        main = FakeLlm(
            ["nope", "nope", "nope"]  # failed synth K=3 (these decide calls go to synth)
            + ['{"actions": ["RIGHT"]}', '{"prediction_ok": true}'] * 6  # RECOVER decide + reflect
        )
        synth = FakeLlm(["bad", "bad", "bad", "bad", "bad", "bad"])
        ag = EwmAgent(
            env, main,
            config=AgentConfig(game_id="toy", max_turns=8, reactive_after_failures=3, synth_llm=synth),
        )
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        ag.run()
        # RECOVER decide landed on main (it emitted the winning action from main's script).
        main_texts = [c["messages"][-1]["content"] for c in main.received]
        self.assertTrue(any("Current mode: RECOVER" in t for t in main_texts))


class WriteGateTests(unittest.TestCase):
    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def test_write_cap_respected_on_acceptance(self):
        EwmAgent._vision_available = staticmethod(lambda: False)
        env = ToyEnv(_grid("2.3"))
        llm = FakeLlm([_fenced(TOY_GAME_SOURCE), '{"prediction_ok": true, "note": "won"}'])
        kb = FakeKb(max_writes_per_turn=2)
        ag = EwmAgent(
            env, llm, kb=kb,
            config=AgentConfig(game_id="toy", max_turns=10, min_probe_transitions=1),
        )
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        ag.run()
        # begin_turn resets each write batch, so no batch ever exceeds the cap of 2.
        # We assert at least one write happened and the recorded count never breached the cap.
        self.assertGreaterEqual(len(kb.writes), 1)
        self.assertLessEqual(kb._this_turn, kb.max_writes_per_turn)


class ArtifactPersistenceTests(unittest.TestCase):
    """Rejected world-model candidates must be inspectable: with artifacts_dir set, each
    synthesis/repair attempt writes a NN-{mode}.json (adopted flag + validation report), the run
    dumps a round-trippable transition-suite.json, and artifacts_dir=None writes nothing."""

    def setUp(self):
        EwmAgent._vision_available = staticmethod(lambda: False)

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def test_synthesize_reject_writes_artifact_with_populated_report(self):
        import json
        import os
        import tempfile

        from bench.arc_agi3_zonoid.ewm.world_model import TransitionSuite

        with tempfile.TemporaryDirectory() as tmp:
            env = ToyEnv(_grid("2.3"))
            # First candidate is WRONG (fails the seeded RIGHT transition) -> rejected; second is
            # correct -> adopted. Both attempts must be persisted.
            llm = FakeLlm(
                [_fenced(WRONG_GAME_SOURCE), _fenced(TOY_GAME_SOURCE), '{"prediction_ok": true}']
            )
            ag = EwmAgent(
                env, llm,
                config=AgentConfig(
                    game_id="toy", max_turns=10, min_probe_transitions=1, artifacts_dir=tmp
                ),
            )
            ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
            ag.run()

            # First attempt is the rejected synthesize.
            reject_path = os.path.join(tmp, "01-SYNTHESIZE.json")
            self.assertTrue(os.path.exists(reject_path))
            with open(reject_path, encoding="utf-8") as fh:
                art = json.load(fh)
            self.assertEqual(art["mode"], "SYNTHESIZE")
            self.assertFalse(art["adopted"])
            self.assertIsNotNone(art["extracted_program_source"])
            report = art["validation_report"]
            self.assertIsNotNone(report)
            self.assertFalse(report["ok"])
            self.assertGreater(report["total"], 0)
            self.assertIn("pass_count", report)
            self.assertIn("mismatches", report)
            self.assertIn("prompt_text", art)
            self.assertIn("raw_llm_response", art)

            # The accepted attempt is persisted too, with adopted=True.
            accept_path = os.path.join(tmp, "02-SYNTHESIZE.json")
            self.assertTrue(os.path.exists(accept_path))
            with open(accept_path, encoding="utf-8") as fh:
                accepted = json.load(fh)
            self.assertTrue(accepted["adopted"])

            # Suite dump round-trips through TransitionSuite.
            suite_path = os.path.join(tmp, "transition-suite.json")
            self.assertTrue(os.path.exists(suite_path))
            with open(suite_path, encoding="utf-8") as fh:
                suite = TransitionSuite.from_json(fh.read())
            self.assertGreaterEqual(len(suite), 1)
            self.assertEqual(len(suite), len(ag.suite))

            # A program was adopted -> final-program.py exists.
            self.assertTrue(os.path.exists(os.path.join(tmp, "final-program.py")))

    def test_artifacts_dir_none_writes_nothing(self):
        import os
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            probe = os.path.join(tmp, "probe")
            env = ToyEnv(_grid("2.3"))
            llm = FakeLlm([_fenced(TOY_GAME_SOURCE), '{"prediction_ok": true}'])
            ag = EwmAgent(
                env, llm,
                config=AgentConfig(
                    game_id="toy", max_turns=10, min_probe_transitions=1, artifacts_dir=None
                ),
            )
            ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
            ag.run()
            # artifacts_dir=None means the dir was never created and nothing was written.
            self.assertFalse(os.path.exists(probe))
            self.assertEqual(os.listdir(tmp), [])


class SynthesisPromptTests(unittest.TestCase):
    """The SYNTHESIZE/REPAIR prompt carries the real grid (parse it, don't hardcode): grid rows, a
    segmentation object summary, sample transitions, and the hard dimension contract. The gameplay
    (RECOVER/ORIENT decide) prompt is left unchanged."""

    def setUp(self):
        EwmAgent._vision_available = staticmethod(lambda: False)

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _agent(self):
        return EwmAgent(ToyEnv(_grid("2.3")), FakeLlm([]), kb=None, config=_no_pil_config())

    def test_synthesize_prompt_contains_grid_rows_objects_and_contract(self):
        ag = self._agent()
        # Seed a transition so the sample-transitions block has content.
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        frame = {"grid": _grid("2.3"), "valid_actions": ["UP"], "level": 1, "step": 0}
        text = ag._decide_messages("SYNTHESIZE", frame, [], None, None)[-1]["content"]
        # (a) grid rows as digit row-strings, with the dimensions stated.
        self.assertIn("1 rows x 3 cols", text)
        self.assertIn("203", text)  # the frame grid packed as a digit row-string
        # (b) object summary from segment_grid: color/pixels/bbox/id.
        self.assertIn("Object summary", text)
        self.assertIn("id=", text)
        self.assertIn("bbox=", text)
        # (c) sample transitions rendered before/action/after.
        self.assertIn("Observed transitions", text)
        self.assertIn("before:", text)
        self.assertIn("after:", text)
        # (d) the hard dimension contract.
        self.assertIn("never hardcode a grid", text)
        self.assertIn("same dimensions", text)

    def test_repair_prompt_also_carries_grid_block(self):
        ag = self._agent()
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        frame = {"grid": _grid("2.3"), "valid_actions": ["UP"], "level": 1, "step": 0}
        text = ag._decide_messages("REPAIR", frame, [], None, None)[-1]["content"]
        self.assertIn("SYNTHESIS DATA", text)
        self.assertIn("never hardcode a grid", text)

    def test_synthesize_prompt_teaches_unknown_partial_fidelity(self):
        # The SYNTHESIZE prompt must teach the UNKNOWN sentinel by its exact injected name, tell the
        # program the validator SKIPS UNKNOWN cells, name the input-row format, and advise marking an
        # every-action-changing region (energy/timer bar) UNKNOWN rather than assuming it constant.
        # This is the ls20 partial-fidelity gap: candidates failed ONLY on an auto-changing HUD-bar
        # region they had no sanctioned way to declare unmodelable.
        from bench.arc_agi3_zonoid.ewm.world_model import UNKNOWN

        ag = self._agent()
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        frame = {"grid": _grid("2.3"), "valid_actions": ["UP"], "level": 1, "step": 0}
        text = ag._decide_messages("SYNTHESIZE", frame, [], None, None)[-1]["content"]
        # The sentinel is named EXACTLY as world_model injects it into the program namespace.
        self.assertEqual(repr(UNKNOWN), "UNKNOWN")
        self.assertIn("UNKNOWN", text)
        # Validator-skips-UNKNOWN and the every-action-changing-region advice.
        self.assertIn("SKIPS", text)
        self.assertIn("either model it EXACTLY or mark those cells UNKNOWN", text)
        self.assertIn("do NOT assume it stays constant", text)
        # Input-row format clarification.
        self.assertIn("Each row of the grid is a list of ints", text)

    def test_synthesize_prompt_names_stdlib_whitelist_and_rejects_numpy(self):
        # The SYNTHESIZE prompt must tell the model exactly which stdlib modules are importable and
        # that numpy/pandas are NOT — the ls20 candidates died on "import of 'numpy' is not
        # permitted" with nothing telling them what WAS available. The advertised list must match the
        # sandbox loader's whitelist (world_model.ALLOWED_IMPORTS) verbatim so it can never lie.
        from bench.arc_agi3_zonoid.ewm.world_model import ALLOWED_IMPORTS

        ag = self._agent()
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        frame = {"grid": _grid("2.3"), "valid_actions": ["UP"], "level": 1, "step": 0}
        text = ag._decide_messages("SYNTHESIZE", frame, [], None, None)[-1]["content"]
        self.assertIn("Only these stdlib modules may be imported:", text)
        self.assertIn("numpy/pandas are NOT available", text)
        # Every whitelisted module is named, and it matches the loader's frozenset exactly.
        for mod in ALLOWED_IMPORTS:
            self.assertIn(mod, text)
        expected_list = ", ".join(sorted(ALLOWED_IMPORTS))
        self.assertIn(expected_list, text)
        # Sanity: the whitelist covers the modules that killed ls20 candidates (they'd have used
        # random/re/statistics) and excludes numpy/pandas.
        self.assertNotIn("numpy,", expected_list)
        self.assertNotIn("pandas,", expected_list)

    def test_synthesize_prompt_teaches_object_relative_authoring(self):
        # The SYNTHESIZE prompt must advertise the injected segment(grid) helper and steer the model
        # to author mechanics RELATIVE TO OBJECTS (find the avatar by color each step, move by delta)
        # instead of absolute cell indices, which break on new levels.
        ag = self._agent()
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        frame = {"grid": _grid("2.3"), "valid_actions": ["UP"], "level": 1, "step": 0}
        text = ag._decide_messages("SYNTHESIZE", frame, [], None, None)[-1]["content"]
        self.assertIn("segment(grid) is already injected", text)
        self.assertIn("{nodes, adjacency_list}", text)
        self.assertIn("PREFER expressing mechanics relative to objects", text)
        self.assertIn("absolute indices break on new levels", text)

    def test_gameplay_prompt_has_no_grid_dump(self):
        # RECOVER (reactive play) decide prompt is unchanged: no grid dump, no contract.
        ag = self._agent()
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        frame = {"grid": _grid("2.3"), "valid_actions": ["UP"], "level": 1, "step": 0}
        text = ag._decide_messages("RECOVER", frame, [], None, None)[-1]["content"]
        self.assertNotIn("SYNTHESIS DATA", text)
        self.assertNotIn("never hardcode a grid", text)


class AutoChangingCellsHintTests(unittest.TestCase):
    """The SYNTHESIZE/REPAIR prompt states the every-action-changing region as bounding-box row/col
    ranges computed from the suite: the ls20 candidates modelled ls20's auto-repainting bar as static
    because they could not spot the changing region in a raw transition dump. Only cells that change
    in EVERY observed transition count, and only once the suite holds >= 3 transitions. Also asserts
    the step-tuple contract line (candidate 04 died on 'not enough values to unpack')."""

    def setUp(self):
        EwmAgent._vision_available = staticmethod(lambda: False)

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _agent(self):
        return EwmAgent(ToyEnv(_grid("2.3")), FakeLlm([]), kb=None, config=_no_pil_config())

    @staticmethod
    def _box_grid(fill: int, changed_cells):
        """A 6x6 grid of ``fill`` with each (row, col) in ``changed_cells`` bumped by +1 so it differs
        from the all-``fill`` before-grid."""

        grid = [[fill for _ in range(6)] for _ in range(6)]
        for (r, c) in changed_cells:
            grid[r][c] = fill + 1
        return grid

    def _seed_constant_region(self, ag, n=3):
        """Seed ``n`` transitions in which the block rows 1-2 cols 2-3 changes in EVERY transition."""

        region = {(1, 2), (1, 3), (2, 2), (2, 3)}
        before = [[4 for _ in range(6)] for _ in range(6)]
        for _ in range(n):
            ag.suite.append(before, "UP", self._box_grid(4, region))

    def test_hint_states_exact_range_from_suite(self):
        ag = self._agent()
        self._seed_constant_region(ag, n=3)
        frame = {"grid": _grid("2.3"), "valid_actions": ["UP"], "level": 1, "step": 0}
        text = ag._decide_messages("SYNTHESIZE", frame, [], None, None)[-1]["content"]
        self.assertIn("OBSERVED AUTO-CHANGING CELLS", text)
        self.assertIn("rows 1-2 cols 2-3", text)
        self.assertIn("Model these exactly or render them UNKNOWN", text)
        self.assertIn("do NOT model them as static", text)

    def test_hint_absent_below_three_transitions(self):
        ag = self._agent()
        self._seed_constant_region(ag, n=2)
        frame = {"grid": _grid("2.3"), "valid_actions": ["UP"], "level": 1, "step": 0}
        text = ag._decide_messages("SYNTHESIZE", frame, [], None, None)[-1]["content"]
        self.assertNotIn("OBSERVED AUTO-CHANGING CELLS", text)

    def test_cells_changing_in_only_some_transitions_excluded(self):
        # Rows 1-2 cols 2-3 change in ALL three transitions; cell (4,4) changes in only the first.
        ag = self._agent()
        region = {(1, 2), (1, 3), (2, 2), (2, 3)}
        before = [[4 for _ in range(6)] for _ in range(6)]
        ag.suite.append(before, "UP", self._box_grid(4, region | {(4, 4)}))
        ag.suite.append(before, "DOWN", self._box_grid(4, region))
        ag.suite.append(before, "LEFT", self._box_grid(4, region))
        cells = ag._auto_changing_cells()
        self.assertEqual(cells, region)
        self.assertNotIn((4, 4), cells)
        text = ag._decide_messages("SYNTHESIZE", frame={"grid": _grid("2.3"),
                                   "valid_actions": ["UP"], "level": 1, "step": 0},
                                   kb_hits=[], report=None, image_url=None)[-1]["content"]
        self.assertIn("rows 1-2 cols 2-3", text)
        self.assertNotIn("row 4 col 4", text)

    def test_disjoint_regions_render_as_separate_boxes(self):
        ag = self._agent()
        # Two disjoint changing blocks: rows 0-1 col 0, and row 4 cols 4-5.
        region = {(0, 0), (1, 0), (4, 4), (4, 5)}
        before = [[4 for _ in range(6)] for _ in range(6)]
        for _ in range(3):
            ag.suite.append(before, "UP", self._box_grid(4, region))
        text = ag._auto_changing_cells_text()
        self.assertIn("rows 0-1 col 0", text)
        self.assertIn("row 4 cols 4-5", text)

    def test_step_tuple_contract_line_present(self):
        ag = self._agent()
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        frame = {"grid": _grid("2.3"), "valid_actions": ["UP"], "level": 1, "step": 0}
        text = ag._decide_messages("SYNTHESIZE", frame, [], None, None)[-1]["content"]
        self.assertIn(
            "step(state, action) MUST return a (state, events) tuple — never a bare state", text
        )
        # Also present on the REPAIR prompt (same contract paragraph).
        repair = ag._decide_messages("REPAIR", frame, [], None, None)[-1]["content"]
        self.assertIn("(state, events) tuple — never a bare state", repair)


class SynthTokenBudgetTests(unittest.TestCase):
    """SYNTHESIZE/REPAIR decide calls use config.synth_max_tokens (default 4096); gameplay decide
    and reflect stay at their smaller budgets. 1024 truncated every ls20 candidate mid-program."""

    def setUp(self):
        EwmAgent._vision_available = staticmethod(lambda: False)

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def test_synth_config_default(self):
        self.assertEqual(AgentConfig().synth_max_tokens, 4096)

    def test_synthesize_call_uses_synth_max_tokens(self):
        env = ToyEnv(_grid("2.3"))
        llm = FakeLlm([_fenced(TOY_GAME_SOURCE), '{"prediction_ok": true}'])
        ag = EwmAgent(
            env, llm,
            config=AgentConfig(
                game_id="toy", max_turns=10, min_probe_transitions=1, synth_max_tokens=4096
            ),
        )
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        ag.run()
        # The SYNTHESIZE decide call requested synth_max_tokens; reflect used the small budget.
        synth_calls = [
            c for c in llm.received
            if isinstance(c["messages"][-1]["content"], str)
            and "Current mode: SYNTHESIZE" in c["messages"][-1]["content"]
        ]
        self.assertTrue(synth_calls)
        self.assertEqual(synth_calls[0]["max_tokens"], 4096)
        reflect_calls = [
            c for c in llm.received
            if isinstance(c["messages"][-1]["content"], str)
            and "Reflect on the action" in c["messages"][-1]["content"]
        ]
        self.assertTrue(reflect_calls)
        self.assertEqual(reflect_calls[0]["max_tokens"], AgentConfig().reflect_max_tokens)

    def test_no_fenced_block_triggers_single_terse_retry(self):
        # First synth response is prose-only (no fenced block) -> exactly ONE terse retry, whose
        # prompt is the "one fenced block" re-ask; the retry then supplies a valid program.
        env = ToyEnv(_grid("2.3"))
        llm = FakeLlm(
            [
                "I think the model should do X and Y but here is no code block.",  # prose only
                _fenced(TOY_GAME_SOURCE),                                          # terse retry
                '{"prediction_ok": true}',
            ]
        )
        ag = EwmAgent(
            env, llm,
            config=AgentConfig(game_id="toy", max_turns=10, min_probe_transitions=1),
        )
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        summary = ag.run()
        self.assertTrue(summary["program_accepted"])
        # The second decide call carried the terse "one fenced block" re-ask.
        retry_text = llm.received[1]["messages"][-1]["content"]
        self.assertIn("Return ONLY one fenced python block", retry_text)


class GraphSynthesisTests(unittest.TestCase):
    """config.graph_synthesis routes SYNTHESIZE through a synth_graph.SynthSession: the ANALYZE ->
    PLAN -> EDIT chain adopts a program, feeds deltas.summarize_suite texts to ANALYZE, injects the
    KB hypothesis menu as ANALYZE context, and writes a per-EDIT artifact."""

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _seeded_agent(self, llm, kb=None):
        import json

        EwmAgent._vision_available = staticmethod(lambda: False)
        analyze = json.dumps([{"name": "move", "description": "shift"}])
        plan = json.dumps(
            [{"name": "toy", "description": "author", "target_transitions": [0]}]
        )
        # FakeLlm scripts ANALYZE, PLAN, EDIT completions in order.
        scripted = FakeLlm([analyze, plan, _fenced(TOY_GAME_SOURCE)]) if llm is None else llm
        ag = EwmAgent(
            env=None,
            llm=scripted,
            kb=kb,
            vision_enabled=False,
            config=AgentConfig(game_id="toy", graph_synthesis=True),
            graph=None,
        )
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        return ag, scripted

    def test_graph_synthesis_adopts_program(self):
        ag, _ = self._seeded_agent(None)
        frame = {"grid": _grid("2.3"), "level": 1, "step": 0}
        self.assertTrue(ag._synthesize_graph(frame))
        self.assertIsNotNone(ag.program)
        self.assertTrue(ag.summary.program_accepted)

    def test_graph_synthesis_feeds_deltas_to_analyze(self):
        ag, llm = self._seeded_agent(None)
        frame = {"grid": _grid("2.3"), "level": 1, "step": 0}
        ag._synthesize_graph(frame)
        # First FakeLlm call is the ANALYZE completion; its user prompt carries delta text derived
        # from summarize_suite (the RIGHT action's aggregate effect line).
        analyze_user = llm.received[0]["messages"][-1]["content"]
        self.assertIn("transition deltas", analyze_user.lower())
        self.assertIn("RIGHT", analyze_user)

    def test_graph_synthesis_writes_edit_artifact(self):
        import json
        import os
        import tempfile

        d = tempfile.mkdtemp()
        EwmAgent._vision_available = staticmethod(lambda: False)
        analyze = json.dumps([{"name": "move", "description": "shift"}])
        plan = json.dumps(
            [{"name": "toy", "description": "author", "target_transitions": [0]}]
        )
        llm = FakeLlm([analyze, plan, _fenced(TOY_GAME_SOURCE)])
        ag = EwmAgent(
            env=None,
            llm=llm,
            kb=None,
            vision_enabled=False,
            config=AgentConfig(game_id="toy", graph_synthesis=True, artifacts_dir=d),
            graph=None,
        )
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        ag._synthesize_graph({"grid": _grid("2.3"), "level": 1, "step": 0})
        arts = sorted(f for f in os.listdir(d) if f.endswith("-SYNTHESIZE.json"))
        self.assertTrue(arts)
        with open(os.path.join(d, arts[0]), encoding="utf-8") as fh:
            art = json.load(fh)
        for key in ("mode", "prompt_text", "raw_llm_response",
                    "extracted_program_source", "validation_report", "adopted"):
            self.assertIn(key, art)
        self.assertTrue(art["adopted"])

    def test_graph_synthesis_injects_hypothesis_menu_context(self):
        import json

        kb = SearchKb(hits=[{"title": "gate on a key", "summary": "SOME games need a key first"}])
        analyze = json.dumps([{"name": "move", "description": "shift"}])
        plan = json.dumps(
            [{"name": "toy", "description": "author", "target_transitions": [0]}]
        )
        llm = FakeLlm([analyze, plan, _fenced(TOY_GAME_SOURCE)])
        ag, _ = self._seeded_agent(llm, kb=kb)
        ag._synthesize_graph({"grid": _grid("2.3"), "level": 1, "step": 0})
        analyze_user = llm.received[0]["messages"][-1]["content"]
        # The hypothesis-menu preamble + note text reach the ANALYZE prompt as context.
        self.assertIn("HYPOTHES", analyze_user.upper())
        self.assertIn("gate on a key", analyze_user)

    def test_graph_synthesis_accumulates_per_change_stats(self):
        ag, _ = self._seeded_agent(None)
        ag._synthesize_graph({"grid": _grid("2.3"), "level": 1, "step": 0})
        stats = ag._graph_synth_stats
        self.assertEqual(stats["sessions"], 1)
        self.assertEqual(stats["changes_proposed"], 1)
        self.assertEqual(stats["changes_passed"], 1)
        self.assertEqual(stats["changes_skipped"], 0)
        # One FINAL pass rate recorded: the toy program passes the single seeded transition.
        self.assertEqual(stats["final_pass_rates"], [[1, 1]])

    def test_graph_synthesis_refuses_adoption_on_failed_final(self):
        import json

        analyze = json.dumps([{"name": "move", "description": "shift"}])
        plan = json.dumps(
            [{"name": "toy", "description": "author", "target_transitions": [0]}]
        )
        # Every EDIT attempt proposes the WRONG program -> nothing adopted -> FINAL fails.
        llm = FakeLlm(
            [analyze, plan, _fenced(WRONG_GAME_SOURCE), _fenced(WRONG_GAME_SOURCE),
             _fenced(WRONG_GAME_SOURCE)]
        )
        ag, _ = self._seeded_agent(llm)
        self.assertFalse(ag._synthesize_graph({"grid": _grid("2.3"), "level": 1, "step": 0}))
        self.assertIsNone(ag.program)


if __name__ == "__main__":
    unittest.main()
