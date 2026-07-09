"""Tests for the EWM agent loop (mode machine, decide/reflect, suite growth, reactive fallback).

The scripted ``ToyEnv`` reuses the world-model kit's toy-game pattern (avatar=2 moves on 0-cells,
walls=1 block, goal=3). ``FakeLlm`` scripts the decide/reflect calls, and a ``FakeKb`` stands in for
the KB WriteGate. All tests run without any real LLM or daemon; the PIL-free test forces vision off.
"""

from __future__ import annotations

import re
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
from bench.arc_agi3_zonoid.ewm.world_model import grids_match


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
                # UNKNOWN-aware (matches live.py / driver.py): masked cells are wildcards, so a
                # partially-adopted program's UNKNOWN cells never spuriously trip a divergence.
                if not grids_match([list(r) for r in expect[index]], after):
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

    def write_goal_evidence(self, *args, **kw):
        return self._write("goal_evidence", *args)

    def write_interaction(self, *args, **kw):
        return self._write("interaction", *args)

    def write_failed_repair(self, *args, **kw):
        return self._write("failed_repair", *args)

    def write_coverage_state(self, game_id, body, *, supersedes=None):
        # Coverage persistence bypasses the per-turn write cap (one acceptance event, agent-owned).
        self.writes.append(("coverage_state", (game_id, body, supersedes)))
        return {"ok": True}


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
        # ORIENT fetches a generous candidate pool (k=20) so a chunked program's index note surfaces
        # past the system-note + chunk band; a single inline program note is still returned + adopted.
        self.assertEqual(kb.client.queries[0][1], 20)

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

    def test_orient_adopts_program_from_fenced_note_body(self):
        # Warm-start round-trip variant: the note body carries the program ONLY as a fenced ```python
        # block (no "program source:" marker). ORIENT must still extract, load, validate and adopt it
        # straight from the KB — this is the dev-time-persisted-program -> ORIENT-recall path.
        EwmAgent._vision_available = staticmethod(lambda: False)
        env = ToyEnv(_grid("2.3"))
        hit = {
            "title": "game toy world model program",
            "summary": (
                "handles avatar movement\n\npass rate: 2/2\n\n" + _fenced(TOY_GAME_SOURCE)
            ),
        }
        kb = SearchKb([hit])
        llm = FakeLlm(['{"prediction_ok": true}'] * 6)
        ag = EwmAgent(env, llm, kb=kb, config=AgentConfig(game_id="toy", max_turns=10))
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        summary = ag.run()
        self.assertTrue(summary["program_accepted"])
        self.assertTrue(summary["won"])
        # Adopted straight from the fenced note body: zero synthesis decide calls.
        self.assertEqual(summary["decide_calls"], 0)
        self.assertTrue(kb.client.queries)

    def test_orient_partial_adopts_stored_ceiling_program(self):
        # Pillar-5 offline verification: the dev-time ls20 ceiling program passes 12/13 of the
        # recorded live suite (it deliberately leaves one auto-changing region unmodeled). A stored
        # program that is not a full pass must still be adopted via the changed-cells partial-adopt
        # floor (mask the persistently-wrong cells UNKNOWN), not discarded — otherwise the warm-start
        # program this path exists to recall would never be usable. Loads the REAL run artifacts.
        import json
        import os

        here = os.path.dirname(os.path.abspath(__file__))
        run_root = os.path.normpath(os.path.join(here, "..", "..", "..", "..", "out", "ewm-runs"))
        edit_path = os.path.join(run_root, "ceiling-ls20-1783084398", "edit-01.json")
        suite_path = os.path.join(run_root, "ls20-1783084398", "transition-suite.json")
        if not (os.path.exists(edit_path) and os.path.exists(suite_path)):
            self.skipTest("ceiling ls20 run artifacts not present")

        source = json.load(open(edit_path))["source"]
        transitions = json.load(open(suite_path))
        first_before = transitions[0]["before_grid"]

        # A mock env whose observe() hands back the recorded first frame (for board-cell sizing).
        class _MockEnv:
            def observe(self_inner):
                return {"grid": first_before}

        hit = {
            "title": "game ls20 world model program",
            "summary": "linked color 12 plus 9 unit; each action translates by plus or minus 5\n\n"
            "pass rate: 12/13\n\nprogram source:\n" + source,
        }
        EwmAgent._vision_available = staticmethod(lambda: False)
        kb = SearchKb([hit])
        ag = EwmAgent(
            _MockEnv(),
            FakeLlm([]),
            kb=kb,
            config=AgentConfig(game_id="ls20", max_turns=1),
        )
        for t in transitions:
            ag.suite.append(t["before_grid"], t["action"], t["after_grid"])

        adopted = ag._orient({"grid": first_before})
        self.assertTrue(adopted, "ORIENT should partial-adopt the stored 12/13 ceiling program")
        self.assertIsNotNone(ag.program)
        self.assertTrue(ag.summary.program_adopted_partial)
        # Masked region is tiny (the single unmodeled transition's cells), well under the mask cap.
        self.assertGreater(ag.summary.mask_cells, 0)
        self.assertGreaterEqual(ag.summary.changed_cells_accuracy, 0.6)


class _TruncatingKbClient:
    """A KbClient that persists notes and honors BOTH daemon truncation limits, so an ORIENT
    reassembly test would have CAUGHT run 12's break: a program stored in ONE note is clipped past
    recall, but a chunked program round-trips because each chunk fits the 1200-char read cap.

    * ``note`` clips the stored body to WRITE_CLIP (2000).
    * ``search`` matches on title-token superset; returns a 200-char ``summary`` always and, when
      ``full_content`` is set, a ``content`` field clipped to READ_CAP (1200).
    """

    WRITE_CLIP = 2000
    READ_CAP = 1200

    def __init__(self) -> None:
        import re as _re

        self._re = _re
        self.notes: list[dict] = []

    def note(self, title, summary, category="arc-agi-3", supersedes=None):
        self.notes.append(
            {"title": str(title), "stored": str(summary)[: self.WRITE_CLIP]}
        )
        return {"ok": True, "id": f"note-{len(self.notes)}"}

    def _tokens(self, text):
        return set(t for t in self._re.split(r"[^0-9A-Za-z]+", text.lower()) if t)

    def search(self, q, k, gated=False, full_content=False):
        q_tokens = self._tokens(q)
        out = []
        for note in self.notes:
            if q_tokens and q_tokens.issubset(self._tokens(note["title"])):
                hit = {"title": note["title"], "summary": note["stored"][:200]}
                if full_content:
                    hit["content"] = note["stored"][: self.READ_CAP]
                # Exact-title match outranks a token-superset match (real-daemon relevance proxy): a
                # "chunk 3 of 3" query's tokens are also a subset of "chunk 1 of 3".
                out.append((0 if note["title"].strip().lower() == q.strip().lower() else 1, hit))
        out.sort(key=lambda pair: pair[0])
        return [h for _, h in out[:k]]


class _WriteGateOver:
    """Minimal WriteGate-shaped wrapper exposing ``client`` (for _kb_search) and delegating the
    chunked writer to the real gate logic."""

    def __init__(self, client):
        from bench.arc_agi3_zonoid.ewm.kb_protocol import WriteGate

        self.client = client
        self._gate = WriteGate(client, max_writes_per_turn=2)
        self._gate.begin_turn()

    def write_program_revision_chunked(self, *a, **kw):
        return self._gate.write_program_revision_chunked(*a, **kw)


class ChunkedOrientTests(unittest.TestCase):
    """End-to-end: a program persisted via the chunked writer and recalled through a daemon that
    clips writes to 2000 and reads to 1200 is reassembled byte-identical by ORIENT and adopted."""

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def test_orient_reassembles_chunked_program_and_adopts(self):
        EwmAgent._vision_available = staticmethod(lambda: False)
        # TOY_GAME_SOURCE is 1432 chars — bigger than the 1200 read cap, so a single-note store would
        # be clipped and never compile (the run-12 failure). Chunked, it round-trips.
        self.assertGreater(len(TOY_GAME_SOURCE), _TruncatingKbClient.READ_CAP)
        client = _TruncatingKbClient()
        gate = _WriteGateOver(client)
        written = gate.write_program_revision_chunked(
            "toy", "avatar moves on empty cells", TOY_GAME_SOURCE, "2/2"
        )
        self.assertTrue(written["ok"])
        self.assertGreater(written["chunks"], 1)

        env = ToyEnv(_grid("2.3"))
        llm = FakeLlm(['{"prediction_ok": true}'] * 6)
        ag = EwmAgent(
            env, llm, kb=gate,
            config=AgentConfig(game_id="toy", max_turns=10, chunked_program_notes=True),
        )
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        summary = ag.run()
        self.assertTrue(summary["program_accepted"])
        self.assertTrue(summary["won"])
        self.assertTrue(summary["orient_adopted"])
        # The truncating client has no native /note/get, so the native path falls through to the
        # chunk reassembler — the diagnosis now records which path served ("... (chunks)").
        self.assertTrue(summary["orient_diagnosis"].startswith(("adopted whole", "adopted partial")))
        self.assertIn("(chunks)", summary["orient_diagnosis"])
        # Straight from the chunked KB store: zero synthesis decide calls.
        self.assertEqual(summary["decide_calls"], 0)

    def test_orient_refuses_on_missing_chunk_with_diagnosis(self):
        EwmAgent._vision_available = staticmethod(lambda: False)
        client = _TruncatingKbClient()
        gate = _WriteGateOver(client)
        written = gate.write_program_revision_chunked("toy", "prose", TOY_GAME_SOURCE, "2/2")
        # Evict one chunk note to simulate corruption: ORIENT must refuse cleanly, not adopt garbage.
        client.notes = [n for n in client.notes if "chunk 2 of" not in n["title"]]

        env = ToyEnv(_grid("2.3"))
        # SYNTHESIZE fallthrough is scripted so the run still terminates; the point is ORIENT refused.
        llm = FakeLlm([_fenced(TOY_GAME_SOURCE), '{"prediction_ok": true}'] + ['{"prediction_ok": true}'] * 6)
        ag = EwmAgent(
            env, llm, kb=gate,
            config=AgentConfig(
                game_id="toy", max_turns=10, min_probe_transitions=1, chunked_program_notes=True
            ),
        )
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        # Drive ORIENT directly to assert the refusal + diagnosis (independent of downstream synth).
        adopted = ag._orient({"grid": _grid("2.3")})
        self.assertFalse(adopted)
        self.assertFalse(ag.summary.orient_adopted)
        self.assertIsNotNone(ag.summary.orient_diagnosis)
        self.assertIn("chunk", ag.summary.orient_diagnosis.lower())

    def test_chunked_recall_off_by_default_does_not_reassemble(self):
        # The chunked path is a FALLBACK gated behind config.chunked_program_notes; with the flag OFF
        # (the default), ORIENT must NOT fire the chunk-fetch path on a chunked index note — it treats
        # it like any inline hit, finds no usable source, and reports no warm-start.
        EwmAgent._vision_available = staticmethod(lambda: False)
        client = _TruncatingKbClient()
        gate = _WriteGateOver(client)
        gate.write_program_revision_chunked("toy", "prose", TOY_GAME_SOURCE, "2/2")
        env = ToyEnv(_grid("2.3"))
        ag = EwmAgent(
            env, FakeLlm([]), kb=gate,
            config=AgentConfig(game_id="toy", max_turns=1),  # chunked_program_notes defaults False
        )
        self.assertFalse(ag.config.chunked_program_notes)
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        adopted = ag._orient({"grid": _grid("2.3")})
        self.assertFalse(adopted)
        self.assertFalse(ag.summary.orient_adopted)


class _NativeKbClient:
    """A KbClient stand-in whose ``/search`` returns a lean INDEX hit (200-char clipped summary, NO
    usable inline source and NO chunk fields) but whose native ``get_note_full`` returns the WHOLE
    fenced program body — the daemon-reassembled full-body read. This is exactly the shape the
    production ``GET /note/get`` supersedes the chunk fallback with: ORIENT keys on the index hit,
    then reads the full program in one native call.

    ``full_body`` map is keyed by note key; a missing key returns an ``ok:False`` miss so the fallback
    paths get exercised.
    """

    def __init__(self, hits, full_bodies):
        self.hits = hits
        self.full_bodies = full_bodies
        self.get_calls: list[str] = []

    def search(self, q, k, gated=False, full_content=False):
        return list(self.hits)

    def get_note_full(self, key):
        self.get_calls.append(key)
        body = self.full_bodies.get(key)
        if body is None:
            return {"ok": False, "error": "unknown note"}
        return {
            "ok": True,
            "key": key,
            "title": "game toy world model program",
            "summary": body[:200],
            "full_body": body,
            "chunk_count": 2,
            "byte_length": len(body.encode("utf-8")),
        }


class _NativeKb(FakeKb):
    def __init__(self, client, max_writes_per_turn: int = 2) -> None:
        super().__init__(max_writes_per_turn=max_writes_per_turn)
        self.client = client


class NativeOrientTests(unittest.TestCase):
    """ORIENT prefers the native full-body note read (GET /note/get) over the chunk fallback."""

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _index_hit(self):
        # A lean index hit: game-scoped title, a clipped prose summary that carries NO fenced source
        # and NO chunk-count field, plus the note key ORIENT keys the native read on.
        return {
            "key": "note:toy-program-index",
            "title": "game toy world model program",
            "summary": "handles avatar movement; program stored in the note body (pass rate 2/2).",
        }

    def test_orient_adopts_via_native_note_get(self):
        EwmAgent._vision_available = staticmethod(lambda: False)
        hit = self._index_hit()
        # The full body carries the whole program in a fenced block — only recoverable via note/get.
        full_body = (
            "handles avatar movement\n\npass rate: 2/2\n\n"
            f"```python\n{TOY_GAME_SOURCE}\n```"
        )
        client = _NativeKbClient([hit], {"note:toy-program-index": full_body})
        kb = _NativeKb(client)
        env = ToyEnv(_grid("2.3"))
        llm = FakeLlm(['{"prediction_ok": true}'] * 6)
        ag = EwmAgent(env, llm, kb=kb, config=AgentConfig(game_id="toy", max_turns=10))
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        adopted = ag._orient({"grid": _grid("2.3")})
        self.assertTrue(adopted)
        self.assertTrue(ag.summary.orient_adopted)
        # Diagnosis records the NATIVE path served the program.
        self.assertIn("(native)", ag.summary.orient_diagnosis)
        self.assertTrue(ag.summary.orient_diagnosis.startswith(("adopted whole", "adopted partial")))
        # The native full-body endpoint was actually consulted with the index hit's key.
        self.assertEqual(client.get_calls, ["note:toy-program-index"])

    def test_native_miss_falls_back_without_crashing(self):
        # The native endpoint reports a miss (unknown key); the lean index hit carries no inline
        # source and chunked recall is off — ORIENT must degrade cleanly to "no warm-start", never
        # crash, and never claim adoption.
        EwmAgent._vision_available = staticmethod(lambda: False)
        hit = self._index_hit()
        client = _NativeKbClient([hit], {})  # empty full-body map -> every get_note_full is a miss
        kb = _NativeKb(client)
        env = ToyEnv(_grid("2.3"))
        ag = EwmAgent(env, FakeLlm([]), kb=kb, config=AgentConfig(game_id="toy", max_turns=1))
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        adopted = ag._orient({"grid": _grid("2.3")})
        self.assertFalse(adopted)
        self.assertFalse(ag.summary.orient_adopted)
        self.assertEqual(client.get_calls, ["note:toy-program-index"])

    def test_hit_key_derives_parent_note_from_cluster_artifact(self):
        # ORIENT's keyed search often surfaces the `knowledge:source_doc:note-<id> ... evidence`
        # cluster artifact instead of the index note (the index summary is compacted to a stub at
        # write time). /note/get only resolves `note:` keys, so _hit_key must recover the parent
        # note key from the artifact rather than hand the unreadable artifact key to get_note_full.
        self.assertEqual(
            EwmAgent._hit_key({"key": "knowledge:source_doc:note-mr5c8xcs7uo"}),
            "note:note-mr5c8xcs7uo",
        )
        self.assertEqual(
            EwmAgent._hit_key({"key": "knowledge:source_chunk:note-abc123#note-evidence:chunk-2"}),
            "note:note-abc123",
        )
        # A plain note key passes through unchanged.
        self.assertEqual(EwmAgent._hit_key({"key": "note:note-plain"}), "note:note-plain")
        # No note-id token in a knowledge key -> unresolvable (None), never a bad key.
        self.assertIsNone(EwmAgent._hit_key({"key": "knowledge:source_doc:weird-doc"}))

    def test_orient_adopts_via_native_from_cluster_artifact_hit(self):
        # End-to-end: the ORIENT hit is a cluster ARTIFACT key (as the live daemon returns), but the
        # parent note's native full-body read carries the program -> ORIENT still adopts natively.
        EwmAgent._vision_available = staticmethod(lambda: False)
        hit = {
            "key": "knowledge:source_doc:note-toyprog",
            "title": "game toy world model program evidence",
            "summary": "[Long raw evidence preserved as structured source chunks.]",
        }
        full_body = f"pass rate: 2/2\n\n```python\n{TOY_GAME_SOURCE}\n```"
        client = _NativeKbClient([hit], {"note:note-toyprog": full_body})
        kb = _NativeKb(client)
        env = ToyEnv(_grid("2.3"))
        llm = FakeLlm(['{"prediction_ok": true}'] * 6)
        ag = EwmAgent(env, llm, kb=kb, config=AgentConfig(game_id="toy", max_turns=10))
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        adopted = ag._orient({"grid": _grid("2.3")})
        self.assertTrue(adopted)
        self.assertIn("(native)", ag.summary.orient_diagnosis)
        # get_note_full was called with the DERIVED parent note key, not the artifact key.
        self.assertEqual(client.get_calls, ["note:note-toyprog"])

    def test_native_disabled_falls_through_to_inline(self):
        # With native_note_get OFF, ORIENT must NOT call get_note_full; a hit whose inline body
        # carries the program (legacy small-program path) is still adopted via the inline resolver.
        EwmAgent._vision_available = staticmethod(lambda: False)
        hit = {
            "key": "note:toy-inline",
            "title": "game toy world model program",
            "summary": f"pass rate: 2/2\n\nprogram source:\n{TOY_GAME_SOURCE}",
        }
        client = _NativeKbClient([hit], {"note:toy-inline": "unused"})
        kb = _NativeKb(client)
        env = ToyEnv(_grid("2.3"))
        llm = FakeLlm(['{"prediction_ok": true}'] * 6)
        ag = EwmAgent(
            env, llm, kb=kb,
            config=AgentConfig(game_id="toy", max_turns=10, native_note_get=False),
        )
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        adopted = ag._orient({"grid": _grid("2.3")})
        self.assertTrue(adopted)
        self.assertIn("(inline)", ag.summary.orient_diagnosis)
        self.assertEqual(client.get_calls, [])


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


# A candidate that models the toy mechanics correctly but renders a WRONG constant (5) on one
# fixed cell (the bottom-right corner) — the "wrong bar region" of Run-9 #13. Everything else is
# TOY_GAME_SOURCE, so movement/goal are right; only that corner cell persistently mismatches.
BAR_WRONG_SOURCE = TOY_GAME_SOURCE.replace(
    "    ar, ac = state[\"avatar\"]\n    grid[ar][ac] = AVATAR\n    return grid",
    "    ar, ac = state[\"avatar\"]\n    grid[ar][ac] = AVATAR\n"
    "    grid[rows - 1][cols - 1] = 5\n    return grid",
)

# A candidate that mispredicts BROADLY: it never moves the avatar (step is a no-op), so every
# non-trivial transition is wrong across most of the changed cells -> below the cell-accuracy floor.
STUCK_SOURCE = TOY_GAME_SOURCE.replace(
    "    if 0 <= nr < state[\"rows\"] and 0 <= nc < state[\"cols\"] and (nr, nc) not in state[\"walls\"]:\n"
    "        state[\"avatar\"] = (nr, nc)\n"
    "        moved = True",
    "    moved = False",
)


# A movement world-model whose slide magnitude is a parameter. On RIGHT the avatar (color 2) slides
# ``MAG`` columns right; every other cell is static background (0). This reproduces the Run-10 weak
# model's SHAPE: right structure (an avatar that slides on RIGHT) but a WRONG magnitude when MAG does
# not match the truth. The board is mostly static background, so whole-board cell accuracy is
# vacuous — only the changed cells (the object's old + new positions) discriminate.
def _mover_source(mag: int) -> str:
    return f'''
AVATAR = 2

def init_state(frame):
    rows = len(frame)
    cols = len(frame[0]) if rows else 0
    avatar = None
    for r in range(rows):
        for c in range(cols):
            if frame[r][c] == AVATAR:
                avatar = (r, c)
    return {{"avatar": avatar, "rows": rows, "cols": cols}}


def legal_actions(state):
    return ["RIGHT"]


def step(state, action):
    r, c = state["avatar"]
    nc = min(state["cols"] - 1, c + {mag})
    ns = dict(state)
    ns["avatar"] = (r, nc)
    return ns, {{"moved": nc != c}}


def render(state):
    rows, cols = state["rows"], state["cols"]
    grid = [[0 for _ in range(cols)] for _ in range(rows)]
    ar, ac = state["avatar"]
    grid[ar][ac] = AVATAR
    return grid


def is_win(state):
    return state["avatar"][1] >= state["cols"] - 1
'''


def _mover_grid(cols: int, avatar_col: int) -> list[list[int]]:
    """A 1x``cols`` background (0) grid with a single avatar (2) at ``avatar_col``."""

    row = [0] * cols
    row[avatar_col] = 2
    return [row]


