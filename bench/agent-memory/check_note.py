import json

path = r"C:\bench-workspaces\cl3-test\conv-26\.graph\nodes\note%3Anote-mqiwcr40dkn.jsonl"
with open(path, encoding='utf-8') as f:
    for line in f:
        d = json.loads(line)
        if 'summary' in d or d.get('evt') == 'created':
            print(f"evt: {d.get('evt')}")
            print(f"title: {d.get('title', '')[:100]}")
            summary = d.get('summary', '')
            print(f"summary: {summary[:400]}")
            print("---")
            break
