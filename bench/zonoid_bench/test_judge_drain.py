"""Coverage for the P3 judge-drain path (commit 86dd386).

P3 de-ported the bench edge judge: instead of pull(/judge/next) -> bench LLM -> post(/judge/verdict),
``client.judge_drain`` makes ONE call to the production sync judge and ``arms.run_canonical_wiring``
reads the counts back. That rewire shipped with no tests; this file is that coverage.

What is pinned here
-------------------
1. The WIRE CONTRACT of ``client.judge_drain``: POST /judge/drain, ``node``+``budget`` on the
   QUERY-STRING, ``workspace`` in the BODY. The route reads ``u.searchParams`` first and resolves
   the overlay from the body, so swapping either side silently drains the wrong node/overlay.
2. The finding-#1 absolute-workspace guard fires BEFORE any HTTP call.
3. The never-raise contract: transport/HTTP failures return the sentinel dict, they do not propagate
   (arms calls this un-guarded, so a raise would abort a whole bench unit).
4. ``ZonoidClient.judge_drain`` delegation: base_url/workspace/timeout binding + per-call overrides.
5. ``arms.run_canonical_wiring``'s use of the drain: one call with the minted probe key and the
   forwarded budget, count mapping onto WiringResult, the non-obvious ``judge_idle`` rule, and the
   load-bearing P3 invariant that the bench authors NO verdict of its own.

Runtime: stdlib ONLY (no pytest, no requests) — same constraint as the rest of the bench, which
runs on embeddable Python 3.12. Run it directly:

    python bench/zonoid_bench/test_judge_drain.py

``test/bench-judge-drain.test.js`` is the wrapper that pulls this into ``npm run test:all``.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zonoid_bench import arms  # noqa: E402
from zonoid_bench import client as client_mod  # noqa: E402
from zonoid_bench.client import ZonoidClient, judge_drain  # noqa: E402

ABS_WS = "/abs/bench/ws"
WIN_WS = "D:\\zonoid"

_checks = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global _checks
    _checks += 1
    if not condition:
        raise AssertionError(f"{label}{': ' + detail if detail else ''}")


# ---------------------------------------------------------------------------
# A tiny recording daemon stand-in (stdlib http.server)
# ---------------------------------------------------------------------------

class _StubDaemon:
    """Records every request and replies with a canned JSON body / status."""

    def __init__(self, response: dict[str, Any] | None = None, status: int = 200) -> None:
        self.requests: list[dict[str, Any]] = []
        self.response = response if response is not None else {"ok": True}
        self.status = status
        recorder = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler API
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                parsed = urlparse(self.path)
                try:
                    body = json.loads(raw) if raw else None
                except ValueError:
                    body = {"__unparsed__": raw.decode("utf-8", "replace")}
                recorder.requests.append({
                    "method": "POST",
                    "path": parsed.path,
                    "query": parse_qs(parsed.query),
                    "body": body,
                    "content_type": self.headers.get("Content-Type"),
                })
                payload = json.dumps(recorder.response).encode("utf-8")
                self.send_response(recorder.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args: Any) -> None:
                pass  # keep the test output clean

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self.port = self._server.server_address[1]
        self.base_url = f"http://127.0.0.1:{self.port}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self) -> "_StubDaemon":
        self._thread.start()
        return self

    def __exit__(self, *_exc: Any) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    @property
    def last(self) -> dict[str, Any]:
        return self.requests[-1]


def _dead_port() -> int:
    """A port that was bound and then released — nothing is listening on it."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


# ---------------------------------------------------------------------------
# 1. Wire contract: node/budget on the query-string, workspace in the body
# ---------------------------------------------------------------------------

