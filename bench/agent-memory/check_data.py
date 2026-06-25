import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from datasets import load_locomo

data_dir = r"C:\Users\Imyu\.zonoid-bench-data"
records = load_locomo(data_dir)
print(f"Loaded {len(records)} conversations")
for r in records:
    print(f"  {r['conv_id']}: {len(r['sessions'])} sessions, {len(r['probes'])} probes")
