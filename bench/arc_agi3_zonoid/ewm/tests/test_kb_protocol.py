"""Tests for the EWM KB protocol: mode-scoped search, acceptance writes, outage swallowing."""

from __future__ import annotations

import io
import json
import unittest
from unittest import mock
from urllib import error, parse

from bench.arc_agi3_zonoid.ewm import kb_protocol
from bench.arc_agi3_zonoid.ewm.kb_protocol import KbClient, WriteGate, looks_like_grid_dump


WORKSPACE = "/Users/imyu/Desktop/zonoid"
TASK_KEY = "codex/ewm-kb-protocol-mode-scoped-search-acceptance-writes"


class _FakeResponse(io.BytesIO):
    """Context-manager BytesIO standing in for an http.client response."""

    def __enter__(self) -> "_FakeResponse":  # noqa: D401
        return self

    def __exit__(self, *exc: object) -> bool:
        self.close()
        return False


class _Recorder:
    """Captures urlopen requests and replays a canned JSON body."""

    def __init__(self, payload: object = None) -> None:
        self.payload = payload if payload is not None else []
        self.calls: list[dict[str, object]] = []

    def __call__(self, req, timeout=None):  # noqa: ANN001
        self.calls.append(
            {
                "url": req.full_url,
                "method": req.get_method(),
                "body": None if req.data is None else req.data.decode("utf-8"),
                "timeout": timeout,
            }
        )
        return _FakeResponse(json.dumps(self.payload).encode("utf-8"))


def _client() -> KbClient:
    return KbClient("http://localhost:8787", WORKSPACE, TASK_KEY, timeout_s=7)


def _query(url: str) -> dict[str, list[str]]:
    return parse.parse_qs(parse.urlsplit(url).query)


class KbClientSearchTest(unittest.TestCase):
    def test_search_route_and_params(self) -> None:
        rec = _Recorder([{"title": "hit"}])
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            out = _client().search("game ls20 world model program", k=1, gated=False)
        self.assertEqual(out, [{"title": "hit"}])
        self.assertEqual(len(rec.calls), 1)
        call = rec.calls[0]
        self.assertEqual(call["method"], "GET")
        self.assertTrue(call["url"].startswith("http://localhost:8787/search?"))
        self.assertEqual(call["timeout"], 7)
        q = _query(call["url"])
        self.assertEqual(q["workspace"], [WORKSPACE])
        self.assertEqual(q["task_key"], [TASK_KEY])
        self.assertEqual(q["q"], ["game ls20 world model program"])
        self.assertEqual(q["k"], ["1"])
        self.assertEqual(q["gated"], ["false"])

    def test_search_gated_true(self) -> None:
        rec = _Recorder([])
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            _client().search("q", k=4, gated=True)
        self.assertEqual(_query(rec.calls[0]["url"])["gated"], ["true"])

    def test_search_extracts_wrapped_results(self) -> None:
        rec = _Recorder({"results": [{"a": 1}, "junk", {"b": 2}]})
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            out = _client().search("q", k=4)
        self.assertEqual(out, [{"a": 1}, {"b": 2}])

    def test_search_swallows_network_error(self) -> None:
        def boom(req, timeout=None):  # noqa: ANN001
            raise error.URLError("connection refused")

        with mock.patch.object(kb_protocol.request, "urlopen", boom):
            out = _client().search("q", k=4)
        self.assertEqual(out, [])


