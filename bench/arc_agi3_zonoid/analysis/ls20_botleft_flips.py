#!/usr/bin/env python3
"""Focused: what causes bottom-left 3x3 glyph cell flips? Where is the cursor,
what action, what else changed. Also: cursor range, plus-glyph interactions,
and win/score outcomes per run."""
import json, glob, collections

RUNS_GLOB = "/Users/imyu/Desktop/zonoid/out/ewm-runs/ls20-*/transition-suite.json"
LEGEND = {0:'@',1:'K',2:'2',3:'.',4:' ',5:'#',8:'8',9:'~',10:'X',11:'M',12:'P'}
BOTLEFT = (53, 61, 1, 10)

def mover_bbox(g):
    cells = [(r, c) for r in range(64) for c in range(64) if g[r][c] == 12]
    if not cells: return None
    rs = [r for r, _ in cells]; cs = [c for _, c in cells]
    return (min(rs), max(rs), min(cs), max(cs))

def glyph3x3(g):
    # 3x3 of 2x2 cells: rows 55-56/57-58/59-60, cols 3-4/5-6/7-8; ~(9)=on, #(5)=off
    out = []
    for gr in range(3):
        row = ''
        for gc in range(3):
            r = 55 + gr*2; c = 3 + gc*2
            row += 'X' if g[r][c] == 9 else '.'
        out.append(row)
    return tuple(out)

def region(g, r0, r1, c0, c1):
    return tuple(tuple(g[r][c] for c in range(c0, c1+1)) for r in range(r0, r1+1))

suites = {}
for p in sorted(glob.glob(RUNS_GLOB)):
    suites[p.split('/')[-2]] = json.load(open(p))

print("===== ALL BOTLEFT GLYPH CHANGES =====")
for run, trs in suites.items():
    for i, t in enumerate(trs):
        b, a = t['before_grid'], t['after_grid']
        gb, ga = glyph3x3(b), glyph3x3(a)
        if gb != ga:
            bb, ba = mover_bbox(b), mover_bbox(a)
            flips = [(gr, gc, gb[gr][gc], ga[gr][gc]) for gr in range(3) for gc in range(3) if gb[gr][gc] != ga[gr][gc]]
            print(f"{run}[{i}] act={t['action']} mover {bb}->{ba} flips {flips}")
            print("   before:", '/'.join(gb), " after:", '/'.join(ga))

print("\n===== CURSOR RANGE (mover bbox extremes across all frames) =====")
rmin, rmax, cmin, cmax = 99, -1, 99, -1
anchors = collections.Counter()
for run, trs in suites.items():
    for t in trs:
        for g in (t['before_grid'], t['after_grid']):
            b = mover_bbox(g)
            if b:
                rmin, rmax = min(rmin, b[0]), max(rmax, b[1])
                cmin, cmax = min(cmin, b[2]), max(cmax, b[3])
                anchors[(b[0], b[2])] += 1
print("mover row range", rmin, rmax, "col range", cmin, cmax)
print("distinct anchors:", len(anchors))
rows = sorted({r for r, c in anchors}); cols = sorted({c for r, c in anchors})
print("anchor rows:", rows)
print("anchor cols:", cols)

print("\n===== PLUS GLYPH (rows 30-34, cols 19-23) states =====")
pg = collections.Counter()
pg_first = {}
for run, trs in suites.items():
    for i, t in enumerate(trs):
        for tag, g in (('b', t['before_grid']), ('a', t['after_grid'])):
            bb = mover_bbox(g)
            # skip frames where mover overlaps this region
            if bb and not (bb[3] < 19 or bb[2] > 23 or bb[1]+3 < 30 or bb[0] > 34):
                continue
            st = region(g, 30, 34, 19, 23)
            pg[st] += 1
            if st not in pg_first: pg_first[st] = (run, i, tag)
print("distinct plus-glyph states (mover clear):", len(pg))
for st, cnt in pg.most_common(6):
    print(f"-- count {cnt} first {pg_first[st]}")
    print("\n".join("".join(LEGEND.get(v,'?') for v in row) for row in st))

print("\n===== TOP BOX target glyph reading =====")
# rows 11-13 x cols 35-37 per OVERRIDE
for run in ['ls20-1783701123']:
    g = suites[run][0]['before_grid']
    print("\n".join("".join(LEGEND.get(g[r][c],'?') for c in range(32, 42)) for r in range(8, 17)))
