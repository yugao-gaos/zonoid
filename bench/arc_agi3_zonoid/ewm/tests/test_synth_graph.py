"""Tests for the graph-native multi-step synthesis state machine (:mod:`.synth_graph`).

Everything runs without a real LLM or daemon. ``FakeLlm`` (reused from :mod:`.llm_client`) scripts
the ANALYZE / PLAN / EDIT completions in order; ``MockGraph`` records the task lifecycle and serves
scripted context notes; ``OutageGraph`` raises on every op to prove degradation. The programs are
built from the world-model kit's toy game so ``validate`` gives real accept/reject verdicts.
"""

from __future__ import annotations

import json
import logging
import unittest

# The outage tests deliberately trigger DaemonGraph's best-effort warnings; silence them so the
# suite output stays clean (the swallowing itself is what's under test, not the log line).
logging.getLogger("bench.arc_agi3_zonoid.ewm.synth_graph").setLevel(logging.ERROR)

from bench.arc_agi3_zonoid.ewm.llm_client import FakeLlm
from bench.arc_agi3_zonoid.ewm.synth_graph import (
    DaemonGraph,
    SynthConfig,
    SynthSession,
    _passing_indices,
    _sub_suite,
)
from bench.arc_agi3_zonoid.ewm.world_model import TransitionSuite, WorldModelProgram
from bench.arc_agi3_zonoid.ewm.tests.test_world_model import TOY_GAME_SOURCE, WRONG_GAME_SOURCE


DELTAS = {"UP": (-1, 0), "DOWN": (1, 0), "LEFT": (0, -1), "RIGHT": (0, 1)}


def _grid(*rows: str) -> list[list[int]]:
    return [[0 if ch == "." else int(ch) for ch in row] for row in rows]


def _toy_next(frame, action):
    """Apply the toy game's transition to a grid (avatar=2 moves on 0-cells, wall=1, goal=3)."""

    prog = WorldModelProgram.load(TOY_GAME_SOURCE)
    state = prog.init_state(frame)
    state, _ = prog.step(state, action)
    return prog.render(state)


def _toy_suite(*moves: tuple[str, list[str]]) -> TransitionSuite:
    """Build a suite of toy-game transitions from (action, before-rows) pairs."""

    suite = TransitionSuite()
    for action, rows in moves:
        before = _grid(*rows)
        after = _toy_next(before, action)
        suite.append(before, action, after)
    return suite


def _fenced(source: str) -> str:
    return f"Here is the model:\n```python\n{source}\n```\n"


class MockGraph:
    """In-memory :class:`GraphClient` that records lifecycle order and serves scripted context.

    ``context_by_title`` maps a task-title substring -> the note list ``task_context`` returns for
    that task; ``fail_status`` (optional) forces a task's completion status for assertions.
    """

    def __init__(self, context_by_title: dict[str, list[str]] | None = None) -> None:
        self.context_by_title = context_by_title or {}
        self.events: list[tuple] = []
        self.notes: list[dict] = []
        self._key_to_title: dict[str, str] = {}
        self._n = 0

    def create_task(self, title: str, desc: str) -> str:
        self._n += 1
        key = f"mock/{self._n}"
        self._key_to_title[key] = title
        self.events.append(("create", key, title))
        return key

    def task_context(self, key: str) -> list[str]:
        title = self._key_to_title.get(key, "")
        self.events.append(("context", key))
        for needle, notes in self.context_by_title.items():
            if needle in title:
                return list(notes)
        return []

    def claim(self, key: str) -> None:
        self.events.append(("claim", key))

    def complete(self, key: str, status: str, summary: str) -> None:
        self.events.append(("complete", key, status))

    def note(self, title: str, summary: str, wires_to: list[str]) -> None:
        self.events.append(("note", title, tuple(wires_to)))
        self.notes.append({"title": title, "summary": summary, "wires_to": list(wires_to)})

    # -- assertion helpers -------------------------------------------------------------------------

    def lifecycle(self, key: str) -> list[str]:
        """The ordered event kinds recorded for one task key."""

        return [e[0] for e in self.events if len(e) > 1 and e[1] == key]

    def created_keys(self) -> list[str]:
        return [e[1] for e in self.events if e[0] == "create"]

    def title_for(self, key: str) -> str:
        return self._key_to_title.get(key, "")


