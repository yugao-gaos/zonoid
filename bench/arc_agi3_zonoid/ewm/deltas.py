"""Object-level transition deltas for the EWM relative-coordinate synthesis path.

The synthesis redesign (design note "graph native synthesis relative coordinates
hypothesis menu design") presents transitions to the ANALYZE step as *object-level
deltas* instead of raw digit dumps: for each ``(before_grid, action, after_grid)`` we
segment both grids, match objects across the pair, and describe how the matched objects
changed -- ``moved (dr,dc)`` / ``grew +n`` / ``shrank -n`` / ``recolored old->new`` --
plus objects that ``appeared`` / ``disappeared``.

Object identity uses the segmentation layer's translation-invariant hash first (an exact
shape+color match, which survives pure translation), then falls back to best cell-overlap
(>=50% of the smaller object's cells shared) so a shape that grows/shrinks/recolors is
still recognized as the same object rather than one disappearing and another appearing.

Validation elsewhere stays absolute cell-by-cell; this module only produces the relative
summaries fed to the LLM. Pure standard library and deterministic.
"""

from __future__ import annotations

from .segmentation import segment_grid

# 4-connected orthogonal neighbour offsets -- must match segmentation._ORTH so the
# reading-order flood fill here assigns the same component ids as ``segment_grid``.
_ORTH = ((-1, 0), (1, 0), (0, -1), (0, 1))

# Fraction of the smaller object's cells that must be shared for an overlap match.
_OVERLAP_THRESHOLD = 0.5


def _component_cells(grid):
    """Reading-order flood fill yielding each component's cell set, id-aligned with
    :func:`segmentation.segment_grid` (same 4-connectivity + reading-order scan)."""
    height = len(grid)
    width = len(grid[0]) if height else 0
    comp_id = [[-1] * width for _ in range(height)]
    cells_by_id = []
    for sr in range(height):
        for sc in range(width):
            if comp_id[sr][sc] != -1:
                continue
            value = grid[sr][sc]
            cid = len(cells_by_id)
            cells = set()
            stack = [(sr, sc)]
            comp_id[sr][sc] = cid
            while stack:
                r, c = stack.pop()
                cells.add((r, c))
                for dr, dc in _ORTH:
                    nr, nc = r + dr, c + dc
                    if 0 <= nr < height and 0 <= nc < width and comp_id[nr][nc] == -1 and grid[nr][nc] == value:
                        comp_id[nr][nc] = cid
                        stack.append((nr, nc))
            cells_by_id.append(cells)
    return cells_by_id


def _bbox(cells):
    """Inclusive ``(min_r, min_c, max_r, max_c)`` bounding box of a cell set."""
    rows = [r for r, _ in cells]
    cols = [c for _, c in cells]
    return (min(rows), min(cols), max(rows), max(cols))


def _objects(grid):
    """Segment ``grid`` into objects carrying id, color, pixel count, hash, cells, bbox."""
    seg = segment_grid(grid)
    cells_by_id = _component_cells(grid)
    objs = []
    for node in seg["nodes"]:
        cells = cells_by_id[node["id"]]
        objs.append(
            {
                "id": node["id"],
                "color": node["color"],
                "pixels": node["pixels"],
                "hash": node["hash"],
                "cells": cells,
                "bbox": _bbox(cells),
            }
        )
    return objs


def _translation(before_obj, after_obj):
    """Translation ``(dr, dc)`` taking ``before_obj`` to ``after_obj`` via top-left cell.

    Both objects share a hash (identical normalized shape), so a single corner offset
    describes the whole move.
    """
    br, bc, _, _ = before_obj["bbox"]
    ar, ac, _, _ = after_obj["bbox"]
    return (ar - br, ac - bc)