class PartialAdoptionTests(unittest.TestCase):
    """Partial adoption (Run-9): a best-but-imperfect candidate is adopted with its persistently
    wrong cells masked UNKNOWN, so the planner still gets a usable model."""

    def _agent(self, env, llm, **cfg):
        EwmAgent._vision_available = staticmethod(lambda: False)
        base = dict(game_id="toy", max_turns=20, min_probe_transitions=1)
        base.update(cfg)
        return EwmAgent(env, llm, config=AgentConfig(**base))

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _seed_bar_suite(self, ag):
        # Seed one real transition on a 2-row board so the corner-cell mismatch is observed and the
        # suite is non-empty at acceptance time. Real RIGHT: avatar (0,0)->(0,1); row1 stays zeros.
        ag.suite.append(_grid("2..3", "...."), "RIGHT", _grid(".2.3", "...."))

    def test_partial_adopt_masks_bar_and_execute_wins(self):
        # The only synthesized candidate is wrong solely on the corner cell. It clears the floor and
        # mask cap, so it is partially adopted (corner masked UNKNOWN) and PLAN/EXECUTE wins.
        env = ToyEnv(_grid("2..3", "...."))
        llm = FakeLlm([_fenced(BAR_WRONG_SOURCE), '{"prediction_ok": true}'] * 8)
        ag = self._agent(env, llm)
        self._seed_bar_suite(ag)
        summary = ag.run()
        self.assertTrue(summary["program_accepted"])
        self.assertTrue(summary["program_adopted_partial"])
        self.assertEqual(summary["mask_cells"], 1)  # only the bottom-right corner
        self.assertTrue(summary["won"])
        # The active program is the masked wrapper over the real (unwrapped) source.
        from bench.arc_agi3_zonoid.ewm.world_model import MaskedProgram

        self.assertIsInstance(ag.program, MaskedProgram)

    def test_mask_cap_refusal(self):
        # With a punishing mask_cap the single wrong cell (1/8 = 0.125) exceeds the cap, so partial
        # adoption is refused and no program is adopted.
        env = ToyEnv(_grid("2..3", "...."))
        llm = FakeLlm([_fenced(BAR_WRONG_SOURCE)] + ['{"prediction_ok": true}'] * 20)
        ag = self._agent(env, llm, mask_cap=0.05, max_synth_attempts=1, reactive_after_failures=99)
        self._seed_bar_suite(ag)
        adopted = ag._synthesize(ag._observe(), None)
        self.assertFalse(adopted)
        self.assertIsNone(ag.program)
        self.assertFalse(ag.summary.program_adopted_partial)

    def test_below_floor_refusal(self):
        # A broadly-wrong candidate (avatar never moves) falls below the cell-accuracy floor, so it
        # is refused even though masking COULD technically make it pass — a mostly-holes "model" is
        # not worth adopting.
        env = ToyEnv(_grid("2..3", "...."))
        llm = FakeLlm([_fenced(STUCK_SOURCE)] + ['{"prediction_ok": true}'] * 20)
        ag = self._agent(env, llm, min_partial_adopt_rate=0.9, max_synth_attempts=1)
        # Seed two transitions the stuck program mispredicts heavily.
        ag.suite.append(_grid("2..3", "...."), "RIGHT", _grid(".2.3", "...."))
        ag.suite.append(_grid(".2.3", "...."), "RIGHT", _grid("..23", "...."))
        adopted = ag._synthesize(ag._observe(), None)
        self.assertFalse(adopted)
        self.assertIsNone(ag.program)

    def test_repair_shrinks_mask(self):
        # Start partially adopted with a 2-cell mask, then REPAIR proposes a candidate wrong on only
        # ONE of those cells: the mask must shrink from 2 to 1.
        from bench.arc_agi3_zonoid.ewm.world_model import WorldModelProgram, masked_program

        env = ToyEnv(_grid("2..3", "...."))
        # Suite: two transitions. A "two-bar-wrong" source is wrong on TWO corner cells; the repair
        # candidate BAR_WRONG_SOURCE is wrong on only one.
        two_bar = TOY_GAME_SOURCE.replace(
            "    ar, ac = state[\"avatar\"]\n    grid[ar][ac] = AVATAR\n    return grid",
            "    ar, ac = state[\"avatar\"]\n    grid[ar][ac] = AVATAR\n"
            "    grid[rows - 1][cols - 1] = 5\n    grid[rows - 1][0] = 5\n    return grid",
        )
        # REPAIR is scripted to return the single-bar candidate first.
        llm = FakeLlm([_fenced(BAR_WRONG_SOURCE)] + ['{"prediction_ok": true}'] * 20)
        ag = self._agent(env, llm, max_repair_attempts=1)
        ag.suite.append(_grid("2..3", "...."), "RIGHT", _grid(".2.3", "...."))
        # Adopt the two-bar program partially (mask of 2 corner cells).
        inner = WorldModelProgram.load(two_bar)
        mask = {(1, 3), (1, 0)}
        ag.program = masked_program(inner, mask)
        ag.summary.program_accepted = True
        ag.summary.program_adopted_partial = True
        ag.summary.mask_cells = 2
        repaired = ag._repair(ag._observe(), None)
        self.assertTrue(repaired)
        self.assertTrue(ag.summary.program_adopted_partial)
        self.assertEqual(ag.summary.mask_cells, 1)  # shrank from 2 to 1

    # -- Run-10: changed-cells floor -----------------------------------------------------------

    def _mover_suite_truth5(self, ag, *, cols: int = 32):
        """Seed a suite whose TRUTH slides the avatar +5 on RIGHT (Run-10 movement magnitude). The
        board is mostly static background so whole-board accuracy is vacuous."""

        for start in range(0, cols - 5, 2):
            ag.suite.append(
                _mover_grid(cols, start), "RIGHT", _mover_grid(cols, start + 5)
            )

    def test_changed_cells_floor_refuses_wrong_magnitude_run10_model(self):
        # Reconstruct the Run-10 weak adopted model: RIGHT structure (slides on RIGHT), WRONG
        # magnitude (+1 where truth is +5) -> 0/5 transitions. On a 1x32 board it matches ~30/32
        # cells per transition (whole-board ~0.94), which the OLD whole-board floor (0.6) would
        # clear. The changed-cells floor scores it on ONLY the object's old+new cells, where it is
        # 0/... -> refused.
        env = ToyEnv(_grid("2.3"))
        ag = self._agent(env, FakeLlm([]))
        self._mover_suite_truth5(ag)
        from bench.arc_agi3_zonoid.ewm.world_model import WorldModelProgram

        weak = WorldModelProgram.load(_mover_source(1))  # +1: wrong magnitude
        self.assertLess(
            ag._cell_pass_rate(weak), ag.config.min_partial_adopt_rate,
            "changed-cells accuracy of a wrong-magnitude model must be below the floor",
        )
        # ... and partial adoption of the weak model is REFUSED.
        adopted = ag._try_partial_adopt(env.observe(), _mover_source(1))
        self.assertFalse(adopted)
        self.assertIsNone(ag.program)
        self.assertFalse(ag.summary.program_adopted_partial)

    def test_changed_cells_floor_admits_correct_magnitude_and_records_accuracy(self):
        # The correctly-magnituded model (+5) predicts every changed cell -> changed-cells accuracy
        # 1.0, full pass, adopted whole; telemetry records changed_cells_accuracy.
        env = ToyEnv(_grid("2.3"))
        ag = self._agent(env, FakeLlm([]))
        self._mover_suite_truth5(ag)
        adopted = ag._try_partial_adopt(env.observe(), _mover_source(5))
        self.assertTrue(adopted)
        self.assertEqual(ag.summary.changed_cells_accuracy, 1.0)

    # -- Run-10: repair engagement on a partial-adopted program --------------------------------

    def test_masked_moving_cells_do_not_swallow_expect_divergence(self):
        # The core Run-10 no-show mechanism: a partial adoption masks exactly the cells the model
        # gets wrong. When those are the object's MOVING cells (wrong magnitude), the plan's masked
        # `expect` grid renders them UNKNOWN, and the env's UNKNOWN-aware check treats them as
        # wildcards -> the real divergence is NEVER seen (diverged=False) and REPAIR never fires.
        # The fix reveals the inner prediction on moved cells so EXECUTE reports diverged=True.
        from bench.arc_agi3_zonoid.ewm.world_model import WorldModelProgram, masked_program, mismatch_mask
        from bench.arc_agi3_zonoid.ewm.planner import PlanResult

        cols = 12
        env = _MoverEnv(cols=cols, truth_mag=5)
        ag = self._agent(env, FakeLlm(['{"prediction_ok": false}'] * 20), max_repair_attempts=0)
        self._mover_suite_truth5(ag, cols=cols)
        inner = WorldModelProgram.load(_mover_source(1))
        mask = mismatch_mask(inner, ag.suite)
        self.assertTrue(mask, "the wrong-magnitude model must mismatch (mask non-empty)")
        wrapped = masked_program(inner, mask)
        ag.program = wrapped
        ag.summary.program_adopted_partial = True
        ag._partial_repaired = False

        frame = env.observe()
        # The plan a masked-program planner would emit: one RIGHT step, predicted grid = the MASKED
        # wrapper's render (UNKNOWN over the moving cells). This is the grid that used to swallow the
        # divergence.
        state = wrapped.init_state(ag._frame_grid(frame))
        nstate, _ = wrapped.step(state, "RIGHT")
        masked_pred = wrapped.render(nstate)
        plan_result = PlanResult(actions=["RIGHT"], predicted_grids=[masked_pred])

        # WITH the fix (partial, not yet repaired): EXECUTE reveals inner's moving cell -> diverged.
        _result, diverged = ag._execute(plan_result, frame)
        self.assertTrue(
            diverged,
            "a real divergence in the masked moving region must be detected, not swallowed",
        )

    def test_first_live_divergence_on_partial_adoption_triggers_repair(self):
        # End-to-end: on the first divergence of a partial-adopted program, _handle_divergence must
        # engage REPAIR (repair_attempts > 0), never fall silently to reactive with 0 attempts.
        from bench.arc_agi3_zonoid.ewm.world_model import WorldModelProgram, masked_program, mismatch_mask
        from bench.arc_agi3_zonoid.ewm.planner import PlanResult

        cols = 12
        env = _MoverEnv(cols=cols, truth_mag=5)
        # Repair loop: one scripted (still-wrong) candidate + reflects; correctness is not asserted.
        llm = FakeLlm([_fenced(_mover_source(2))] + ['{"prediction_ok": false}'] * 40)
        ag = self._agent(env, llm, max_repair_attempts=1, max_repairs_per_divergence=1)
        self._mover_suite_truth5(ag, cols=cols)
        inner = WorldModelProgram.load(_mover_source(1))
        mask = mismatch_mask(inner, ag.suite)
        wrapped = masked_program(inner, mask)
        ag.program = wrapped
        ag.summary.program_accepted = True
        ag.summary.program_adopted_partial = True
        ag._partial_repaired = False

        frame = env.observe()
        state = wrapped.init_state(ag._frame_grid(frame))
        nstate, _ = wrapped.step(state, "RIGHT")
        plan_result = PlanResult(actions=["RIGHT"], predicted_grids=[wrapped.render(nstate)])

        _result, diverged = ag._execute(plan_result, frame)
        self.assertTrue(diverged)
        ag._handle_divergence(frame, None)
        self.assertGreater(
            ag.summary.repair_attempts, 0,
            "the first live divergence on a partial adoption must trigger REPAIR, not reactive",
        )


class _MoverEnv:
    """Minimal env whose truth slides the avatar (2) +``truth_mag`` on RIGHT, on a 1x``cols`` board.
    Supports the ``expect``-abort seam (UNKNOWN-aware) like ToyEnv so a partial adoption's revealed
    moving cells can trip ``expect_mismatch``."""

    def __init__(self, cols: int = 12, truth_mag: int = 5, budget: int = 50) -> None:
        self._cols = cols
        self._truth_mag = truth_mag
        self._avatar = 0
        self.remaining_actions = budget

    def _grid(self):
        return _mover_grid(self._cols, self._avatar)

    def observe(self):
        return {
            "grid": self._grid(),
            "level": 1,
            "step": 0,
            "valid_actions": ["RIGHT"],
            "score": 0,
            "remaining_actions": self.remaining_actions,
        }

    def act(self, actions, expect=None):
        executed = []
        stop_reason = "completed"
        for index, action in enumerate(actions):
            self.remaining_actions = max(0, self.remaining_actions - 1)
            self._avatar = min(self._cols - 1, self._avatar + self._truth_mag)
            executed.append(action)
            after = self._grid()
            if expect is not None and index < len(expect) and expect[index] is not None:
                if not grids_match([list(r) for r in expect[index]], after):
                    stop_reason = "expect_mismatch"
                    break
        return {
            "current_frame": {"grid": self._grid(), "level": 1, "step": 0},
            "action_result": {"score": 0, "done": False},
            "valid_actions": ["RIGHT"],
            "remaining_actions": self.remaining_actions,
            "executed": executed,
            "stop_reason": stop_reason,
            "done": False,
        }


class _WallMoverEnv:
    """A 1x``cols`` board whose avatar (2) slides +``truth_mag`` on RIGHT UNTIL it hits a wall at
    ``wall_col``, then stays put (a real (0,0) no-op at the wall — the Run-13 wall-contact reality).

    This is the live shape the recalled ls20 ceiling failed on: the program translates the object
    UNCONDITIONALLY, so once the truth stops at the wall the program keeps predicting a move and
    every subsequent transition diverges. No ``expect`` seam is honoured here on purpose: this env
    drives the loop through its OWN divergence detection (reactive path), reproducing the Run-13
    case where ``is_win`` is False so the planner never emits a plan to check ``expect`` against."""

    def __init__(self, cols: int = 20, truth_mag: int = 5, wall_col: int = 5, budget: int = 60) -> None:
        self._cols = cols
        self._truth_mag = truth_mag
        self._wall = wall_col
        self._avatar = 0
        self.remaining_actions = budget

    def _grid(self):
        return _mover_grid(self._cols, self._avatar)

    def observe(self):
        return {
            "grid": self._grid(),
            "level": 1,
            "step": 0,
            "valid_actions": ["RIGHT"],
            "score": 0,
            "remaining_actions": self.remaining_actions,
        }

    def act(self, actions, expect=None):
        executed = []
        for action in actions:
            self.remaining_actions = max(0, self.remaining_actions - 1)
            nxt = self._avatar + self._truth_mag
            # The wall blocks any move that would cross or reach it: the avatar stays put (no-op).
            if nxt < self._wall:
                self._avatar = nxt
            executed.append(action)
        return {
            "current_frame": {"grid": self._grid(), "level": 1, "step": 0},
            "action_result": {"score": 0, "done": False},
            "valid_actions": ["RIGHT"],
            "remaining_actions": self.remaining_actions,
            "executed": executed,
            "stop_reason": "completed",
            "done": False,
        }


class WarmStartTrustAndRepairTests(unittest.TestCase):
    """Run-14: hypothesis-trust revalidation of a recalled program + repair engagement for a
    KB-adopted unconditional mover (the Run-13 pathology: adopted whole, 31 live divergences, 0
    repair attempts)."""

    def setUp(self):
        EwmAgent._vision_available = staticmethod(lambda: False)

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _mover_hit(self, mag: int, *, is_win_false: bool = False) -> dict:
        # A KB note carrying an unconditional-mover program (the Run-13 recalled-ceiling shape: it
        # translates the object every step with no wall/collision modelling). ``is_win_false`` hard-
        # codes is_win False (the actual ls20 ceiling shape), so the planner NEVER finds a goal and
        # the loop reaches the reactive path every turn — the exact Run-13 condition under which the
        # live divergence must still route into REPAIR.
        src = _mover_source(mag)
        if is_win_false:
            src = src.replace(
                "def is_win(state):\n    return state[\"avatar\"][1] >= state[\"cols\"] - 1",
                "def is_win(state):\n    return False",
            )
        return {
            "key": "note:note-mover1",
            "title": "game ls20 world model program",
            "summary": "each RIGHT translates the object by a fixed step\n\npass rate: n/n\n\n"
            "program source:\n" + src,
        }

    def test_recalled_program_revalidated_on_fresh_probes_records_telemetry(self):
        # ORIENT resolves a recalled mover and revalidates it against the fresh probe suite through
        # the changed-cells floor; orient_revalidation records probes/pass_rate/adopted_as. A
        # correctly-magnituded mover (matches the seeded truth) is adopted WHOLE with pass_rate 1.0.
        cols = 20
        env = _MoverEnv(cols=cols, truth_mag=5)
        kb = SearchKb([self._mover_hit(5)])
        ag = EwmAgent(
            env, FakeLlm([]), kb=kb,
            config=AgentConfig(game_id="ls20", max_turns=1, min_probe_transitions=1),
        )
        # Fresh probes: real +5 RIGHT transitions (what the probe batch would seed live).
        for start in range(0, cols - 5, 2):
            ag.suite.append(_mover_grid(cols, start), "RIGHT", _mover_grid(cols, start + 5))
        adopted = ag._orient({"grid": _mover_grid(cols, 0)})
        self.assertTrue(adopted)
        rev = ag.summary.orient_revalidation
        self.assertIsNotNone(rev, "orient_revalidation telemetry must be recorded")
        self.assertEqual(rev["adopted_as"], "whole")
        self.assertGreaterEqual(rev["probes"], 1)
        self.assertEqual(rev["pass_rate"], 1.0)

    def test_vacuous_unknown_program_not_trusted_whole(self):
        # A program that renders EVERYTHING UNKNOWN after a step passes validate() vacuously (every
        # cell skipped) but has ZERO changed-cells accuracy: it must NOT be adopted whole on the
        # strength of a skip. It fails the changed-cells floor AND the mask path (nothing concrete to
        # mask), so ORIENT refuses it and records adopted_as="rejected".
        unknown_src = (
            "def init_state(frame):\n"
            "    return {'rows': len(frame), 'cols': len(frame[0]) if frame else 0, 'steps': 0}\n"
            "def step(state, action):\n"
            "    ns = dict(state); ns['steps'] = state['steps'] + 1; return ns, {}\n"
            "def render(state):\n"
            "    return [[UNKNOWN for _ in range(state['cols'])] for _ in range(state['rows'])]\n"
            "def is_win(state):\n    return False\n"
            "def legal_actions(state):\n    return ['RIGHT']\n"
        )
        cols = 20
        env = _MoverEnv(cols=cols, truth_mag=5)
        kb = SearchKb([{
            "key": "note:note-unk",
            "title": "game ls20 world model program",
            "summary": "program source:\n" + unknown_src,
        }])
        ag = EwmAgent(
            env, FakeLlm([]), kb=kb,
            config=AgentConfig(game_id="ls20", max_turns=1, min_probe_transitions=1),
        )
        for start in range(0, cols - 5, 2):
            ag.suite.append(_mover_grid(cols, start), "RIGHT", _mover_grid(cols, start + 5))
        adopted = ag._orient({"grid": _mover_grid(cols, 0)})
        self.assertFalse(adopted, "a vacuously-valid UNKNOWN-everything program must not be trusted")
        self.assertIsNone(ag.program)
        self.assertEqual((ag.summary.orient_revalidation or {}).get("adopted_as"), "rejected")

    def test_run13_shape_unconditional_mover_engages_repair_live(self):
        # THE Run-13 regression test: a KB-recalled UNCONDITIONAL mover (no wall modelling) is
        # adopted, then live it hits a wall (real no-op) and every subsequent transition diverges.
        # In Run-13 this produced 31 divergences and 0 repair attempts because is_win is False (no
        # plan -> reactive path -> the divergence never reached REPAIR). With the fix, the live
        # divergence routes into REPAIR: repair_attempts > 0.
        cols, wall = 24, 16
        env = _WallMoverEnv(cols=cols, truth_mag=5, wall_col=wall, budget=60)
        # REPAIR decide returns a still-imperfect candidate each time (correctness not asserted here;
        # the point is that REPAIR is ENGAGED). Reflects otherwise.
        class _Fake(FakeLlm):
            def __init__(self):
                super().__init__([])

            def chat(self, messages, max_tokens=1024, temperature=0.0):
                self.received.append({"messages": messages, "max_tokens": max_tokens,
                                      "temperature": temperature})
                self.calls += 1
                last = messages[-1]["content"]
                text = last if isinstance(last, str) else ""
                if "Current mode: REPAIR" in text:
                    return {"content": _fenced(_mover_source(3)), "finish_reason": None, "raw": ""}
                return {"content": '{"prediction_ok": false}', "finish_reason": None, "raw": ""}

        kb = SearchKb([self._mover_hit(5, is_win_false=True)])
        ag = EwmAgent(
            env, _Fake(), kb=kb,
            config=AgentConfig(
                game_id="ls20", max_turns=40, min_probe_transitions=2,
                # Keep the program alive long enough to observe repair engagement before caps drop it.
                max_repairs_per_game=99, max_repairs_per_divergence=99,
                min_live_pass_rate=0.0, max_repair_attempts=1,
            ),
        )
        summary = ag.run()
        self.assertTrue(summary["orient_adopted"], "the recalled mover should be adopted")
        self.assertGreater(
            summary["repair_attempts"], 0,
            "a KB-adopted unconditional mover that diverges at a wall must ENGAGE REPAIR "
            "(Run-13 regression: 31 divergences, 0 repair attempts)",
        )

    def test_accepted_repair_of_recalled_program_supersedes_kb_note(self):
        # Compounding (Req 3): when a recalled program is repaired to a fully-passing candidate, the
        # KB write supersedes the note it was recalled from (write_program_revision supersedes=key).
        cols, wall = 12, 6
        env = _MoverEnv(cols=cols, truth_mag=5)

        class _RecordingKb(SearchKb):
            def write_program_revision(self, *args, **kw):
                # Record the supersedes kwarg for the assertion, then behave like the base gate.
                self.last_supersedes = kw.get("supersedes")
                return super().write_program_revision(*args, **kw)

        # The recalled program is an UNCONDITIONAL +5 mover (Run-13 shape: no wall modelling). The
        # REPAIR candidate is the SAME mover taught to STOP at a wall, so it passes the augmented
        # suite that includes the live wall no-op transition.
        wall_src = (
            "AVATAR = 2\nWALL = %d\n"
            "def init_state(frame):\n"
            "    rows = len(frame); cols = len(frame[0]) if rows else 0\n"
            "    a = None\n"
            "    for r in range(rows):\n"
            "        for c in range(cols):\n"
            "            if frame[r][c] == AVATAR: a = (r, c)\n"
            "    return {'avatar': a, 'rows': rows, 'cols': cols}\n"
            "def legal_actions(state):\n    return ['RIGHT']\n"
            "def step(state, action):\n"
            "    r, c = state['avatar']; nc = c + 5\n"
            "    if nc >= WALL: nc = c\n"
            "    ns = dict(state); ns['avatar'] = (r, nc); return ns, {}\n"
            "def render(state):\n"
            "    rows, cols = state['rows'], state['cols']\n"
            "    g = [[0] * cols for _ in range(rows)]; ar, ac = state['avatar']; g[ar][ac] = AVATAR\n"
            "    return g\n"
            "def is_win(state):\n    return False\n"
        ) % wall

        kb = _RecordingKb([self._mover_hit(5)])  # recalled: unconditional +5 mover
        llm = FakeLlm([_fenced(wall_src)] + ['{"prediction_ok": false}'] * 20)
        ag = EwmAgent(
            env, llm, kb=kb,
            config=AgentConfig(game_id="ls20", max_turns=1, min_probe_transitions=1,
                               max_repair_attempts=2),
        )
        # Fresh probes: two +5 moves the unconditional mover predicts perfectly -> adopted WHOLE.
        ag.suite.append(_mover_grid(cols, 0), "RIGHT", _mover_grid(cols, 5))
        adopted = ag._orient({"grid": _mover_grid(cols, 0)})
        self.assertTrue(adopted)
        self.assertIsNone(ag.summary.program_adopted_partial or None)
        self.assertEqual(ag._orient_note_key, "note:note-mover1")
        # A live wall contact: truth is a no-op at the wall, which the unconditional mover fails.
        ag.suite.append(_mover_grid(cols, 5), "RIGHT", _mover_grid(cols, 5))
        # REPAIR authors the wall-aware mover, which fully passes the augmented suite -> accepted +
        # persisted with supersedes=<recalled note key>.
        repaired = ag._repair({"grid": _mover_grid(cols, 5), "level": 1}, None)
        self.assertTrue(repaired, "the wall-aware repair candidate fully passes and must be accepted")
        self.assertEqual(
            kb.last_supersedes, "note:note-mover1",
            "an accepted repair of a recalled program must supersede its KB note (compounding)",
        )


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


