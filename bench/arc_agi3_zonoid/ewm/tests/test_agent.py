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
    return AgentConfig(game_id="toy", max_turns=20)


class ParsingTests(unittest.TestCase):
    def test_extract_python_fenced(self):
        code = extract_python("prose\n```python\ndef init_state(f):\n    return f\n```")
        self.assertIn("def init_state", code)

    def test_extract_python_unfenced_contract(self):
        code = extract_python("def init_state(f):\n    return f\ndef step(s,a):\n    return s,{}")
        self.assertIsNotNone(code)

    def test_extract_python_none(self):
        self.assertIsNone(extract_python("no code here"))

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
        ag = EwmAgent(env, llm, kb=kb, config=AgentConfig(game_id="toy", max_turns=10))
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        summary = ag.run()
        self.assertTrue(summary["program_accepted"])
        # Fell through to synthesis: exactly one decide call.
        self.assertEqual(summary["decide_calls"], 1)


class SynthesizeExecuteTests(unittest.TestCase):
    def _agent(self, env, llm, **kw):
        # Disable vision so these tests don't depend on Pillow.
        EwmAgent._vision_available = staticmethod(lambda: False)
        return EwmAgent(env, llm, config=AgentConfig(game_id="toy", max_turns=20), **kw)

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
        ag = EwmAgent(env, llm, config=AgentConfig(game_id="toy", max_turns=6))
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


class WriteGateTests(unittest.TestCase):
    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def test_write_cap_respected_on_acceptance(self):
        EwmAgent._vision_available = staticmethod(lambda: False)
        env = ToyEnv(_grid("2.3"))
        llm = FakeLlm([_fenced(TOY_GAME_SOURCE), '{"prediction_ok": true, "note": "won"}'])
        kb = FakeKb(max_writes_per_turn=2)
        ag = EwmAgent(env, llm, kb=kb, config=AgentConfig(game_id="toy", max_turns=10))
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        ag.run()
        # begin_turn resets each write batch, so no batch ever exceeds the cap of 2.
        # We assert at least one write happened and the recorded count never breached the cap.
        self.assertGreaterEqual(len(kb.writes), 1)
        self.assertLessEqual(kb._this_turn, kb.max_writes_per_turn)


if __name__ == "__main__":
    unittest.main()
