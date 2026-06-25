# Task: benchmark protocol design doc

Write a design doc for a benchmark protocol that measures whether the zonoid context gate improves
agent output quality. Produce a single markdown file at `bench/sandbox/bench-design-ht.md` in the
repo `__INSTALL_DIR__`. Do NOT run `git commit`.

## Goal

The protocol must be **reproducible and publishable**: another team should be able to re-run it
on their own infrastructure and get comparable results. It must produce a valid signal — not just
a number, but a number that actually measures what it claims to measure.

## What to produce

A markdown design doc with the following sections:

### 1. Candidate task selection criteria
What makes a task suitable for inclusion in the benchmark? What makes a task unsuitable?
Describe the selection criteria precisely enough to apply them mechanically.

### 2. Metric definition
Define the primary metric used to compare ON vs OFF arms. Explain what it measures and why
that measure was chosen over alternatives. Define any secondary metrics used for diagnostic
purposes.

### 3. Arm design
Describe the ON arm and the OFF arm. What does each arm do differently? How are tasks assigned
to arms? How do you control for task difficulty, model variation, and prompt sensitivity?

### 4. Sample size and power
How many trials are needed? State the assumed effect size, desired power, and significance
threshold. Explain how you determined the sample size.

### 5. Win condition
Define the exact condition under which the ON arm is declared the winner. Include the threshold,
the test statistic, and how ties or inconclusive results are handled.

### 6. MCP plumbing overhead
The ON arm incurs MCP tool-call overhead that the OFF arm does not. Explain how the protocol
accounts for this so that overhead does not confound the quality measurement.

## Scope

Focus on design, not implementation. Assume the reader is a senior engineer who will implement
the harness. Be precise about definitions and thresholds — vague criteria are not acceptable.

Produce the markdown file, then stop. Do not write implementation code.