class DivergenceToleranceTests(unittest.TestCase):
    """Run-18: a TRANSIENT divergence confined to (or adjacent to) a partial adoption's known-
    unmodelable mask is TOLERATED — auto-extend the mask, NO trust drop, NO repair, exploration
    continues with zero LLM calls. Window degradation still triggers repair; the runtime sanity cap
    halts identical extract/compile loops for a divergence signature."""

    def setUp(self):
        EwmAgent._vision_available = staticmethod(lambda: False)

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _masked_mover(self, cols=64):
        """A partial adoption: inner mover(+1) wrapped with the mask of its persistently-wrong cells
        over a truth(+5) suite. A WIDE board keeps the mask fraction well under mask_cap so the
        auto-extend path is exercised (a real ls20 board is 64x64). Returns (ag, wrapped, mask)."""
        from bench.arc_agi3_zonoid.ewm.world_model import (
            WorldModelProgram, masked_program, mismatch_mask,
        )

        env = _MoverEnv(cols=cols, truth_mag=5)
        ag = EwmAgent(
            env, FakeLlm([]),
            config=AgentConfig(
                game_id="toy", min_probe_transitions=1,
                repair_trigger_pass_rate=0.85, repair_sanity_cap=2,
                fast_path_trust_window=3, mask_cap=0.15,
            ),
        )
        # A few transitions near the left so the mask stays small vs the wide board.
        for start in range(0, 8, 2):
            ag.suite.append(_mover_grid(cols, start), "RIGHT", _mover_grid(cols, start + 5))
        inner = WorldModelProgram.load(_mover_source(1))
        mask = mismatch_mask(inner, ag.suite)
        wrapped = masked_program(inner, mask)
        ag.program = wrapped
        ag.summary.program_adopted_partial = True
        ag.summary.mask_cells = len(mask)
        ag._partial_repaired = True  # already live-repaired: window is authoritative
        return ag, wrapped, mask

    def test_masked_adjacent_transient_tolerated_zero_llm_and_continues(self):
        ag, wrapped, mask = self._masked_mover()
        # Prove the model healthy: a passing prior window.
        ag._live_results.extend([True] * 5)
        ag._refresh_model_trust()
        self.assertTrue(ag._model_trusted)
        # Append a live transition the INNER program mispredicts on cells INSIDE the mask (a transient
        # in the region the model already declines to model). before: avatar at a masked col mc, so
        # inner(+1) renders the avatar at mc+1 while truth(+5) puts it at mc+5 -> the mismatch cells
        # (old+new positions) land in/adjacent to the mask.
        (_mr, mc) = sorted(mask)[0]
        before = _mover_grid(64, mc)
        after = _mover_grid(64, min(63, mc + 5))
        ag.suite.append(before, "RIGHT", after)
        ag._live_results.append(ag._predicts_transition(before, "RIGHT", after))

        cells = ag._last_divergence_cells()
        self.assertTrue(cells, "the inner program must mispredict this transition")
        self.assertTrue(
            all(ag._cells_adjacent_to(cell, set(wrapped.mask_cells)) for cell in cells),
            "the transient must be confined to / adjacent to the mask",
        )

        calls_before = ag.llm.calls
        repairs_before = ag.summary.repair_attempts
        ag._handle_divergence({"grid": before, "valid_actions": ["RIGHT"]}, None)

        # Tolerated: NO LLM call, NO repair, program kept, trust NOT dropped, exploration continues.
        self.assertEqual(ag.llm.calls, calls_before, "tolerating a transient must make zero LLM calls")
        self.assertEqual(ag.summary.repair_attempts, repairs_before, "no repair on a tolerated transient")
        self.assertIsNotNone(ag.program)
        self.assertFalse(ag._modelability_poor)
        self.assertTrue(ag._model_trusted, "a tolerated transient must NOT drop fast-path trust")
        self.assertEqual(ag.summary.transients_tolerated, 1)
        self.assertNotEqual(ag._select_mode(), "RECOVER")

    def test_window_degradation_still_triggers_repair(self):
        # A partial adoption whose live window has degraded below the repair trigger is NOT a
        # transient: _handle_divergence must engage REPAIR (repair_attempts > 0), not tolerate.
        ag, wrapped, mask = self._masked_mover()
        ag._partial_repaired = True
        # Window degraded: mostly failing predictions (rate < 0.85).
        ag._live_results.extend([False, False, False, False, True])
        self.assertLess(ag._live_pass_rate(), 0.85)
        # One scripted repair candidate (still wrong; correctness not asserted) + reflects.
        ag.llm = FakeLlm([_fenced(_mover_source(2))] + ['{"prediction_ok": false}'] * 20)
        ag.config.max_repair_attempts = 1
        ag.config.max_repairs_per_divergence = 1
        before = _mover_grid(64, 0)
        after = _mover_grid(64, 5)
        ag.suite.append(before, "RIGHT", after)
        ag._live_results.append(False)
        ag._handle_divergence({"grid": before, "valid_actions": ["RIGHT"]}, None)
        self.assertGreater(
            ag.summary.repair_attempts, 0,
            "a degraded window must still route to REPAIR, not be tolerated",
        )
        self.assertEqual(ag.summary.transients_tolerated, 0)

    def test_sanity_cap_halts_identical_failure_loop(self):
        # After repair_sanity_cap consecutive candidates fail extract/compile for the SAME divergence
        # signature, that signature is halted: a subsequent repair is SKIPPED (repair_skips++) with no
        # further LLM calls, instead of looping the 0-for-N qwen failure forever.
        from bench.arc_agi3_zonoid.ewm.world_model import validate

        ag, wrapped, mask = self._masked_mover()
        ag._partial_repaired = True
        # Repair candidates that are PROSE ONLY (no fenced block) -> extract failure every time.
        ag.llm = FakeLlm(["no code here, sorry"] * 40)
        ag.config.max_repair_attempts = 1
        ag.config.min_live_pass_rate = 0.0        # isolate the sanity cap from the floor drop
        ag.config.max_repairs_per_game = 99
        ag.config.max_repairs_per_divergence = 99
        before = _mover_grid(64, 0)
        after = _mover_grid(64, 5)
        ag.suite.append(before, "RIGHT", after)

        # Drive divergences on the SAME signature. Window degraded so gating routes to repair.
        def diverge():
            ag._live_results.append(False)
            ag._handle_divergence({"grid": before, "valid_actions": ["RIGHT"]}, None)

        # First two divergences each attempt repair (extract fails); the 2nd hit halts the signature.
        diverge()
        diverge()
        attempts_after_cap = ag.summary.repair_attempts
        self.assertGreater(attempts_after_cap, 0)
        # Third divergence on the halted signature: repair is SKIPPED — no new attempt, repair_skips++.
        skips_before = ag.summary.repair_skips
        diverge()
        self.assertEqual(
            ag.summary.repair_attempts, attempts_after_cap,
            "a halted signature must not attempt another repair",
        )
        self.assertGreater(ag.summary.repair_skips, skips_before)


class SynthSessionCapTests(unittest.TestCase):
    """Graph-native session pacing: once max_synth_sessions_per_game is hit, _synthesize_graph
    refuses to launch another SynthSession and drops to reactive (modelability poor) — the run-8
    fix for games that burned the whole wall budget on back-to-back sessions."""

    def setUp(self):
        EwmAgent._vision_available = staticmethod(lambda: False)

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def test_per_game_session_cap_flips_reactive(self):
        ag = EwmAgent(
            ToyEnv(_grid("2.3")),
            FakeLlm([]),
            config=AgentConfig(
                game_id="toy", graph_synthesis=True, max_synth_sessions_per_game=2
            ),
        )
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))  # non-empty so synth isn't vacuous
        frame = {"grid": _grid("2.3"), "valid_actions": ["RIGHT"]}
        # At the cap, _synthesize_graph refuses without launching a session and drops the program.
        ag._synth_sessions_this_game = 2
        self.assertFalse(ag._synthesize_graph(frame))
        self.assertTrue(ag._modelability_poor)
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


class GoalDiscoveryAndFastPathTests(unittest.TestCase):
    """Run-16: GOAL DISCOVERY (frontier + level-boundary capture + is_win re-derive) and the
    MODEL-TRUSTED FAST PATH (skip reflect while passing, restore on mismatch)."""

    def _agent(self, **cfg):
        from bench.arc_agi3_zonoid.ewm.world_model import WorldModelProgram

        env = ToyEnv(_grid("2.3"), budget=50)
        llm = FakeLlm([])
        agent_mod.EwmAgent._vision_available = staticmethod(lambda: False)
        base = dict(game_id="toy", max_turns=20, min_probe_transitions=1)
        base.update(cfg)
        ag = EwmAgent(env, llm, kb=FakeKb(), vision_enabled=False, config=AgentConfig(**base))
        ag.program = WorldModelProgram.load(TOY_GAME_SOURCE)
        return ag

    # -- level-boundary capture + is_win re-derivation ---------------------------------------------

    def _level_transition_result(self, after_grid, level=2, score=1):
        return {
            "current_frame": {"grid": after_grid, "level": level, "step": 3, "score": score},
            "action_result": {"score": score, "done": False},
            "executed": ["RIGHT", "RIGHT"],
            "stop_reason": "level_transition",
            "done": False,
        }

    def test_boundary_capture_writes_goal_note_and_rederives_is_win(self) -> None:
        ag = self._agent()
        before = {"grid": _grid("2.3"), "level": 1, "step": 0, "score": 0}
        result = self._level_transition_result(_grid("2..3"))
        ag._ingest_result(before, ["RIGHT", "RIGHT"], result)
        self.assertTrue(ag.summary.level_boundary_captured)
        self.assertTrue(ag.summary.goal_note_written)
        self.assertTrue(ag.summary.is_win_rederived)
        self.assertIsNotNone(ag._goal_predicate)
        # A goal-evidence note was recorded (game-scoped, standalone-token title).
        kinds = [k for (k, _args) in ag.kb.writes]
        self.assertIn("goal_evidence", kinds)

    def test_rederived_is_win_lets_planner_target_the_goal(self) -> None:
        # Before capture, the program's is_win never fires until the avatar sits ON the goal, so a
        # plan exists only because is_win is real here — assert the re-derived predicate is a valid
        # goal-contact test: the captured player position satisfies it.
        ag = self._agent()
        before = {"grid": _grid("2.3"), "level": 1, "step": 0, "score": 0}
        # Player at (0,0) immediately preceded the boundary -> that becomes the goal-contact cell.
        ag._ingest_result(before, ["RIGHT"], self._level_transition_result(_grid("2..3")))
        pred = ag._goal_predicate
        assert pred is not None
        state_at_goalcell = ag.program.init_state(_grid("2.3"))  # avatar at (0,0)
        self.assertTrue(pred(state_at_goalcell))
        # A state where the avatar is elsewhere is NOT a win.
        state_elsewhere = ag.program.init_state(_grid(".23"))  # avatar at (0,1)
        self.assertFalse(pred(state_elsewhere))

    def test_boundary_captured_only_once_note_written(self) -> None:
        ag = self._agent()
        before = {"grid": _grid("2.3"), "level": 1, "step": 0, "score": 0}
        ag._ingest_result(before, ["RIGHT"], self._level_transition_result(_grid("2..3")))
        ag.kb.writes.clear()
        # A second boundary must NOT write another goal-evidence note (first-boundary only).
        ag._ingest_result(before, ["RIGHT"], self._level_transition_result(_grid("2...3"), level=3, score=2))
        kinds = [k for (k, _args) in ag.kb.writes]
        self.assertNotIn("goal_evidence", kinds)

    def test_score_jump_counts_as_boundary(self) -> None:
        ag = self._agent()
        before = {"grid": _grid("2.3"), "level": 1, "step": 0, "score": 0}
        # No level_transition stop reason, but score jumped 0 -> 1: still a boundary.
        result = {
            "current_frame": {"grid": _grid("2..3"), "level": 1, "step": 2, "score": 1},
            "action_result": {"score": 1, "done": False},
            "executed": ["RIGHT"],
            "stop_reason": "completed",
            "done": False,
        }
        ag._ingest_result(before, ["RIGHT"], result)
        self.assertTrue(ag.summary.level_boundary_captured)

    # -- model-trusted fast path -------------------------------------------------------------------

    def test_fast_path_skips_reflect_while_trusted(self) -> None:
        ag = self._agent(fast_path_trust_window=2)
        before = {"grid": _grid("2.3"), "level": 1, "step": 0, "score": 0}
        # Feed passing single-step transitions the toy program predicts correctly (RIGHT: (0,0)->(0,1)).
        good = {
            "current_frame": {"grid": _grid(".23"), "level": 1, "step": 1, "score": 0},
            "action_result": {"score": 0, "done": False},
            "executed": ["RIGHT"],
            "stop_reason": "completed",
            "done": False,
        }
        calls_before = ag.summary.reflect_calls
        ag._ingest_result({"grid": _grid("2.3"), "level": 1}, ["RIGHT"], good)
        ag._ingest_result({"grid": _grid("2.3"), "level": 1}, ["RIGHT"], good)
        # Not yet trusted for the first two (window not full at ingest time); once trusted, the next
        # passing transition skips the reflect call.
        skipped_before = ag.summary.reflect_skipped
        ag._ingest_result({"grid": _grid("2.3"), "level": 1}, ["RIGHT"], good)
        self.assertTrue(ag._model_trusted)
        self.assertGreater(ag.summary.reflect_skipped, skipped_before)

    def test_fast_path_restores_reflect_on_mismatch(self) -> None:
        ag = self._agent(fast_path_trust_window=2)
        good = {
            "current_frame": {"grid": _grid(".23"), "level": 1, "step": 1, "score": 0},
            "action_result": {"score": 0, "done": False},
            "executed": ["RIGHT"],
            "stop_reason": "completed",
            "done": False,
        }
        for _ in range(3):
            ag._ingest_result({"grid": _grid("2.3"), "level": 1}, ["RIGHT"], good)
        self.assertTrue(ag._model_trusted)
        # A mispredicted transition: the toy program says RIGHT->(0,1) but the env reports the avatar
        # did NOT move. That live miss must drop trust and restore reflect cadence.
        bad = {
            "current_frame": {"grid": _grid("2.3"), "level": 1, "step": 1, "score": 0},
            "action_result": {"score": 0, "done": False},
            "executed": ["RIGHT"],
            "stop_reason": "completed",
            "done": False,
        }
        reflect_before = ag.summary.reflect_calls
        ag._ingest_result({"grid": _grid("2.3"), "level": 1}, ["RIGHT"], bad)
        self.assertFalse(ag._model_trusted)
        # Trust dropped, so this ingest ran the reflect LLM call (not skipped).
        self.assertGreater(ag.summary.reflect_calls, reflect_before)

    def test_fast_path_disabled_never_trusts(self) -> None:
        ag = self._agent(fast_path=False, fast_path_trust_window=2)
        good = {
            "current_frame": {"grid": _grid(".23"), "level": 1, "step": 1, "score": 0},
            "action_result": {"score": 0, "done": False},
            "executed": ["RIGHT"],
            "stop_reason": "completed",
            "done": False,
        }
        for _ in range(4):
            ag._ingest_result({"grid": _grid("2.3"), "level": 1}, ["RIGHT"], good)
        self.assertFalse(ag._model_trusted)
        self.assertEqual(ag.summary.reflect_skipped, 0)

    # -- goal-discovery readiness gate -------------------------------------------------------------

    def test_goal_discovery_ready_requires_live_confidence(self) -> None:
        ag = self._agent(goal_discovery_min_live_samples=3, goal_discovery_min_live_rate=0.9)
        # No live samples yet.
        self.assertFalse(ag._goal_discovery_ready())
        ag._live_results.extend([True, True, True])
        self.assertTrue(ag._goal_discovery_ready())
        # A miss drops the rate below the floor.
        ag._live_results.append(False)
        ag._live_results.append(False)
        self.assertFalse(ag._goal_discovery_ready())

    def test_decide_llm_error_degrades_instead_of_crashing(self) -> None:
        # Run-16 live crash: a timed-out decide call raised LlmError and killed the whole run.
        # _decide must catch it and return "" (callers treat that as an unusable response).
        from bench.arc_agi3_zonoid.ewm.llm_client import LlmError

        class _Boom:
            def chat(self, *a, **k):
                raise LlmError("chat completion failed: TimeoutError('timed out')")

        ag = self._agent()
        ag.llm = _Boom()
        out = ag._decide([{"role": "user", "content": "hi"}])
        self.assertEqual(out, "")

    def test_telemetry_fields_present_after_run(self) -> None:
        env = ToyEnv(_grid("2.3"), budget=50)
        llm = _script_reflect_only()
        agent_mod.EwmAgent._vision_available = staticmethod(lambda: False)
        ag = EwmAgent(
            env, llm, kb=None, vision_enabled=False,
            config=AgentConfig(game_id="toy", max_turns=6, min_probe_transitions=1),
        )
        out = ag.run()
        for key in ("coverage_pct", "actions_per_minute", "llm_calls_per_action",
                    "frontier_batches", "fast_path_batches", "reflect_skipped",
                    "level_boundary_captured", "goal_note_written", "is_win_rederived",
                    "interactions_probed", "interactions_found"):
            self.assertIn(key, out)


class _FlakyKbClient:
    """A KbClient stand-in that TIMES OUT on the first ``fail_first`` searches (returning [] with
    ``last_search_failed=True``, exactly like the real client on a daemon timeout) and then serves a
    stored-program hit. Exercises the Run-17 ORIENT retry: a timeout is retried, not conceded."""

    def __init__(self, hits, fail_first: int) -> None:
        self.hits = hits
        self.fail_first = fail_first
        self.calls = 0
        self.last_search_failed = False

    def search(self, q, k, gated=False, full_content=False):
        self.calls += 1
        if self.calls <= self.fail_first:
            self.last_search_failed = True   # a retryable daemon timeout, NOT an absence
            return []
        self.last_search_failed = False
        return list(self.hits)


class _FlakyKb(FakeKb):
    def __init__(self, client, max_writes_per_turn: int = 2) -> None:
        super().__init__(max_writes_per_turn=max_writes_per_turn)
        self.client = client


class OrientRetryTests(unittest.TestCase):
    """Run-17: ORIENT retries a daemon TIMEOUT (retryable) instead of conceding "no stored program"
    and burning a needless SYNTHESIZE cycle."""

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _stored_hit(self):
        return {
            "title": "game toy world model program",
            "summary": f"program source:\n{TOY_GAME_SOURCE}",
        }

    def _agent(self, client, orient_retries=3):
        EwmAgent._vision_available = staticmethod(lambda: False)
        env = ToyEnv(_grid("2.3"))
        llm = FakeLlm(['{"prediction_ok": true}'] * 6)
        ag = EwmAgent(
            env, llm, kb=_FlakyKb(client),
            config=AgentConfig(game_id="toy", max_turns=10, orient_retries=orient_retries),
        )
        ag._sleep = lambda _d: None  # no real backoff sleeps in the test
        ag.suite.append(_grid("2.3"), "RIGHT", _grid(".23"))
        return ag

    def test_orient_retries_flaky_timeout_then_adopts(self):
        # First two ORIENT searches time out; the third succeeds and adopts the stored program.
        client = _FlakyKbClient([self._stored_hit()], fail_first=2)
        ag = self._agent(client, orient_retries=3)
        adopted = ag._orient({"grid": _grid("2.3")})
        self.assertTrue(adopted)
        self.assertTrue(ag.summary.orient_adopted)
        # Three ORIENT attempts were made (two timeouts + the successful one).
        self.assertEqual(ag.summary.orient_kb_attempts, 3)

    def test_orient_exhausts_retries_on_persistent_timeout(self):
        # The daemon NEVER answers: after exhausting the retries ORIENT gives up (falls through to
        # SYNTHESIZE) rather than spinning forever, and the attempt count is bounded.
        client = _FlakyKbClient([self._stored_hit()], fail_first=99)
        ag = self._agent(client, orient_retries=3)
        adopted = ag._orient({"grid": _grid("2.3")})
        self.assertFalse(adopted)
        self.assertEqual(ag.summary.orient_kb_attempts, 4)  # 1 initial + 3 retries

    def test_orient_genuine_absence_does_not_retry(self):
        # An EMPTY result that is NOT a timeout (last_search_failed False) is a genuine absence:
        # ORIENT must NOT retry it — exactly one attempt.
        client = _FlakyKbClient([], fail_first=0)  # succeeds immediately, returns no hits
        ag = self._agent(client, orient_retries=3)
        adopted = ag._orient({"grid": _grid("2.3")})
        self.assertFalse(adopted)
        self.assertEqual(ag.summary.orient_kb_attempts, 1)