class OutageGraph:
    """A :class:`GraphClient` whose every op raises, to prove best-effort degradation.

    NOTE: this is stricter than :class:`DaemonGraph`, which swallows HTTP errors internally. The
    session code calls the graph directly, so a raising graph would crash the session — this class
    exists to test :class:`DaemonGraph`'s OWN swallowing (used via monkeypatched urlopen), not to be
    passed to a session. See :class:`DaemonOutageTests`.
    """

    def _boom(self, *a, **k):
        raise RuntimeError("daemon outage")

    create_task = _boom
    task_context = _boom
    claim = _boom
    complete = _boom
    note = _boom


def _fast_config(**kw) -> SynthConfig:
    kw.setdefault("context_wait_s", 0.0)
    kw.setdefault("context_poll_s", 0.0)
    return SynthConfig(**kw)


# A suite whose two transitions are both explained by the toy game.
_SUITE = _toy_suite(
    ("RIGHT", ["2..", "...", "..3"]),
    ("DOWN", ["2..", "...", "..3"]),
)


def _analyze_json(*mechanics) -> str:
    return json.dumps([{"name": n, "description": d} for n, d in mechanics])


def _plan_json(*changes) -> str:
    return json.dumps(
        [{"name": n, "description": d, "target_transitions": t} for n, d, t in changes]
    )


class SubSuiteTests(unittest.TestCase):
    def test_sub_suite_selects_indices(self):
        sub = _sub_suite(_SUITE, [1])
        self.assertEqual(len(sub), 1)
        self.assertEqual(sub[0].action, _SUITE[1].action)

    def test_sub_suite_ignores_out_of_range(self):
        self.assertEqual(len(_sub_suite(_SUITE, [5, -1])), 0)

    def test_passing_indices_full_program(self):
        prog = WorldModelProgram.load(TOY_GAME_SOURCE)
        self.assertEqual(_passing_indices(prog, _SUITE), {0, 1})

    def test_passing_indices_wrong_program(self):
        # WRONG_GAME_SOURCE swaps a delta so the RIGHT/DOWN moves render wrong -> nothing passes.
        prog = WorldModelProgram.load(WRONG_GAME_SOURCE)
        self.assertNotEqual(_passing_indices(prog, _SUITE), {0, 1})


class HappyPathTests(unittest.TestCase):
    """One ANALYZE, one PLAN, one EDIT that lands the toy program -> full suite green."""

    def _run(self, graph):
        llm = FakeLlm(
            [
                _analyze_json(("movement", "avatar shifts by action delta")),  # ANALYZE
                _plan_json(("write toy", "author the mover", [0, 1])),          # PLAN
                _fenced(TOY_GAME_SOURCE),                                        # EDIT change 0
            ]
        )
        session = SynthSession(
            "toy", _SUITE, llm, graph=graph, config=_fast_config(), sleep=lambda s: None
        )
        return session, session.run(deltas=["avatar moved (0,1)"])

    def test_full_suite_green(self):
        graph = MockGraph()
        _, result = self._run(graph)
        self.assertIsNotNone(result["program_source"])
        self.assertTrue(result["report"]["ok"])
        self.assertEqual(result["report"]["pass_count"], 2)

    def test_step_task_lifecycle_order(self):
        graph = MockGraph()
        session, _ = self._run(graph)
        # Three tasks created: ANALYZE, PLAN, EDIT — in that order.
        created = graph.created_keys()
        self.assertEqual(len(created), 3)
        self.assertIn("analyze transitions", graph.title_for(created[0]))
        self.assertIn("plan program changes", graph.title_for(created[1]))
        self.assertIn("edit", graph.title_for(created[2]))
        # ANALYZE: create -> (context poll) -> note -> complete tested.
        self.assertEqual(graph.lifecycle(created[0])[0], "create")
        self.assertIn("complete", graph.lifecycle(created[0]))
        # EDIT task is claimed before it completes.
        edit_life = graph.lifecycle(created[2])
        self.assertEqual(edit_life[0], "create")
        self.assertLess(edit_life.index("claim"), edit_life.index("complete"))
        # EDIT completed 'tested' (acceptance passed).
        self.assertIn(("complete", created[2], "tested"), graph.events)

    def test_context_notes_reach_analyze_prompt(self):
        graph = MockGraph(context_by_title={"analyze transitions": ["SOME games gate on a key"]})
        llm = FakeLlm(
            [
                _analyze_json(("movement", "shift")),
                _plan_json(("write toy", "author", [0, 1])),
                _fenced(TOY_GAME_SOURCE),
            ]
        )
        session = SynthSession(
            "toy", _SUITE, llm, graph=graph, config=_fast_config(), sleep=lambda s: None
        )
        session.run(deltas=["avatar moved"])
        analyze_user = llm.received[0]["messages"][1]["content"]
        self.assertIn("SOME games gate on a key", analyze_user)
        self.assertIn("HYPOTHESES", analyze_user)
        # The delta text also reaches the ANALYZE user prompt.
        self.assertIn("avatar moved", analyze_user)