def test_wire_contract() -> None:
    drain_body = {
        "ok": True, "workspace": ABS_WS, "node": "bench/probe-1",
        "judged": 7, "kept": 3, "pruned": 4, "idle": True, "rounds": 2,
    }
    with _StubDaemon(drain_body) as daemon:
        resp = judge_drain(daemon.base_url, "bench/probe-1", ABS_WS, budget=11, timeout=10)

    check("judge_drain returns the daemon body verbatim", resp == drain_body, repr(resp))

    req = daemon.last
    check("POST is the method", req["method"] == "POST")
    check("path is /judge/drain", req["path"] == "/judge/drain", req["path"])
    check("JSON content-type", req["content_type"] == "application/json", str(req["content_type"]))
    # node + budget ride the QUERY-STRING (the route reads u.searchParams first).
    check("node on query-string", req["query"].get("node") == ["bench/probe-1"], str(req["query"]))
    check("budget on query-string", req["query"].get("budget") == ["11"], str(req["query"]))
    # workspace rides the BODY so targetOverlay(b, u) resolves the right overlay.
    check("workspace in body", req["body"] == {"workspace": ABS_WS}, str(req["body"]))
    check("workspace NOT on query-string", "workspace" not in req["query"], str(req["query"]))
    check("node NOT in body", "node" not in (req["body"] or {}), str(req["body"]))

    # Default budget is the documented 20 (the daemon clamps 1..50).
    with _StubDaemon(drain_body) as daemon2:
        judge_drain(daemon2.base_url, "bench/probe-2", ABS_WS, timeout=10)
    check("default budget is 20", daemon2.last["query"].get("budget") == ["20"],
          str(daemon2.last["query"]))

    # _base() strips a trailing slash so the path is /judge/drain, not //judge/drain.
    with _StubDaemon(drain_body) as daemon3:
        judge_drain(daemon3.base_url + "/", "bench/probe-3", ABS_WS, timeout=10)
    check("trailing slash normalized", daemon3.last["path"] == "/judge/drain", daemon3.last["path"])

    print("PASS judge_drain wire contract (node/budget on query, workspace in body)")


# ---------------------------------------------------------------------------
# 2. Finding #1 — the absolute-workspace guard fires before any HTTP call
# ---------------------------------------------------------------------------

def test_absolute_workspace_guard() -> None:
    with _StubDaemon() as daemon:
        for bad in ("rel/path", "", "bench-ws"):
            try:
                judge_drain(daemon.base_url, "bench/probe", bad, timeout=10)
            except ValueError as exc:
                check("guard names finding #1", "finding #1" in str(exc), str(exc))
            else:
                raise AssertionError(f"relative workspace {bad!r} must raise ValueError")
        check("guard fires before any HTTP call", daemon.requests == [], str(daemon.requests))

        # Both absolute forms are accepted: POSIX root and a Windows drive letter.
        judge_drain(daemon.base_url, "bench/probe", ABS_WS, timeout=10)
        judge_drain(daemon.base_url, "bench/probe", WIN_WS, timeout=10)
        check("both absolute forms accepted", len(daemon.requests) == 2, str(len(daemon.requests)))
        check("windows workspace forwarded intact", daemon.last["body"] == {"workspace": WIN_WS},
              str(daemon.last["body"]))

    print("PASS judge_drain absolute-workspace guard (finding #1, pre-HTTP)")


# ---------------------------------------------------------------------------
# 3. Never-raise contract — arms calls this un-guarded
# ---------------------------------------------------------------------------

def _check_error_sentinel(label: str, resp: dict[str, Any]) -> None:
    check(f"{label}: ok False", resp.get("ok") is False, repr(resp))
    check(f"{label}: idle True", resp.get("idle") is True, repr(resp))
    check(f"{label}: zeroed counts",
          (resp.get("judged"), resp.get("kept"), resp.get("pruned")) == (0, 0, 0), repr(resp))
    check(f"{label}: carries an error string",
          isinstance(resp.get("error"), str) and resp["error"] != "", repr(resp))