class _CorridorEnv:
    """An open corridor with the goal WALLED OFF (unreachable), so ``_plan`` finds no win and the loop
    drives FRONTIER EXPLORATION with correct toy-game movement (no divergence). ``act`` moves the
    avatar one cell per action; the env reports a ``level_transition`` on the ``boundary_after``-th
    ``act`` call — i.e. after that many zero-decide frontier batches — which is the level boundary the
    multi-batch exploration must detect. Counts ``act`` calls so a test can assert multiple batches
    ran. ``boundary_after=None`` never crosses a boundary."""

    ACTIONS = ["UP", "DOWN", "LEFT", "RIGHT"]

    def __init__(self, boundary_after=None, budget: int = 200) -> None:
        # 2x6 board: row0 open corridor with the avatar at (0,0); goal at (1,5) walled off ((0,5) and
        # all of row0-adjacent row1 are walls) so BFS never reaches it -> plan() returns None ->
        # frontier path drives exploration.
        self._rows, self._cols = 2, 6
        self._avatar = (0, 0)
        self._goal = (1, 5)
        self._walls = frozenset({(0, 5), (1, 0), (1, 1), (1, 2), (1, 3), (1, 4)})
        self._boundary_after = boundary_after
        self.remaining_actions = budget
        self.act_calls = 0
        self._level = 1

    def _grid(self):
        grid = [[0] * self._cols for _ in range(self._rows)]
        for (r, c) in self._walls:
            grid[r][c] = 1
        gr, gc = self._goal
        grid[gr][gc] = 3
        ar, ac = self._avatar
        grid[ar][ac] = 2
        return grid

    def observe(self):
        return {
            "grid": self._grid(),
            "level": self._level,
            "step": 0,
            "valid_actions": list(self.ACTIONS),
            "score": 0,
            "remaining_actions": self.remaining_actions,
        }

    def _apply_one(self, action: str) -> None:
        dr, dc = DELTAS[action]
        ar, ac = self._avatar
        nr, nc = ar + dr, ac + dc
        if 0 <= nr < self._rows and 0 <= nc < self._cols and (nr, nc) not in self._walls:
            self._avatar = (nr, nc)

    def act(self, actions, expect=None):
        self.act_calls += 1
        executed = []
        stop_reason = "completed"
        crossed = False
        for index, action in enumerate(actions):
            name = action.get("action") if isinstance(action, dict) else action
            self.remaining_actions = max(0, self.remaining_actions - 1)
            self._apply_one(str(name))
            executed.append(name)
            after = self._grid()
            if expect is not None and index < len(expect) and expect[index] is not None:
                if not grids_match([list(r) for r in expect[index]], after):
                    stop_reason = "expect_mismatch"
                    break
        # The level boundary fires on the configured act-call (after N zero-decide batches).
        if self._boundary_after is not None and self.act_calls >= self._boundary_after:
            crossed = True
            stop_reason = "level_transition"
            self._level += 1
        frame = {"grid": self._grid(), "level": self._level, "step": 0, "score": 0}
        return {
            "current_frame": frame,
            "action_result": {"score": 1 if crossed else 0, "done": False},
            "valid_actions": list(self.ACTIONS),
            "remaining_actions": self.remaining_actions,
            "executed": executed,
            "stop_reason": stop_reason,
            "done": False,
        }


class ExplorationExecutorTests(unittest.TestCase):
    """Run-17: the LLM-FREE EXPLORATION EXECUTOR loops CPU-plan -> execute frontier batch -> re-plan
    with ZERO decide calls while trusted; trust-drop restores the decide/reflect cadence."""

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _trusted_agent(self, env, **cfg):
        from bench.arc_agi3_zonoid.ewm.world_model import WorldModelProgram

        EwmAgent._vision_available = staticmethod(lambda: False)
        base = dict(
            game_id="toy", max_turns=20, min_probe_transitions=1,
            fast_path_trust_window=2, fast_path_batch_cap=2, frontier_max_depth=2,
            goal_discovery_min_live_samples=2, goal_discovery_min_live_rate=0.9,
            max_frontier_batches_per_turn=8,
        )
        base.update(cfg)
        ag = EwmAgent(env, FakeLlm([]), kb=FakeKb(), vision_enabled=False,
                      config=AgentConfig(**base))
        ag.program = WorldModelProgram.load(TOY_GAME_SOURCE)
        # Prime the model as trusted: a full window of passing live single-step predictions.
        ag._live_results.extend([True, True, True])
        ag._refresh_model_trust()
        self.assertTrue(ag._model_trusted)
        self.assertTrue(ag._goal_discovery_ready())
        return ag

    def test_multi_batch_zero_decide_exploration_detects_boundary(self):
        # The boundary fires only on the 3rd act call, so the executor must loop CPU-plan -> execute
        # -> re-plan at least three times with NO decide calls before it detects the level boundary.
        env = _CorridorEnv(boundary_after=3)
        ag = self._trusted_agent(env)
        decide_before = ag.summary.decide_calls
        result, diverged, last_frame = ag._explore_frontier_loop({"grid": env._grid(), "level": 1})
        # Multiple frontier batches ran within the single turn (the executor kept re-planning).
        self.assertGreaterEqual(ag.summary.frontier_batches, 2)
        self.assertGreater(env.act_calls, 1)
        # ZERO decide (LLM) calls happened across the whole exploration loop.
        self.assertEqual(ag.summary.decide_calls, decide_before)
        # The level boundary was observed and captured (is_win re-derived from it).
        self.assertTrue(ag.summary.level_boundary_captured)
        self.assertFalse(diverged)

    def test_trust_drop_restores_cadence_single_batch(self):
        # With the exploration executor OFF the loop runs exactly ONE frontier batch (Run-16 cadence),
        # confirming the multi-batch loop is what the executor flag adds. bump_probes OFF so that single
        # batch is the FRONTIER path (the Run-22 bump-quota interleave would otherwise make it a bump).
        env = _CorridorEnv(boundary_after=3)
        ag = self._trusted_agent(env, exploration_executor=False, bump_probes=False)
        ag._explore_frontier_loop({"grid": env._grid(), "level": 1})
        self.assertEqual(ag.summary.frontier_batches, 1)
        self.assertEqual(env.act_calls, 1)

    def test_exploration_loop_stops_when_trust_drops(self):
        # A DEVIATING env (the toy program mispredicts the very first frontier batch) trips an
        # expect-mismatch: the loop must break after ONE batch and hand control back to run() for the
        # single strategy decide (REPAIR), never spinning zero-decide on a model that just diverged.
        # bump_probes OFF so the first (and only) batch is the FRONTIER path under test — with the
        # Run-22 bump-quota interleave ON the very first batch could otherwise be a contact-bump batch.
        env = _DeviatingCorridorEnv()
        ag = self._trusted_agent(env, bump_probes=False)
        result, diverged, last_frame = ag._explore_frontier_loop({"grid": env._grid(), "level": 1})
        self.assertTrue(diverged)
        self.assertEqual(ag.summary.frontier_batches, 1)


class _DeviatingCorridorEnv(_CorridorEnv):
    """A corridor whose avatar does NOT move as the toy program predicts (it ignores the action), so
    the first frontier batch's ``expect`` grids mismatch -> the executor loop breaks on divergence."""

    def __init__(self, budget: int = 200) -> None:
        super().__init__(boundary_after=None, budget=budget)  # boundary never reached

    def _apply_one(self, action: str) -> None:
        # Never move: the program predicts a move (RIGHT: (0,0)->(0,1)) but the env stays put, so the
        # first expect grid mismatches immediately.
        return None


class RepairBudgetGuardTests(unittest.TestCase):
    """Run-28: a HEALTHY recalled model must spend budget on LLM-free exploration, not repair.

    Root cause reproduced: `_handle_divergence` gated repair on `_live_pass_rate()` measured over a
    window that ALREADY INCLUDED the current failing transition, so an ISOLATED transient on a model
    that was healthy just before it (final live_pass_rate 1.0 in run 27) fired a slow qwen REPAIR.
    The fix suppresses repair when the PRIOR window (excluding the failing tail) is healthy, and a
    consecutive-timeout backoff stops paying the full client timeout after the endpoint stalls."""

    def setUp(self):
        EwmAgent._vision_available = staticmethod(lambda: False)

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _whole_mover_agent(self, **cfg):
        # A WHOLE (+5) mover adopted as the active program — exactly the run-27 shape (`adopted_as`
        # "whole"), NOT a MaskedProgram, so tolerance never applies and the healthy gate is the only
        # thing between an isolated transient and REPAIR.
        from bench.arc_agi3_zonoid.ewm.world_model import WorldModelProgram

        cols = 20
        env = _WallMoverEnv(cols=cols, truth_mag=5, wall_col=8, budget=60)
        base = dict(game_id="ls20", max_turns=1, min_probe_transitions=1)
        base.update(cfg)
        ag = EwmAgent(env, FakeLlm([]), kb=FakeKb(), vision_enabled=False, config=AgentConfig(**base))
        ag.program = WorldModelProgram.load(_mover_source(5))
        # A diverging transition in the suite: the truth stayed put at a wall, but the +5 mover
        # predicts a move — so `_repair` (if reached) would validate() False, and `_last_divergence_cells`
        # is non-empty. This is the failing tail.
        ag.suite.append(_mover_grid(cols, 3), "RIGHT", _mover_grid(cols, 3))
        return ag

    def test_healthy_window_transient_suppresses_repair_and_no_llm(self):
        # (a) An adopted WHOLE program + a HEALTHY prior window + a single transient divergence must
        # NOT trigger REPAIR — it routes straight past the repair block. On run-27 behaviour this
        # fired a repair (repair_attempts>0); the guard makes it a suppression instead.
        ag = self._whole_mover_agent()
        # Prime a proven-healthy window, then the failing tail (the current divergence).
        ag._live_results.extend([True, True, True, True])
        ag._live_results.append(False)  # the divergent tail _handle_divergence sees
        self.assertTrue(ag._prior_window_healthy())

        decide_before = ag.summary.decide_calls
        ag._handle_divergence({"grid": _mover_grid(20, 3), "level": 1}, None)

        self.assertEqual(ag.summary.repair_attempts, 0,
                         "a transient on a proven-healthy whole model must NOT enter REPAIR")
        self.assertEqual(ag.summary.repair_suppressed_healthy, 1)
        self.assertEqual(ag.summary.decide_calls, decide_before,
                         "healthy suppression must make ZERO decide (LLM) calls")
        self.assertIsNotNone(ag.program, "the healthy model must NOT be dropped")

    def test_persistent_defect_still_repairs_when_prior_window_degrades(self):
        # The guard is transient-only: once the PRIOR window (excluding the failing tail) has itself
        # degraded below repair_trigger_pass_rate, the divergence is a persistent defect and REPAIR
        # must still engage (the Run-13 wall-mover shape — never mask a real defect away).
        ag = self._whole_mover_agent(max_repair_attempts=1, max_repairs_per_game=99,
                                     max_repairs_per_divergence=99, min_live_pass_rate=0.0)
        # A window whose prior (excluding the tail) is mostly misses: not healthy -> repair engages.
        ag._live_results.extend([False, False, False, False])
        ag._live_results.append(False)
        self.assertFalse(ag._prior_window_healthy())
        ag._handle_divergence({"grid": _mover_grid(20, 3), "level": 1}, None)
        self.assertGreater(ag.summary.repair_attempts, 0,
                           "a persistent defect (prior window degraded) must still REPAIR")
        self.assertEqual(ag.summary.repair_suppressed_healthy, 0)

    def test_consecutive_llm_timeouts_trip_backoff_and_skip_repair(self):
        # (b) Two consecutive client TIMEOUTS trip the backoff latch; a subsequent divergence on an
        # un-healthy window must then FALL to the LLM-free path (no further repair decide) instead of
        # paying another full timeout.
        from bench.arc_agi3_zonoid.ewm.llm_client import LlmError

        class _Timeout:
            def chat(self, *a, **k):
                raise LlmError("chat completion failed: TimeoutError('timed out')")

        ag = self._whole_mover_agent(repair_timeout_backoff=2, max_repair_attempts=1,
                                     max_repairs_per_game=99, max_repairs_per_divergence=99,
                                     min_live_pass_rate=0.0)
        ag.llm = _Timeout()
        # Two timed-out decide calls trip the latch.
        self.assertEqual(ag._decide([{"role": "user", "content": "x"}]), "")
        self.assertFalse(ag._repair_backoff_tripped)
        self.assertEqual(ag._decide([{"role": "user", "content": "x"}]), "")
        self.assertTrue(ag._repair_backoff_tripped)
        self.assertEqual(ag.summary.llm_timeouts, 2)
        self.assertTrue(ag.summary.repair_timeout_backoff_tripped)

        # A divergence on a DEGRADED window would normally repair; with the latch tripped it does not.
        ag._live_results.extend([False, False, False, False])
        ag._live_results.append(False)
        self.assertFalse(ag._prior_window_healthy())
        ag._handle_divergence({"grid": _mover_grid(20, 3), "level": 1}, None)
        self.assertEqual(ag.summary.repair_attempts, 0,
                         "with the timeout backoff tripped, no further REPAIR decide is paid")

    def test_non_timeout_error_resets_consecutive_streak(self):
        # A non-timeout transport error must NOT count toward the timeout streak (only genuine
        # timeouts burn the full client timeout the backoff is guarding against).
        from bench.arc_agi3_zonoid.ewm.llm_client import LlmError

        class _Flaky:
            def __init__(self):
                self.n = 0

            def chat(self, *a, **k):
                self.n += 1
                if self.n == 2:
                    raise LlmError("chat completion failed: URLError('connection refused')")
                raise LlmError("chat completion failed: TimeoutError('timed out')")

        ag = self._whole_mover_agent(repair_timeout_backoff=2)
        ag.llm = _Flaky()
        ag._decide([{"role": "user", "content": "x"}])   # timeout -> streak 1
        ag._decide([{"role": "user", "content": "x"}])   # non-timeout -> streak reset to 0
        self.assertFalse(ag._repair_backoff_tripped)
        ag._decide([{"role": "user", "content": "x"}])   # timeout -> streak 1 (not 2)
        self.assertFalse(ag._repair_backoff_tripped,
                         "an interleaved non-timeout error must reset the consecutive streak")
        self.assertEqual(ag.summary.llm_timeouts, 2)

    def test_healthy_path_reaches_frontier_batch_in_tight_budget(self):
        # (c) With a trusted model and a tight scripted budget, the healthy path reaches at least one
        # LLM-FREE frontier/contact batch (the CPU exploration phase) with ZERO decide calls — the
        # budget the run-27 repair storm consumed.
        from bench.arc_agi3_zonoid.ewm.world_model import WorldModelProgram

        env = _CorridorEnv(boundary_after=None, budget=8)
        base = dict(
            game_id="toy", max_turns=20, min_probe_transitions=1,
            fast_path_trust_window=2, fast_path_batch_cap=2, frontier_max_depth=2,
            goal_discovery_min_live_samples=2, goal_discovery_min_live_rate=0.9,
            max_frontier_batches_per_turn=8, bump_probes=False,
        )
        ag = EwmAgent(env, FakeLlm([]), kb=FakeKb(), vision_enabled=False, config=AgentConfig(**base))
        ag.program = WorldModelProgram.load(TOY_GAME_SOURCE)
        ag._live_results.extend([True, True, True])
        ag._refresh_model_trust()
        self.assertTrue(ag._goal_discovery_ready())
        decide_before = ag.summary.decide_calls
        result, diverged, last_frame = ag._explore_frontier_loop({"grid": env._grid(), "level": 1})
        self.assertGreaterEqual(ag.summary.frontier_batches, 1,
                                "the healthy path must reach at least one LLM-free frontier batch")
        self.assertEqual(ag.summary.decide_calls, decide_before,
                         "exploration must be LLM-FREE (zero decide calls)")
        self.assertFalse(diverged)


# Movement-only model for the switch-door game: the avatar (2) translates on background (0); walls
# (1), the switch (4), the door (5), and the goal (3) are impassable statics. SPACE is a legal action
# the model predicts as a NO-OP (it is not a translation) — exactly the interaction the model cannot
# see, so the discovery mode must find it by probing. Renders every non-avatar cell exactly as read,
# so movement BFS covers the reachable region and then EXHAUSTS with no boundary.
SWITCH_MODEL_SOURCE = '''
import copy

AVATAR = 2
DELTAS = {"UP": (-1, 0), "DOWN": (1, 0), "LEFT": (0, -1), "RIGHT": (0, 1)}
# Walls (1), the switch (4), and the closed door (5) block movement; the goal (3) is WALKABLE (the
# avatar drives onto it). The model does not know the door can open — that is the interaction.
BLOCKERS = {1, 4, 5}


def init_state(frame):
    rows = len(frame)
    cols = len(frame[0]) if rows else 0
    avatar = None
    statics = {}
    for r in range(rows):
        for c in range(cols):
            v = frame[r][c]
            if v == AVATAR:
                avatar = (r, c)
            elif v != 0:
                statics[(r, c)] = v
    return {"avatar": avatar, "statics": statics, "rows": rows, "cols": cols}


def legal_actions(state):
    return ["UP", "DOWN", "LEFT", "RIGHT", "SPACE"]


def step(state, action):
    state = copy.deepcopy(state)
    if action not in DELTAS:
        return state, {"moved": False}  # SPACE etc: the model sees no effect
    dr, dc = DELTAS[action]
    r, c = state["avatar"]
    nr, nc = r + dr, c + dc
    blocked = state["statics"].get((nr, nc)) in BLOCKERS
    if 0 <= nr < state["rows"] and 0 <= nc < state["cols"] and not blocked:
        state["avatar"] = (nr, nc)
    return state, {"moved": state["avatar"] == (nr, nc)}


def render(state):
    rows, cols = state["rows"], state["cols"]
    grid = [[0 for _ in range(cols)] for _ in range(rows)]
    for (r, c), v in state["statics"].items():
        grid[r][c] = v
    ar, ac = state["avatar"]
    grid[ar][ac] = AVATAR
    return grid


def is_win(state):
    return False
'''


class SwitchDoorEnv:
    """A toy game whose WIN needs an INTERACTION, not movement. The avatar (2) moves on 0-cells; a
    switch (4) and a door (5) block a corridor to the goal (3). Movement alone exhausts the reachable
    region without reaching the goal. Firing SPACE while STANDING ADJACENT to the switch opens the
    door (removes the door cell -> a NEW reachable region), and once the avatar reaches the goal the
    env reports ``level_transition``. SPACE anywhere else is a no-op."""

    ACTIONS = ["UP", "DOWN", "LEFT", "RIGHT", "SPACE"]

    def __init__(self, budget: int = 200) -> None:
        # 3x5 board — the goal is walled off behind a DOOR that only the switch opens, so movement
        # alone can never reach it:
        #   row0:  2 . . 1 3      avatar(0,0), wall(0,3), goal(0,4)
        #   row1:  . . 4 . 5      switch(1,2), door(1,4)
        #   row2:  . . . . 1      wall(2,4)
        # goal(0,4)'s only non-wall neighbour is the door(1,4); the reachable region includes cells
        # adjacent to the switch, so INTERACTION DISCOVERY can fire SPACE next to it to open the door.
        self._rows, self._cols = 3, 5
        self._avatar = (0, 0)
        self._switch = (1, 2)
        self._door = (1, 4)
        self._goal = (0, 4)
        self._walls = frozenset({(0, 3), (2, 4)})
        self._door_open = False
        self.remaining_actions = budget
        self.act_calls = 0
        self._level = 1

    def _grid(self):
        grid = [[0] * self._cols for _ in range(self._rows)]
        for (r, c) in self._walls:
            grid[r][c] = 1
        grid[self._switch[0]][self._switch[1]] = 4
        if not self._door_open:
            grid[self._door[0]][self._door[1]] = 5
        grid[self._goal[0]][self._goal[1]] = 3
        grid[self._avatar[0]][self._avatar[1]] = 2
        return grid

    def observe(self):
        return {
            "grid": self._grid(),
            "level": self._level,
            "step": 0,
            "valid_actions": list(self.ACTIONS),
            "score": 0,
            "remaining_actions": self.remaining_actions,
        }

    def _adjacent_to_switch(self) -> bool:
        ar, ac = self._avatar
        sr, sc = self._switch
        return abs(ar - sr) + abs(ac - sc) == 1

    def _apply_one(self, action: str) -> None:
        if action == "SPACE":
            if self._adjacent_to_switch():
                self._door_open = True
            return
        dr, dc = DELTAS[action]
        ar, ac = self._avatar
        nr, nc = ar + dr, ac + dc
        if not (0 <= nr < self._rows and 0 <= nc < self._cols):
            return
        cell = (nr, nc)
        if cell in self._walls or cell == self._switch:
            return  # walls and the switch are solid
        if cell == self._door and not self._door_open:
            return  # closed door blocks
        self._avatar = cell

    def act(self, actions, expect=None):
        self.act_calls += 1
        executed = []
        stop_reason = "completed"
        crossed = False
        for index, action in enumerate(actions):
            name = action.get("action") if isinstance(action, dict) else action
            self.remaining_actions = max(0, self.remaining_actions - 1)
            self._apply_one(str(name))
            executed.append(name)
            after = self._grid()
            if expect is not None and index < len(expect) and expect[index] is not None:
                if not grids_match([list(r) for r in expect[index]], after):
                    stop_reason = "expect_mismatch"
                    break
            if self._avatar == self._goal:
                crossed = True
                stop_reason = "level_transition"
                self._level += 1
                break
        frame = {"grid": self._grid(), "level": self._level, "step": 0,
                 "score": 1 if crossed else 0}
        return {
            "current_frame": frame,
            "action_result": {"score": 1 if crossed else 0, "done": False},
            "valid_actions": list(self.ACTIONS),
            "remaining_actions": self.remaining_actions,
            "executed": executed,
            "stop_reason": stop_reason,
            "done": False,
        }