class KbClientNoteTest(unittest.TestCase):
    def test_note_route_body_and_wires_to(self) -> None:
        rec = _Recorder({"ok": True, "id": "note-1"})
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            out = _client().note("game ls20 solution", "some prose")
        self.assertEqual(out, {"ok": True, "id": "note-1"})
        call = rec.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["url"], "http://localhost:8787/overlay/note")
        body = json.loads(call["body"])
        self.assertEqual(body["workspace"], WORKSPACE)
        self.assertEqual(body["wires_to"], [TASK_KEY])
        self.assertEqual(body["title"], "game ls20 solution")
        self.assertEqual(body["category"], "arc-agi-3")
        self.assertNotIn("supersedes", body)

    def test_note_supersedes_passthrough(self) -> None:
        rec = _Recorder({"ok": True})
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            _client().note("t", "s", supersedes="note-old")
        self.assertEqual(json.loads(rec.calls[0]["body"])["supersedes"], "note-old")

    def test_note_swallows_network_error(self) -> None:
        def boom(req, timeout=None):  # noqa: ANN001
            raise error.URLError("down")

        with mock.patch.object(kb_protocol.request, "urlopen", boom):
            out = _client().note("t", "s")
        self.assertFalse(out["ok"])
        self.assertIn("error", out)


class ModeScopedSearchTest(unittest.TestCase):
    def _run(self, mode: str, **kw) -> tuple[_Recorder, list]:
        rec = _Recorder([])
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            out = kb_protocol.search_for_mode(mode, "ls20", client=_client(), **kw)
        return rec, out

    def test_plan_and_execute_make_zero_http_calls(self) -> None:
        for mode in ("PLAN", "EXECUTE", "plan", "execute"):
            rec, out = self._run(mode)
            self.assertEqual(out, [])
            self.assertEqual(rec.calls, [], f"{mode} must not hit the network")

    def test_orient_keyed_lookup_k1(self) -> None:
        rec, _ = self._run("ORIENT")
        q = _query(rec.calls[0]["url"])
        self.assertEqual(q["k"], ["1"])
        self.assertIn("world", q["q"][0])
        self.assertIn("program", q["q"][0])
        self.assertIn("ls20", q["q"][0])

    def test_synthesize_uses_vocabulary_k4(self) -> None:
        rec, _ = self._run("SYNTHESIZE", vocabulary=["blueKey", "door", "push"])
        q = _query(rec.calls[0]["url"])
        self.assertEqual(q["k"], ["4"])
        query = q["q"][0]
        # camelCase must be split into standalone tokens
        self.assertIn("blue", query)
        self.assertIn("key", query)
        self.assertNotIn("bluekey", query)
        self.assertIn("door", query)

    def test_repair_uses_divergence_k4(self) -> None:
        rec, _ = self._run("REPAIR", divergence="wall collision mispredicted")
        q = _query(rec.calls[0]["url"])
        self.assertEqual(q["k"], ["4"])
        query = q["q"][0]
        self.assertIn("failed", query)
        self.assertIn("repair", query)
        self.assertIn("collision", query)

    def test_recover_k4(self) -> None:
        rec, _ = self._run("RECOVER")
        q = _query(rec.calls[0]["url"])
        self.assertEqual(q["k"], ["4"])
        self.assertIn("modelability", q["q"][0])

    def test_query_tokens_are_standalone(self) -> None:
        rec, _ = self._run("ORIENT")
        query = _query(rec.calls[0]["url"])["q"][0]
        # no camelCase / hyphen fusion survives
        self.assertNotRegex(query, r"[a-z][A-Z]")
        self.assertNotIn("-", query)

    def test_unknown_mode_raises(self) -> None:
        with self.assertRaises(ValueError):
            kb_protocol.search_for_mode("WANDER", "ls20", client=_client())

    def test_missing_client_raises_for_search_mode(self) -> None:
        with self.assertRaises(ValueError):
            kb_protocol.search_for_mode("ORIENT", "ls20")