def match_objects(before_objs, after_objs):
    """Match objects across two segmented grids.

    1. Exact translation-invariant hash match (color+shape identical). Ties within a
       hash are paired in id order, preferring the pairing with the smallest movement.
    2. Remaining objects paired by best cell-overlap, requiring the shared-cell count to
       be >= 50% of the *smaller* object so a growing/shrinking/recoloring object stays
       identified rather than splitting into appeared+disappeared.

    Returns ``(pairs, appeared, disappeared)`` where ``pairs`` is a list of
    ``(before_obj, after_obj)`` and the others are unmatched-object lists.
    """
    before_left = list(before_objs)
    after_left = list(after_objs)
    pairs = []

    # --- Stage 1: exact hash match, translation-invariant. ---
    after_by_hash = {}
    for obj in after_left:
        after_by_hash.setdefault(obj["hash"], []).append(obj)

    remaining_before = []
    for b in before_left:
        bucket = after_by_hash.get(b["hash"])
        if bucket:
            # Prefer the candidate requiring the smallest movement, then lowest id, so
            # matching is deterministic when several identical shapes are present.
            best = min(
                bucket,
                key=lambda a, b=b: (abs(a["bbox"][0] - b["bbox"][0]) + abs(a["bbox"][1] - b["bbox"][1]), a["id"]),
            )
            bucket.remove(best)
            if not bucket:
                del after_by_hash[b["hash"]]
            pairs.append((b, best))
        else:
            remaining_before.append(b)

    matched_after_ids = {a["id"] for _, a in pairs}
    remaining_after = [a for a in after_left if a["id"] not in matched_after_ids]

    # --- Stage 2: best cell-overlap for shape/color changers. ---
    # A pair matches when the shared cells are >= 50% of the SMALLER object. That alone
    # would let a large background object "absorb" a stray pixel that was really a
    # disappearing object (100% of the 1px object, but a negligible slice of the
    # background), so a cross-color match additionally requires the overlap to be a
    # majority of the LARGER object too -- a growing/shrinking/recoloring object shares
    # most of BOTH silhouettes, background absorption does not. Greedy by descending
    # overlap with same-color pairs preferred; deterministic id tie-break.
    candidates = []
    for b in remaining_before:
        for a in remaining_after:
            shared = len(b["cells"] & a["cells"])
            if shared == 0:
                continue
            small = shared / min(len(b["cells"]), len(a["cells"]))
            large = shared / max(len(b["cells"]), len(a["cells"]))
            if small < _OVERLAP_THRESHOLD:
                continue
            if b["color"] != a["color"] and large < _OVERLAP_THRESHOLD:
                continue
            same_color = 0 if b["color"] == a["color"] else 1
            candidates.append((same_color, -small, -large, b["id"], a["id"], b, a))
    candidates.sort(key=lambda t: (t[0], t[1], t[2], t[3], t[4]))

    used_before = set()
    used_after = set()
    for _sc, _s, _l, bid, aid, b, a in candidates:
        if bid in used_before or aid in used_after:
            continue
        used_before.add(bid)
        used_after.add(aid)
        pairs.append((b, a))

    disappeared = [b for b in remaining_before if b["id"] not in used_before]
    appeared = [a for a in remaining_after if a["id"] not in used_after]
    return pairs, appeared, disappeared


def _object_summary(obj):
    """Compact object descriptor used inside a delta record."""
    return {
        "id": obj["id"],
        "color": obj["color"],
        "pixels": obj["pixels"],
        "bbox": obj["bbox"],
    }


def _classify(before_obj, after_obj):
    """Describe how a matched object changed; ``None`` when it is unchanged.

    Precedence: a pure translation is ``moved``; otherwise a pixel-count change is
    ``grew``/``shrank`` and a same-count color change is ``recolored``. Objects that did
    not change are reported by the caller as unchanged (omitted).
    """
    if before_obj["hash"] == after_obj["hash"]:
        dr, dc = _translation(before_obj, after_obj)
        if dr == 0 and dc == 0:
            return None  # identical shape, color, and position -> unchanged
        return {"kind": "moved", "detail": (dr, dc)}

    if before_obj["color"] != after_obj["color"] and before_obj["pixels"] == after_obj["pixels"]:
        return {"kind": "recolored", "detail": (before_obj["color"], after_obj["color"])}

    delta = after_obj["pixels"] - before_obj["pixels"]
    if delta > 0:
        return {"kind": "grew", "detail": delta}
    if delta < 0:
        return {"kind": "shrank", "detail": delta}

    # Same color and pixel count but a different hash: shape changed in place. Report as a
    # zero-magnitude grow so the change is not silently dropped.
    return {"kind": "grew", "detail": 0}


def transition_deltas(before_grid, action, after_grid):
    """Object-level delta record for one transition.

    Returns ``{"action", "deltas": [...]}`` where each delta is
    ``{"object": {id,color,pixels,bbox}, "kind": moved|grew|shrank|recolored|appeared|disappeared,
    "detail": (dr,dc) | +n/-n | (old,new) | None}``. Unchanged objects are omitted; when
    nothing changed at all a ``"static": True`` flag is added.
    """
    before_objs = _objects(before_grid)
    after_objs = _objects(after_grid)
    pairs, appeared, disappeared = match_objects(before_objs, after_objs)

    deltas = []
    for b, a in pairs:
        change = _classify(b, a)
        if change is None:
            continue
        # ``moved``/``grew``/``shrank`` describe the after-state object; ``recolored`` too.
        deltas.append({"object": _object_summary(a), "kind": change["kind"], "detail": change["detail"]})
    for a in appeared:
        deltas.append({"object": _object_summary(a), "kind": "appeared", "detail": None})
    for b in disappeared:
        deltas.append({"object": _object_summary(b), "kind": "disappeared", "detail": None})

    # Stable order: by object id, then kind, so text output is deterministic.
    deltas.sort(key=lambda d: (d["object"]["id"], d["kind"]))

    record = {"action": action, "deltas": deltas}
    if not deltas:
        record["static"] = True
    return record


def _detail_text(kind, detail):
    """Human-readable tail for one delta, e.g. ``(+1,0)`` / ``+5`` / ``4->3``."""
    if kind == "moved":
        dr, dc = detail
        return "(%+d,%d)" % (dr, dc)
    if kind == "grew":
        return "+%d cells" % detail if detail else "shape change"
    if kind == "shrank":
        return "%d cells" % detail  # detail already negative
    if kind == "recolored":
        old, new = detail
        return "%d->%d" % (old, new)
    return ""  # appeared / disappeared carry no detail tail


