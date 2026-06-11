# Task: first-run onboarding design doc

Write a design doc for the zonoid first-run onboarding experience in the repo `__INSTALL_DIR__`.
Produce a single markdown file at `bench/sandbox/onboarding-design-ht.md`. Do NOT run `git commit`.

## Context

A user has just installed the zonoid plugin and launches Claude Code for the first time in a
new repository. They have never run the daemon before in this repo. Design the onboarding
experience they encounter.

## What to produce

A markdown design doc with the following sections:

### 1. User journey steps
List each step the user goes through from first launch to "ready to work". For each step include:
- What triggers the step
- What the user sees / is asked to do
- How long it takes (approximate)

### 2. UI at each step
Describe what the interface shows at each step — messages, progress indicators, prompts. Be
specific enough that an engineer could implement it without further design input.

### 3. Error states
For each step, describe the error state(s) that can occur and what the user sees. Cover at
minimum: setup failures, dependency problems, and cases where the system is not ready to serve
requests yet.

### 4. Success criteria
Define what "onboarding complete" means. How does the user know the system is working correctly?
What is the first meaningful action they can take?

## Scope

Focus on the first-run experience only (not subsequent launches). Assume the user is a senior
engineer comfortable with CLI tools. Keep the doc tight — prose where needed, bullet lists where
not.

Produce the markdown file, then stop. Do not write implementation code.