class RegressionGuardTests(unittest.TestCase):
    """The acceptance slice must reject a change that regresses a previously-passing index."""

    def test_edit_rejected_when_it_regresses_baseline(self):
        # First EDIT lands the toy program (both indices pass). Second change proposes the WRONG
        # program (regresses both) -> rejected all retries -> skipped, source stays the toy program.
        graph = MockGraph()
        llm = FakeLlm(
            [
                _analyze_json(("movement", "shift")),
                _plan_json(
                    ("write toy", "author mover", [0]),          # change 0: lands toy
                    ("break it", "regress", [1]),                # change 1: WRONG, must be skipped
                ),
                _fenced(TOY_GAME_SOURCE),                         # EDIT change 0 -> accepted
                _fenced(WRONG_GAME_SOURCE),                       # EDIT change 1 attempt 1 -> reject
                _fenced(WRONG_GAME_SOURCE),                       # attempt 2 -> reject
                _fenced(WRONG_GAME_SOURCE),                       # attempt 3 -> reject
            ]
        )
        session = SynthSession(
            "toy", _SUITE, llm, graph=graph, config=_fast_config(), sleep=lambda s: None
        )
        result = session.run(deltas=[])
        # Toy program survived (change 1 was skipped, not adopted).
        self.assertIn("def init_state", result["program_source"])
        self.assertTrue(result["report"]["ok"])  # toy still passes the whole suite
        # Change 1's EDIT task completed 'failed' and a failed-repair note was written.
        edit_keys = [k for k in graph.created_keys() if "edit" in graph.title_for(k)]
        self.assertEqual(len(edit_keys), 2)
        self.assertIn(("complete", edit_keys[1], "failed"), graph.events)
        self.assertTrue(any("failed repair" in n["title"] for n in graph.notes))

    def test_acceptance_requires_targets_to_pass(self):
        # A change whose target index is NOT explained by the proposed program is rejected even
        # with no prior baseline. WRONG program targeting index 0 -> never accepted -> skipped.
        graph = MockGraph()
        llm = FakeLlm(
            [
                _analyze_json(("movement", "shift")),
                _plan_json(("attempt", "wrong prog", [0])),
                _fenced(WRONG_GAME_SOURCE),
                _fenced(WRONG_GAME_SOURCE),
                _fenced(WRONG_GAME_SOURCE),
            ]
        )
        session = SynthSession(
            "toy", _SUITE, llm, graph=graph, config=_fast_config(), sleep=lambda s: None
        )
        result = session.run(deltas=[])
        self.assertIsNone(result["program_source"])  # nothing ever adopted
        self.assertFalse(result["report"]["ok"])


class BestCandidateTests(unittest.TestCase):
    """The session tracks the highest full-suite pass_count candidate across the EDIT chain and
    returns it (best_source/best_report) even when FINAL fails — the partial-adoption handoff."""

    def test_best_candidate_returned_when_final_fails(self):
        # WRONG_GAME_SOURCE passes only the DOWN transition (index 1) of _SUITE; targeting BOTH
        # indices makes the regression guard reject it (must_pass={0,1} but it passes only {1}), so
        # nothing is ever adopted (program_source None) — but it is the best candidate seen.
        graph = MockGraph()
        llm = FakeLlm(
            [
                _analyze_json(("movement", "shift")),
                _plan_json(("attempt", "wrong prog", [0, 1])),
                _fenced(WRONG_GAME_SOURCE),
                _fenced(WRONG_GAME_SOURCE),
                _fenced(WRONG_GAME_SOURCE),
            ]
        )
        session = SynthSession(
            "toy", _SUITE, llm, graph=graph, config=_fast_config(), sleep=lambda s: None
        )
        result = session.run(deltas=[])
        self.assertIsNone(result["program_source"])   # regression guard rejected every attempt
        self.assertFalse(result["report"]["ok"])
        self.assertIsNotNone(result["best_source"])
        self.assertIn("def init_state", result["best_source"])
        # WRONG passes exactly one of the two transitions independently (DOWN, not RIGHT).
        best = WorldModelProgram.load(result["best_source"])
        self.assertEqual(_passing_indices(best, _SUITE), {1})
        self.assertEqual(result["best_report"]["total"], 2)

    def test_best_candidate_none_when_nothing_compiles(self):
        graph = MockGraph()
        llm = FakeLlm(
            [
                _analyze_json(("movement", "shift")),
                _plan_json(("attempt", "no code", [0, 1])),
                "prose only, no fenced block",
                "still no code",
                "nope",
            ]
        )
        session = SynthSession(
            "toy", _SUITE, llm, graph=graph, config=_fast_config(), sleep=lambda s: None
        )
        result = session.run(deltas=[])
        self.assertIsNone(result["best_source"])
        self.assertIsNone(result["best_report"])

    def test_best_candidate_is_the_full_program_when_final_passes(self):
        # When FINAL passes, best_source still tracks the same fully-passing candidate.
        graph = MockGraph()
        llm = FakeLlm(
            [
                _analyze_json(("movement", "shift")),
                _plan_json(("write toy", "author", [0, 1])),
                _fenced(TOY_GAME_SOURCE),
            ]
        )
        session = SynthSession(
            "toy", _SUITE, llm, graph=graph, config=_fast_config(), sleep=lambda s: None
        )
        result = session.run(deltas=[])
        self.assertTrue(result["report"]["ok"])
        self.assertEqual(result["best_report"]["pass_count"], 2)


