# Task: computeRatio (ON-vs-OFF token ratios from trial transcripts)

Implement `computeRatio(onTranscript, offTranscript)` in a NEW file
`bench/sandbox/compute-ratio-ht.js` in the repo `__INSTALL_DIR__`. Do NOT run `git commit`.

## Goal

The benchmark harness compares orchestrator-ON trials against orchestrator-OFF trials by reading
their JSONL transcript files and computing token-usage ratios. Given the paths to two transcript
files, return an object with three ON/OFF ratios.

## JSONL transcript format

Each line in a transcript file is a JSON object. Lines that carry token usage have a `usage` field:

```json
{ "role": "assistant", "usage": { "input_tokens": 120, "output_tokens": 45, "cache_read_input_tokens": 800, "cache_creation_input_tokens": 0 } }
```

Lines without a `usage` field (e.g. tool results, user turns) are skipped for token counting.

Additionally, lines that represent MCP tool-response messages carry a `source` field set to
`"mcp_tool"`. These lines may or may not have a `usage` field; for metric purposes, treat any
tokens on MCP tool-response lines as **plumbing overhead** to be subtracted for the `net` metric.

## Metrics to compute

For each transcript, compute:

- **gross** — sum of ALL `input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens` across every line that has `usage`.
- **net** — gross minus the same sum computed over only the MCP tool-response lines (`source === "mcp_tool"`).
- **output** — sum of `output_tokens` only, across every line that has `usage`.

Then return the ON/OFF ratio for each:

```js
{
  gross:  onGross  / offGross,
  net:    onNet    / offNet,
  output: onOutput / offOutput,
}
```

Round each ratio to 4 decimal places.

## Public examples

**Example 1** — simple, no MCP plumbing:

ON transcript (2 lines with usage):
```
{"role":"assistant","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}
{"role":"assistant","usage":{"input_tokens":80,"output_tokens":30,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}
```
OFF transcript (1 line with usage):
```
{"role":"assistant","usage":{"input_tokens":200,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}
```

ON gross = 260, OFF gross = 300 → gross ratio = 0.8667
ON output = 80, OFF output = 100 → output ratio = 0.8
net ratios equal gross ratios (no MCP lines).

Result: `{ gross: 0.8667, net: 0.8667, output: 0.8 }`

**Example 2** — with MCP plumbing and large cache_read:

ON transcript:
```
{"role":"assistant","usage":{"input_tokens":50,"output_tokens":40,"cache_read_input_tokens":2000,"cache_creation_input_tokens":0}}
{"role":"assistant","source":"mcp_tool","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":1800,"cache_creation_input_tokens":0}}
```
OFF transcript:
```
{"role":"assistant","usage":{"input_tokens":200,"output_tokens":80,"cache_read_input_tokens":200,"cache_creation_input_tokens":0}}
```

ON gross = (50+40+2000) + (10+5+1800) = 2090 + 1815 = 3905
ON net   = 3905 − 1815 = 2090
ON output = 40 + 5 = 45

OFF gross = 200+80+200 = 480
OFF net   = 480 (no MCP lines)
OFF output = 80

gross ratio  = 3905 / 480  = 8.1354
net ratio    = 2090 / 480  = 4.3542
output ratio =   45 /  80  = 0.5625

Result: `{ gross: 8.1354, net: 4.3542, output: 0.5625 }`

## Edge cases your implementation must handle

- A transcript file may contain lines that are not valid JSON — skip them silently.
- A usage line may omit some usage sub-fields — treat missing fields as 0.
- If either denominator (off value) is 0, return `null` for that ratio instead of dividing by zero.
- Large `cache_read_input_tokens` values inflate gross and net significantly — your arithmetic must
  handle them correctly.

## Contract

- File: `bench/sandbox/compute-ratio-ht.js`, exporting `module.exports = { computeRatio };` (CommonJS).
- `computeRatio` reads the two files synchronously (using `fs.readFileSync`).
- Returns `{ gross, net, output }` where each value is a number rounded to 4 decimal places, or
  `null` for any ratio where the denominator is zero.
- Keep it tight. Create `bench/sandbox/` if it does not exist.

Write your best implementation and stop. Do not write any test files.
