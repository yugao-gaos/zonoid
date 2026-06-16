"""Unit tests for bench/agent-memory/datasets.py.

Tests both loaders against the hand-authored synthetic fixtures
(bench/agent-memory/fixtures/) — no licensed dataset files required.
The fixtures directory contains canonical-named files:
  - locomo10.json            (LoCoMo fixture, 1 dialogue)
  - longmemeval_oracle.json  (LongMemEval oracle fixture, 2 items)

Run with:
    pytest bench/agent-memory/test_datasets.py -v
or:
    python -m pytest bench/agent-memory/test_datasets.py -v
or directly (no pytest needed):
    python bench/agent-memory/test_datasets.py
"""

from __future__ import annotations

import os
import sys
import unittest

# Allow running from any working directory
_HERE = os.path.dirname(os.path.abspath(__file__))
_FIXTURES = os.path.join(_HERE, "fixtures")

sys.path.insert(0, _HERE)
from datasets import load_locomo, load_longmemeval  # noqa: E402 (after sys.path tweak)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _assert_common_shape(tc: unittest.TestCase, records: list[dict], label: str) -> None:
    """Assert every record in *records* conforms to the common schema."""
    tc.assertIsInstance(records, list, f"{label}: expected a list")
    tc.assertGreater(len(records), 0, f"{label}: expected at least one record")

    for i, rec in enumerate(records):
        ctx = f"{label}[{i}]"
        # Top-level keys
        tc.assertIn("conv_id", rec, f"{ctx}: missing conv_id")
        tc.assertIn("sessions", rec, f"{ctx}: missing sessions")
        tc.assertIn("probes", rec, f"{ctx}: missing probes")
        tc.assertIsInstance(rec["conv_id"], str, f"{ctx}: conv_id must be str")

        # Sessions
        sessions = rec["sessions"]
        tc.assertIsInstance(sessions, list, f"{ctx}: sessions must be list")
        for s_i, sess in enumerate(sessions):
            s_ctx = f"{ctx}.sessions[{s_i}]"
            tc.assertIn("idx", sess, f"{s_ctx}: missing idx")
            tc.assertIn("date", sess, f"{s_ctx}: missing date (may be None)")
            tc.assertIn("turns", sess, f"{s_ctx}: missing turns")
            tc.assertIsInstance(sess["turns"], list, f"{s_ctx}: turns must be list")
            for t_i, turn in enumerate(sess["turns"]):
                t_ctx = f"{s_ctx}.turns[{t_i}]"
                tc.assertIn("speaker", turn, f"{t_ctx}: missing speaker")
                tc.assertIn("text", turn, f"{t_ctx}: missing text")
                tc.assertIn("turn_id", turn, f"{t_ctx}: missing turn_id key (may be None)")

        # Probes
        probes = rec["probes"]
        tc.assertIsInstance(probes, list, f"{ctx}: probes must be list")
        for p_i, probe in enumerate(probes):
            p_ctx = f"{ctx}.probes[{p_i}]"
            tc.assertIn("qid", probe, f"{p_ctx}: missing qid")
            tc.assertIn("question", probe, f"{p_ctx}: missing question")
            tc.assertIn("answer", probe, f"{p_ctx}: missing answer")
            tc.assertIn("category", probe, f"{p_ctx}: missing category")
            tc.assertIn("evidence", probe, f"{p_ctx}: missing evidence")
            tc.assertIsInstance(probe["qid"], str, f"{p_ctx}: qid must be str")
            tc.assertIsInstance(probe["category"], str, f"{p_ctx}: category must be str")
            tc.assertIsInstance(probe["evidence"], list, f"{p_ctx}: evidence must be list")


# ---------------------------------------------------------------------------
# LoCoMo tests
# ---------------------------------------------------------------------------

class TestLoCoMoLoader(unittest.TestCase):
    """Tests using fixtures/locomo10.json (hand-authored, 1 dialogue, 3 sessions, 2 probes)."""

    def setUp(self):
        self.records = load_locomo(_FIXTURES)

    def test_returns_list(self):
        self.assertIsInstance(self.records, list)
        self.assertEqual(len(self.records), 1, "fixture has exactly 1 dialogue")

    def test_common_shape(self):
        _assert_common_shape(self, self.records, "LoCoMo")

    def test_conv_id_is_preserved(self):
        self.assertEqual(self.records[0]["conv_id"], "fx-locomo-001")

    def test_sessions_count(self):
        self.assertEqual(len(self.records[0]["sessions"]), 3)

    def test_sessions_are_ordered(self):
        idxs = [s["idx"] for s in self.records[0]["sessions"]]
        self.assertEqual(idxs, sorted(idxs), "sessions must be sorted by idx")

    def test_sessions_have_dates(self):
        for sess in self.records[0]["sessions"]:
            self.assertIsNotNone(sess["date"], "LoCoMo fixture sessions should have dates")

    def test_turns_have_speaker_and_text(self):
        for sess in self.records[0]["sessions"]:
            self.assertGreater(len(sess["turns"]), 0)
            for turn in sess["turns"]:
                self.assertIsInstance(turn["speaker"], str)
                self.assertIsInstance(turn["text"], str)
                self.assertGreater(len(turn["text"]), 0)

    def test_probes_count(self):
        self.assertEqual(len(self.records[0]["probes"]), 2)

    def test_probes_carry_category(self):
        categories = {p["category"] for p in self.records[0]["probes"]}
        self.assertIn("single-hop", categories)
        self.assertIn("multi-hop", categories)

    def test_probes_carry_evidence(self):
        for probe in self.records[0]["probes"]:
            self.assertIsInstance(probe["evidence"], list)
            self.assertGreater(len(probe["evidence"]), 0, "LoCoMo probes must have evidence")

    def test_missing_file_raises_clear_error(self):
        with self.assertRaises(FileNotFoundError) as ctx:
            load_locomo("/nonexistent/path/that/does/not/exist")
        self.assertIn("locomo10.json", str(ctx.exception))