class RetryThenSkipTests(unittest.TestCase):
    """A change that fails the first attempt but succeeds within the retry budget is accepted."""

    def test_retry_then_accept(self):
        graph = MockGraph()
        llm = FakeLlm(
            [
                _analyze_json(("movement", "shift")),
                _plan_json(("write toy", "author", [0, 1])),
                "no fenced block here (parse failure)",   # attempt 1: extract_python -> None
                _fenced(WRONG_GAME_SOURCE),                # attempt 2: rejected by acceptance
                _fenced(TOY_GAME_SOURCE),                  # attempt 3: accepted
            ]
        )
        session = SynthSession(
            "toy", _SUITE, llm, graph=graph, config=_fast_config(max_retries_per_change=2),
            sleep=lambda s: None,
        )
        result = session.run(deltas=[])
        self.assertTrue(result["report"]["ok"])
        edit_key = [k for k in graph.created_keys() if "edit" in graph.title_for(k)][0]
        self.assertIn(("complete", edit_key, "tested"), graph.events)
        edit_step = [s for s in result["steps"] if s["name"] == "EDIT"][0]
        self.assertEqual(edit_step["detail"]["attempts"], 3)

    def test_skip_after_exhausting_retries(self):
        graph = MockGraph()
        llm = FakeLlm(
            [
                _analyze_json(("movement", "shift")),
                _plan_json(("write toy", "author", [0, 1])),
                _fenced(WRONG_GAME_SOURCE),   # attempt 1 reject
                _fenced(WRONG_GAME_SOURCE),   # attempt 2 reject
                _fenced(WRONG_GAME_SOURCE),   # attempt 3 reject -> skip
            ]
        )
        session = SynthSession(
            "toy", _SUITE, llm, graph=graph, config=_fast_config(max_retries_per_change=2),
            sleep=lambda s: None,
        )
        result = session.run(deltas=[])
        self.assertIsNone(result["program_source"])
        edit_step = [s for s in result["steps"] if s["name"] == "EDIT"][0]
        self.assertEqual(edit_step["status"], "failed")
        self.assertEqual(edit_step["detail"]["attempts"], 3)  # 1 + 2 retries


