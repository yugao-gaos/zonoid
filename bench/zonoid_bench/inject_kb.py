"""bench/zonoid_bench/inject_kb.py — Inject onboard batch notes into the production daemon.

Reads all onboard-learn-batch-*.json files from bench/onboard/zonoid/, deduplicates by
title, and POSTs each note to the daemon via POST /overlay/note.

Usage
-----
  # Dry-run — show what would be injected, inject nothing
  python bench/zonoid_bench/inject_kb.py --dry-run

  # Check how many notes are already in the daemon (no injection)
  python bench/zonoid_bench/inject_kb.py --check

  # Inject all batch notes
  python bench/zonoid_bench/inject_kb.py

  # Inject against a different daemon
  python bench/zonoid_bench/inject_kb.py --daemon http://localhost:9001
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_BENCH = os.path.dirname(_HERE)
if _BENCH not in sys.path:
    sys.path.insert(0, _BENCH)

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:
        pass

from zonoid_bench.client import ZonoidClient  # noqa: E402

_DEFAULT_DAEMON   = "http://localhost:8787"
_ONBOARD_DIR      = os.path.join(_BENCH, "onboard", "zonoid")


def _load_all_notes() -> list[dict]:
    """Read all batch files + onboard-queue.json kept items, deduplicate by title."""
    items: dict[str, dict] = {}  # title -> item

    # Read all onboard-learn-batch-*.json files
    batch_files = sorted(
        f for f in os.listdir(_ONBOARD_DIR)
        if f.startswith("onboard-learn-batch-") and f.endswith(".json")
    )
    print(f"Found {len(batch_files)} batch files: {', '.join(batch_files)}")

    for fname in batch_files:
        path = os.path.join(_ONBOARD_DIR, fname)
        with open(path, encoding="utf-8-sig") as fh:
            data = json.load(fh)
        kept = data.get("kept") or []
        for item in kept:
            title = (item.get("title") or "").strip()
            if title and title not in items:
                items[title] = item

    # Also include current onboard-queue.json kept items
    queue_path = os.path.join(_ONBOARD_DIR, "onboard-queue.json")
    if os.path.isfile(queue_path):
        with open(queue_path, encoding="utf-8-sig") as fh:
            data = json.load(fh)
        kept = data.get("kept") or []
        added = 0
        for item in kept:
            title = (item.get("title") or "").strip()
            if title and title not in items:
                items[title] = item
                added += 1
        print(f"  onboard-queue.json: {len(kept)} kept, {added} new (not in batches)")

    notes = list(items.values())
    print(f"Total unique notes to inject: {len(notes)}")
    return notes


def _check_daemon(client: ZonoidClient) -> int:
    """Count how many note-kind nodes are in the daemon via /search."""
    hits = client.search("onboard knowledge fact config decision finding", k=20, gated=False)
    note_hits = [h for h in hits if h.get("kind") == "note"]
    task_hits = [h for h in hits if h.get("kind") in ("task",)]
    print(f"  /search top-20: {len(note_hits)} note nodes, {len(task_hits)} task nodes")
    return len(note_hits)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Inject onboard batch notes into the Zonoid production daemon."
    )
    parser.add_argument("--daemon",   default=_DEFAULT_DAEMON,
                        help=f"Daemon base URL (default: {_DEFAULT_DAEMON}).")
    parser.add_argument("--dry-run",  action="store_true",
                        help="Show what would be injected; inject nothing.")
    parser.add_argument("--check",    action="store_true",
                        help="Check note count in daemon; inject nothing.")
    parser.add_argument("--batch-size", type=int, default=10,
                        help="Notes per batch before a settle sleep (default: 10).")
    parser.add_argument("--settle",   type=float, default=3.0,
                        help="Seconds to sleep between batches for embedder (default: 3.0).")
    parser.add_argument("--workspace", default=None,
                        help="Workspace path for the client (default: cwd).")
    args = parser.parse_args()

    workspace = args.workspace or os.getcwd()
    client = ZonoidClient(args.daemon, workspace=workspace, timeout=60)

    # Verify daemon is reachable
    try:
        probe = client.search("warmup probe", k=1)
        print(f"Daemon reachable at {args.daemon} ({len(probe)} results)")
    except Exception as exc:
        print(f"ERROR: daemon not reachable at {args.daemon}: {exc}")
        return 1

    notes = _load_all_notes()

    if args.check:
        print("\nChecking daemon note count ...")
        _check_daemon(client)
        return 0

    if args.dry_run:
        print(f"\n[dry-run] Would inject {len(notes)} notes. First 5:")
        for n in notes[:5]:
            print(f"  - [{n.get('kind','?')}] {n.get('title','?')[:80]}")
        return 0

    print(f"\nInjecting {len(notes)} notes (batch_size={args.batch_size}, settle={args.settle}s) ...")
    injected = 0
    errors   = 0
    t0 = time.monotonic()

    for i, item in enumerate(notes):
        title   = item.get("title", "").strip()
        summary = item.get("summary", "").strip()
        kind    = item.get("kind", "finding")
        evidence = item.get("evidence", "")

        if not title or not summary:
            continue

        tags = ["onboard-bench", f"kind:{kind}"]
        if evidence:
            tags.append(f"evidence:{evidence[:60]}")

        try:
            resp = client.post_note(
                title=title,
                summary=summary,
                category="knowledge",
                tags=tags,
            )
            key = resp.get("key") or resp.get("note_key") or "?"
            injected += 1
            if injected % 10 == 0 or injected <= 3:
                print(f"  [{injected}/{len(notes)}] {key[:40]}  {title[:60]!r}")
        except Exception as exc:  # noqa: BLE001
            errors += 1
            print(f"  [ERR] {title[:60]!r}: {exc}")

        # Settle every batch_size notes so the embedder can keep up
        if (i + 1) % args.batch_size == 0 and (i + 1) < len(notes):
            print(f"  ... settling {args.settle}s ...")
            time.sleep(args.settle)

    elapsed = time.monotonic() - t0
    print(f"\nDone: {injected} injected, {errors} errors in {elapsed:.1f}s")

    # Final settle so embedder indexes everything before bench starts
    print(f"Final settle 5s ...")
    time.sleep(5)
    print("Checking daemon note count after injection ...")
    _check_daemon(client)

    return 0 if errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
