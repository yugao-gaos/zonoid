"""Tests for the EWM KB protocol: mode-scoped search, acceptance writes, outage swallowing."""

from __future__ import annotations

import io
import json
import re
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

    def test_search_synthetic_task_key_omits_param(self) -> None:
        # Run-35b: the daemon corroboration gate (memory-search.js:841, CORROBORATION_MIN=2)
        # prunes uncorroborated note hits on task_key-scoped searches; a synthetic key can never
        # corroborate its notes, so the synthetic client must send NO task_key param at all.
        rec = _Recorder([])
        client = KbClient(
            "http://localhost:8787",
            WORKSPACE,
            "ewm-live-ls20",
            timeout_s=7,
            synthetic_task_key=True,
        )
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            client.search("game ls20 world model program", k=1)
        q = _query(rec.calls[0]["url"])
        self.assertNotIn("task_key", q)
        self.assertEqual(q["workspace"], [WORKSPACE])

    def test_search_real_task_key_still_sent(self) -> None:
        # Run-35b guard: a REAL graph task key keeps sending task_key unchanged — tiered
        # retrieval for genuine graph tasks is intended.
        rec = _Recorder([])
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            _client().search("q", k=4)
        self.assertEqual(_query(rec.calls[0]["url"])["task_key"], [TASK_KEY])

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

    def test_note_synthetic_task_key_omits_wires_to(self) -> None:
        # Run-30: a synthetic key (the driver's "ewm-live-<game>" fallback) is not a real graph
        # task, and the daemon's phantom-node guard 404s any wires_to naming an unknown task — the
        # bug that dropped run 30's five first-ever live interaction discoveries. The field must be
        # ABSENT from the POST body (not empty, not null).
        rec = _Recorder({"ok": True, "id": "note-1"})
        client = KbClient(
            "http://localhost:8787",
            WORKSPACE,
            "ewm-live-ls20",
            timeout_s=7,
            synthetic_task_key=True,
        )
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            out = client.note("game ls20 interaction 6", "some prose")
        self.assertEqual(out, {"ok": True, "id": "note-1"})
        body = json.loads(rec.calls[0]["body"])
        self.assertNotIn("wires_to", body)
        self.assertEqual(body["workspace"], WORKSPACE)
        self.assertEqual(body["title"], "game ls20 interaction 6")
        self.assertEqual(body["category"], "arc-agi-3")

    def test_coverage_write_synthetic_client_sends_no_wires_to(self) -> None:
        # The Run-30 rule holds for EVERY write path funneled through KbClient.note — the coverage
        # chunk+index writes included: no POST body carries wires_to on a synthetic client.
        rec = _Recorder({"ok": True, "id": "note-1"})
        client = KbClient(
            "http://localhost:8787",
            WORKSPACE,
            "ewm-live-ls20",
            timeout_s=7,
            synthetic_task_key=True,
        )
        gate = WriteGate(client)
        body = kb_protocol.encode_coverage_state(
            {(1, 2, 3)}, {("<bump>", "obj1")}, board_cells=9
        )
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            out = gate.write_coverage_state("ls20", body)
        self.assertTrue(out["ok"])
        self.assertGreaterEqual(len(rec.calls), 2)  # chunk note(s) + index note
        for call in rec.calls:
            self.assertNotIn("wires_to", json.loads(call["body"]))

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