class SynthContextInEditTests(unittest.TestCase):
    """The hardened synthesis contract (built by agent.build_synth_context) must reach every EDIT
    prompt verbatim — the run-8 fix: without it, session candidates imported numpy and hardcoded
    grids. The single-shot path already carried it; the graph path did not."""

    def _script(self):
        return [
            _analyze_json(("movement", "shift")),
            _plan_json(("write toy", "author", [0, 1])),
            _fenced(TOY_GAME_SOURCE),
        ]

    def test_edit_prompt_carries_contract_and_stdlib_line(self):
        from bench.arc_agi3_zonoid.ewm.agent import build_synth_context

        ctx = build_synth_context(
            [[2, 0], [0, 3]], "obj summary", "trans text", "auto hint", object_cap=20
        )
        graph = MockGraph()
        llm = FakeLlm(self._script())
        session = SynthSession(
            "toy", _SUITE, llm, graph=graph, config=_fast_config(), sleep=lambda s: None,
            synth_context=ctx,
        )
        session.run(deltas=["avatar moved"])
        # The EDIT completion is the 3rd LLM call (ANALYZE, PLAN, EDIT).
        edit_user = llm.received[2]["messages"][1]["content"]
        self.assertIn("Only these stdlib modules may be imported:", edit_user)
        self.assertIn("numpy/pandas are NOT available", edit_user)
        self.assertIn("segment(grid)", edit_user)          # object teaching present
        self.assertIn("--- SYNTHESIS DATA", edit_user)      # data block present
        self.assertIn("render(state) MUST return a grid", edit_user)  # dimension contract

    def test_no_synth_context_omits_contract(self):
        """Backcompat: with no synth_context the EDIT prompt carries only the generic reminder."""

        graph = MockGraph()
        llm = FakeLlm(self._script())
        session = SynthSession(
            "toy", _SUITE, llm, graph=graph, config=_fast_config(), sleep=lambda s: None,
        )
        session.run(deltas=[])
        edit_user = llm.received[2]["messages"][1]["content"]
        self.assertNotIn("Only these stdlib modules", edit_user)


class WallCapTests(unittest.TestCase):
    """The per-session wall cap stops the state machine cleanly between LLM calls."""

    def _clock_from(self, ticks):
        """A fake monotonic clock that returns each value in ``ticks`` in turn, then the last."""

        seq = list(ticks)

        def clock():
            return seq.pop(0) if len(seq) > 1 else seq[0]

        return clock

    def test_wall_cap_stops_edit_chain_early(self):
        # PLAN proposes two changes; the clock jumps past the 240s cap after the first EDIT so the
        # second change is skipped. t0=0 (run start), 0 (before PLAN check), 0 (first EDIT check),
        # then 500 (second EDIT check -> exceeded).
        graph = MockGraph()
        llm = FakeLlm(
            [
                _analyze_json(("movement", "shift")),
                _plan_json(
                    ("first", "author toy", [0, 1]),
                    ("second", "would-run-if-time", [0, 1]),
                ),
                _fenced(TOY_GAME_SOURCE),   # first EDIT accepted
                _fenced(TOY_GAME_SOURCE),   # second EDIT — should never be requested (capped)
            ]
        )
        session = SynthSession(
            "toy", _SUITE, llm, graph=graph,
            config=_fast_config(max_session_seconds=240.0),
            sleep=lambda s: None,
            clock=self._clock_from([0.0, 0.0, 0.0, 500.0]),
        )
        result = session.run(deltas=[])
        self.assertTrue(result["wall_capped"])
        # Only ANALYZE, PLAN, and ONE EDIT completion were issued (the 2nd change was capped out).
        self.assertEqual(len(llm.received), 3)
        edit_steps = [s for s in result["steps"] if s["name"] == "EDIT"]
        self.assertEqual(len(edit_steps), 1)

    def test_no_wall_cap_when_disabled(self):
        graph = MockGraph()
        llm = FakeLlm(
            [
                _analyze_json(("movement", "shift")),
                _plan_json(("write toy", "author", [0, 1])),
                _fenced(TOY_GAME_SOURCE),
            ]
        )
        session = SynthSession(
            "toy", _SUITE, llm, graph=graph,
            config=_fast_config(max_session_seconds=0.0),  # 0 -> no cap
            sleep=lambda s: None,
            clock=self._clock_from([0.0, 1e9]),  # huge jump but cap is off
        )
        result = session.run(deltas=[])
        self.assertFalse(result["wall_capped"])
        self.assertTrue(result["report"]["ok"])


class NoGraphParityTests(unittest.TestCase):
    """graph=None runs the identical state machine and yields the same result as MockGraph."""

    def _script(self):
        return [
            _analyze_json(("movement", "shift")),
            _plan_json(("write toy", "author", [0, 1])),
            _fenced(TOY_GAME_SOURCE),
        ]

    def test_no_graph_matches_mock_graph(self):
        cfg = _fast_config()
        s_none = SynthSession(
            "toy", _SUITE, FakeLlm(self._script()), graph=None, config=cfg, sleep=lambda s: None
        )
        r_none = s_none.run(deltas=["d"])
        s_mock = SynthSession(
            "toy", _SUITE, FakeLlm(self._script()), graph=MockGraph(), config=cfg,
            sleep=lambda s: None,
        )
        r_mock = s_mock.run(deltas=["d"])
        self.assertEqual(r_none["report"], r_mock["report"])
        self.assertEqual(r_none["program_source"], r_mock["program_source"])
        # Same step NAMES and statuses in the same order (task_keys differ: "" vs "mock/N").
        names_none = [(s["name"], s["status"]) for s in r_none["steps"]]
        names_mock = [(s["name"], s["status"]) for s in r_mock["steps"]]
        self.assertEqual(names_none, names_mock)

    def test_no_graph_task_keys_empty(self):
        s = SynthSession(
            "toy", _SUITE, FakeLlm(self._script()), graph=None, config=_fast_config(),
            sleep=lambda s: None,
        )
        result = s.run(deltas=[])
        self.assertTrue(all(step["task_key"] == "" for step in result["steps"]))