class InteractionDiscoveryTests(unittest.TestCase):
    """Run-19: INTERACTION DISCOVERY — on movement-frontier exhaustion with no boundary, probe
    untried (non-movement action, adjacent-object) pairs, dedup them, order cheapest-first, and record
    a discovery when a probe changes cells beyond the auto-changing region."""

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _trusted_agent(self, env, **cfg):
        from bench.arc_agi3_zonoid.ewm.world_model import WorldModelProgram

        EwmAgent._vision_available = staticmethod(lambda: False)
        base = dict(
            game_id="switch", max_turns=40, min_probe_transitions=1,
            fast_path_trust_window=2, goal_discovery_min_live_samples=2,
            goal_discovery_min_live_rate=0.9, max_frontier_batches_per_turn=8,
            max_interaction_probes_per_turn=6,
        )
        base.update(cfg)
        ag = EwmAgent(env, FakeLlm([]), kb=FakeKb(max_writes_per_turn=8),
                      vision_enabled=False, config=AgentConfig(**base))
        ag.program = WorldModelProgram.load(SWITCH_MODEL_SOURCE)
        ag._live_results.extend([True, True, True])
        ag._refresh_model_trust()
        return ag

    def test_non_movement_actions_isolated(self):
        env = SwitchDoorEnv()
        ag = self._trusted_agent(env)
        frame = env.observe()
        non_move = ag._non_movement_actions(frame)
        # SPACE is the only action the movement-only model predicts as a no-op.
        self.assertEqual(non_move, ["SPACE"])

    def test_contexts_ordered_cheapest_first(self):
        env = SwitchDoorEnv()
        ag = self._trusted_agent(env)
        contexts = ag._adjacent_object_contexts(env._grid())
        # At least the switch (4) and goal (3) object classes yield a reachable adjacent context.
        self.assertGreaterEqual(len(contexts), 1)
        costs = [cost for (_h, _t, cost) in contexts]
        self.assertEqual(costs, sorted(costs))  # cheapest reach first

    def test_probe_dedup_same_action_object_fired_once(self):
        # Door pinned open so SPACE is a pure no-op: no probe ever changes the board, so the ONLY
        # thing that stops probing is DEDUP. Drive discovery to exhaustion, then assert one more pass
        # fires nothing (every (action, object) pair already recorded) and no pair is ever double-fired.
        env = SwitchDoorEnv()
        env._door_open = True
        ag = self._trusted_agent(env)
        for _ in range(12):
            before = ag.summary.interactions_probed
            ag._interaction_discovery(env.observe())
            if ag.summary.interactions_probed == before:
                break
        exhausted_probed = ag.summary.interactions_probed
        exhausted_fired = set(ag._fired_probes)
        self.assertGreater(exhausted_probed, 0)
        # Distinct pairs fired == probes fired: no (action, object) pair was ever re-fired.
        self.assertEqual(exhausted_probed, len(exhausted_fired))
        # A further pass adds nothing.
        ag._interaction_discovery(env.observe())
        self.assertEqual(ag.summary.interactions_probed, exhausted_probed)
        self.assertEqual(set(ag._fired_probes), exhausted_fired)

    def test_switch_game_solved_end_to_end_by_discovery(self):
        env = SwitchDoorEnv()
        ag = self._trusted_agent(env)
        out = ag.run()
        # The probe of SPACE adjacent to the switch was fired and recorded as a discovery.
        self.assertGreaterEqual(out["interactions_probed"], 1)
        self.assertGreaterEqual(out["interactions_found"], 1)
        # Opening the door let movement reach the goal -> a level boundary was captured end-to-end.
        self.assertTrue(out["level_boundary_captured"])
        # A game-scoped interaction note was recorded.
        kinds = [k for (k, _args) in ag.kb.writes]
        self.assertIn("interaction", kinds)


# ---------------------------------------------------------------------------------------------------
# Run-20 BUMP PROBES + CROSS-RUN COVERAGE PERSISTENCE
# ---------------------------------------------------------------------------------------------------

# Movement-only model for the push-block game. The avatar (2) translates on background (0); walls (1),
# the block (6), and the goal (3) are ALL treated as impassable statics — the model does NOT know the
# block can be pushed (that is the contact mechanic bump discovery must find). ls20-shaped: the only
# valid actions are the four translations, so _non_movement_actions returns [] and interaction discovery
# falls through to BUMP PROBES (movement INTO the block).
PUSHBLOCK_MODEL_SOURCE = '''
import copy

AVATAR = 2
DELTAS = {"UP": (-1, 0), "DOWN": (1, 0), "LEFT": (0, -1), "RIGHT": (0, 1)}
BLOCKERS = {1, 6, 3}


def init_state(frame):
    rows = len(frame)
    cols = len(frame[0]) if rows else 0
    avatar = None
    statics = {}
    for r in range(rows):
        for c in range(cols):
            v = frame[r][c]
            if v == AVATAR:
                avatar = (r, c)
            elif v != 0:
                statics[(r, c)] = v
    return {"avatar": avatar, "statics": statics, "rows": rows, "cols": cols}


def legal_actions(state):
    return ["UP", "DOWN", "LEFT", "RIGHT"]


def step(state, action):
    state = copy.deepcopy(state)
    if action not in DELTAS:
        return state, {"moved": False}
    dr, dc = DELTAS[action]
    r, c = state["avatar"]
    nr, nc = r + dr, c + dc
    blocked = state["statics"].get((nr, nc)) in BLOCKERS
    if 0 <= nr < state["rows"] and 0 <= nc < state["cols"] and not blocked:
        state["avatar"] = (nr, nc)
    return state, {"moved": state["avatar"] == (nr, nc)}


def render(state):
    rows, cols = state["rows"], state["cols"]
    grid = [[0 for _ in range(cols)] for _ in range(rows)]
    for (r, c), v in state["statics"].items():
        grid[r][c] = v
    ar, ac = state["avatar"]
    grid[ar][ac] = AVATAR
    return grid


def is_win(state):
    return False
'''


class PushBlockEnv:
    """A toy push-block (sokoban) game whose WIN needs a CONTACT bump, not movement. The avatar (2)
    moves on 0-cells; a block (6) sits between the avatar and the goal (3). Movement alone can never
    pass the block (it is solid to the avatar), so the movement frontier exhausts on {avatar}. Bumping
    INTO the block pushes it one cell in the bump direction when that cell is empty OR the GOAL; pushing
    the block ONTO the goal clears the level (``level_transition``). A bump into a wall/edge is a no-op."""

    ACTIONS = ["UP", "DOWN", "LEFT", "RIGHT"]

    def __init__(self, budget: int = 200) -> None:
        # 3x4 open board — the avatar has room to TRANSLATE (so the movement-only model exposes real
        # movement actions and the non-movement vocabulary is empty, ls20-shaped), while a block(6) is
        # walled so its ONLY empty neighbour is its left cell — forcing the bump RIGHT that pushes it
        # ONTO the goal(3) and clears the level. Movement alone sweeps the background but never reaches
        # the goal (a solid to the model):
        #   row0:  2 . 1 .
        #   row1:  . . 6 3     block(1,2), goal(1,3)
        #   row2:  . . 1 .
        self._rows, self._cols = 3, 4
        self._avatar = (0, 0)
        self._block = (1, 2)
        self._goal = (1, 3)
        self._walls = frozenset({(0, 2), (2, 2)})
        self._solved = False
        self.remaining_actions = budget
        self.act_calls = 0
        self._level = 1

    def _grid(self):
        grid = [[0] * self._cols for _ in range(self._rows)]
        for (r, c) in self._walls:
            grid[r][c] = 1
        if not self._solved:
            grid[self._goal[0]][self._goal[1]] = 3
            grid[self._block[0]][self._block[1]] = 6
        grid[self._avatar[0]][self._avatar[1]] = 2
        return grid

    def observe(self):
        return {
            "grid": self._grid(),
            "level": self._level,
            "step": 0,
            "valid_actions": list(self.ACTIONS),
            "score": 1 if self._solved else 0,
            "remaining_actions": self.remaining_actions,
        }

    def _apply_one(self, action: str) -> bool:
        dr, dc = DELTAS[action]
        ar, ac = self._avatar
        nr, nc = ar + dr, ac + dc
        if not (0 <= nr < self._rows and 0 <= nc < self._cols):
            return False
        target = (nr, nc)
        if target in self._walls:
            return False  # walls are solid
        if target == self._block and not self._solved:
            # Bump the block: push it one further in the same direction if that cell is on-board.
            br, bc = nr + dr, nc + dc
            if not (0 <= br < self._rows and 0 <= bc < self._cols):
                return False  # block against the edge: no-op
            beyond = (br, bc)
            if beyond == self._goal:
                # Block pushed ONTO the goal -> level solved.
                self._block = beyond
                self._solved = True
                self._avatar = target
                return True
            # Otherwise the block slides to an empty cell and the avatar follows.
            self._block = beyond
            self._avatar = target
            return False
        if target == self._goal and not self._solved:
            return False  # goal is solid until the block clears it (matches the model's view)
        self._avatar = target
        return False

    def act(self, actions, expect=None):
        self.act_calls += 1
        executed = []
        stop_reason = "completed"
        crossed = False
        for index, action in enumerate(actions):
            name = action.get("action") if isinstance(action, dict) else action
            self.remaining_actions = max(0, self.remaining_actions - 1)
            solved_now = self._apply_one(str(name))
            executed.append(name)
            after = self._grid()
            if expect is not None and index < len(expect) and expect[index] is not None:
                if not grids_match([list(r) for r in expect[index]], after):
                    stop_reason = "expect_mismatch"
                    break
            if solved_now:
                crossed = True
                stop_reason = "level_transition"
                self._level += 1
                break
        frame = {"grid": self._grid(), "level": self._level, "step": 0,
                 "score": 1 if self._solved else 0}
        return {
            "current_frame": frame,
            "action_result": {"score": 1 if self._solved else 0, "done": False},
            "valid_actions": list(self.ACTIONS),
            "remaining_actions": self.remaining_actions,
            "executed": executed,
            "stop_reason": stop_reason,
            "done": False,
        }


class BumpProbeTests(unittest.TestCase):
    """Run-20: when the non-movement vocabulary is EMPTY (ls20), interaction discovery falls back to
    CONTACT bump probes — move INTO each adjacent object class and diff for a contact effect."""

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _trusted_agent(self, env, source, **cfg):
        from bench.arc_agi3_zonoid.ewm.world_model import WorldModelProgram

        EwmAgent._vision_available = staticmethod(lambda: False)
        base = dict(
            game_id="push", max_turns=40, min_probe_transitions=1,
            fast_path_trust_window=2, goal_discovery_min_live_samples=2,
            goal_discovery_min_live_rate=0.9, max_frontier_batches_per_turn=8,
            max_interaction_probes_per_turn=6, coverage_persistence=False,
        )
        base.update(cfg)
        ag = EwmAgent(env, FakeLlm([]), kb=FakeKb(max_writes_per_turn=8),
                      vision_enabled=False, config=AgentConfig(**base))
        ag.program = WorldModelProgram.load(source)
        ag._live_results.extend([True, True, True])
        ag._refresh_model_trust()
        return ag

    def test_non_movement_vocabulary_empty_on_movement_only_model(self):
        env = PushBlockEnv()
        ag = self._trusted_agent(env, PUSHBLOCK_MODEL_SOURCE)
        # The model exposes only translations -> nothing to fire in place.
        self.assertEqual(ag._non_movement_actions(env.observe()), [])

    def test_bump_contexts_include_block_with_direction(self):
        env = PushBlockEnv()
        ag = self._trusted_agent(env, PUSHBLOCK_MODEL_SOURCE)
        contexts = ag._bump_contexts(env._grid())
        # The block (6) yields a contact context; the bump direction points from the approach cell
        # toward the block (RIGHT: (0, +1) from avatar's cell (0,0) toward block (0,1)).
        self.assertGreaterEqual(len(contexts), 1)
        dirs = {bump for (_h, _a, bump, _c) in contexts}
        self.assertIn((0, 1), dirs)

    def test_push_block_solved_end_to_end_by_bump(self):
        env = PushBlockEnv()
        ag = self._trusted_agent(env, PUSHBLOCK_MODEL_SOURCE)
        out = ag.run()
        # A contact bump was fired and found the push mechanic; the block-on-goal cleared the level.
        self.assertGreaterEqual(out["bumps_probed"], 1)
        self.assertGreaterEqual(out["bumps_found"], 1)
        self.assertTrue(out["level_boundary_captured"])
        # A game-scoped interaction note recorded the discovered contact mechanic.
        kinds = [k for (k, _args) in ag.kb.writes]
        self.assertIn("interaction", kinds)

    def test_bump_dedup_respects_per_run_guard(self):
        # A block pushed off-board is a pure no-op wall: bumps never change the board, so the ONLY
        # thing that stops probing is the PER-RUN (_bump_attempted) dedup (Run-25 fix: bump discovery is
        # per-run, NOT gated by the persisted _fired_probes set).
        env = PushBlockEnv()
        env._solved = True  # goal/block removed -> the avatar's neighbors are all background/edge
        ag = self._trusted_agent(env, PUSHBLOCK_MODEL_SOURCE)
        # Seed the per-run attempt guard as if THIS run already bumped every object class.
        contexts = ag._bump_contexts(env._grid())
        for (obj_hash, _a, _b, _c) in contexts:
            ag._bump_attempted.add(obj_hash)
        before = ag.summary.bumps_probed
        ag._bump_discovery(env.observe())
        # Every object class already recorded as bumped THIS run -> no new bump fires (per-run dedup holds).
        self.assertEqual(ag.summary.bumps_probed, before)

    def test_plateau_one_hands_off_to_bumps_within_short_budget(self):
        # Run-21: coverage_plateau_exhaust default is 1, so a SINGLE no-new-coverage frontier batch
        # exhausts the movement frontier and hands off to bump discovery. Prove the handoff fires
        # within a tight budget (the Run-17..20 pathology was the budget draining before the 2-batch
        # plateau ever tripped). The env starts the avatar boxed against the block so its first real
        # translation batch immediately re-treads / stalls, then bumps clear the level.
        env = PushBlockEnv()
        # A tight action budget: with plateau=2 the frontier would still be re-sweeping when this runs
        # out; plateau=1 must reach the bump handoff and clear the level inside it.
        ag = self._trusted_agent(env, PUSHBLOCK_MODEL_SOURCE, max_turns=12)
        self.assertEqual(ag.config.coverage_plateau_exhaust, 1)
        out = ag.run()
        self.assertGreaterEqual(out["bumps_probed"], 1)
        self.assertGreaterEqual(out["bumps_found"], 1)
        self.assertTrue(out["level_boundary_captured"])

    def test_frontier_fully_covered_true_when_batch_is_resumed_ground(self):
        # Run-21 bump-first gate: a frontier batch whose predicted player cells are ALL already in
        # _coverage_cells is pure re-sweep of resumed ground -> _frontier_fully_covered is True.
        env = PushBlockEnv()
        ag = self._trusted_agent(env, PUSHBLOCK_MODEL_SOURCE)
        frame = env.observe()
        from bench.arc_agi3_zonoid.ewm.planner import explore_frontier

        frontier = explore_frontier(
            ag.program, ag._frame_grid(frame),
            max_depth=min(ag.config.frontier_max_depth, ag.config.plan_max_depth),
            max_nodes=ag.config.plan_max_nodes,
        )
        self.assertIsNotNone(frontier)
        self.assertTrue(frontier.actions)
        # Fresh coverage: the batch opens NEW ground -> not fully covered.
        self.assertFalse(ag._frontier_fully_covered(frame, frontier))
        # Now seed coverage with exactly the player cells the batch would visit (level-keyed) -> the
        # batch is a pure re-sweep and the gate reports fully covered.
        level = frame.get("level")
        prev = ag._frame_grid(frame)
        for grid in frontier.predicted_grids:
            for r, (brow, arow) in enumerate(zip(prev, grid)):
                for c, (b, a) in enumerate(zip(brow, arow)):
                    if b != a:
                        ag._coverage_cells.add((level, r, c))
            prev = grid
        self.assertTrue(ag._frontier_fully_covered(frame, frontier))

    def test_bump_first_trips_plateau_on_resumed_coverage(self):
        # Run-21: with resumed coverage (coverage_resumed_pct > 0) covering the frontier region, the
        # FIRST frontier batch is skipped in favour of bump discovery — the loop hands off immediately
        # instead of re-sweeping. Assert a bump fires without first burning a redundant frontier batch.
        env = PushBlockEnv()
        ag = self._trusted_agent(env, PUSHBLOCK_MODEL_SOURCE, max_turns=12)
        frame = env.observe()
        from bench.arc_agi3_zonoid.ewm.planner import explore_frontier

        frontier = explore_frontier(
            ag.program, ag._frame_grid(frame),
            max_depth=min(ag.config.frontier_max_depth, ag.config.plan_max_depth),
            max_nodes=ag.config.plan_max_nodes,
        )
        # Simulate a resume that already swept the whole frontier region.
        ag.summary.coverage_resumed_pct = 0.5
        level = frame.get("level")
        prev = ag._frame_grid(frame)
        for grid in frontier.predicted_grids:
            for r, (brow, arow) in enumerate(zip(prev, grid)):
                for c, (b, a) in enumerate(zip(brow, arow)):
                    if b != a:
                        ag._coverage_cells.add((level, r, c))
            prev = grid
        self.assertEqual(ag.summary.frontier_batches, 0)
        ag._frontier_execute(frame)
        # Bump-first: no redundant frontier batch was recorded before the discovery handoff.
        self.assertEqual(ag.summary.frontier_batches, 0)
        self.assertGreaterEqual(ag.summary.bumps_probed, 1)


# Movement-only model for the multi-block quota env: the avatar (2) translates on background (0);
# every non-zero, non-avatar color (blocks 4,5,6,7) is an impassable static — ls20-shaped (only the
# four translations are valid, so the non-movement vocabulary is empty and interaction discovery
# falls through to BUMP PROBES). The model does NOT know bumping does anything (a no-op wall to it),
# so the quota interleave is the ONLY thing that fires contact bumps.
QUOTA_MODEL_SOURCE = '''
import copy

AVATAR = 2
DELTAS = {"UP": (-1, 0), "DOWN": (1, 0), "LEFT": (0, -1), "RIGHT": (0, 1)}


def init_state(frame):
    rows = len(frame)
    cols = len(frame[0]) if rows else 0
    avatar = None
    statics = {}
    for r in range(rows):
        for c in range(cols):
            v = frame[r][c]
            if v == AVATAR:
                avatar = (r, c)
            elif v != 0:
                statics[(r, c)] = v
    return {"avatar": avatar, "statics": statics, "rows": rows, "cols": cols}


def legal_actions(state):
    return ["UP", "DOWN", "LEFT", "RIGHT"]


def step(state, action):
    state = copy.deepcopy(state)
    if action not in DELTAS:
        return state, {"moved": False}
    dr, dc = DELTAS[action]
    r, c = state["avatar"]
    nr, nc = r + dr, c + dc
    blocked = (nr, nc) in state["statics"]
    if 0 <= nr < state["rows"] and 0 <= nc < state["cols"] and not blocked:
        state["avatar"] = (nr, nc)
    return state, {"moved": state["avatar"] == (nr, nc)}


def render(state):
    rows, cols = state["rows"], state["cols"]
    grid = [[0 for _ in range(cols)] for _ in range(rows)]
    for (r, c), v in state["statics"].items():
        grid[r][c] = v
    ar, ac = state["avatar"]
    grid[ar][ac] = AVATAR
    return grid


def is_win(state):
    return False
'''


class _QuotaMultiBlockEnv:
    """A wide OPEN board whose movement frontier NEVER plateaus within a short budget (every batch
    reaches fresh cells) yet also carries several DISTINCT-color bumpable blocks (Run-22).

    This is the Run-21 pathology in miniature: with only the exhaustion/plateau handoff, bumps would
    NEVER fire because the frontier keeps finding new ground. With the bump QUOTA interleave, contact
    bumps must fire from the start. Each block is a solid wall to BOTH the env and the model, so a bump
    is a pure no-op on the board (the run never ends) and the four distinct block colors give four
    dedup-distinct bump targets so bumps keep firing across passes."""

    ACTIONS = ["UP", "DOWN", "LEFT", "RIGHT"]

    def __init__(self, budget: int = 200) -> None:
        # 3x12 open corridor: avatar at (0,0) with a long clear row0 to sweep (frontier never
        # plateaus in-budget), and four distinct-color single-cell blocks parked in row2 with empty
        # approach cells in row1 above each, so each is reachable AND bumpable.
        self._rows, self._cols = 3, 12
        self._avatar = (0, 0)
        # color -> cell; distinct colors => distinct (translation-invariant) object hashes.
        self._blocks = {(2, 2): 4, (2, 5): 5, (2, 8): 6, (2, 10): 7}
        self.remaining_actions = budget
        self.act_calls = 0
        self._level = 1

    def _grid(self):
        grid = [[0] * self._cols for _ in range(self._rows)]
        for (r, c), color in self._blocks.items():
            grid[r][c] = color
        grid[self._avatar[0]][self._avatar[1]] = 2
        return grid

    def observe(self):
        return {
            "grid": self._grid(),
            "level": self._level,
            "step": 0,
            "valid_actions": list(self.ACTIONS),
            "score": 0,
            "remaining_actions": self.remaining_actions,
        }

    def _apply_one(self, action: str) -> None:
        dr, dc = DELTAS[action]
        ar, ac = self._avatar
        nr, nc = ar + dr, ac + dc
        if not (0 <= nr < self._rows and 0 <= nc < self._cols):
            return
        if (nr, nc) in self._blocks:
            return  # blocks are solid to the avatar (a bump is a pure no-op)
        self._avatar = (nr, nc)

    def act(self, actions, expect=None):
        self.act_calls += 1
        executed = []
        stop_reason = "completed"
        for index, action in enumerate(actions):
            name = action.get("action") if isinstance(action, dict) else action
            self.remaining_actions = max(0, self.remaining_actions - 1)
            self._apply_one(str(name))
            executed.append(name)
            after = self._grid()
            if expect is not None and index < len(expect) and expect[index] is not None:
                if not grids_match([list(r) for r in expect[index]], after):
                    stop_reason = "expect_mismatch"
                    break
        frame = {"grid": self._grid(), "level": self._level, "step": 0, "score": 0}
        return {
            "current_frame": frame,
            "action_result": {"score": 0, "done": False},
            "valid_actions": list(self.ACTIONS),
            "remaining_actions": self.remaining_actions,
            "executed": executed,
            "stop_reason": stop_reason,
            "done": False,
        }