class KbClientGetNoteFullTest(unittest.TestCase):
    def test_get_note_full_route_and_params(self) -> None:
        payload = {
            "ok": True,
            "key": "note:abc",
            "title": "game ls20 world model program",
            "full_body": "```python\ndef init_state(f):\n    return f\n```",
            "chunk_count": 2,
            "byte_length": 44,
        }
        rec = _Recorder(payload)
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            out = _client().get_note_full("note:abc")
        self.assertEqual(out, payload)
        call = rec.calls[0]
        self.assertEqual(call["method"], "GET")
        self.assertTrue(call["url"].startswith("http://localhost:8787/note/get?"))
        q = _query(call["url"])
        self.assertEqual(q["workspace"], [WORKSPACE])
        self.assertEqual(q["key"], ["note:abc"])
        self.assertEqual(q["full"], ["1"])

    def test_get_note_full_swallows_network_error(self) -> None:
        def boom(req, timeout=None):  # noqa: ANN001
            raise error.URLError("down")

        with mock.patch.object(kb_protocol.request, "urlopen", boom):
            out = _client().get_note_full("note:abc")
        self.assertFalse(out["ok"])
        self.assertIn("error", out)

    def test_get_note_full_swallows_http_404(self) -> None:
        def boom(req, timeout=None):  # noqa: ANN001
            raise error.HTTPError(req.full_url, 404, "not found", {}, None)

        with mock.patch.object(kb_protocol.request, "urlopen", boom):
            out = _client().get_note_full("note:missing")
        self.assertFalse(out["ok"])
        self.assertEqual(out["error"], "http 404")


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

    def test_orient_keyed_lookup(self) -> None:
        # ORIENT fetches a small candidate pool (k=4, full_content) so a CHUNKED program's index note
        # can be picked out from among its chunk notes (which share the program query tokens).
        rec, _ = self._run("ORIENT")
        q = _query(rec.calls[0]["url"])
        self.assertEqual(q["k"], ["20"])
        self.assertEqual(q["full_content"], ["1"])
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
            gate.write_mechanism_hypothesis(
                "gravityPull", ["fall", "block"], "drop a block", "objects fall", ["ls20"]
            )
        t1 = json.loads(rec.calls[0]["body"])
        title1 = t1["title"]
        self.assertEqual(title1, "game ls20 level 2 solution")
        title2 = json.loads(rec.calls[1]["body"])["title"]
        # camelCase name split into standalone tokens
        self.assertEqual(title2, "mechanism hypothesis gravity pull")

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

    def test_interaction_title_and_body(self) -> None:
        rec, gate = self._gate()
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            gate.write_interaction(
                "ls20", "SPACE", "player adjacent to object class abc123",
                "changed 4 cells beyond the auto-changing region at rows 1-2 cols 3-4",
            )
        body = json.loads(rec.calls[0]["body"])
        # Standalone-token title (lowercased) so it round-trips for an interaction query.
        self.assertEqual(body["title"], "game ls20 interaction space")
        self.assertIn("player adjacent to object class abc123", body["summary"])
        self.assertIn("changed 4 cells", body["summary"])


class MechanismHypothesisSchemaTest(unittest.TestCase):
    def _gate(self, payload=None):
        rec = _Recorder(payload if payload is not None else {"ok": True, "id": "n"})
        gate = WriteGate(_client(), max_writes_per_turn=5)
        gate.begin_turn()
        return rec, gate

    def test_body_rendered_in_hypothesis_form(self) -> None:
        rec, gate = self._gate()
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            out = gate.write_mechanism_hypothesis(
                "gravity pull",
                cues=["falling block", "empty below"],
                probe="drop a block and watch",
                dynamics="pull loose objects downward until blocked",
                observed_in=["ls20", "ft09"],
            )
        self.assertTrue(out["ok"])
        body = json.loads(rec.calls[0]["body"])["summary"]
        self.assertTrue(body.startswith("SOME games pull loose objects downward"))
        self.assertIn("Cues: falling block, empty below.", body)
        self.assertIn("Probe: drop a block and watch.", body)
        self.assertIn("Observed in: ls20, ft09.", body)
        # never stated as a fact about THIS game
        self.assertNotIn("this game", body.lower())

    def test_title_is_standalone_tokens(self) -> None:
        rec, gate = self._gate()
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            gate.write_mechanism_hypothesis(
                "gravityPull", ["x"], "p", "objects fall", ["ls20"]
            )
        title = json.loads(rec.calls[0]["body"])["title"]
        self.assertEqual(title, "mechanism hypothesis gravity pull")

    def test_absolute_coordinate_in_dynamics_rejected(self) -> None:
        rec, gate = self._gate()
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            out = gate.write_mechanism_hypothesis(
                "wall", ["edge"], "p", "block stops at row 40", ["ls20"]
            )
        self.assertEqual(out, {"ok": False, "reason": "absolute coordinate"})
        self.assertEqual(rec.calls, [])

    def test_absolute_coordinate_range_and_pair_rejected(self) -> None:
        rec, gate = self._gate()
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            r1 = gate.write_mechanism_hypothesis(
                "a", ["cols 34-38"], "p", "objects fall", ["ls20"]
            )
            r2 = gate.write_mechanism_hypothesis(
                "b", ["c"], "p", "spawns at (40,34)", ["ls20"]
            )
            r3 = gate.write_mechanism_hypothesis(
                "c", ["c"], "p", "target sits near 40, 34 always", ["ls20"]
            )
        self.assertEqual(r1["reason"], "absolute coordinate")
        self.assertEqual(r2["reason"], "absolute coordinate")
        self.assertEqual(r3["reason"], "absolute coordinate")
        self.assertEqual(rec.calls, [])

    def test_relative_dynamics_accepted(self) -> None:
        rec, gate = self._gate()
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            out = gate.write_mechanism_hypothesis(
                "push", ["adjacent block"], "nudge it", "push blocks in the move direction",
                ["ls20"],
            )
        self.assertTrue(out["ok"])
        self.assertEqual(len(rec.calls), 1)

    def test_foreign_game_id_rejected(self) -> None:
        rec, gate = self._gate()
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            out = gate.write_mechanism_hypothesis(
                "warp",
                cues=["seen in vc99"],
                probe="p",
                dynamics="objects teleport",
                observed_in=["ls20"],
            )
        self.assertEqual(out, {"ok": False, "reason": "foreign game id"})
        self.assertEqual(rec.calls, [])

    def test_observed_game_id_allowed_in_body(self) -> None:
        rec, gate = self._gate()
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            out = gate.write_mechanism_hypothesis(
                "warp", ["cue"], "p", "behaves like ls20 warp", observed_in=["ls20"]
            )
        self.assertTrue(out["ok"])