def test_never_raises() -> None:
    # Connection refused (nothing listening).
    resp = judge_drain(f"http://127.0.0.1:{_dead_port()}", "bench/probe", ABS_WS, timeout=5)
    _check_error_sentinel("connection refused", resp)

    # Daemon answers, but with a 5xx (urllib raises HTTPError on non-2xx).
    with _StubDaemon({"ok": False, "error": "boom"}, status=500) as daemon:
        resp = judge_drain(daemon.base_url, "bench/probe", ABS_WS, timeout=10)
    _check_error_sentinel("http 500", resp)

    # A malformed (non-JSON) body is also swallowed rather than propagating a JSONDecodeError.
    original = client_mod._http_post

    def broken(*_a: Any, **_kw: Any) -> Any:
        raise json.JSONDecodeError("Expecting value", "", 0)

    client_mod._http_post = broken
    try:
        resp = judge_drain("http://daemon.invalid:8787", "bench/probe", ABS_WS, timeout=10)
    finally:
        client_mod._http_post = original
    _check_error_sentinel("malformed body", resp)

    print("PASS judge_drain never raises (refused / 5xx / malformed body -> sentinel)")


# ---------------------------------------------------------------------------
# 4. ZonoidClient.judge_drain delegation
# ---------------------------------------------------------------------------

def test_client_method_delegation() -> None:
    calls: list[dict[str, Any]] = []
    original = client_mod._http_post

    def record(url: str, body: dict[str, Any], timeout: int) -> Any:
        calls.append({"url": url, "body": body, "timeout": timeout})
        return {"ok": True, "judged": 1, "kept": 1, "pruned": 0, "idle": True, "rounds": 1}

    client_mod._http_post = record
    try:
        client = ZonoidClient("http://daemon.invalid:8787/", workspace=ABS_WS, timeout=42)

        resp = client.judge_drain("bench/probe-a")
        check("method returns the drain dict", resp.get("judged") == 1, repr(resp))
        check("bound base_url used",
              calls[-1]["url"].startswith("http://daemon.invalid:8787/judge/drain?"),
              calls[-1]["url"])
        check("bound workspace used", calls[-1]["body"] == {"workspace": ABS_WS},
              str(calls[-1]["body"]))
        check("bound timeout used", calls[-1]["timeout"] == 42, str(calls[-1]["timeout"]))
        check("default budget forwarded", "budget=20" in calls[-1]["url"], calls[-1]["url"])

        # Per-call overrides win over the instance binding.
        client.judge_drain("bench/probe-b", budget=5, workspace=WIN_WS, timeout=9)
        check("per-call budget wins", "budget=5" in calls[-1]["url"], calls[-1]["url"])
        check("per-call workspace wins", calls[-1]["body"] == {"workspace": WIN_WS},
              str(calls[-1]["body"]))
        check("per-call timeout wins", calls[-1]["timeout"] == 9, str(calls[-1]["timeout"]))

        # No workspace anywhere -> _ws() raises rather than draining an unknown overlay.
        try:
            ZonoidClient("http://daemon.invalid:8787").judge_drain("bench/probe-c")
        except ValueError as exc:
            check("workspace-less client raises", "workspace is required" in str(exc), str(exc))
        else:
            raise AssertionError("judge_drain with no workspace must raise ValueError")
    finally:
        client_mod._http_post = original

    print("PASS ZonoidClient.judge_drain delegation (binding + per-call overrides)")


# ---------------------------------------------------------------------------
# 5. arms.run_canonical_wiring — the P3 rewire
# ---------------------------------------------------------------------------