class BumpQuotaInterleaveTests(unittest.TestCase):
    """Run-22: contact bump probing is a FIRST-CLASS budget quota interleaved from action 1, not an
    exhaustion-gated fallback. ~``bump_quota_fraction`` of executed exploration actions are bumps, with
    a ``exploration_min_bump_actions`` guaranteed floor under a tight budget."""

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _trusted_agent(self, env, source, **cfg):
        from bench.arc_agi3_zonoid.ewm.world_model import WorldModelProgram

        EwmAgent._vision_available = staticmethod(lambda: False)
        base = dict(
            game_id="quota", max_turns=40, min_probe_transitions=1,
            fast_path_trust_window=2, goal_discovery_min_live_samples=2,
            goal_discovery_min_live_rate=0.9, max_frontier_batches_per_turn=8,
            max_interaction_probes_per_turn=6, coverage_persistence=False,
        )
        base.update(cfg)
        ag = EwmAgent(env, FakeLlm([]), kb=FakeKb(max_writes_per_turn=8),
                      vision_enabled=False, config=AgentConfig(**base))
        ag.program = WorldModelProgram.load(source)
        ag._live_results.extend([True, True, True])
        ag._refresh_model_trust()
        return ag

    # -- quota decision (unit) --------------------------------------------------------------------

    def test_quota_due_at_start_min_bump_floor(self):
        # Before any bump fires (bumps_probed=0 < exploration_min_bump_actions) the quota is due from
        # action 1 — bump probing does NOT wait for a plateau.
        env = _QuotaMultiBlockEnv()
        ag = self._trusted_agent(env, QUOTA_MODEL_SOURCE, exploration_min_bump_actions=24)
        self.assertEqual(ag.summary.bumps_probed, 0)
        self.assertTrue(ag._bump_quota_due())

    def test_quota_due_tracks_ratio_once_floor_met(self):
        # Floor met (min=0). Below the 40% share -> due; at/above -> not due.
        env = _QuotaMultiBlockEnv()
        ag = self._trusted_agent(
            env, QUOTA_MODEL_SOURCE, exploration_min_bump_actions=0, bump_quota_fraction=0.4,
        )
        ag.summary.bumps_probed = 3      # 3 bumps vs 10 frontier => 3/13 ~= 0.23 < 0.4 -> due
        ag._explore_frontier_actions = 10
        self.assertTrue(ag._bump_quota_due())
        ag.summary.bumps_probed = 6      # 6 vs 6 => 0.5 >= 0.4 -> not due
        ag._explore_frontier_actions = 6
        self.assertFalse(ag._bump_quota_due())

    def test_quota_off_when_fraction_zero(self):
        env = _QuotaMultiBlockEnv()
        ag = self._trusted_agent(env, QUOTA_MODEL_SOURCE, bump_quota_fraction=0.0)
        self.assertFalse(ag._bump_quota_due())

    # -- interleave from action 1 (no plateau) ----------------------------------------------------

    def test_quota_fires_bump_on_the_very_first_batch(self):
        # The frontier NEVER plateaus on this open board (every batch reaches fresh cells), so the
        # Run-21 exhaustion gate would never hand off to bumps. The quota must still fire a contact bump
        # on the VERY FIRST exploration batch — before any frontier movement executes — proving bump
        # probing is a first-class quota, not an exhaustion-gated fallback.
        env = _QuotaMultiBlockEnv()
        ag = self._trusted_agent(env, QUOTA_MODEL_SOURCE, exploration_min_bump_actions=24)
        self.assertEqual(ag.summary.frontier_batches, 0)
        ag._explore_batch(env.observe())
        # The first batch was a BUMP batch: contact bumps fired and NO frontier movement ran yet.
        self.assertGreaterEqual(ag.summary.bumps_probed, 1)
        self.assertEqual(ag._explore_frontier_actions, 0)

    def test_quota_targets_forty_percent_share_while_targets_remain(self):
        # While fresh bump targets remain, the quota holds ~40% of executed exploration actions as
        # contact bumps: it keeps requesting a bump batch whenever the running share dips below the
        # fraction, and lets the frontier run only until the share is met again. We drive batches until
        # the block targets are exhausted (dedup) and assert the share stayed at/above the quota over
        # that window — the first-class 40% behaviour, independent of any plateau.
        env = _QuotaMultiBlockEnv()
        # One bump probe + one small frontier batch per pass so the interleave genuinely ALTERNATES
        # (bump, frontier, bump, ...) rather than firing every block in a single greedy bump batch —
        # this exercises the running-ratio scheduler, not just the min floor.
        ag = self._trusted_agent(
            env, QUOTA_MODEL_SOURCE, exploration_min_bump_actions=0,
            bump_quota_fraction=0.4, frontier_max_depth=3, bump_probe_repeats=1,
            max_interaction_probes_per_turn=1,
        )
        distinct_blocks = len(ag._bump_contexts(env._grid()))
        self.assertGreaterEqual(distinct_blocks, 4)
        # Drive exploration batches until every distinct block class has been bumped (targets drained).
        for _ in range(40):
            frame = env.observe()
            ag._explore_batch(frame)
            if ag.summary.bumps_probed >= distinct_blocks:
                break
        # All distinct block classes were bumped (the quota drained the available targets)...
        self.assertGreaterEqual(ag.summary.bumps_probed, distinct_blocks)
        # ...and over the window where targets existed, the bump share met/held the 40% quota (the
        # frontier was throttled to keep bumps a first-class ~40% share, not an incidental trickle).
        total = ag.summary.bumps_probed + ag._explore_frontier_actions
        self.assertGreater(total, 0)
        self.assertGreaterEqual(ag.summary.bumps_probed / total, 0.4)

    def test_min_bump_guarantee_under_tiny_budget(self):
        # A tiny action budget must STILL deliver the guaranteed bump floor rather than spending
        # everything on frontier movement: with min=4 and a small budget, bumps fire before the budget
        # is exhausted on frontier sweeps.
        env = _QuotaMultiBlockEnv(budget=24)
        ag = self._trusted_agent(env, QUOTA_MODEL_SOURCE, exploration_min_bump_actions=4,
                                 bump_quota_fraction=0.4, max_turns=30)
        ag.run()
        # The guarantee held: at least one contact bump fired under the tight budget (frontier did not
        # monopolise the whole budget as it did pre-Run-22).
        self.assertGreaterEqual(ag.summary.bumps_probed, 1)

    def test_dedup_respects_per_run_guard_on_quota_path(self):
        # The quota interleave shares the SAME per-run _bump_attempted dedup as the exhaustion path: a
        # block whose class THIS run already bumped is not re-bumped, even when the quota is due (Run-25
        # fix: dedup is per-run, not the persisted _fired_probes set).
        env = _QuotaMultiBlockEnv()
        ag = self._trusted_agent(env, QUOTA_MODEL_SOURCE, exploration_min_bump_actions=24)
        # Seed every block's object class as already bumped THIS run.
        contexts = ag._bump_contexts(env._grid())
        self.assertGreaterEqual(len(contexts), 1)
        for (obj_hash, _a, _b, _c) in contexts:
            ag._bump_attempted.add(obj_hash)
        before = ag.summary.bumps_probed
        # Quota is due, but every target is deduped -> _bump_discovery finds nothing new to bump and
        # the batch falls through to a frontier step (no new bump fired).
        self.assertTrue(ag._bump_quota_due())
        ag._explore_batch(env.observe())
        self.assertEqual(ag.summary.bumps_probed, before)

    def test_fired_bump_records_durable_object_identity(self):
        # Run-38 GAP-1 wiring: a FIRED bump must record its translation-invariant object_hash in
        # _fired_bump_objects (the set _persist_coverage writes as <bump> probe tokens). Run-37
        # fired 12 bumps yet the persisted note carried probes=[] — nothing wired the identities in.
        env = _QuotaMultiBlockEnv()
        ag = self._trusted_agent(env, QUOTA_MODEL_SOURCE, exploration_min_bump_actions=24)
        self.assertEqual(ag._fired_bump_objects, set())
        ag._explore_batch(env.observe())
        self.assertGreaterEqual(ag.summary.bumps_probed, 1)
        self.assertGreaterEqual(len(ag._fired_bump_objects), 1)
        # The recorded identity is the same durable key bump dedup uses (an attempted object hash).
        self.assertTrue(ag._fired_bump_objects <= ag._bump_attempted)

    def test_bump_contexts_order_resumed_probed_objects_last(self):
        # Run-38 GAP-1 resume side: objects a PRIOR run already bump-probed rank LAST in
        # _bump_contexts — untried objects first — but stay bumpable (prefer-not-exclude).
        env = _QuotaMultiBlockEnv()
        ag = self._trusted_agent(env, QUOTA_MODEL_SOURCE)
        contexts = ag._bump_contexts(env._grid())
        self.assertGreaterEqual(len(contexts), 2)
        cheapest = contexts[0][0]
        ag._resumed_bump_probes.add(cheapest)
        reordered = ag._bump_contexts(env._grid())
        # Still present (the board can change — a resumed-probed object is never excluded)...
        self.assertIn(cheapest, [c[0] for c in reordered])
        # ...but ranked last, behind every untried object.
        self.assertEqual(reordered[-1][0], cheapest)
        self.assertNotIn(cheapest, [c[0] for c in reordered[:-1]])
        # Untried objects keep their cheapest-first order among themselves.
        untried_costs = [c[3] for c in reordered[:-1]]
        self.assertEqual(untried_costs, sorted(untried_costs))


class MinBumpHoistTests(unittest.TestCase):
    """Run-32: the MIN-BUMP GUARANTEE is hoisted into the MAIN turn loop. Runs 31-32 fired ZERO bumps
    (bump_due_batches=0 despite 76 and 102 actions) because exploration only ran when a plan came back
    empty AND _goal_discovery_ready() held — a window ~97%-reactive runs never open. While the
    exploration_min_bump_actions floor is unmet, a reactive/RECOVER turn is spent on ONE exploration
    batch instead (with a 3-consecutive-empty-batch anti-spin standdown)."""

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _hoist_agent(self, env, **cfg):
        # Like BumpQuotaInterleaveTests._trusted_agent but WITHOUT trust/live-sample seeding: the
        # agent is deliberately NOT goal-discovery-ready, so pre-Run-32 the exploration entry point
        # (and therefore any bump) would never fire.
        from bench.arc_agi3_zonoid.ewm.world_model import WorldModelProgram

        EwmAgent._vision_available = staticmethod(lambda: False)
        base = dict(
            game_id="hoist", max_turns=6, min_probe_transitions=1,
            goal_discovery_min_live_samples=3, goal_discovery_min_live_rate=0.7,
            max_interaction_probes_per_turn=6, coverage_persistence=False,
            bump_probe_repeats=1,
        )
        base.update(cfg)
        ag = EwmAgent(env, FakeLlm([]), kb=FakeKb(max_writes_per_turn=8),
                      vision_enabled=False, config=AgentConfig(**base))
        ag.program = WorldModelProgram.load(QUOTA_MODEL_SOURCE)
        return ag

    def test_hoist_fires_bumps_without_goal_discovery_window(self):
        # THE run-31/32 regression shape: program adopted, a NON-EMPTY plan available (so the
        # plan-empty exploration gate never opens), goal discovery NOT ready (zero live samples),
        # and every turn reactive (RECOVER). Pre-fix this run fires zero bumps; the hoist must spend
        # those reactive turns on exploration batches and increment bumps_probed.
        env = _QuotaMultiBlockEnv(budget=40)
        ag = self._hoist_agent(env, exploration_min_bump_actions=4, max_turns=4)
        # A goal-contact predicate the planner can reach -> _plan is NON-EMPTY, so the old
        # plan-empty + goal-discovery-ready window can never be the exploration entry point here.
        ag._goal_predicate = lambda state: state.get("avatar") == (0, 3)
        plan_result = ag._plan(env.observe())
        self.assertTrue(plan_result is not None and plan_result.actions,
                        "the plan must be NON-EMPTY for the regression shape")
        self.assertFalse(ag._goal_discovery_ready())
        self.assertEqual(ag.summary.bumps_probed, 0)
        ag._failure_cycles = ag.config.reactive_after_failures  # the ~97%-reactive shape (RECOVER)
        ag.run()
        self.assertGreaterEqual(
            ag.summary.hoisted_bump_batches, 1,
            "a reactive turn under the min-bump floor must be spent on a hoisted exploration batch",
        )
        self.assertGreaterEqual(
            ag.summary.bumps_probed, 1,
            "the hoisted batch must actually fire contact bumps (run-31/32: bumps stuck at 0)",
        )

    def test_no_bump_hoist_once_min_bump_floor_met_frontier_continues(self):
        # bumps_probed >= exploration_min_bump_actions -> the bump guarantee is honored, so no BUMP
        # hoist fires. Run-38: the hoist does NOT stand down — it continues as FRONTIER batches so
        # coverage keeps growing (run-37: coverage froze at 13.01% with frontier_batches=0 because
        # hoisting stopped entirely at the floor).
        env = _QuotaMultiBlockEnv(budget=30)
        ag = self._hoist_agent(env, exploration_min_bump_actions=4, max_turns=3)
        ag.summary.bumps_probed = 4  # floor already met
        ag._failure_cycles = ag.config.reactive_after_failures
        ag.run()
        self.assertEqual(ag.summary.hoisted_bump_batches, 0)
        self.assertGreaterEqual(ag.summary.hoisted_frontier_batches, 1)

    def test_hoist_transitions_to_frontier_once_floor_met(self):
        # Run-38 GAP-2 unit shape: floor met -> the hoisted batch is dispatched through
        # _explore_batch, whose quota (ratio 4/4 >= 0.4 -> not due) falls through to
        # _frontier_execute. The hoist counts a FRONTIER batch, not a bump batch.
        env = _QuotaMultiBlockEnv(budget=60)
        ag = self._hoist_agent(env, exploration_min_bump_actions=4)
        ag.summary.bumps_probed = 4  # floor met, no frontier actions yet -> quota not due
        self.assertIsNotNone(ag._hoist_bump_batch(env.observe()))
        self.assertEqual(ag.summary.hoisted_bump_batches, 0)
        self.assertEqual(ag.summary.hoisted_frontier_batches, 1)
        self.assertEqual(ag.summary.frontier_batches, 1)

    def test_frontier_anti_spin_stands_down_after_three_zero_growth_batches(self):
        # Run-38: 3 consecutive hoisted FRONTIER batches with ZERO coverage growth stand the
        # frontier hoist down (mirror of the bump anti-spin); ANY coverage growth re-arms it.
        env = _QuotaMultiBlockEnv(budget=400)
        ag = self._hoist_agent(env, exploration_min_bump_actions=0, bump_quota_fraction=0.0)
        # Pre-cover the whole level-1 board so no frontier batch can grow coverage.
        grid = env._grid()
        for r in range(len(grid)):
            for c in range(len(grid[0])):
                ag._coverage_cells.add((1, r, c))
        # Dedup every block class: the plateaued frontier's interaction-discovery handoff would
        # otherwise fire bumps, which count as progress (a batch that fires a bump must not advance
        # the frontier standdown) and would legitimately defer the guard.
        for (obj_hash, _approach, _direction, _cost) in ag._bump_contexts(grid):
            ag._bump_attempted.add(obj_hash)
        for _ in range(3):
            self.assertIsNotNone(ag._hoist_bump_batch(env.observe()))
        self.assertEqual(ag.summary.hoisted_frontier_batches, 3)
        self.assertEqual(ag.summary.hoisted_bump_batches, 0)
        # Guard tripped: the next turn must NOT hoist (the normal reactive path runs instead).
        self.assertIsNone(ag._hoist_bump_batch(env.observe()))
        self.assertEqual(ag.summary.hoisted_frontier_batches, 3)
        # ANY coverage growth (a planned/reactive batch reached new ground) re-arms the hoist.
        ag._coverage_cells.add((2, 0, 0))
        self.assertIsNotNone(ag._hoist_bump_batch(env.observe()))
        self.assertEqual(ag.summary.hoisted_frontier_batches, 4)

    def test_anti_spin_guard_stands_down_after_three_empty_batches(self):
        # Three consecutive hoisted batches that fire NO bump trip the BUMP standdown. Run-38: bump
        # exhaustion no longer stops hoisting entirely — the hoist TRANSITIONS to FRONTIER batches
        # (coverage growth). ANY fired bump re-arms the bump phase.
        env = _QuotaMultiBlockEnv(budget=200)
        ag = self._hoist_agent(env, exploration_min_bump_actions=8)
        # Dedup every block class so each hoisted batch fires nothing (falls through to frontier).
        for (obj_hash, _approach, _direction, _cost) in ag._bump_contexts(env._grid()):
            ag._bump_attempted.add(obj_hash)
        for _ in range(3):
            self.assertIsNotNone(ag._hoist_bump_batch(env.observe()))
        self.assertEqual(ag.summary.bumps_probed, 0)
        self.assertEqual(ag.summary.hoisted_bump_batches, 3)
        # Bump guard tripped: the next hoist is a FRONTIER batch, not a bump batch (Run-38 — the
        # pre-fix behavior returned None here and coverage froze).
        self.assertIsNotNone(ag._hoist_bump_batch(env.observe()))
        self.assertEqual(ag.summary.hoisted_bump_batches, 3)
        self.assertEqual(ag.summary.hoisted_frontier_batches, 1)
        # A fired bump (e.g. from the goal-discovery exploration path) re-arms the BUMP phase.
        ag.summary.bumps_probed += 1
        self.assertIsNotNone(ag._hoist_bump_batch(env.observe()))
        self.assertEqual(ag.summary.hoisted_bump_batches, 4)

    def test_done_or_out_of_budget_never_hoists(self):
        # A done frame or an exhausted budget must never be spent on a hoisted batch.
        env = _QuotaMultiBlockEnv(budget=40)
        ag = self._hoist_agent(env, exploration_min_bump_actions=4)
        done_frame = dict(env.observe())
        done_frame["done"] = True
        self.assertIsNone(ag._hoist_bump_batch(done_frame))
        broke_frame = dict(env.observe())
        broke_frame["remaining_actions"] = 0
        self.assertIsNone(ag._hoist_bump_batch(broke_frame))
        self.assertEqual(ag.summary.hoisted_bump_batches, 0)
        # The FRONTIER phase (Run-38, floor met) is gated identically: done/budget frames never hoist.
        ag3 = self._hoist_agent(env, exploration_min_bump_actions=0)
        self.assertIsNone(ag3._hoist_bump_batch(done_frame))
        self.assertIsNone(ag3._hoist_bump_batch(broke_frame))
        self.assertEqual(ag3.summary.hoisted_frontier_batches, 0)
        # And end-to-end: a run that opens out of budget stops before any hoist.
        env2 = _QuotaMultiBlockEnv(budget=0)
        ag2 = self._hoist_agent(env2, exploration_min_bump_actions=4, max_turns=3)
        ag2._failure_cycles = ag2.config.reactive_after_failures
        ag2.run()
        self.assertEqual(ag2.summary.hoisted_bump_batches, 0)
        self.assertEqual(ag2.summary.hoisted_frontier_batches, 0)


# ls20-COLORED variants (Run-23): the LIVE player renders as color 12, NOT the toy avatar color 2.
# The Run-17..22 live silent-drop was that _player_position hardcoded color 2, so on the live board it
# returned None, _bump_contexts was empty, and the bump quota fired 0 bumps SILENTLY while every
# color-2 toy test above stayed green. These recolored copies reproduce that exact live condition.
LS20_COLORED_QUOTA_MODEL_SOURCE = QUOTA_MODEL_SOURCE.replace("AVATAR = 2", "AVATAR = 12")


class _Ls20ColoredQuotaEnv(_QuotaMultiBlockEnv):
    """The quota env with the avatar rendered as color 12 (the real ls20 player color) instead of 2 —
    everything else identical. On this board the OLD color-2 _player_position finds no player and bumps
    silently never fire; the Run-23 model-agnostic inference must find the color-12 player and bump."""

    def _grid(self):
        grid = [[0] * self._cols for _ in range(self._rows)]
        for (r, c), color in self._blocks.items():
            grid[r][c] = color
        grid[self._avatar[0]][self._avatar[1]] = 12  # player is color 12, not 2
        return grid


