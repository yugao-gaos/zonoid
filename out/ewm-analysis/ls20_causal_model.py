#!/usr/bin/env python3
"""Derive ls20 causal model from banked transition suites (analysis only).

Reads (before_grid, action, after_grid) triples from the MAIN checkout at
/Users/imyu/Desktop/zonoid/out/ewm-runs/*/transition-suite.json and answers:
 1. ink persistence (does color-9 trail survive cursor departure?)
 2. left box as mini-map (correlate left-box cell changes vs cursor block pos)
 3. bottom-left glyph static or dynamic
 4. life-loss reset diffs (timer refill frames)
 5. coincident indicator flips
"""
import json, glob, collections, sys

RUNS_GLOB = "/Users/imyu/Desktop/zonoid/out/ewm-runs/ls20-*/transition-suite.json"
LEGEND = {0:'@',1:'K',2:'2',3:'.',4:' ',5:'#',6:'6',7:'7',8:'8',9:'~',10:'X',11:'M',12:'P'}

CANVAS = (25, 49, 34, 53)      # rows, cols inclusive
LEFTBOX = (30, 39, 14, 28)
BOTLEFT = (53, 61, 1, 10)
TIMER_ROWS = (61, 62)

def render(g, r0=0, r1=63, c0=0, c1=63):
    return "\n".join("".join(LEGEND.get(g[r][c], '?') for c in range(c0, c1+1)) for r in range(r0, r1+1))

def mover_cells(g):
    return [(r, c) for r in range(64) for c in range(64) if g[r][c] == 12]

def mover_bbox(g):
    cells = mover_cells(g)
    if not cells: return None
    rs = [r for r, _ in cells]; cs = [c for _, c in cells]
    return (min(rs), max(rs), min(cs), max(cs))

def cursor_anchor(g):
    """top-left of 2x5 mover block"""
    b = mover_bbox(g)
    return (b[0], b[2]) if b else None

