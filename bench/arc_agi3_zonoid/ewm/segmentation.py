"""Connected-component segmentation of a single grid layer.

A grid is a list of rows, each row a list of small non-negative ints (colors). The
grid is partitioned into 4-connected components of equal color via flood fill; each
component becomes a node carrying an id, color, pixel count, corner-reduced boundary,
a translation-invariant hash, and the ids of the components it fully encloses.

Standard-library only and free of project imports so the source can be inlined into
the REPL sandbox bootstrap, where project packages are not importable.
"""

from __future__ import annotations

import hashlib

# 4-connected orthogonal neighbour offsets.
_ORTH = ((-1, 0), (1, 0), (0, -1), (0, 1))
# Clockwise Moore-neighbour offsets, starting at the NW corner.
_CW = ((-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1))
_CW_INDEX = {off: i for i, off in enumerate(_CW)}


def _trace_outer_contour(cells, start):
    """Moore-neighbour trace of a 4-connected component's outer perimeter, clockwise.

    ``start`` is the reading-order-minimum cell of the component, so its west
    neighbour is guaranteed to lie outside the component -- a valid backtrack seed.
    """
    if len(cells) == 1:
        return [start]

    contour = [start]
    b = start
    prev = (start[0], start[1] - 1)  # west neighbour: outside the component
    second = None
    for _ in range(8 * len(cells) + 16):
        idx = _CW_INDEX[(prev[0] - b[0], prev[1] - b[1])]
        nxt = None
        new_prev = None
        for k in range(1, 9):
            off = _CW[(idx + k) % 8]
            cand = (b[0] + off[0], b[1] + off[1])
            if cand in cells:
                nxt = cand
                back = _CW[(idx + k - 1) % 8]
                new_prev = (b[0] + back[0], b[1] + back[1])
                break
        if nxt is None:
            break
        if second is None:
            second = nxt
        elif b == start and nxt == second:  # Jacob's stopping criterion
            break
        contour.append(nxt)
        prev, b = new_prev, nxt

    if len(contour) > 1 and contour[-1] == contour[0]:
        contour.pop()
    return contour


def _corner_points(contour):
    """Reduce a traced contour loop to the points where its direction changes."""
    if len(contour) <= 2:
        return list(contour)
    m = len(contour)
    corners = []
    for i in range(m):
        prev, cur, nxt = contour[i - 1], contour[i], contour[(i + 1) % m]
        d_in = (cur[0] - prev[0], cur[1] - prev[1])
        d_out = (nxt[0] - cur[0], nxt[1] - cur[1])
        if d_in != d_out:
            corners.append(cur)
    return corners


def _object_hash(cells, color):
    """Translation-invariant signature: color plus cell shape normalized to a
    top-left origin, so an identical shape+color yields the same hash wherever it
    sits. Lets objects be matched across frames or between repeated instances."""
    min_r = min(r for r, _ in cells)
    min_c = min(c for _, c in cells)
    norm = sorted((r - min_r, c - min_c) for r, c in cells)
    payload = repr((color, norm)).encode()
    return hashlib.sha1(payload).hexdigest()[:16]


def segment_grid(grid):
    """Segment a grid into 4-connected same-color component nodes.

    ``grid`` is a list of equal-length rows of small ints. Returns a dict with:

      - ``nodes``: list of node dicts in reading order (the id order), each with:
          - ``id``: index in the top-most-left-most cell ordering.
          - ``color``: the component's integer color.
          - ``pixels``: number of cells in the component.
          - ``boundary``: outer perimeter as an ordered clockwise list of
            ``[row, col]`` corner points (a Moore trace reduced to direction-change
            vertices; enclosed holes are not traced).
          - ``hash``: translation-invariant color+shape signature.
          - ``children``: ids of components directly enclosed by this node -- A is a
            child of B only when B is the innermost component fully surrounding A.
      - ``adjacency_list``: sorted list of ``[i, j]`` id pairs for components that
        share a 4-connected edge (includes parent/child pairs, since they touch).
    """
    height = len(grid)
    width = len(grid[0]) if height else 0

    # Connected components, 4-connectivity. A reading-order scan assigns ids in
    # top-most-left-most order, so ``start`` cells are already sorted by that key.
    comp_id = [[-1] * width for _ in range(height)]
    components = []  # each: {"value": int, "cells": set[(r, c)], "start": (r, c)}
    for sr in range(height):
        for sc in range(width):
            if comp_id[sr][sc] != -1:
                continue
            value = grid[sr][sc]
            cid = len(components)
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
            components.append({"value": int(value), "cells": cells, "start": (sr, sc)})

    n = len(components)

    # Adjacency: any two distinct components with 4-adjacent cells touch.
    adj_pairs = set()
    for r in range(height):
        for c in range(width):
            cid = comp_id[r][c]
            if r + 1 < height and comp_id[r + 1][c] != cid:
                other = comp_id[r + 1][c]
                adj_pairs.add((min(cid, other), max(cid, other)))
            if c + 1 < width and comp_id[r][c + 1] != cid:
                other = comp_id[r][c + 1]
                adj_pairs.add((min(cid, other), max(cid, other)))
    adjacency_list = sorted([a, b] for a, b in adj_pairs)

    # Containment: for each component b, flood its complement inward from the grid
    # border; any component whose start cell is never reached is enclosed by b.
    enclosers = [set() for _ in range(n)]
    for b in range(n):
        reached = [[False] * width for _ in range(height)]
        stack = []
        for r in range(height):
            for c in (0, width - 1):
                if comp_id[r][c] != b and not reached[r][c]:
                    reached[r][c] = True
                    stack.append((r, c))
        for c in range(width):
            for r in (0, height - 1):
                if comp_id[r][c] != b and not reached[r][c]:
                    reached[r][c] = True
                    stack.append((r, c))
        while stack:
            r, c = stack.pop()
            for dr, dc in _ORTH:
                nr, nc = r + dr, c + dc
                if 0 <= nr < height and 0 <= nc < width and not reached[nr][nc] and comp_id[nr][nc] != b:
                    reached[nr][nc] = True
                    stack.append((nr, nc))
        for a in range(n):
            if a == b:
                continue
            ar, ac = components[a]["start"]
            if not reached[ar][ac]:
                enclosers[a].add(b)

    # Parent = innermost encloser. Enclosers are transitive, so along a nesting
    # chain the innermost is the one that is itself most deeply enclosed.
    children = [[] for _ in range(n)]
    for a in range(n):
        if enclosers[a]:
            parent = max(enclosers[a], key=lambda e: (len(enclosers[e]), -e))
            children[parent].append(a)
    for child_list in children:
        child_list.sort()

    nodes = []
    for cid in range(n):
        comp = components[cid]
        boundary = _corner_points(_trace_outer_contour(comp["cells"], comp["start"]))
        nodes.append(
            {
                "id": cid,
                "color": comp["value"],
                "pixels": len(comp["cells"]),
                "boundary": [[r, c] for r, c in boundary],
                "hash": _object_hash(comp["cells"], comp["value"]),
                "children": children[cid],
            }
        )

    return {"nodes": nodes, "adjacency_list": adjacency_list}