class GridDumpHeuristicTest(unittest.TestCase):
    def test_stacked_grid_rejected(self) -> None:
        body = "insight: pushed block\n0 1 2\n3 4 5\n6 7 8\ndone"
        self.assertTrue(looks_like_grid_dump(body))

    def test_flattened_row_rejected(self) -> None:
        self.assertTrue(looks_like_grid_dump("state 000111222333 collapsed"))

    def test_prose_accepted(self) -> None:
        body = "unlocking insight: move the block onto tile 3 then press action 2 twice"
        self.assertFalse(looks_like_grid_dump(body))

    def test_two_grid_lines_not_rejected(self) -> None:
        # fewer than 3 consecutive digit-only lines is allowed prose
        self.assertFalse(looks_like_grid_dump("0 1 2\n3 4 5\nmoved right"))


class WriteGateTest(unittest.TestCase):
    def _gate(self, payload=None):
        rec = _Recorder(payload if payload is not None else {"ok": True, "id": "n"})
        client = _client()
        gate = WriteGate(client, max_writes_per_turn=2)
        gate.begin_turn()
        return rec, gate

    def test_write_cap_enforced(self) -> None:
        rec, gate = self._gate()
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            r1 = gate.write_failed_repair("ls20", "tried A, diverged")
            r2 = gate.write_failed_repair("ls20", "tried B, diverged")
            r3 = gate.write_failed_repair("ls20", "tried C, diverged")
        self.assertTrue(r1["ok"])
        self.assertTrue(r2["ok"])
        self.assertEqual(r3, {"ok": False, "reason": "write cap"})
        self.assertEqual(len(rec.calls), 2)

    def test_begin_turn_resets_cap(self) -> None:
        rec, gate = self._gate()
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            gate.write_failed_repair("ls20", "a")
            gate.write_failed_repair("ls20", "b")
            gate.begin_turn()
            r3 = gate.write_failed_repair("ls20", "c")
        self.assertTrue(r3["ok"])
        self.assertEqual(len(rec.calls), 3)

    def test_grid_dump_rejected_and_no_http(self) -> None:
        rec, gate = self._gate()
        dump = "0 1 2\n3 4 5\n6 7 8\n9 0 1"
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            out = gate.write_program_revision("ls20", dump, "def f(): pass", "3/3")
        self.assertEqual(out, {"ok": False, "reason": "grid dump"})
        self.assertEqual(rec.calls, [])

    def test_program_revision_supersede_passthrough(self) -> None:
        rec, gate = self._gate()
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            gate.write_program_revision(
                "ls20", "handles push mechanic", "def step(): ...", "5/5",
                supersedes="note-prev",
            )
        body = json.loads(rec.calls[0]["body"])
        self.assertEqual(body["supersedes"], "note-prev")
        self.assertIn("pass rate: 5/5", body["summary"])
        self.assertIn("program source", body["summary"])

    def test_titles_are_standalone_tokens(self) -> None:
        rec, gate = self._gate()
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            gate.write_level_solution("ls20", 2, ["ACTION1", "ACTION2"], "align then push")
            gate.write_mechanic_pattern("gravityPull", "objects fall", "def g(): ...")
        t1 = json.loads(rec.calls[0]["body"])
        title1 = t1["title"]
        self.assertEqual(title1, "game ls20 level 2 solution")
        title2 = json.loads(rec.calls[1]["body"])["title"]
        # camelCase name split into standalone tokens
        self.assertEqual(title2, "mechanic pattern gravity pull")

    def test_modelability_verdict_supersede(self) -> None:
        rec, gate = self._gate()
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            gate.write_modelability_verdict(
                "ls20", "modelable", "suite stabilized at 6/6", supersedes="note-v0"
            )
        body = json.loads(rec.calls[0]["body"])
        self.assertEqual(body["title"], "game ls20 modelability verdict")
        self.assertEqual(body["supersedes"], "note-v0")
        self.assertIn("modelable", body["summary"])

    def test_level_solution_actions_joined(self) -> None:
        rec, gate = self._gate()
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            gate.write_level_solution("ls20", 1, [1, 2, 3], "go right")
        self.assertIn("1 2 3", json.loads(rec.calls[0]["body"])["summary"])


if __name__ == "__main__":
    unittest.main()