class _FakeResp:
    def __init__(self, payload):
        self._data = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class DaemonGraphTests(unittest.TestCase):
    """DaemonGraph maps ops onto the documented endpoints and parses /task/context summaries."""

    def _patched(self, responses, monkey):
        """Return a DaemonGraph whose urlopen yields ``responses`` in order (a dict per call)."""

        import bench.arc_agi3_zonoid.ewm.synth_graph as sg

        calls = []

        def fake_urlopen(req, timeout=None):
            calls.append({"url": req.full_url, "method": req.get_method(),
                          "body": req.data.decode("utf-8") if req.data else None})
            return _FakeResp(responses[len(calls) - 1])

        monkey(sg.request, "urlopen", fake_urlopen)
        graph = DaemonGraph(
            "http://localhost:8787", "/ws", agent_id="a1", session_id="s1", data_dir=None
        )
        return graph, calls

    def test_task_context_parses_summaries(self):
        import bench.arc_agi3_zonoid.ewm.synth_graph as sg

        orig = sg.request.urlopen
        try:
            sg.request.urlopen = lambda req, timeout=None: _FakeResp(
                {"dependencySummaries": [
                    {"summary": "note one"},
                    {"summary": "  "},         # blank -> dropped
                    {"label": "no summary"},   # missing -> dropped
                    {"summary": "note two"},
                ]}
            )
            graph = DaemonGraph("http://x", "/ws", agent_id="a", session_id="s")
            self.assertEqual(graph.task_context("mock/1"), ["note one", "note two"])
        finally:
            sg.request.urlopen = orig

    def test_claim_and_complete_post_status(self):
        import bench.arc_agi3_zonoid.ewm.synth_graph as sg

        orig = sg.request.urlopen
        bodies = []
        try:
            def cap(req, timeout=None):
                bodies.append(json.loads(req.data.decode("utf-8")))
                return _FakeResp({"ok": True})

            sg.request.urlopen = cap
            graph = DaemonGraph("http://x", "/ws", agent_id="a1", session_id="s1")
            graph.claim("mock/9")
            graph.complete("mock/9", "tested", "done")
            self.assertEqual(bodies[0]["status"], "in_progress")
            self.assertEqual(bodies[0]["key"], "mock/9")
            self.assertEqual(bodies[0]["agent_id"], "a1")
            self.assertEqual(bodies[1]["status"], "tested")
            self.assertEqual(bodies[1]["summary"], "done")
        finally:
            sg.request.urlopen = orig

    def test_create_task_via_file_drop(self):
        import os
        import tempfile

        import bench.arc_agi3_zonoid.ewm.synth_graph as sg

        orig = sg.request.urlopen
        try:
            sync_bodies = []

            def cap(req, timeout=None):
                sync_bodies.append(req.full_url)
                return _FakeResp({"ok": True, "adopted": ["local/synth-1"]})

            sg.request.urlopen = cap
            with tempfile.TemporaryDirectory() as d:
                graph = DaemonGraph(
                    "http://x", "/some/ws", agent_id="a", session_id="s",
                    harness="local", data_dir=d,
                )
                key = graph.create_task("game x analyze", "desc")
                self.assertEqual(key, "local/synth-1")
                # Stub file exists under the documented layout.
                found = []
                for root, _dirs, files in os.walk(d):
                    for f in files:
                        if f.endswith(".json"):
                            found.append(os.path.join(root, f))
                self.assertEqual(len(found), 1)
                with open(found[0]) as fh:
                    stub = json.load(fh)
                self.assertEqual(stub["id"], "synth-1")
                self.assertEqual(stub["subject"], "game x analyze")
                self.assertTrue(sync_bodies and sync_bodies[0].endswith("/sync"))
        finally:
            sg.request.urlopen = orig

    def test_create_task_no_data_dir_degrades(self):
        graph = DaemonGraph("http://x", "/ws", agent_id="a", session_id="s", data_dir=None)
        self.assertEqual(graph.create_task("t", "d"), "")

    def test_endpoint_paths_match_probed_daemon(self):
        """Paths + query params match the LIVE daemon routes probed against localhost:8787:
        GET /task/context?workspace=..&key=..; POST /overlay/status (claim/complete); POST
        /overlay/note; POST /sync (file-drop adoption). The daemon reads `key` (NOT `task_key`) on
        /task/context — a task_key-only request returns 'unknown task'."""

        import bench.arc_agi3_zonoid.ewm.synth_graph as sg

        orig = sg.request.urlopen
        seen = []
        try:
            def cap(req, timeout=None):
                seen.append({
                    "url": req.full_url,
                    "method": req.get_method(),
                    "body": json.loads(req.data.decode("utf-8")) if req.data else None,
                })
                return _FakeResp({"dependencySummaries": []})

            sg.request.urlopen = cap
            graph = DaemonGraph(
                "http://localhost:8787", "/Users/imyu/Desktop/zonoid",
                agent_id="a1", session_id="s1", data_dir=None,
            )
            graph.task_context("k/1")
            graph.claim("k/1")
            graph.complete("k/1", "tested", "done")
            graph.note("T", "S", ["k/1"])
        finally:
            sg.request.urlopen = orig

        ctx = seen[0]
        self.assertEqual(ctx["method"], "GET")
        self.assertIn("/task/context?", ctx["url"])
        self.assertIn("key=k%2F1", ctx["url"])                 # daemon param is `key`, url-encoded
        self.assertIn("workspace=", ctx["url"])
        self.assertNotIn("task_key=", ctx["url"])              # NOT task_key (README is stale)

        claim = seen[1]
        self.assertTrue(claim["url"].endswith("/overlay/status"))
        self.assertEqual(claim["body"]["status"], "in_progress")
        self.assertEqual(claim["body"]["key"], "k/1")

        done = seen[2]
        self.assertTrue(done["url"].endswith("/overlay/status"))
        self.assertEqual(done["body"]["status"], "tested")

        note = seen[3]
        self.assertTrue(note["url"].endswith("/overlay/note"))
        self.assertEqual(note["body"]["title"], "T")
        self.assertIn("workspace", note["body"])              # daemon requires workspace on /overlay/note

    def test_note_omits_empty_wires_to(self):
        # Synthetic-safety principle (Run-30): never send an EMPTY wires_to param.
        import bench.arc_agi3_zonoid.ewm.synth_graph as sg

        orig = sg.request.urlopen
        bodies = []
        try:
            def cap(req, timeout=None):
                bodies.append(json.loads(req.data.decode("utf-8")))
                return _FakeResp({"ok": True})

            sg.request.urlopen = cap
            graph = DaemonGraph("http://x", "/ws", agent_id="a", session_id="s")
            graph.note("T", "S", [])
            graph.note("T2", "S2", [""])  # falsy keys are dropped, not sent
        finally:
            sg.request.urlopen = orig
        self.assertEqual(len(bodies), 2)
        self.assertNotIn("wires_to", bodies[0])
        self.assertNotIn("wires_to", bodies[1])

    def test_note_404_retries_once_without_wires_to(self):
        """Run-36: the daemon's phantom-node guard 404s /overlay/note when wires_to names a task it
        never adopted (file-drop adoption is best-effort), losing the note. note() must retry once
        WITHOUT wires_to so the note body survives."""

        import bench.arc_agi3_zonoid.ewm.synth_graph as sg
        from urllib import error as urlerr

        orig = sg.request.urlopen
        bodies = []
        try:
            def cap(req, timeout=None):
                body = json.loads(req.data.decode("utf-8"))
                bodies.append(body)
                if "wires_to" in body:
                    raise urlerr.HTTPError(req.full_url, 404, "not found", {}, None)
                return _FakeResp({"ok": True})

            sg.request.urlopen = cap
            graph = DaemonGraph("http://x", "/ws", agent_id="a", session_id="s")
            graph.note("game x analyze", "mechanics", ["local/synth-1"])
        finally:
            sg.request.urlopen = orig
        self.assertEqual(len(bodies), 2)
        self.assertEqual(bodies[0]["wires_to"], ["local/synth-1"])  # first try keeps provenance
        self.assertNotIn("wires_to", bodies[1])                     # retry drops ONLY the wiring
        self.assertEqual(bodies[1]["title"], "game x analyze")
        self.assertEqual(bodies[1]["summary"], "mechanics")
        self.assertEqual(bodies[1]["workspace"], "/ws")

    def test_note_outage_does_not_retry(self):
        # A non-404 failure (real outage) is NOT the phantom-node guard: no blind retry.
        import bench.arc_agi3_zonoid.ewm.synth_graph as sg
        from urllib import error as urlerr

        orig = sg.request.urlopen
        calls = []
        try:
            def boom(req, timeout=None):
                calls.append(1)
                raise urlerr.URLError("connection refused")

            sg.request.urlopen = boom
            graph = DaemonGraph("http://x", "/ws", agent_id="a", session_id="s")
            graph.note("T", "S", ["local/synth-1"])
        finally:
            sg.request.urlopen = orig
        self.assertEqual(len(calls), 1)

    def test_note_success_posts_once_with_wires_to(self):
        import bench.arc_agi3_zonoid.ewm.synth_graph as sg

        orig = sg.request.urlopen
        bodies = []
        try:
            def cap(req, timeout=None):
                bodies.append(json.loads(req.data.decode("utf-8")))
                return _FakeResp({"ok": True})

            sg.request.urlopen = cap
            graph = DaemonGraph("http://x", "/ws", agent_id="a", session_id="s")
            graph.note("T", "S", ["local/synth-1"])
        finally:
            sg.request.urlopen = orig
        self.assertEqual(len(bodies), 1)
        self.assertEqual(bodies[0]["wires_to"], ["local/synth-1"])

    def test_graph_ops_counters_track_live_vs_degraded(self):
        """graph_ops_ok / graph_ops_failed let a run report whether graph mode was actually live."""

        import bench.arc_agi3_zonoid.ewm.synth_graph as sg
        from urllib import error as urlerr

        orig = sg.request.urlopen
        try:
            sg.request.urlopen = lambda req, timeout=None: _FakeResp({"dependencySummaries": []})
            graph = DaemonGraph("http://x", "/ws", agent_id="a", session_id="s")
            graph.task_context("k/1")
            graph.claim("k/1")
            self.assertEqual((graph.graph_ops_ok, graph.graph_ops_failed), (2, 0))

            def boom(req, timeout=None):
                raise urlerr.URLError("refused")

            sg.request.urlopen = boom
            graph.task_context("k/1")   # degraded call -> failed++
            self.assertEqual((graph.graph_ops_ok, graph.graph_ops_failed), (2, 1))
        finally:
            sg.request.urlopen = orig