class MechanicPatternAliasTest(unittest.TestCase):
    def _gate(self):
        rec = _Recorder({"ok": True, "id": "n"})
        gate = WriteGate(_client(), max_writes_per_turn=5)
        gate.begin_turn()
        return rec, gate

    def test_alias_maps_prose_to_dynamics_and_flags_legacy(self) -> None:
        rec, gate = self._gate()
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            out = gate.write_mechanic_pattern("gravityPull", "objects fall downward", "def g(): ...")
        self.assertTrue(out["ok"])
        note = json.loads(rec.calls[0]["body"])
        self.assertEqual(note["title"], "mechanism hypothesis gravity pull")
        body = note["summary"]
        self.assertTrue(body.startswith("SOME games objects fall downward."))
        # empty cues/probe allowed but flagged legacy
        self.assertIn("Cues: .", body)
        self.assertIn("Probe: .", body)
        self.assertIn("legacy", body.lower())

    def test_alias_still_rejects_absolute_coordinates(self) -> None:
        rec, gate = self._gate()
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            out = gate.write_mechanic_pattern("wall", "block stops at row 40", "def g(): ...")
        self.assertEqual(out, {"ok": False, "reason": "absolute coordinate"})
        self.assertEqual(rec.calls, [])


class HypothesisMenuTest(unittest.TestCase):
    def _menu_notes(self):
        return [
            {"title": "mechanism hypothesis gravity pull",
             "summary": "SOME games pull blocks down. Cues: falling block, gravity."},
            {"title": "mechanism hypothesis door key",
             "summary": "SOME games open a door with a key. Cues: door, key, locked."},
            {"title": "mechanism hypothesis color swap",
             "summary": "SOME games swap colors. Cues: recolor, palette."},
        ]

    def test_preamble_prepended_and_ranked_by_overlap(self) -> None:
        rec = _Recorder(self._menu_notes())
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            menu = kb_protocol.hypothesis_menu(
                "zz01", ["door", "key", "locked"], k=5, client=_client()
            )
        self.assertTrue(menu["hypothesis_menu"])
        self.assertEqual(menu["preamble"], kb_protocol.HYPOTHESIS_MENU_PREAMBLE)
        self.assertTrue(menu["formatted"].startswith(kb_protocol.HYPOTHESIS_MENU_PREAMBLE))
        # door/key note ranks first (3 overlapping cue words vs 0)
        self.assertEqual(menu["notes"][0]["title"], "mechanism hypothesis door key")

    def test_menu_respects_k(self) -> None:
        rec = _Recorder(self._menu_notes())
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            menu = kb_protocol.hypothesis_menu("zz01", ["door"], k=2, client=_client())
        self.assertEqual(len(menu["notes"]), 2)

    def test_menu_requires_client(self) -> None:
        with self.assertRaises(ValueError):
            kb_protocol.hypothesis_menu("zz01", ["door"])