def delta_text(record):
    """One compact line for a delta record.

    Example: ``ACTION1: obj#2 (color 4, 4px) moved (+1,0); obj#7 (color 3, 25px) grew +5 cells``.
    A record with no changes renders ``ACTION1: static``.
    """
    action = record["action"]
    if not record.get("deltas"):
        return "%s: static" % action

    parts = []
    for d in record["deltas"]:
        obj = d["object"]
        head = "obj#%d (color %d, %dpx) %s" % (obj["id"], obj["color"], obj["pixels"], d["kind"])
        tail = _detail_text(d["kind"], d["detail"])
        parts.append((head + " " + tail).rstrip() if tail else head)
    return "%s: %s" % (action, "; ".join(parts))


def _aggregate_action(action, records):
    """One aggregate effect line for all transitions sharing an action.

    Reports the most common ``(kind, color, detail)`` effect across the action's
    transitions with an ``[n/total transitions]`` support count, e.g.
    ``ACTION1: consistently moves obj color 4 by (+1,0) [4/4 transitions]``. When no single
    effect dominates (or the action is static throughout) it says so.
    """
    total = len(records)
    if all(r.get("static") or not r.get("deltas") for r in records):
        return "%s: no object changes [0/%d transitions]" % (action, total)

    # Count transitions exhibiting each canonical effect signature.
    counts = {}
    for r in records:
        seen = set()  # count each effect at most once per transition
        for d in r["deltas"]:
            sig = (d["kind"], d["object"]["color"], _detail_key(d["kind"], d["detail"]))
            if sig in seen:
                continue
            seen.add(sig)
            counts[sig] = counts.get(sig, 0) + 1

    if not counts:
        return "%s: no object changes [0/%d transitions]" % (action, total)

    # Most-supported effect wins; among equal support, the more INFORMATIVE effect wins
    # (a concrete move/resize/recolor over the zero-magnitude "reshape" bucket that a
    # reshuffling background falls into), then a stable descending signature order.
    best_sig = max(counts, key=lambda sig: (counts[sig], _informativeness(sig), _neg_sig_order(sig)))
    kind, color, detail = best_sig
    support = counts[best_sig]
    effect = _aggregate_phrase(kind, color, detail)
    lead = "consistently" if support == total else "usually"
    return "%s: %s %s [%d/%d transitions]" % (action, lead, effect, support, total)


def _informativeness(sig):
    """Higher = a more concrete/salient effect, used only to break support ties. The
    zero-magnitude ``grew`` bucket (a shape that changed with no pixel delta -- what a
    reshuffling background collapses into) is the least informative."""
    kind, _color, detail = sig
    if kind == "grew" and detail == 0:
        return 0
    return 1


def _detail_key(kind, detail):
    """Hashable canonical form of a delta detail for aggregate counting."""
    if kind in ("moved", "recolored"):
        return tuple(detail)
    return detail


def _neg_sig_order(sig):
    """Descending tie-break key (max() picks the lexicographically smallest signature
    among effects with equal support)."""
    kind, color, detail = sig
    ordinal = tuple(-ord(ch) for ch in kind)
    return (ordinal, -color, tuple(-ord(ch) for ch in str(detail)))


def _aggregate_phrase(kind, color, detail):
    """Phrase describing one aggregate effect, e.g. ``moves obj color 4 by (+1,0)``."""
    if kind == "moved":
        dr, dc = detail
        return "moves obj color %d by (%+d,%d)" % (color, dr, dc)
    if kind == "grew":
        return "grows obj color %d by +%d cells" % (color, detail) if detail else "reshapes obj color %d" % color
    if kind == "shrank":
        return "shrinks obj color %d by %d cells" % (color, detail)
    if kind == "recolored":
        old, new = detail
        return "recolors obj %d->%d" % (old, new)
    if kind == "appeared":
        return "adds obj color %d" % color
    if kind == "disappeared":
        return "removes obj color %d" % color
    return "changes obj color %d" % color


def summarize_suite(suite):
    """Summarize a :class:`world_model.TransitionSuite` as relative-coordinate text.

    Returns ``{"per_transition": [text, ...], "per_action": [aggregate_line, ...]}`` where
    ``per_transition`` is one :func:`delta_text` line per transition in suite order and
    ``per_action`` is one aggregate-effect line per distinct action (in first-seen order).
    """
    per_transition = []
    by_action = {}
    action_order = []
    for transition in suite:
        record = transition_deltas(transition.before_grid, transition.action, transition.after_grid)
        per_transition.append(delta_text(record))
        key = transition.action
        if key not in by_action:
            by_action[key] = []
            action_order.append(key)
        by_action[key].append(record)

    per_action = [_aggregate_action(action, by_action[action]) for action in action_order]
    return {"per_transition": per_transition, "per_action": per_action}