class PlayerColorInferenceTests(unittest.TestCase):
    """Run-23 regression: the live wiring gap. The player is inferred from the ACTIVE program, not a
    hardcoded color 2, so a non-color-2 live player (ls20 is {9,12}) is found and bumps fire."""

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _trusted_agent(self, env, source, **cfg):
        from bench.arc_agi3_zonoid.ewm.world_model import WorldModelProgram

        EwmAgent._vision_available = staticmethod(lambda: False)
        base = dict(
            game_id="ls20color", max_turns=40, min_probe_transitions=1,
            fast_path_trust_window=2, goal_discovery_min_live_samples=2,
            goal_discovery_min_live_rate=0.9, max_frontier_batches_per_turn=8,
            max_interaction_probes_per_turn=6, coverage_persistence=False,
        )
        base.update(cfg)
        ag = EwmAgent(env, FakeLlm([]), kb=FakeKb(max_writes_per_turn=8),
                      vision_enabled=False, config=AgentConfig(**base))
        ag.program = WorldModelProgram.load(source)
        ag._live_results.extend([True, True, True])
        ag._refresh_model_trust()
        return ag

    def test_player_color_inferred_from_program_not_hardcoded_two(self):
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE)
        colors = ag._player_color_set()
        # The inference derives the player color from the program's own render — 12, not the old 2.
        self.assertIn(12, colors)
        self.assertNotIn(2, colors)

    def test_player_position_found_on_non_color_two_board(self):
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE)
        grid = env._grid()
        pos = ag._player_position(grid)
        # The OLD color-2 scan would return None here (no color-2 cell) — the silent-drop root cause.
        self.assertIsNotNone(pos)
        self.assertEqual(grid[pos[0]][pos[1]], 12)

    def test_bump_contexts_nonempty_on_non_color_two_board(self):
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE)
        contexts = ag._bump_contexts(env._grid())
        # With the player found, the distinct-color blocks yield bump contexts (was [] with color-2).
        self.assertGreaterEqual(len(contexts), 1)

    def test_bumps_fire_live_on_non_color_two_player(self):
        # THE end-to-end regression: on an ls20-colored board (player 12), the quota interleave actually
        # FIRES contact bumps — the live pathology (bumps_probed=0) is closed.
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE,
                                 exploration_min_bump_actions=24, max_turns=30)
        out = ag.run()
        self.assertGreaterEqual(out["bumps_probed"], 1)
        # The config echo surfaces the effective knobs AND the inferred player color (12), so a future
        # regression to color 2 is visible in the summary, not silent.
        echo = out.get("config_echo")
        self.assertIsNotNone(echo)
        self.assertTrue(echo["bump_probes"])
        self.assertIn(12, echo["player_colors"])

    def test_bumps_fire_despite_persisted_bump_dedup(self):
        # Run-25 regression: a FRESH game instance whose persisted probe state ALREADY contains every
        # current-frame object's <bump> key must STILL fire bumps. object_hashes are translation-invariant,
        # so ls20 objects match across runs — routing bump dedup through the persisted _fired_probes set
        # permanently suppressed bumps in ALL future runs (bump_due_batches>0 but bumps_probed=0). Bump
        # discovery is now PER-RUN (self._bump_attempted), so the persisted keys no longer gate.
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE)
        # Seed the PERSISTED-style set with the <bump> key of EVERY distinct current-frame object class,
        # exactly as a prior run's resumed coverage note would. On the OLD code this suppressed all bumps.
        contexts = ag._bump_contexts(env._grid())
        self.assertGreaterEqual(len(contexts), 1)
        for (obj_hash, _a, _b, _c) in contexts:
            ag._fired_probes.add((ag._BUMP_MARKER, obj_hash))
        before = ag.summary.bumps_probed
        ag._bump_discovery(env.observe())
        # The fresh per-run guard was empty, so bumps fired despite the persisted dedup.
        self.assertGreater(ag.summary.bumps_probed, before)

    def test_player_color_inference_survives_unknown_rendering_program(self):
        # Run-23 LIVE finding: the real ls20 dev program renders EVERYTHING except the player as the
        # UNKNOWN sentinel, so the moving-cell diff contains UNKNOWN values. int(UNKNOWN) raising out
        # of the color-collection loop discarded the WHOLE color set and fell back to {2} live
        # (player_colors=[2] in the run-23 summary). The per-cell guard must keep the int colors
        # (9/12-style) and skip only the UNKNOWN cells.
        unknown_src = LS20_COLORED_QUOTA_MODEL_SOURCE.replace(
            "grid = [[0 for _ in range(cols)] for _ in range(rows)]",
            "grid = [[UNKNOWN for _ in range(cols)] for _ in range(rows)]",
        )
        self.assertIn("UNKNOWN", unknown_src)  # the substitution took (render is all-UNKNOWN + player)
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, unknown_src)
        colors = ag._player_color_set()
        # The avatar color 12 survives; the UNKNOWN background cells are skipped, not fatal.
        self.assertIn(12, colors)
        self.assertNotIn(2, colors)

    def test_bump_skip_reason_records_no_player_when_player_absent(self):
        # Silent-drop guard: if the player genuinely cannot be found, _bump_discovery records WHY rather
        # than returning None invisibly. Simulate the old pathology by forcing the color set to {2} on a
        # board that has no color-2 cell.
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE)
        ag._player_colors = frozenset({2})  # pin the OLD hardcoded color
        ag._player_colors_for = ag.program
        result = ag._bump_discovery(env.observe())
        self.assertIsNone(result)
        self.assertIsNotNone(ag.summary.bump_skip_reason)
        self.assertIn("no player cell", ag.summary.bump_skip_reason)

    def test_empirical_walk_converges_despite_mispredicting_model(self):
        # Run-27 LIVE finding (successor to the Run-26 single-retry test): the adopted ls20 program
        # SYSTEMATICALLY mispredicts the player mover, so the retry walk also diverged and bumps
        # still never fired (run-27: both due batches ended "approach walk aborted before bump
        # (diverged)"). The approach walk is now EMPIRICAL — act one step, observe, re-plan from the
        # REAL frame, no expect gating — so a model whose player drifts off the plan EVERY step
        # still converges by correction and the bump fires.
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE,
                                 max_interaction_probes_per_turn=1)

        class _Plan:
            def __init__(self, actions):
                self.actions = list(actions)

        # Pre-check plan, then per-step re-plans: the player lands off-plan each step, so every
        # re-plan still sees work to do until the walk finally converges (empty plan = arrived).
        plans = iter([_Plan(["UP", "UP"]), _Plan(["UP", "UP"]), _Plan(["UP"]), _Plan([])])
        ag._plan_to_cell = lambda frame, target: next(plans)
        before = ag.summary.bumps_probed
        result = ag._bump_discovery(env.observe())
        self.assertIsNotNone(result)
        self.assertGreater(ag.summary.bumps_probed, before)  # _fire_bump ran after arrival
        self.assertIsNone(ag.summary.bump_skip_reason)  # a bump fired: no skip reason left behind
        self.assertGreater(ag.summary.approach_retries, 0)  # the per-step re-plans were counted

    def test_empirical_walk_unreachable_unpoisons_and_records_reason(self):
        # Run-27: a mid-walk re-plan that finds NO path from where the player REALLY is skips the
        # object with a reason and un-poisons the per-run dedup (same guarantee as the old Run-26
        # retry-unreachable path). The state is captured at the NEXT pre-check: being re-handed the
        # FIRST object's approach cell proves the discard un-poisoned it (a poisoned object is
        # never re-picked).
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE)
        contexts = ag._bump_contexts(env._grid())
        self.assertGreaterEqual(len(contexts), 1)
        first_approach = contexts[0][1]

        class _Plan:
            def __init__(self, actions):
                self.actions = list(actions)

        calls = {"n": 0}
        seen: dict[str, object] = {}

        def _plan(frame, target):
            calls["n"] += 1
            if calls["n"] == 1:
                return _Plan(["UP"])  # pre-check: the model claims a path exists
            if calls["n"] == 2:
                return None  # the walk's own re-plan: unreachable from the real position
            seen.setdefault("reason", ag.summary.bump_skip_reason)
            seen.setdefault("target", target)
            return None  # poison the remaining objects so the loop drains and exits

        ag._plan_to_cell = _plan
        before = ag.summary.bumps_probed
        ag._bump_discovery(env.observe())
        self.assertEqual(ag.summary.bumps_probed, before)  # no bump fired
        self.assertIn("unreachable", str(seen["reason"]))
        self.assertIn("empirical walk", str(seen["reason"]))
        self.assertEqual(seen["target"], first_approach)  # the un-poisoned object was re-picked

    def test_empirical_walk_done_or_budget_mid_walk_aborts_and_unpoisons(self):
        # Run-25 guarantee under Run-27 semantics: a walk that ends the episode (done) or drains
        # the budget before any bump fires must abort WITH a recorded cause and un-poison the
        # per-run dedup so the next due batch can retry the never-bumped object. The abort returns
        # `last`, which may be None — the caller treats None as fall-through to the frontier.
        class _Plan:
            actions = ["UP"]

        for cause, rig in (
            ("done", lambda env, ag: setattr(
                ag, "_observe", lambda: {**env.observe(), "done": True})),
            ("out of budget", lambda env, ag: setattr(env, "remaining_actions", 1)),
        ):
            with self.subTest(cause=cause):
                env = _Ls20ColoredQuotaEnv()
                ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE)
                rig(env, ag)
                ag._plan_to_cell = lambda frame, target: _Plan()
                before = ag.summary.bumps_probed
                result = ag._bump_discovery(env.observe())
                self.assertIsNone(result)  # no bump fired: None falls through to the frontier
                self.assertEqual(ag.summary.bumps_probed, before)
                self.assertIsNotNone(ag.summary.bump_skip_reason)
                self.assertIn("approach walk aborted before bump", ag.summary.bump_skip_reason)
                self.assertIn(cause, ag.summary.bump_skip_reason)
                self.assertEqual(ag._bump_attempted, set())

    def test_empirical_walk_never_converging_chase_hits_step_cap(self):
        # Run-27 boundary: with no expect gating, the only way an approach walk can spin forever is
        # a chase that never converges (the plan never comes back empty). The step cap (2*plan+2)
        # bounds it, aborting with a cause and un-poisoning the dedup like every other abort.
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE)

        class _Plan:
            actions = ["UP", "UP"]

        ag._plan_to_cell = lambda frame, target: _Plan()  # always two steps to go: never converges
        before = ag.summary.bumps_probed
        result = ag._bump_discovery(env.observe())
        self.assertIsNone(result)  # no bump fired: None falls through to the frontier
        self.assertEqual(ag.summary.bumps_probed, before)
        self.assertIsNotNone(ag.summary.bump_skip_reason)
        self.assertIn("approach walk aborted before bump", ag.summary.bump_skip_reason)
        self.assertIn("step cap", ag.summary.bump_skip_reason)
        self.assertEqual(ag._bump_attempted, set())
        self.assertGreater(ag.summary.approach_retries, 0)


# ---------------------------------------------------------------------------------------------------
# Run-27 STRIDE-AGNOSTIC CONTACT DISCOVERY
# ---------------------------------------------------------------------------------------------------

# A STRIDE-2 mover model: the avatar (2) translates TWO cells per action (ls20-shaped: ls20's player
# moves ±5 per the adopted program). The target (3) is WALKABLE — the model steps the avatar over it
# (it does not know crossing the target wins; that is the positional win discovery must find). Only the
# four translations are legal, so the non-movement vocabulary is EMPTY and interaction discovery falls
# through to CONTACT probes — which must be STRIDE-aware to ever reach an odd-parity target the mover
# can only CROSS, never land adjacent to.
STRIDE2_MODEL_SOURCE = '''
import copy

AVATAR = 2
STRIDE = 2
DELTAS = {"UP": (-1, 0), "DOWN": (1, 0), "LEFT": (0, -1), "RIGHT": (0, 1)}


def init_state(frame):
    rows = len(frame)
    cols = len(frame[0]) if rows else 0
    avatar = None
    statics = {}
    for r in range(rows):
        for c in range(cols):
            v = frame[r][c]
            if v == AVATAR:
                avatar = (r, c)
            elif v != 0:
                statics[(r, c)] = v
    return {"avatar": avatar, "statics": statics, "rows": rows, "cols": cols}


def legal_actions(state):
    return ["UP", "DOWN", "LEFT", "RIGHT"]


def step(state, action):
    state = copy.deepcopy(state)
    if action not in DELTAS:
        return state, {"moved": False}
    dr, dc = DELTAS[action]
    r, c = state["avatar"]
    nr, nc = r + dr * STRIDE, c + dc * STRIDE
    # Walls (1) block; the target (3) is walkable (the avatar drives over/through it).
    blocked = state["statics"].get((nr, nc)) == 1
    if 0 <= nr < state["rows"] and 0 <= nc < state["cols"] and not blocked:
        state["avatar"] = (nr, nc)
    return state, {"moved": state["avatar"] == (nr, nc)}


def render(state):
    rows, cols = state["rows"], state["cols"]
    grid = [[0 for _ in range(cols)] for _ in range(rows)]
    for (r, c), v in state["statics"].items():
        grid[r][c] = v
    ar, ac = state["avatar"]
    grid[ar][ac] = AVATAR
    return grid


def is_win(state):
    return False
'''


class Stride2CrossEnv:
    """A STRIDE-2 toy whose WIN needs the mover to CROSS a target it can NEVER land adjacent to. The
    avatar (2) starts at (0,0) and moves TWO cells per action, so it only ever occupies EVEN columns —
    a sparse lattice {(0,0),(0,2),(0,4),(0,6)}. The target (3) sits on ODD column (0,3): unit-step
    adjacency probing plans onto a distance-1 cell then steps in, but the mover can occupy NEITHER
    (0,2)-then-step-1 nor (0,4)-then-step-1 to land on (0,3) — a distance-1 approach cell is off the
    lattice. Only the STRIDE-2 move (0,2)->(0,4), whose swept path crosses (0,3), reaches the target;
    crossing it clears the level (``level_transition``). Movement alone never wins (the model does not
    know the crossing wins), so the contact probe must be stride-aware."""

    ACTIONS = ["UP", "DOWN", "LEFT", "RIGHT"]

    def __init__(self, budget: int = 200) -> None:
        self._rows, self._cols = 1, 7
        self._avatar = (0, 0)
        self._target = (0, 3)   # ODD column -> off the even-parity movement lattice
        self._solved = False
        self.remaining_actions = budget
        self.act_calls = 0
        self._level = 1

    def _grid(self):
        grid = [[0] * self._cols for _ in range(self._rows)]
        if not self._solved:
            grid[self._target[0]][self._target[1]] = 3
        grid[self._avatar[0]][self._avatar[1]] = 2
        return grid

    def observe(self):
        return {
            "grid": self._grid(),
            "level": self._level,
            "step": 0,
            "valid_actions": list(self.ACTIONS),
            "score": 1 if self._solved else 0,
            "remaining_actions": self.remaining_actions,
        }

    def _apply_one(self, action: str) -> bool:
        dr, dc = DELTAS[action]
        ar, ac = self._avatar
        nr, nc = ar + dr * 2, ac + dc * 2  # STRIDE 2
        if not (0 <= nr < self._rows and 0 <= nc < self._cols):
            return False
        # The swept path of this stride-2 move (the cells crossed, destination inclusive).
        step_r = (dr > 0) - (dr < 0)
        step_c = (dc > 0) - (dc < 0)
        swept = [(ar + step_r * k, ac + step_c * k) for k in (1, 2)]
        self._avatar = (nr, nc)
        if not self._solved and self._target in swept:
            # The mover CROSSED the target -> level solved (a positional/crossing win).
            self._solved = True
            return True
        return False

    def act(self, actions, expect=None):
        self.act_calls += 1
        executed = []
        stop_reason = "completed"
        for index, action in enumerate(actions):
            name = action.get("action") if isinstance(action, dict) else action
            self.remaining_actions = max(0, self.remaining_actions - 1)
            solved_now = self._apply_one(str(name))
            executed.append(name)
            after = self._grid()
            if expect is not None and index < len(expect) and expect[index] is not None:
                if not grids_match([list(r) for r in expect[index]], after):
                    stop_reason = "expect_mismatch"
                    break
            if solved_now:
                stop_reason = "level_transition"
                self._level += 1
                break
        frame = {"grid": self._grid(), "level": self._level, "step": 0,
                 "score": 1 if self._solved else 0}
        return {
            "current_frame": frame,
            "action_result": {"score": 1 if self._solved else 0, "done": False},
            "valid_actions": list(self.ACTIONS),
            "remaining_actions": self.remaining_actions,
            "executed": executed,
            "stop_reason": stop_reason,
            "done": False,
        }


class StrideAgnosticContactTests(unittest.TestCase):
    """Run-27: contact probing is the game's OWN movement geometry, not hardcoded unit-step adjacency.
    A STRIDE-2 mover infers stride=2, redefines contact as a move whose swept path CROSSES an object,
    reaches an odd-parity target it can never stand adjacent to, and detects the crossing win. The OLD
    unit-step code returns 0 probes on this toy (regression guard); stride-1 reduces to old behavior."""

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _trusted_agent(self, env, source, **cfg):
        from bench.arc_agi3_zonoid.ewm.world_model import WorldModelProgram

        EwmAgent._vision_available = staticmethod(lambda: False)
        base = dict(
            game_id="stride2", max_turns=40, min_probe_transitions=1,
            fast_path_trust_window=2, goal_discovery_min_live_samples=2,
            goal_discovery_min_live_rate=0.9, max_frontier_batches_per_turn=8,
            max_interaction_probes_per_turn=6, coverage_persistence=False,
        )
        base.update(cfg)
        ag = EwmAgent(env, FakeLlm([]), kb=FakeKb(max_writes_per_turn=8),
                      vision_enabled=False, config=AgentConfig(**base))
        ag.program = WorldModelProgram.load(source)
        ag._live_results.extend([True, True, True])
        ag._refresh_model_trust()
        return ag

    def test_stride_inferred_as_two_from_model(self):
        env = Stride2CrossEnv()
        ag = self._trusted_agent(env, STRIDE2_MODEL_SOURCE)
        self.assertEqual(ag._movement_stride(env.observe()), 2)
        # The reachable lattice is the sparse even-column set, NOT every cell.
        lattice = ag._reachable_player_cells(env.observe())
        self.assertEqual(lattice, {(0, 0), (0, 2), (0, 4), (0, 6)})

    def test_target_off_lattice_is_unreachable_by_landing(self):
        # The odd-column target can never be LANDED on: it is off the even-parity movement lattice, so
        # a unit-step "plan onto the cell" strategy has no cell to plan to.
        env = Stride2CrossEnv()
        ag = self._trusted_agent(env, STRIDE2_MODEL_SOURCE)
        self.assertIsNone(ag._plan_to_cell(env.observe(), env._target))

    def test_contact_context_is_stride_aware_crossing_probe(self):
        env = Stride2CrossEnv()
        ag = self._trusted_agent(env, STRIDE2_MODEL_SOURCE)
        contexts = ag._bump_contexts(env._grid())
        # The target (3) yields a contact context whose bump direction is the STRIDE-2 delta (0, +2)
        # from lattice cell (0, 2) — the move whose swept path crosses the odd-parity target.
        self.assertGreaterEqual(len(contexts), 1)
        by_dir = {bump: approach for (_h, approach, bump, _c) in contexts}
        self.assertIn((0, 2), by_dir)
        self.assertEqual(by_dir[(0, 2)], (0, 2))

    def test_stride2_crossing_solved_end_to_end(self):
        env = Stride2CrossEnv()
        ag = self._trusted_agent(env, STRIDE2_MODEL_SOURCE)
        out = ag.run()
        # The stride-aware contact probe fired, crossed the target, and the crossing cleared the level.
        self.assertEqual(out["movement_stride"], 2)
        self.assertGreaterEqual(out["contact_probes_probed"], 1)
        self.assertGreaterEqual(out["contact_probes_found"], 1)
        self.assertTrue(out["level_boundary_captured"])

    def test_old_unit_step_contexts_return_zero_probes_on_stride2_toy(self):
        # REGRESSION GUARD: the OLD unit-step contact code (approach = empty cell orthogonally ADJACENT
        # to the object, bump direction = UNIT delta from the approach cell toward the object) fires 0
        # probes on this toy. The odd-column target's only empty neighbors are (0,2)/(0,4); the old code
        # would plan onto one and then fire a UNIT bump (0,1)/(0,-1) INTO the target — but a STRIDE-2
        # mover has no action that translates by a unit step, so the old _movement_direction_map has no
        # action for a unit bump direction ("no movement action drives the bump direction") and every
        # such context is skipped. Reproduce the old algorithm inline and assert it drives no bump.
        env = Stride2CrossEnv()
        ag = self._trusted_agent(env, STRIDE2_MODEL_SOURCE)
        grid = env._grid()
        rows, cols = len(grid), len(grid[0])
        player_colors = ag._player_color_set()
        dir_map = ag._movement_direction_map(env.observe())  # stride-2: only (0, +/-2) deltas
        old_firable = 0
        for r in range(rows):
            for c in range(cols):
                if grid[r][c] == 0 or grid[r][c] in player_colors:
                    continue
                for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):  # UNIT-STEP adjacency only
                    ar, ac = r + dr, c + dc
                    if 0 <= ar < rows and 0 <= ac < cols and grid[ar][ac] == 0:
                        # OLD bump direction = UNIT delta from the approach cell back to the object.
                        unit_bump = (r - ar, c - ac)
                        # OLD code fired this bump ONLY if an action drives that unit direction.
                        if dir_map.get(unit_bump) is not None:
                            old_firable += 1
        self.assertEqual(old_firable, 0)  # no unit bump direction has a stride-2 action to drive it

    def test_stride1_reduces_to_old_unit_step_behavior(self):
        # A STRIDE-1 mover (the push-block toy) must keep firing unit-step contact probes unchanged:
        # stride inference returns 1 and the contexts are the same adjacency the old code produced.
        env = PushBlockEnv()
        from bench.arc_agi3_zonoid.ewm.world_model import WorldModelProgram

        EwmAgent._vision_available = staticmethod(lambda: False)
        ag = EwmAgent(
            env, FakeLlm([]), kb=FakeKb(max_writes_per_turn=8), vision_enabled=False,
            config=AgentConfig(
                game_id="push", max_turns=40, min_probe_transitions=1,
                fast_path_trust_window=2, goal_discovery_min_live_samples=2,
                goal_discovery_min_live_rate=0.9, coverage_persistence=False,
            ),
        )
        ag.program = WorldModelProgram.load(PUSHBLOCK_MODEL_SOURCE)
        ag._live_results.extend([True, True, True])
        ag._refresh_model_trust()
        self.assertEqual(ag._movement_stride(env.observe()), 1)
        contexts = ag._bump_contexts(env._grid())
        # Unit-step contact into the block: bump direction is a unit delta (the block is reached by a
        # single-cell move onto the adjacent lattice cell), exactly the old behavior.
        dirs = {bump for (_h, _a, bump, _c) in contexts}
        self.assertIn((0, 1), dirs)
        self.assertTrue(all(max(abs(dr), abs(dc)) == 1 for (dr, dc) in dirs))


# ---------------------------------------------------------------------------------------------------
# Run-28 EMPIRICAL MOVEMENT GEOMETRY (observed delta map feeds stride/lattice and walk steering)
# ---------------------------------------------------------------------------------------------------


class _Stride2ColoredQuotaEnv(_Ls20ColoredQuotaEnv):
    """The ls20-colored quota env whose avatar REALLY moves TWO cells per action (blocks/edges
    solid) while the paired model (LS20_COLORED_QUOTA_MODEL_SOURCE) stays a UNIT mover — a genuinely
    stride-mispredicting model, the run-26/28 live shape (the adopted ls20 program mispredicts the
    5-stride mover on every step)."""

    def _apply_one(self, action: str) -> None:
        dr, dc = DELTAS[str(action)]
        ar, ac = self._avatar
        nr, nc = ar + dr * 2, ac + dc * 2  # STRIDE 2 (the model believes 1)
        if not (0 <= nr < self._rows and 0 <= nc < self._cols):
            return
        if (nr, nc) in self._blocks:
            return  # blocks are solid to the avatar (a bump is a pure no-op)
        self._avatar = (nr, nc)


class _FrozenColoredQuotaEnv(_Ls20ColoredQuotaEnv):
    """The ls20-colored quota env whose avatar NEVER moves — every action is a blocked no-op, so an
    observed delta map that says "this action moves" is contradicted by the live board (the Run-28
    walk must terminate via its step cap, not spin)."""

    def _apply_one(self, action: str) -> None:
        return  # frozen: the env no-ops every move