class _TruncatingDaemon:
    """Stateful mock daemon that honors BOTH real truncation limits, so a chunk round-trip test would
    have CAUGHT run 12's break (a single 3272-char note clipped past recall):

    * WRITE (POST /overlay/note): stores the note but clips its ``summary`` to WRITE_CLIP (2000).
    * READ  (GET /search): matches notes whose title contains every query token; returns a 200-char
      ``summary`` always, and — only when ``full_content=1`` — a ``content`` field clipped to
      READ_CAP (1200). This is exactly the daemon behavior verified live against localhost:8787.
    """

    WRITE_CLIP = 2000
    READ_CAP = 1200

    def __init__(self) -> None:
        self.notes: list[dict[str, str]] = []
        self._counter = 0

    def __call__(self, req, timeout=None):  # noqa: ANN001
        url = req.full_url
        if req.get_method() == "POST":
            body = json.loads(req.data.decode("utf-8"))
            self._counter += 1
            self.notes.append(
                {
                    "id": f"note-{self._counter}",
                    "title": str(body.get("title", "")),
                    # WRITE clip: the daemon stores at most WRITE_CLIP chars of the body.
                    "stored": str(body.get("summary", ""))[: self.WRITE_CLIP],
                }
            )
            return _FakeResponse(json.dumps({"ok": True, "id": f"note-{self._counter}"}).encode("utf-8"))
        # GET /search
        parsed = parse.urlsplit(url)
        params = parse.parse_qs(parsed.query)
        q = (params.get("q") or [""])[0]
        k = int((params.get("k") or ["5"])[0])
        full_content = (params.get("full_content") or ["0"])[0] in ("1", "true")
        q_tokens = set(t for t in re.split(r"[^0-9A-Za-z]+", q.lower()) if t)
        results = []
        for note in self.notes:
            title_tokens = set(t for t in re.split(r"[^0-9A-Za-z]+", note["title"].lower()) if t)
            if q_tokens and q_tokens.issubset(title_tokens):
                hit = {"title": note["title"], "summary": note["stored"][:200]}
                if full_content:
                    # READ cap: the content field returns at most READ_CAP chars of the stored body.
                    hit["content"] = note["stored"][: self.READ_CAP]
                # Relevance proxy: an EXACT title match outranks a token-superset match, mirroring the
                # real daemon (a "chunk 3 of 3" query's tokens are a subset of "chunk 1 of 3" too, so
                # without exact-match ranking the wrong chunk would win — the ambiguity the agent's
                # exact-title reassembler defends against).
                exact = note["title"].strip().lower() == q.strip().lower()
                results.append((0 if exact else 1, hit))
        results.sort(key=lambda pair: pair[0])
        return _FakeResponse(json.dumps([h for _, h in results[:k]]).encode("utf-8"))