class _FakeClient:
    """Records the drain call and every verdict-authoring call that must NOT happen."""

    workspace = ABS_WS

    def __init__(self, drain: dict[str, Any], context_deps: list[dict[str, Any]] | None = None):
        self._drain = drain
        self._context_deps = context_deps or []
        self.drain_calls: list[tuple[str, int]] = []
        self.forbidden_calls: list[str] = []

    def search(self, *_a: Any, **_kw: Any) -> list[dict[str, Any]]:
        return []

    def judge_drain(self, node: str, budget: int = 20, **_kw: Any) -> dict[str, Any]:
        self.drain_calls.append((node, budget))
        return self._drain

    def get_task_context(self, _node_key: str, **_kw: Any) -> dict[str, Any]:
        return {"dependencySummaries": self._context_deps}

    # P3 de-ported these: the bench must never pull candidates or author a verdict again.
    def judge_next(self, *_a: Any, **_kw: Any) -> dict[str, Any]:
        self.forbidden_calls.append("judge_next")
        return {"items": [], "idle": True}

    def post_verdict(self, *_a: Any, **_kw: Any) -> dict[str, Any]:
        self.forbidden_calls.append("post_verdict")
        return {"ok": True}


def _wire(drain: dict[str, Any], context_deps: list[dict[str, Any]] | None = None,
          **kwargs: Any) -> tuple[Any, _FakeClient]:
    """run_canonical_wiring with the probe-minting side effects stubbed out."""
    fake = _FakeClient(drain, context_deps)
    original_mint = arms._mint_probe_task
    arms._mint_probe_task = lambda *_a, **_kw: "bench/probe-key"
    try:
        result = arms.run_canonical_wiring(
            fake, "unit-1", "a task summary", data_dir="/unused", **kwargs
        )
    finally:
        arms._mint_probe_task = original_mint
    return result, fake


def test_wiring_drives_the_production_drain() -> None:
    result, fake = _wire(
        {"ok": True, "judged": 9, "kept": 4, "pruned": 5, "idle": True, "rounds": 3},
        judge_budget=13,
    )

    check("exactly one drain call", len(fake.drain_calls) == 1, str(fake.drain_calls))
    check("drain targets the minted probe", fake.drain_calls[0][0] == "bench/probe-key",
          str(fake.drain_calls))
    check("judge_budget forwarded to the drain", fake.drain_calls[0][1] == 13,
          str(fake.drain_calls))
    check("probe key on the result", result.task_key == "bench/probe-key", result.task_key)
    check("node_kind is task", result.node_kind == "task", result.node_kind)

    # Drain counts land on the WiringResult verbatim.
    check("judged mapped", result.judged == 9, str(result.judged))
    check("kept mapped", result.kept == 4, str(result.kept))
    check("pruned mapped", result.pruned == 5, str(result.pruned))
    check("rounds mapped", result.rounds == 3, str(result.rounds))
    check("drain_skipped None when not skipped", result.drain_skipped is None,
          str(result.drain_skipped))

    # THE P3 invariant: there is exactly one judge, and it lives in production.
    check("bench authors no verdict and pulls no candidates", fake.forbidden_calls == [],
          str(fake.forbidden_calls))

    print("PASS run_canonical_wiring drives the production drain (one call, counts mapped)")


def test_wiring_count_coercion_and_skip() -> None:
    # A drain that skipped (e.g. no_backend) returns no counts at all — they must coerce to 0,
    # not crash on None, and the skip reason must survive onto the result.
    result, _ = _wire({"ok": True, "skipped": "no_backend", "idle": True})
    check("missing counts coerce to 0",
          (result.judged, result.kept, result.pruned, result.rounds) == (0, 0, 0, 0),
          str((result.judged, result.kept, result.pruned, result.rounds)))
    check("skip reason propagated", result.drain_skipped == "no_backend", str(result.drain_skipped))

    # Explicit nulls coerce too (`int(drain.get(...) or 0)`).
    result, _ = _wire({"ok": True, "judged": None, "kept": None, "pruned": None, "rounds": None})
    check("null counts coerce to 0",
          (result.judged, result.kept, result.pruned, result.rounds) == (0, 0, 0, 0),
          str((result.judged, result.kept, result.pruned, result.rounds)))

    # The error sentinel from a failed drain flows through without raising.
    result, _ = _wire({"ok": False, "idle": True, "judged": 0, "kept": 0, "pruned": 0,
                       "error": "connection refused"})
    check("failed drain leaves the wiring idle", result.judge_idle is True, str(result.judge_idle))

    print("PASS run_canonical_wiring coerces missing/None drain counts and keeps the skip reason")