class DaemonOutageTests(unittest.TestCase):
    """A daemon outage degrades DaemonGraph to no-graph behavior without ever raising."""

    def _outage_graph(self):
        import bench.arc_agi3_zonoid.ewm.synth_graph as sg
        from urllib import error as urlerr

        self._orig = sg.request.urlopen

        def boom(req, timeout=None):
            raise urlerr.URLError("connection refused")

        sg.request.urlopen = boom
        return DaemonGraph("http://x", "/ws", agent_id="a", session_id="s", data_dir=None)

    def tearDown(self):
        import bench.arc_agi3_zonoid.ewm.synth_graph as sg

        if hasattr(self, "_orig"):
            sg.request.urlopen = self._orig

    def test_ops_swallow_outage(self):
        graph = self._outage_graph()
        # None of these raise.
        self.assertEqual(graph.task_context("k"), [])
        self.assertIsNone(graph.claim("k"))
        self.assertIsNone(graph.complete("k", "tested", "s"))
        self.assertIsNone(graph.note("t", "s", ["k"]))

    def test_session_runs_through_daemon_outage(self):
        """A full session over an outaged DaemonGraph still synthesizes (degrades to no-graph)."""

        graph = self._outage_graph()
        llm = FakeLlm(
            [
                _analyze_json(("movement", "shift")),
                _plan_json(("write toy", "author", [0, 1])),
                _fenced(TOY_GAME_SOURCE),
            ]
        )
        session = SynthSession(
            "toy", _SUITE, llm, graph=graph, config=_fast_config(), sleep=lambda s: None
        )
        result = session.run(deltas=["d"])
        # Task keys are empty (create_task degraded) but the program still validated.
        self.assertTrue(result["report"]["ok"])
        self.assertTrue(all(step["task_key"] == "" for step in result["steps"]))


if __name__ == "__main__":
    unittest.main()
