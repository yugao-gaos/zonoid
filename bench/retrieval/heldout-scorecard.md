# Held-out retrieval scorecard — search_knowledge

Generated: 2026-06-14T04:34:36.305Z  
Daemon: `http://127.0.0.1:8857` (isolated snapshot)  
Eval set: `bench/retrieval/heldout-eval-set.json` (v1)  
Status: **PASS**

## Per-candidate aggregate (k=5)

| candidate | negative | recall@k | MRR@k | queries |
|-----------|----------|----------|-------|---------|
| task-transcript | no | 1 | 1 | 4 |
| locale-sum | no | 1 | 1 | 5 |
| bench-metric | no | 0.4 | 0.4 | 5 |
| interval-merge | yes | 1 | 1 | 5 |

### task-transcript

| query | recall | MRR | contaminated |
|-------|--------|-----|--------------|
| task transcript owner resolution exact-session drops tasks window overlap correlation resolveOwner assignee | 1 | 1 | — |
| resolveOwner taskKey registry assignee transcript_path sessionTranscript byWindow fallback | 1 | 1 | — |
| how to attribute a task token usage to the correct agent transcript file | 1 | 1 | — |
| task claim window overlap transcript attribution when assignee has no session | 1 | 1 | — |

### locale-sum

| query | recall | MRR | contaminated |
|-------|--------|-----|--------------|
| sumAmounts amount feed decimal format parsing | 1 | 1 | — |
| sumAmounts amount feed total rounding monetary string parsing | 1 | 1 | — |
| sumAmounts amount string parsing monetary rounding | 1 | 1 | — |
| locale decimal format en-US de-DE amount parseFloat mis-sum | 1 | 1 | — |
| sumAmounts amount feed billing total string parsing | 1 | 1 | — |

### bench-metric

| query | recall | MRR | contaminated |
|-------|--------|-----|--------------|
| computeRatio token usage transcript mcp_tool gross net ratio | 1 | 1 | — |
| computeRatio benchmark token ratio transcript mcp_tool net gross | 1 | 1 | — |
| computeRatio ON OFF token ratios transcript JSONL benchmark | 0 | 0 | — |
| token ratio computation ON OFF transcript benchmark metrics | 0 | 0 | — |
| token ratio benchmark ON OFF transcript JSONL compute metrics | 0 | 0 | — |

### interval-merge (negative control)

| query | recall | MRR | contaminated |
|-------|--------|-----|--------------|
| interval merge overlapping touching intervals JavaScript | 1 | 1 | — |
| merge intervals overlapping touching sort | 1 | 1 | — |
| interval merge overlapping sorted JavaScript implementation | 1 | 1 | — |
| merge intervals algorithm benchmark sandbox | 1 | 1 | — |
| merge intervals JavaScript benchmark sandbox | 1 | 1 | — |