# ---------------------------------------------------------------------------
# LongMemEval tests
# ---------------------------------------------------------------------------

class TestLongMemEvalLoader(unittest.TestCase):
    """Tests using fixtures/longmemeval_oracle.json (hand-authored, 2 items, 3 sessions each)."""

    def setUp(self):
        self.records = load_longmemeval(_FIXTURES, variant="oracle")

    def test_returns_list(self):
        self.assertIsInstance(self.records, list)
        self.assertEqual(len(self.records), 2, "fixture has exactly 2 questions")

    def test_common_shape(self):
        _assert_common_shape(self, self.records, "LongMemEval")

    def test_conv_ids(self):
        ids = {r["conv_id"] for r in self.records}
        self.assertIn("fx-lme-001", ids)
        self.assertIn("fx-lme-002", ids)

    def test_sessions_count(self):
        # Each item has 3 haystack sessions
        for rec in self.records:
            self.assertEqual(len(rec["sessions"]), 3, f"Expected 3 sessions in {rec['conv_id']}")

    def test_sessions_have_dates(self):
        for rec in self.records:
            for sess in rec["sessions"]:
                self.assertIsNotNone(sess["date"])

    def test_turns_shapes(self):
        for rec in self.records:
            for sess in rec["sessions"]:
                self.assertGreater(len(sess["turns"]), 0)
                for turn in sess["turns"]:
                    self.assertIn(turn["speaker"], ("user", "assistant", "unknown"))

    def test_single_probe_per_item(self):
        for rec in self.records:
            self.assertEqual(len(rec["probes"]), 1, f"{rec['conv_id']} should have exactly 1 probe")

    def test_probes_carry_category(self):
        categories = {rec["probes"][0]["category"] for rec in self.records}
        self.assertIn("multi-session", categories)
        self.assertIn("temporal-reasoning", categories)

    def test_probes_carry_evidence(self):
        for rec in self.records:
            probe = rec["probes"][0]
            self.assertIsInstance(probe["evidence"], list)
            self.assertGreater(len(probe["evidence"]), 0, f"{rec['conv_id']} probe must have evidence")
            for ev in probe["evidence"]:
                self.assertIsInstance(ev, str)

    def test_evidence_are_non_empty_strings(self):
        """Evidence items must be non-empty strings (session ids from the source data)."""
        for rec in self.records:
            for probe in rec["probes"]:
                for ev in probe["evidence"]:
                    self.assertIsInstance(ev, str)
                    self.assertTrue(len(ev) > 0, f"Evidence item must be non-empty in {rec['conv_id']}")

    def test_missing_file_raises_clear_error(self):
        with self.assertRaises(FileNotFoundError) as ctx:
            load_longmemeval("/nonexistent/path/that/does/not/exist", variant="oracle")
        self.assertIn("longmemeval_oracle.json", str(ctx.exception))

    def test_unknown_variant_raises_value_error(self):
        with self.assertRaises(ValueError) as ctx:
            load_longmemeval(_FIXTURES, variant="xl")
        self.assertIn("xl", str(ctx.exception))


# ---------------------------------------------------------------------------
# Cross-loader shape consistency test
# ---------------------------------------------------------------------------

class TestCommonShapeConsistency(unittest.TestCase):
    """Verify the two loaders produce structurally identical schemas."""

    def setUp(self):
        self.locomo = load_locomo(_FIXTURES)
        self.lme = load_longmemeval(_FIXTURES, variant="oracle")

    def test_top_level_keys_match(self):
        locomo_keys = set(self.locomo[0].keys())
        lme_keys = set(self.lme[0].keys())
        self.assertEqual(locomo_keys, lme_keys, "Top-level keys must match between loaders")

    def test_session_keys_match(self):
        locomo_sess = self.locomo[0]["sessions"][0]
        lme_sess = self.lme[0]["sessions"][0]
        self.assertEqual(set(locomo_sess.keys()), set(lme_sess.keys()))

    def test_turn_keys_match(self):
        locomo_turn = self.locomo[0]["sessions"][0]["turns"][0]
        lme_turn = self.lme[0]["sessions"][0]["turns"][0]
        self.assertEqual(set(locomo_turn.keys()), set(lme_turn.keys()))

    def test_probe_keys_match(self):
        locomo_probe = self.locomo[0]["probes"][0]
        lme_probe = self.lme[0]["probes"][0]
        self.assertEqual(set(locomo_probe.keys()), set(lme_probe.keys()))

    def test_sessions_are_lists_in_both(self):
        self.assertIsInstance(self.locomo[0]["sessions"], list)
        self.assertIsInstance(self.lme[0]["sessions"], list)

    def test_probes_are_lists_in_both(self):
        self.assertIsInstance(self.locomo[0]["probes"], list)
        self.assertIsInstance(self.lme[0]["probes"], list)


# ---------------------------------------------------------------------------
# Main runner (plain python -m / python test_datasets.py)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    unittest.main(verbosity=2)