class ChunkedProgramRoundTripTest(unittest.TestCase):
    """The chunked writer + reassembler must round-trip a program too big for a single note through a
    daemon that clips writes to 2000 and reads to 1200 — the run-12 defect."""

    def _big_program(self) -> str:
        # 3272-char pure-ASCII program, the exact size of the ls20 ceiling program that broke run 12.
        header = "# world model program for the round trip test\n"
        return header + "x = 0\n" * ((3272 - len(header)) // 6)

    def test_chunk_bodies_fit_stricter_limit(self) -> None:
        source = self._big_program()
        slices = kb_protocol.chunk_program_source(source)
        self.assertGreater(len(slices), 1)  # a >1200-char program must span multiple chunks
        for i, slice_text in enumerate(slices, start=1):
            body = f"chunk {i} of {len(slices)}\n{slice_text}"
            # Every chunk body must survive the STRICTER (1200) read cap intact.
            self.assertLessEqual(len(body), kb_protocol.CHUNK_BODY_LIMIT)

    def test_round_trip_through_truncating_daemon(self) -> None:
        source = self._big_program()
        daemon = _TruncatingDaemon()
        gate = WriteGate(_client(), max_writes_per_turn=2)
        gate.begin_turn()
        with mock.patch.object(kb_protocol.request, "urlopen", daemon):
            written = gate.write_program_revision_chunked(
                "ls20", "linked unit moves plus or minus 5", source, "12/13"
            )
        self.assertTrue(written["ok"])
        self.assertEqual(written["length"], len(source.encode("utf-8")))
        # index note + N chunk notes were stored.
        self.assertEqual(len(daemon.notes), written["chunks"] + 1)

        # Now recall the way ORIENT does: read the index note, then fetch chunks by exact title.
        client = _client()
        with mock.patch.object(kb_protocol.request, "urlopen", daemon):
            index_hits = kb_protocol.search_for_mode("ORIENT", "ls20", client=client)
            self.assertEqual(len(index_hits), 1)
            index_body = index_hits[0]["content"]
            chunk_count = int(kb_protocol._INDEX_CHUNKS_RE.search(index_body).group(1))
            source_length = int(kb_protocol._INDEX_LENGTH_RE.search(index_body).group(1))
            chunk_bodies = []
            for n in range(1, chunk_count + 1):
                title = kb_protocol.program_chunk_title("ls20", n, chunk_count)
                hits = client.search(title, k=1, full_content=True)
                chunk_bodies.append(hits[0]["content"])
        reassembled = kb_protocol.reassemble_chunks(
            chunk_bodies, expected_count=chunk_count, expected_length=source_length
        )
        # Byte-identical round trip — the property run 12 silently lacked.
        self.assertEqual(reassembled, source)

    def test_missing_chunk_refuses(self) -> None:
        source = self._big_program()
        daemon = _TruncatingDaemon()
        gate = WriteGate(_client(), max_writes_per_turn=2)
        gate.begin_turn()
        with mock.patch.object(kb_protocol.request, "urlopen", daemon):
            written = gate.write_program_revision_chunked("ls20", "prose", source, "12/13")
        # Drop one chunk note to simulate corruption/eviction.
        daemon.notes = [n for n in daemon.notes if "chunk 2 of" not in n["title"]]
        client = _client()
        with mock.patch.object(kb_protocol.request, "urlopen", daemon):
            chunk_bodies = []
            for n in range(1, written["chunks"] + 1):
                title = kb_protocol.program_chunk_title("ls20", n, written["chunks"])
                hits = client.search(title, k=1, full_content=True)
                chunk_bodies.append(hits[0]["content"] if hits else "")
        reassembled = kb_protocol.reassemble_chunks(
            chunk_bodies, expected_count=written["chunks"], expected_length=written["length"]
        )
        self.assertIsNone(reassembled)  # clean refusal, never a partial program

    def test_length_mismatch_refuses(self) -> None:
        source = self._big_program()
        slices = kb_protocol.chunk_program_source(source)
        bodies = [f"chunk {i} of {len(slices)}\n{s}" for i, s in enumerate(slices, start=1)]
        # A wrong expected length (one byte off) is a corruption signal -> refuse.
        out = kb_protocol.reassemble_chunks(
            bodies, expected_count=len(slices), expected_length=len(source.encode("utf-8")) + 1
        )
        self.assertIsNone(out)

    def test_reassemble_orders_shuffled_chunks(self) -> None:
        source = self._big_program()
        slices = kb_protocol.chunk_program_source(source)
        bodies = [f"chunk {i} of {len(slices)}\n{s}" for i, s in enumerate(slices, start=1)]
        shuffled = list(reversed(bodies))
        out = kb_protocol.reassemble_chunks(
            shuffled, expected_count=len(slices), expected_length=len(source.encode("utf-8"))
        )
        self.assertEqual(out, source)  # ordering is driven by the chunk header, not list order


class StrippedNewGameEntryTest(unittest.TestCase):
    def _client_with_hits(self, per_call):
        """Recorder that returns a different payload for each successive urlopen call."""

        calls = {"n": 0}

        def opener(req, timeout=None):  # noqa: ANN001
            idx = calls["n"]
            calls["n"] += 1
            payload = per_call[idx] if idx < len(per_call) else []
            return _FakeResponse(json.dumps(payload).encode("utf-8"))

        return opener

    def test_orient_new_game_returns_hypothesis_menu(self) -> None:
        # call 0 = ORIENT keyed lookup (no game-scoped note); call 1 = menu search
        opener = self._client_with_hits([
            [],
            [{"title": "mechanism hypothesis push", "summary": "SOME games push blocks."}],
        ])
        with mock.patch.object(kb_protocol.request, "urlopen", opener):
            out = kb_protocol.search_for_mode(
                "ORIENT", "zz01", vocabulary=["push", "block"], client=_client()
            )
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0]["hypothesis_menu"])
        self.assertTrue(out[0]["formatted"].startswith(kb_protocol.HYPOTHESIS_MENU_PREAMBLE))

    def test_orient_existing_game_returns_scoped_fact(self) -> None:
        # game-scoped note is keyed by game id in the title — returned as-is, no menu
        opener = self._client_with_hits([
            [{"title": "game zz01 world model program", "summary": "def step(): ..."}],
        ])
        with mock.patch.object(kb_protocol.request, "urlopen", opener):
            out = kb_protocol.search_for_mode(
                "ORIENT", "zz01", vocabulary=["push"], client=_client()
            )
        self.assertEqual(len(out), 1)
        self.assertNotIn("hypothesis_menu", out[0])
        self.assertIn("zz01", out[0]["title"])

    def test_synthesize_new_game_returns_hypothesis_menu(self) -> None:
        opener = self._client_with_hits([
            [{"title": "mechanism hypothesis door key", "summary": "SOME games open doors."}],
            [{"title": "mechanism hypothesis door key", "summary": "SOME games open doors."}],
        ])
        with mock.patch.object(kb_protocol.request, "urlopen", opener):
            out = kb_protocol.search_for_mode(
                "SYNTHESIZE", "zz01", vocabulary=["door", "key"], client=_client()
            )
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0]["hypothesis_menu"])

    def test_game_scoped_facts_keyed_by_game_id_convention(self) -> None:
        # convention assertion: fact titles carry the game id; menu items do NOT
        rec = _Recorder({"ok": True})
        gate = WriteGate(_client(), max_writes_per_turn=5)
        gate.begin_turn()
        with mock.patch.object(kb_protocol.request, "urlopen", rec):
            gate.write_program_revision("zz01", "handles push", "def s(): ...", "3/3")
            gate.write_modelability_verdict("zz01", "modelable", "stable")
        prog_title = json.loads(rec.calls[0]["body"])["title"]
        verdict_title = json.loads(rec.calls[1]["body"])["title"]
        self.assertTrue(prog_title.startswith("game zz01"))
        self.assertTrue(verdict_title.startswith("game zz01"))
        # a cross-game hypothesis title is NOT keyed by any game id
        self.assertNotRegex("mechanism hypothesis gravity pull", r"\b[a-z]{2,}\d+\b")