class EmpiricalMovementGeometryTests(unittest.TestCase):
    """Run-28: movement geometry is measured from OBSERVED suite transitions, not the model. Run 26
    proved the adopted ls20 program systematically mispredicts the 5-stride mover; run 28 proved the
    empirical walk executes fine but chases into its step cap because _plan_to_cell/_player_delta_map
    steer by MODEL physics. The observed delta map now overrides the model per action, feeds the
    stride/lattice, and steers the bump walk greedily."""

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _trusted_agent(self, env, source, **cfg):
        from bench.arc_agi3_zonoid.ewm.world_model import WorldModelProgram

        EwmAgent._vision_available = staticmethod(lambda: False)
        base = dict(
            game_id="run28", max_turns=40, min_probe_transitions=1,
            fast_path_trust_window=2, goal_discovery_min_live_samples=2,
            goal_discovery_min_live_rate=0.9, max_frontier_batches_per_turn=8,
            max_interaction_probes_per_turn=6, coverage_persistence=False,
        )
        base.update(cfg)
        ag = EwmAgent(env, FakeLlm([]), kb=FakeKb(max_writes_per_turn=8),
                      vision_enabled=False, config=AgentConfig(**base))
        ag.program = WorldModelProgram.load(source)
        ag._live_results.extend([True, True, True])
        ag._refresh_model_trust()
        return ag

    @staticmethod
    def _seed_move(ag, rows, cols, action, src, dst):
        """Append one synthetic OBSERVED transition where the color-12 player translated src->dst."""

        def grid(cell):
            g = [[0] * cols for _ in range(rows)]
            g[cell[0]][cell[1]] = 12
            return g

        ag.suite.append(grid(src), action, grid(dst))

    def test_observed_delta_map_measures_stride5_moves(self):
        # (a) The suite holds real stride-5 translations of the color-12 player: the observed map
        # returns action -> (dr, dc) at TRUE magnitude, picking the MOST-COMMON delta per action (one
        # noisy unit-looking sample must not displace two stride-5 observations).
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE)
        self._seed_move(ag, 12, 12, "RIGHT", (0, 0), (0, 5))
        self._seed_move(ag, 12, 12, "RIGHT", (0, 5), (0, 10))
        self._seed_move(ag, 12, 12, "RIGHT", (3, 0), (3, 1))  # noisy odd one out
        self._seed_move(ag, 12, 12, "LEFT", (0, 10), (0, 5))
        self.assertEqual(
            ag._observed_delta_map(), {"RIGHT": (0, 5), "LEFT": (0, -5)}
        )

    def test_player_delta_map_prefers_observed_over_wrong_model(self):
        # (a) The model is a UNIT mover, so its per-action deltas are empirically WRONG for the
        # observed stride-5 actions: those actions contribute their OBSERVED deltas and their unit
        # model deltas are dropped; actions with no observation yet keep the model's (so a
        # half-measured map never blinds the walk to a direction).
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE)
        self._seed_move(ag, 12, 12, "RIGHT", (0, 0), (0, 5))
        self._seed_move(ag, 12, 12, "LEFT", (0, 10), (0, 5))
        deltas = ag._player_delta_map(env.observe())
        self.assertEqual(deltas.get((0, 5)), "RIGHT")
        self.assertEqual(deltas.get((0, -5)), "LEFT")
        self.assertNotIn((0, 1), deltas)   # the model's wrong RIGHT delta was superseded
        self.assertNotIn((0, -1), deltas)  # the model's wrong LEFT delta was superseded
        self.assertEqual(deltas.get((-1, 0)), "UP")  # unobserved actions keep the model fallback
        self.assertEqual(deltas.get((1, 0)), "DOWN")

    def test_observed_geometry_feeds_stride_and_lattice(self):
        # (a) With every moving action measured at stride 5, stride inference and the reachable
        # lattice are pure OBSERVED geometry: a sparse 5-spacing lattice from the player's REAL
        # position, no model BFS (whose unit physics would produce a dense wrong lattice).
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE)
        for action, src, dst in (
            ("RIGHT", (0, 0), (0, 5)), ("LEFT", (0, 10), (0, 5)),
            ("DOWN", (0, 0), (5, 0)), ("UP", (10, 0), (5, 0)),
        ):
            self._seed_move(ag, 12, 12, action, src, dst)
        self.assertEqual(ag._movement_stride(env.observe()), 5)
        # On the live 3x12 board only the horizontal stride-5 deltas stay in bounds from (0, 0).
        self.assertEqual(
            ag._reachable_player_cells(env.observe()), {(0, 0), (0, 5), (0, 10)}
        )

    def test_empirical_walk_converges_where_model_steering_never_would(self):
        # (b) THE run-28 live shape: the env mover is stride-2 while the model is a unit mover, and
        # model-plan steering (stubbed to the same never-converging chase run 28 recorded) would hit
        # the step cap. With observed stride-2 deltas in the suite the walk steers empirically,
        # arrives, and the bump FIRES.
        env = _Stride2ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE,
                                 max_interaction_probes_per_turn=1)
        for action, src, dst in (
            ("RIGHT", (0, 0), (0, 2)), ("LEFT", (0, 2), (0, 0)),
            ("DOWN", (0, 0), (2, 0)), ("UP", (2, 0), (0, 0)),
        ):
            self._seed_move(ag, 3, 12, action, src, dst)

        class _Plan:
            actions = ["UP", "UP"]

        # The model's plan never converges (run-28 live: approach_retries=10, then STEP CAP). Only
        # the pre-check reads it now — for reachability and step-cap sizing — never for steering.
        ag._plan_to_cell = lambda frame, target: _Plan()
        before = ag.summary.bumps_probed
        result = ag._bump_discovery(env.observe())
        self.assertIsNotNone(result)
        self.assertGreater(ag.summary.bumps_probed, before)  # arrived -> _fire_bump ran
        self.assertIsNone(ag.summary.bump_skip_reason)  # a bump fired: no skip reason left behind
        self.assertGreater(ag.summary.approach_retries, 0)  # the per-step re-picks were counted

    def test_empty_suite_falls_back_to_model_geometry(self):
        # (c) No observed transitions: the observed map is empty and every geometry consumer keeps
        # the model path unchanged (unit deltas, stride 1).
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE)
        self.assertEqual(ag._observed_delta_map(), {})
        deltas = ag._player_delta_map(env.observe())
        self.assertEqual(deltas.get((0, 1)), "RIGHT")
        self.assertEqual(ag._movement_stride(env.observe()), 1)

    def test_blocked_observed_move_hits_step_cap_and_unpoisons(self):
        # (d) The observed map says the actions move, but the live env no-ops EVERY move (blocked):
        # the walk must terminate via its step cap with the abort reason recorded and the per-run
        # dedup un-poisoned, exactly like every other approach-walk abort.
        env = _FrozenColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE)
        for action, src, dst in (
            ("RIGHT", (0, 0), (0, 1)), ("LEFT", (0, 1), (0, 0)),
            ("DOWN", (0, 0), (1, 0)), ("UP", (1, 0), (0, 0)),
        ):
            self._seed_move(ag, 3, 12, action, src, dst)
        before = ag.summary.bumps_probed
        result = ag._bump_discovery(env.observe())
        self.assertIsNone(result)  # no bump fired: None falls through to the frontier
        self.assertEqual(ag.summary.bumps_probed, before)
        self.assertIsNotNone(ag.summary.bump_skip_reason)
        self.assertIn("approach walk aborted before bump", ag.summary.bump_skip_reason)
        self.assertIn("step cap", ag.summary.bump_skip_reason)
        self.assertEqual(ag._bump_attempted, set())

    def test_batched_transitions_never_pollute_observed_deltas(self):
        # A multi-action batch is recorded as ONE grid-in/grid-out transition, so its player delta
        # COMPOUNDS several moves (three stride-2 steps would read as a bogus stride-6 action). Only
        # single-step transitions are measured.
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE)
        # A real single-step observation, recorded through the agent's own bookkeeping...
        ag._record_transition(
            {"grid": [[12] + [0] * 11, [0] * 12, [0] * 12]}, "RIGHT",
            [[0, 12] + [0] * 10, [0] * 12, [0] * 12], single_step=True,
        )
        # ...then a 3-action batch recorded as one compound transition (delta (0, 3)).
        ag._record_transition(
            {"grid": [[0, 12] + [0] * 10, [0] * 12, [0] * 12]}, "RIGHT",
            [[0, 0, 0, 0, 12] + [0] * 7, [0] * 12, [0] * 12], single_step=False,
        )
        self.assertEqual(ag._observed_delta_map(), {"RIGHT": (0, 1)})


# ---------------------------------------------------------------------------------------------------
# Run-29 PER-COLOR OBSERVED MOVER DETECTION (color 12 moves; color 9 is static decoration)
# ---------------------------------------------------------------------------------------------------


class _Ls20StaticDecorEnv(_Stride2ColoredQuotaEnv):
    """The stride-2 ls20-colored env plus a SOLID static color-9 decoration cell that never moves —
    the run-29 live shape in miniature (color 12 is the true mover; color 9 is static
    decoration/HUD). Solid like every block, so it is also a legitimate bump target once the player
    set narrows to the mover."""

    def __init__(self, budget: int = 200) -> None:
        super().__init__(budget)
        self._blocks[(2, 0)] = 9  # static color-9 decoration: solid, never moves


class PerColorMoverDetectionTests(unittest.TestCase):
    """Run-29: rigid-translation detection is PER COLOR and the player color set narrows
    observed-first to the color(s) that ACTUALLY move. Run 29 live proved the run-23 program
    inference is over-broad on ls20 ({9,12}): offline analysis of the 47-transition suite shows
    color 12 is the TRUE mover (a 2x5 block making perfect stride-5 rigid translations) while
    color 9 is 45 STATIC decoration cells that never move. The run-28 UNION rigidity check
    therefore measured ZERO moves (run 29 byte-identical to run 28), and _player_position planned
    every walk from a static color-9 cell."""

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _trusted_agent(self, env, source, **cfg):
        from bench.arc_agi3_zonoid.ewm.world_model import WorldModelProgram

        EwmAgent._vision_available = staticmethod(lambda: False)
        base = dict(
            game_id="run29", max_turns=40, min_probe_transitions=1,
            fast_path_trust_window=2, goal_discovery_min_live_samples=2,
            goal_discovery_min_live_rate=0.9, max_frontier_batches_per_turn=8,
            max_interaction_probes_per_turn=6, coverage_persistence=False,
        )
        base.update(cfg)
        ag = EwmAgent(env, FakeLlm([]), kb=FakeKb(max_writes_per_turn=8),
                      vision_enabled=False, config=AgentConfig(**base))
        ag.program = WorldModelProgram.load(source)
        ag._live_results.extend([True, True, True])
        # Pin the PROGRAM-inferred candidate set to the over-broad run-23 live result {9,12}:
        # color 9 is static decoration, color 12 the true mover.
        ag._player_colors = frozenset({9, 12})
        ag._player_colors_for = ag.program
        ag._refresh_model_trust()
        return ag

    @staticmethod
    def _seed_decorated_move(ag, rows, cols, action, src, dst, decor=((11, 0), (11, 5))):
        """One observed single-step transition: the color-12 player translates src->dst while
        static color-9 decoration cells sit UNMOVED in both grids (the run-29 live shape)."""

        def grid(cell):
            g = [[0] * cols for _ in range(rows)]
            for (r, c) in decor:
                g[r][c] = 9
            g[cell[0]][cell[1]] = 12
            return g

        ag.suite.append(grid(src), action, grid(dst))

    def test_per_color_detection_finds_mover_the_union_check_missed(self):
        # (a) THE run-29 regression: color 12 translates rigidly while the (larger) static color-9
        # decoration never moves. The old UNION rigidity check merged static+moving cells, found
        # the union non-rigid, and measured NOTHING; the per-color detection measures the mover
        # AND reports which color moved.
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE)
        self._seed_decorated_move(ag, 12, 12, "RIGHT", (0, 0), (0, 5))
        self._seed_decorated_move(ag, 12, 12, "RIGHT", (0, 5), (0, 10))
        self._seed_decorated_move(ag, 12, 12, "LEFT", (0, 10), (0, 5))
        # Fixture sanity: the UNION of {9,12} cells does NOT translate rigidly on these grids —
        # exactly why the old union-based check measured zero moves (so this test fails without
        # the per-color fix, which would return {} here).
        before, after = ag.suite[0].before_grid, ag.suite[0].after_grid
        union_b = {(r, c) for r, row in enumerate(before) for c, v in enumerate(row) if v in (9, 12)}
        union_a = {(r, c) for r, row in enumerate(after) for c, v in enumerate(row) if v in (9, 12)}
        (br, bc), (ar, ac) = min(union_b), min(union_a)
        shifted = {(r + ar - br, c + ac - bc) for (r, c) in union_b}
        self.assertNotEqual(shifted, union_a)  # union is non-rigid: the old check discards this move
        self.assertEqual(ag._observed_delta_map(), {"RIGHT": (0, 5), "LEFT": (0, -5)})
        self.assertEqual(ag._observed_mover_colors(), frozenset({12}))

    def test_player_color_set_narrows_observed_first_and_refreshes(self):
        # (b) Observed-first with program fallback AND cache coherence: the empty-suite call
        # returns the program-inferred {9,12} (the fallback path unchanged), and that early result
        # must NOT pin — the moment a real color-12 move lands in the suite the set narrows to the
        # true mover {12} (the observed branch is keyed on suite length, not program identity).
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE)
        self.assertEqual(ag._player_color_set(), frozenset({9, 12}))  # empty suite: program path
        self._seed_decorated_move(ag, 12, 12, "RIGHT", (0, 0), (0, 5))
        self.assertEqual(ag._player_color_set(), frozenset({12}))  # narrowed, not pinned

    def test_player_position_tracks_the_moving_color_not_static_decoration(self):
        # (c) The point of the fix: a static color-9 cell earlier in row order must not be
        # reported as the player once moves are observed — walks then plan from the REAL mover
        # instead of a position that never moves.
        env = _Ls20ColoredQuotaEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE)
        grid = [[0] * 12 for _ in range(12)]
        grid[0][1] = 9    # static decoration, FIRST in row order
        grid[5][5] = 12   # the true mover
        # Empty suite: the {9,12} fallback finds the static cell first (the run-29 live pathology).
        self.assertEqual(ag._player_position(grid), (0, 1))
        self._seed_decorated_move(ag, 12, 12, "RIGHT", (0, 0), (0, 5))
        self.assertEqual(ag._player_position(grid), (5, 5))  # a MOVING-color cell, not the 9

    def test_end_to_end_bump_fires_steered_from_true_mover(self):
        # (d) End-to-end on the run-29 shape: stride-2 env, mispredicting unit model, static
        # color-9 decoration on the board AND in the observed grids. Per-color deltas steer the
        # empirical walk from the TRUE mover position -> "arrived" -> _fire_bump fires and
        # bumps_probed increments. Without the per-color fix the observed map is empty (union
        # non-rigid), so the walk would chase the wrong model into its step cap with no bump.
        env = _Ls20StaticDecorEnv()
        ag = self._trusted_agent(env, LS20_COLORED_QUOTA_MODEL_SOURCE,
                                 max_interaction_probes_per_turn=1)
        for action, src, dst in (
            ("RIGHT", (0, 0), (0, 2)), ("LEFT", (0, 2), (0, 0)),
            ("DOWN", (0, 0), (2, 0)), ("UP", (2, 0), (0, 0)),
        ):
            self._seed_decorated_move(ag, 3, 12, action, src, dst, decor=((1, 11),))
        self.assertEqual(ag._observed_mover_colors(), frozenset({12}))  # decoration never vetoes

        class _Plan:
            actions = ["UP", "UP"]

        # The model's plan is only the reachability pre-check / step-cap sizer, never the steering.
        ag._plan_to_cell = lambda frame, target: _Plan()
        before = ag.summary.bumps_probed
        result = ag._bump_discovery(env.observe())
        self.assertIsNotNone(result)
        self.assertGreater(ag.summary.bumps_probed, before)  # arrived -> _fire_bump ran
        self.assertIsNone(ag.summary.bump_skip_reason)  # a bump fired: no skip reason left behind
        self.assertEqual(ag.summary.player_colors, [12])  # the echo truthfully reports the mover


class _CoverageKbClient:
    """KbClient stand-in for coverage resume: returns a native full-body coverage note for the index
    hit so read_coverage_state's preferred (native) path recovers it in one call."""

    def __init__(self, game_id: str, body: str) -> None:
        self._game_id = game_id
        self._body = body
        self._index_key = f"note:{game_id}-coverage-index"
        self.last_search_failed = False

    def search(self, q, k, gated=False, full_content=False):
        toks = set(re.split(r"[^0-9A-Za-z]+", q.lower()))
        if {"coverage", "state", self._game_id}.issubset(toks):
            return [{
                "key": self._index_key,
                "title": f"game {self._game_id} coverage state",
                "summary": "coverage state index\nchunk count: 1\nsource length: 1",
                "content": "coverage state index\nchunk count: 1\nsource length: 1",
            }]
        return []

    def get_note_full(self, key):
        if key == self._index_key:
            return {"ok": True, "key": key, "full_body": self._body}
        return {"ok": False, "error": "http 404"}


class _CoverageKb(FakeKb):
    """A FakeKb whose ``client`` serves a persisted coverage note, so _resume_coverage recovers it."""

    def __init__(self, game_id: str, body: str, max_writes_per_turn: int = 8) -> None:
        super().__init__(max_writes_per_turn=max_writes_per_turn)
        self.client = _CoverageKbClient(game_id, body)


class CrossRunCoveragePersistenceTests(unittest.TestCase):
    """Run-20: the run persists its swept ground at run end, and a SECOND run RESUMES it at ORIENT so
    budgets never compound (persisted cells are pre-loaded; the frontier never re-sweeps them)."""

    def tearDown(self):
        import importlib

        importlib.reload(agent_mod)

    def _agent(self, env, kb, **cfg):
        EwmAgent._vision_available = staticmethod(lambda: False)
        base = dict(game_id="push", max_turns=6, min_probe_transitions=1, coverage_persistence=True)
        base.update(cfg)
        return EwmAgent(env, FakeLlm([]), kb=kb, vision_enabled=False, config=AgentConfig(**base))

    def test_persist_writes_coverage_note_with_swept_cells(self):
        from bench.arc_agi3_zonoid.ewm import kb_protocol

        env = PushBlockEnv()
        kb = FakeKb(max_writes_per_turn=8)
        ag = self._agent(env, kb)
        ag._board_cell_count = 3
        ag._coverage_cells = {(1, 0, 0), (1, 0, 1)}
        ag._fired_probes = {("<bump>", "objA")}
        ag._persist_coverage()
        self.assertTrue(ag.summary.coverage_persisted)
        cov = [args for (kind, args) in kb.writes if kind == "coverage_state"]
        self.assertEqual(len(cov), 1)
        body = cov[0][1]
        decoded = kb_protocol.decode_coverage_state(body)
        self.assertEqual(decoded["visited"], {(1, 0, 0), (1, 0, 1)})
        self.assertEqual(decoded["probes"], {("<bump>", "objA")})

    def test_second_run_resumes_persisted_coverage(self):
        from bench.arc_agi3_zonoid.ewm import kb_protocol

        # A prior run swept these cells + recorded a NON-movement interaction probe (SPACE) AND a bump
        # probe (<bump>). Run-25 fix: NON-bump probes resume; bump probes are EXCLUDED on load (bump
        # discovery is per-run, so a prior run's bump intent must not gate this run).
        visited = {(1, 0, 0), (1, 0, 1), (1, 0, 2)}
        probes = {("SPACE", "objA"), ("<bump>", "objA")}
        body = kb_protocol.encode_coverage_state(visited, probes, board_cells=3)

        env = PushBlockEnv()
        kb = _CoverageKb("push", body)
        ag = self._agent(env, kb)
        ag._board_cell_count = 3
        ag._resume_coverage(env.observe())
        # The persisted ground is pre-loaded: the frontier will not re-sweep it.
        self.assertTrue(visited.issubset(ag._coverage_cells))
        # Non-bump interaction probes resume so run 20's coverage feature is not regressed...
        self.assertIn(("SPACE", "objA"), ag._fired_probes)
        # ...but the persisted <bump> probe is EXCLUDED so bumps are re-probed this run (Run-25 fix).
        self.assertNotIn(("<bump>", "objA"), ag._fired_probes)
        # coverage_resumed_pct reflects the resumed fraction of the board (3/3 == 1.0 here).
        self.assertGreater(ag.summary.coverage_resumed_pct, 0.0)

    def test_resume_degrades_gracefully_on_kb_miss(self):
        env = PushBlockEnv()
        # FakeKb.client is None -> no KB -> a clean fresh sweep, no crash, no resumed coverage.
        ag = self._agent(env, FakeKb(max_writes_per_turn=8))
        ag._board_cell_count = 3
        ag._resume_coverage(env.observe())
        self.assertEqual(ag._coverage_cells, set())
        self.assertEqual(ag.summary.coverage_resumed_pct, 0.0)

    def test_fired_bumps_persist_resume_and_compound_across_runs(self):
        # Run-37 regression shape: the live coverage note round-tripped visited=533 cells but
        # probes=[] despite 12 fired bumps, so runs 33/34/37 each re-bumped the SAME 12 objects.
        # Run-38: fired bump identities persist as <bump> tokens, RESUME into the cross-run
        # ordering set (NOT _fired_probes — Run-25 semantics intact), and COMPOUND on re-persist.
        from bench.arc_agi3_zonoid.ewm import kb_protocol

        # RUN A: a bump fired this run (recorded by _fire_bump into _fired_bump_objects).
        env = PushBlockEnv()
        kb = FakeKb(max_writes_per_turn=8)
        ag = self._agent(env, kb)
        ag._board_cell_count = 3
        ag._coverage_cells = {(1, 0, 0)}
        ag._fired_bump_objects = {"objA"}
        ag._persist_coverage()
        body = [args for (kind, args) in kb.writes if kind == "coverage_state"][0][1]
        decoded = kb_protocol.decode_coverage_state(body)
        self.assertIn(("<bump>", "objA"), decoded["probes"])  # encode -> write -> decode

        # RUN B resumes: the bump key seeds the cross-run ORDERING set, never the per-run gates.
        kb2 = _CoverageKb("push", body)
        ag2 = self._agent(PushBlockEnv(), kb2)
        ag2._board_cell_count = 3
        ag2._resume_coverage(env.observe())
        self.assertIn("objA", ag2._resumed_bump_probes)
        self.assertNotIn(("<bump>", "objA"), ag2._fired_probes)  # Run-25: bumps not gated
        self.assertNotIn("objA", ag2._bump_attempted)  # per-run dedup untouched

        # RUN B fires NO new bump, yet its re-persist still carries run A's probe (compounding).
        ag2._persist_coverage()
        cov2 = [args for (kind, args) in kb2.writes if kind == "coverage_state"]
        decoded2 = kb_protocol.decode_coverage_state(cov2[-1][1])
        self.assertIn(("<bump>", "objA"), decoded2["probes"])

    def test_resumed_cells_are_not_re_persisted_as_new(self):
        # Round-trip invariant: resume then persist must not LOSE the resumed ground (it accumulates).
        from bench.arc_agi3_zonoid.ewm import kb_protocol

        visited = {(1, 0, 0), (1, 0, 1)}
        body = kb_protocol.encode_coverage_state(visited, set(), board_cells=3)
        env = PushBlockEnv()
        kb = _CoverageKb("push", body)
        ag = self._agent(env, kb)
        ag._board_cell_count = 3
        ag._resume_coverage(env.observe())
        ag._coverage_cells.add((1, 0, 2))  # this run swept one new cell
        ag._persist_coverage()
        cov = [args for (kind, args) in kb.writes if kind == "coverage_state"]
        decoded = kb_protocol.decode_coverage_state(cov[-1][1])
        # Persisted set = prior resumed ground UNION this run's new cell (budgets accumulate).
        self.assertEqual(decoded["visited"], {(1, 0, 0), (1, 0, 1), (1, 0, 2)})


def _script_reflect_only() -> FakeLlm:
    """A FakeLlm that always returns a benign reflect (no program authoring) — for loop-drive tests
    where the program is not needed (the toy env just gets reactive/probe play)."""

    class _R(FakeLlm):
        def chat(self, messages, max_tokens=1024, temperature=0.0):
            self.received.append({"messages": messages})
            self.calls += 1
            return {"content": '{"prediction_ok": true, "note": "ok"}', "finish_reason": None,
                    "raw": ""}

    return _R([])


if __name__ == "__main__":
    unittest.main()
