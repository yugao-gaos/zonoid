import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

results_path = r"C:\Users\Imyu\.claude\orchestrator\worktrees\288633812625a9d6\9195fb5e-f196-497d-962f-69616733d2e9-21\bench\agent-memory\results.jsonl"

if not os.path.exists(results_path):
    print("results.jsonl not found")
    sys.exit(1)

records = []
with open(results_path, encoding='utf-8') as f:
    for line in f:
        records.append(json.loads(line.strip()))

print(f"Total records: {len(records)}")
by_arm = {}
for r in records:
    arm = r['arm']
    if arm not in by_arm:
        by_arm[arm] = {'total': 0, 'non_idk': 0}
    by_arm[arm]['total'] += 1
    if r.get('predicted') and r['predicted'] != "I don't know.":
        by_arm[arm]['non_idk'] += 1

for arm, stats in sorted(by_arm.items()):
    pct = stats['non_idk'] / stats['total'] * 100 if stats['total'] > 0 else 0
    print(f"  {arm}: {stats['total']} records, {stats['non_idk']} non-IDK ({pct:.1f}%)")

# Show search arm hit counts
search_recs = [r for r in records if r['arm'] == 'search']
hits_counts = [len(r.get('hit_keys') or []) for r in search_recs]
print(f"\nSearch arm hit_keys counts: {hits_counts}")
print(f"  avg hits: {sum(hits_counts)/len(hits_counts):.1f} (0 = broken, >0 = working)")