class CoverageStateCodecTest(unittest.TestCase):
    """Run-20: the cross-run coverage codec must round-trip visited cells + fired probes exactly, and
    RUN-LENGTH encode a contiguously-swept row so the body stays compact."""

    def test_encode_decode_round_trip(self) -> None:
        visited = {(1, 0, 0), (1, 0, 1), (1, 0, 2), (1, 2, 5), (2, 3, 3)}
        probes = {("SPACE", "objA"), ("<bump>", "objB"), ("FIRE", None)}
        body = kb_protocol.encode_coverage_state(
            visited, probes, board_cells=225, coverage_plateau=2
        )
        out = kb_protocol.decode_coverage_state(body)
        self.assertEqual(out["visited"], visited)
        self.assertEqual(out["probes"], probes)
        self.assertEqual(out["board"], 225)
        self.assertEqual(out["plateau"], 2)

    def test_contiguous_row_is_one_range(self) -> None:
        visited = {(1, 0, c) for c in range(10)}  # a fully-swept row
        body = kb_protocol.encode_coverage_state(visited, set())
        # RLE: the ten columns collapse to a single "0-9" range on one visited line.
        self.assertIn("1|0|0-9", body)
        self.assertEqual(kb_protocol.decode_coverage_state(body)["visited"], visited)

    def test_deterministic_encoding(self) -> None:
        visited = {(1, 2, 3), (1, 0, 0), (2, 1, 1)}
        probes = {("B", "y"), ("A", "x")}
        a = kb_protocol.encode_coverage_state(visited, probes)
        b = kb_protocol.encode_coverage_state(set(visited), set(probes))
        self.assertEqual(a, b)  # sorted ordering -> identical body for an unchanged run

    def test_corrupt_lines_skipped(self) -> None:
        body = "coverage state v1\nvisited\n1|0|0-2\ngarbage line\nprobes\nSPACE:objA\nnosep\n"
        out = kb_protocol.decode_coverage_state(body)
        self.assertEqual(out["visited"], {(1, 0, 0), (1, 0, 1), (1, 0, 2)})
        self.assertEqual(out["probes"], {("SPACE", "objA")})