def test_wiring_judge_idle_rule() -> None:
    kept_dep = {"key": "note:kept", "label": "Kept note", "via": "context", "weight": 1}
    unjudged_dep = {"key": "note:cand", "label": "Candidate", "via": "context", "weight": 0}

    # Nothing was ever seeded: judged 0, kept 0, no weight>0 edge -> idle.
    result, _ = _wire({"ok": True, "judged": 0, "kept": 0, "pruned": 0}, [unjudged_dep])
    check("no candidates -> idle", result.judge_idle is True, str(result.judge_idle))
    check("idle counts once", result.judge_idle_count == 1, str(result.judge_idle_count))
    check("weight-0 candidates are not wired edges", result.wired_edges == [],
          str(result.wired_edges))

    # The subtle one: the judge DID adjudicate but pruned everything. There WERE candidates, so
    # this is NOT idle — collapsing it into idle would misreport a working judge as a dead one.
    result, _ = _wire({"ok": True, "judged": 6, "kept": 0, "pruned": 6}, [unjudged_dep])
    check("judged>0 kept==0 is NOT idle", result.judge_idle is False, str(result.judge_idle))
    check("non-idle does not count", result.judge_idle_count == 0, str(result.judge_idle_count))

    # Kept something -> not idle, and the kept provider is read back from /task/context.
    result, _ = _wire({"ok": True, "judged": 2, "kept": 1, "pruned": 1}, [kept_dep, unjudged_dep])
    check("kept edge -> not idle", result.judge_idle is False, str(result.judge_idle))
    check("wired_edges is the weight>0 provider", result.wired_edges == ["note:kept"],
          str(result.wired_edges))
    check("candidates_seen records the keep verdict",
          result.candidates_seen == [{"key": "note:kept", "title": "Kept note", "edge": "keep"}],
          str(result.candidates_seen))
    check("bench authors no pruned edges", result.pruned_edges == [], str(result.pruned_edges))

    print("PASS run_canonical_wiring judge_idle rule (pruned-everything is not idle)")


def test_wiring_context_read_is_best_effort() -> None:
    fake = _FakeClient({"ok": True, "judged": 4, "kept": 2, "pruned": 2})
    original_mint = arms._mint_probe_task
    original_read = arms.read_wired_context

    def exploding_read(*_a: Any, **_kw: Any) -> list[dict[str, Any]]:
        raise RuntimeError("/task/context is down")

    arms._mint_probe_task = lambda *_a, **_kw: "bench/probe-key"
    arms.read_wired_context = exploding_read
    try:
        result = arms.run_canonical_wiring(fake, "unit-1", "summary", data_dir="/unused")
    finally:
        arms._mint_probe_task = original_mint
        arms.read_wired_context = original_read

    check("context-read failure is non-fatal", result.task_key == "bench/probe-key")
    check("drain counts survive the failed read", (result.judged, result.kept) == (4, 2),
          str((result.judged, result.kept)))
    check("no wired edges after a failed read", result.wired_edges == [], str(result.wired_edges))
    check("kept>0 keeps it out of idle", result.judge_idle is False, str(result.judge_idle))

    print("PASS run_canonical_wiring survives a failed /task/context read")


# ---------------------------------------------------------------------------

TESTS = [
    test_wire_contract,
    test_absolute_workspace_guard,
    test_never_raises,
    test_client_method_delegation,
    test_wiring_drives_the_production_drain,
    test_wiring_count_coercion_and_skip,
    test_wiring_judge_idle_rule,
    test_wiring_context_read_is_best_effort,
]


def main() -> int:
    for test in TESTS:
        test()
    print(f"\nPASS bench judge drain: {len(TESTS)} tests, {_checks} checks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