def block_pos(anchor):
    if not anchor: return None
    r, c = anchor
    return ((r - 25) // 5, (c - 34) // 5)

def region_cells(g, box):
    r0, r1, c0, c1 = box
    return tuple(tuple(g[r][c] for c in range(c0, c1+1)) for r in range(r0, r1+1))

def timer_count(g):
    return sum(1 for r in TIMER_ROWS for c in range(64) if g[r][c] == 11)

def color8_count(g):
    return sum(1 for r in range(64) for c in range(64) if g[r][c] == 8)

def canvas_nine(g):
    r0, r1, c0, c1 = CANVAS
    return {(r, c) for r in range(r0, r1+1) for c in range(c0, c1+1) if g[r][c] == 9}

def near_mover(cell, bbox, margin=1):
    if not bbox: return False
    r, c = cell
    return (bbox[0]-margin <= r <= bbox[1]+3+margin) and (bbox[2]-margin <= c <= bbox[3]+margin)
    # +3 rows below mover = tail zone

def load():
    suites = {}
    for p in sorted(glob.glob(RUNS_GLOB)):
        run = p.split('/')[-2]
        suites[run] = json.load(open(p))
    return suites

def main():
    suites = load()
    print("loaded runs:", {k: len(v) for k, v in suites.items()})

    # ---------- Q1 ink persistence ----------
    print("\n===== Q1: INK PERSISTENCE =====")
    persist_events = []
    for run, trs in suites.items():
        # build frame list per contiguous segment
        frames = []
        seg = [trs[0]['before_grid']]
        actions = []
        for i, t in enumerate(trs):
            actions.append((len(frames), len(seg)-1, t['action']))
            if seg[-1] != t['before_grid']:
                frames.append(seg); seg = [t['before_grid']]
            seg.append(t['after_grid'])
        frames.append(seg)
        for si, seg in enumerate(frames):
            # for each frame, 9-cells in canvas away from mover
            for fi in range(len(seg)):
                g = seg[fi]
                bbox = mover_bbox(g)
                away = {c for c in canvas_nine(g) if not near_mover(c, bbox)}
                if away:
                    # how long do they persist?
                    for cell in sorted(away):
                        k = 0
                        for fj in range(fi+1, len(seg)):
                            gj = seg[fj]
                            if gj[cell[0]][cell[1]] == 9: k += 1
                            else: break
                        persist_events.append((run, si, fi, cell, k))
    if persist_events:
        # summarize
        long_lived = [e for e in persist_events if e[4] > 3]
        print(f"away-from-mover 9-cells observed: {len(persist_events)}; persisting >3 frames: {len(long_lived)}")
        seen = set()
        for e in long_lived[:40]:
            key = (e[0], e[3])
            if key in seen: continue
            seen.add(key)
            print("  ", e)
    else:
        print("NO canvas color-9 cell was ever observed away from the mover. Ink does NOT persist.")

    # ---------- Q2 left box mini-map ----------
    print("\n===== Q2: LEFT BOX vs CURSOR BLOCK =====")
    change_records = []
    for run, trs in suites.items():
        for i, t in enumerate(trs):
            b, a = t['before_grid'], t['after_grid']
            lb_b, lb_a = region_cells(b, LEFTBOX), region_cells(a, LEFTBOX)
            if lb_b != lb_a:
                diffs = []
                r0, r1, c0, c1 = LEFTBOX
                for r in range(r0, r1+1):
                    for c in range(c0, c1+1):
                        if b[r][c] != a[r][c]:
                            diffs.append((r, c, b[r][c], a[r][c]))
                bp_b = block_pos(cursor_anchor(b)); bp_a = block_pos(cursor_anchor(a))
                change_records.append((run, i, t['action'], bp_b, bp_a, diffs))
    print(f"left-box change transitions: {len(change_records)}")
    for rec in change_records[:60]:
        print("  ", rec[0], rec[1], rec[2], "block", rec[3], "->", rec[4], "diffs", rec[5][:8], "..." if len(rec[5]) > 8 else "")

    # cross-tab: does a left-box cell value correlate with block position statically?
    # collect (block_pos -> left box content hash)
    bp_to_lb = collections.defaultdict(collections.Counter)
    for run, trs in suites.items():
        for i, t in enumerate(trs):
            for g in (t['before_grid'],):
                bp = block_pos(cursor_anchor(g))
                bp_to_lb[bp][region_cells(g, LEFTBOX)] += 1
    print("\nblock_pos -> #distinct left-box states:")
    for bp in sorted(bp_to_lb, key=str):
        print("  ", bp, len(bp_to_lb[bp]), "states, counts", sorted(bp_to_lb[bp].values(), reverse=True)[:5])

    # ---------- Q3 bottom-left glyph ----------
    print("\n===== Q3: BOTTOM-LEFT GLYPH =====")
    bl_states = collections.Counter()
    bl_first = {}
    for run, trs in suites.items():
        for i, t in enumerate(trs):
            for tag, g in (('b', t['before_grid']), ('a', t['after_grid'])):
                st = region_cells(g, BOTLEFT)
                bl_states[st] += 1
                if st not in bl_first: bl_first[st] = (run, i, tag)
    print(f"distinct bottom-left states across ALL runs/frames: {len(bl_states)}")
    for st, cnt in bl_states.most_common():
        r0, r1, c0, c1 = BOTLEFT
        print(f"-- count {cnt}, first seen {bl_first[st]}")
        print("\n".join("".join(LEGEND.get(v, '?') for v in row) for row in st))

    # ---------- Q4 timer refill resets ----------
    print("\n===== Q4: TIMER REFILL / LIFE LOSS =====")
    for run, trs in suites.items():
        for i, t in enumerate(trs):
            b, a = t['before_grid'], t['after_grid']
            tb, ta = timer_count(b), timer_count(a)
            if ta > tb + 4:  # refill jump
                eb, ea = color8_count(b), color8_count(a)
                diffs = collections.Counter()
                regions = {'canvas': CANVAS, 'leftbox': LEFTBOX, 'botleft': BOTLEFT, 'topbox': (8, 16, 32, 41)}
                regdiff = collections.Counter()
                for r in range(64):
                    for c in range(64):
                        if b[r][c] != a[r][c]:
                            diffs[(b[r][c], a[r][c])] += 1
                            for name, (r0, r1, c0, c1) in regions.items():
                                if r0 <= r <= r1 and c0 <= c <= c1:
                                    regdiff[name] += 1
                bp_b = block_pos(cursor_anchor(b)); bp_a = block_pos(cursor_anchor(a))
                print(f"{run}[{i}] act={t['action']} timer {tb}->{ta} col8 {eb}->{ea} cursorblock {bp_b}->{bp_a}")
                print("   value diffs:", dict(diffs))
                print("   region diffs:", dict(regdiff))

    # ---------- Q5: any other change coincident ----------
    print("\n===== Q5: TOP BOX / indicator changes =====")
    tb_states = collections.Counter()
    for run, trs in suites.items():
        prev = None
        for i, t in enumerate(trs):
            b, a = t['before_grid'], t['after_grid']
            sb = region_cells(b, (8, 16, 32, 41)); sa = region_cells(a, (8, 16, 32, 41))
            tb_states[sb] += 1; tb_states[sa] += 1
            if sb != sa:
                print(f"TOP BOX CHANGED {run}[{i}] act={t['action']}")
    print("distinct top-box states:", len(tb_states))

if __name__ == '__main__':
    main()