class CoverageStateRoundTripTest(unittest.TestCase):
    """Run-20: write_coverage_state + read_coverage_state must round-trip a large coverage body through
    the same truncating daemon that clips writes to 2000 and reads to 1200 (chunk fallback path)."""

    def _big_state(self):
        # A coverage set large enough to force multiple chunk notes (>1200 chars encoded).
        visited = {(1, r, c) for r in range(30) for c in range(0, 30, 2)}
        probes = {("<bump>", f"obj{i}") for i in range(20)}
        return visited, probes

    def test_round_trip_through_truncating_daemon(self) -> None:
        visited, probes = self._big_state()
        body = kb_protocol.encode_coverage_state(visited, probes, board_cells=900)
        self.assertGreater(len(body), kb_protocol.CHUNK_BODY_LIMIT)  # must span chunks

        daemon = _TruncatingDaemon()
        gate = WriteGate(_client(), max_writes_per_turn=2)
        with mock.patch.object(kb_protocol.request, "urlopen", daemon):
            written = gate.write_coverage_state("ls20", body)
            self.assertTrue(written["ok"])
            self.assertEqual(len(daemon.notes), written["chunks"] + 1)  # index + chunks
            # Recall (native get_note_full unavailable on this daemon -> chunk-reassembly fallback).
            out = kb_protocol.read_coverage_state(_client(), "ls20")
        self.assertIsNotNone(out)
        self.assertEqual(out["visited"], visited)
        self.assertEqual(out["probes"], probes)

    def test_missing_game_returns_none(self) -> None:
        daemon = _TruncatingDaemon()
        with mock.patch.object(kb_protocol.request, "urlopen", daemon):
            out = kb_protocol.read_coverage_state(_client(), "nogame99")
        self.assertIsNone(out)  # no coverage note -> fresh sweep


class _StaticSearchClient:
    """Fake client whose ``search`` replays a canned hit list (for dedupe-shape tests)."""

    def __init__(self, hits) -> None:
        self.hits = hits

    def search(self, q, k, gated=False, full_content=False):  # noqa: ANN001
        return self.hits[:k]


class SearchHitDedupeTest(unittest.TestCase):
    """Run-35: with ``full_content`` the daemon returns CHUNK-level hits, so one long note can occupy
    a dozen top-k slots. ``_search_full_content`` must collapse those copies to the note's FIRST
    (best-ranked) hit, preserving rank order."""

    def test_same_key_duplicates_dropped_order_preserved(self) -> None:
        hits = [
            {"key": "note:note-a", "title": "alpha"},
            {"key": "note:note-b", "title": "beta"},
            {"key": "note:note-a", "title": "alpha"},
            {"key": "note:note-c", "title": "gamma"},
            {"key": "note:note-b", "title": "beta"},
        ]
        out = kb_protocol._search_full_content(_StaticSearchClient(hits), "q", k=20)
        self.assertEqual([h["key"] for h in out], ["note:note-a", "note:note-b", "note:note-c"])

    def test_chunk_suffix_copies_collapse_to_first_hit(self) -> None:
        # Live daemon shape (runs 33-35): one knowledge item returns a hit per chunk, keys differing
        # only by the trailing #kN chunk marker; cluster artifacts differ by a :chunk-N marker.
        hits = [
            {"key": "6b04b7a6/22#k1", "title": "note judge verdict alpha"},
            {"key": "6b04b7a6/22#k7", "title": "note judge verdict alpha"},
            {"key": "knowledge:source_chunk:note-xyz#note-evidence:chunk-1", "title": "prog evidence chunk 1"},
            {"key": "knowledge:source_chunk:note-xyz#note-evidence:chunk-2", "title": "prog evidence chunk 2"},
            {"key": "note:note-cov", "title": "game ls20 coverage state"},
        ]
        out = kb_protocol._search_full_content(_StaticSearchClient(hits), "q", k=20)
        self.assertEqual(
            [h["key"] for h in out],
            [
                "6b04b7a6/22#k1",
                "knowledge:source_chunk:note-xyz#note-evidence:chunk-1",
                "note:note-cov",
            ],
        )

    def test_title_fallback_when_no_key(self) -> None:
        hits = [
            {"title": "same note"},
            {"title": "same note"},
            {"title": "other note"},
        ]
        out = kb_protocol._search_full_content(_StaticSearchClient(hits), "q", k=20)
        self.assertEqual([h["title"] for h in out], ["same note", "other note"])

    def test_distinct_notes_never_collapsed(self) -> None:
        # Real chunk NOTES (separate notes titled "chunk n of N") have distinct keys — never merged.
        hits = [
            {"key": "note:note-1", "title": "game ls20 coverage chunk 1 of 2"},
            {"key": "note:note-2", "title": "game ls20 coverage chunk 2 of 2"},
        ]
        out = kb_protocol._search_full_content(_StaticSearchClient(hits), "q", k=20)
        self.assertEqual(len(out), 2)


class _FloodedDaemonClient:
    """Reproduces the Run-33..35 live daemon behavior that froze coverage resume:

    * ``full_content=True`` search returns CHUNK-level hits — 5 always-injected system notes plus
      near-duplicate chunk copies of two old long notes — eating ALL k slots; the coverage index
      note never surfaces.
    * PLAIN search (no full_content) ranks at the TITLE level, where the coverage index note places
      inside top-k (observed live: rank [5]).
    * ``get_note_full`` serves the index note's full body natively.
    """

    def __init__(self, game_id: str, full_body: str) -> None:
        self.full_body = full_body
        self.index_key = "note:note-cov"
        sys_notes = [
            {"key": f"note:note-sys{i}", "title": f"workspace anchor {i}", "summary": "anchor", "tier": "system"}
            for i in range(5)
        ]
        flood = [
            {"key": f"6b04b7a6/22#k{i}", "title": "note judge verdict alpha", "summary": "chunk", "content": "chunk text"}
            for i in range(1, 11)
        ] + [
            {"key": f"4b12fe1f/12#k{i}", "title": "note judge verdict beta", "summary": "chunk", "content": "chunk text"}
            for i in range(1, 10)
        ]
        # 5 system + 19 chunk copies = 24 candidates; a k=20 fetch never reaches the index note.
        self.full_hits = sys_notes + flood
        length = len(full_body.encode("utf-8"))
        index_summary = (
            "coverage state index\n"
            "chunk count: 1\n"
            f"source length: {length}\n\n"
            "coverage stored in chunk notes titled 'game ls20 coverage chunk 1 of 1' .. "
            "'game ls20 coverage chunk 1 of 1'."
        )[:200]
        self.plain_hits = sys_notes + [
            {"key": self.index_key, "title": f"game {game_id} coverage state", "summary": index_summary},
        ]
        self.full_calls = 0
        self.plain_calls = 0

    def search(self, q, k, gated=False, full_content=False):  # noqa: ANN001
        if full_content:
            self.full_calls += 1
            return self.full_hits[:k]
        self.plain_calls += 1
        return self.plain_hits[:k]

    def get_note_full(self, key):  # noqa: ANN001
        if key == self.index_key:
            return {"ok": True, "key": key, "full_body": self.full_body}
        return {"ok": False, "error": "http 404"}


class CoverageResumeChunkFloodRegressionTest(unittest.TestCase):
    """Run-35 regression: index DISCOVERY through a full_content search let 5 system notes + 19
    duplicate chunk copies eat every slot, so resume silently returned None and three straight runs
    cloned each other (coverage frozen at 0.1301). Discovery must use the PLAIN title-level search —
    where the index note actually ranks — and fetch the body natively afterwards."""

    def test_resume_resolves_despite_full_content_chunk_flood(self) -> None:
        visited = {(1, 0, c) for c in range(5)}
        probes = {("SPACE", "objA")}
        body = kb_protocol.encode_coverage_state(visited, probes, board_cells=100)
        client = _FloodedDaemonClient("ls20", body)

        out = kb_protocol.read_coverage_state(client, "ls20")

        self.assertIsNotNone(out)  # pre-fix: full_content flood -> None -> fresh sweep
        self.assertEqual(out["visited"], visited)
        self.assertEqual(out["probes"], probes)
        self.assertEqual(out["board"], 100)
        # Discovery went through the plain title-level search, not the floodable full_content path.
        self.assertGreaterEqual(client.plain_calls, 1)
        self.assertEqual(client.full_calls, 0)


if __name__ == "__main__":
    unittest.main()
