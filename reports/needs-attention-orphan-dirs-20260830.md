# Needs-Attention Orphan Dirs Audit

- Task: codex/audit-needs-attention-orphan-dirs-20260830
- Generated: 2026-08-30T21:55:58.563Z
- Repo: /Users/imyu/Desktop/zonoid
- Scope: repo-local NEEDS-ATTENTION entries that are not currently registered Git worktrees
- Delete-safe: 0
- Preserve/unknown: 144
- Registered worktrees excluded: 7

## Decision

No delete-safe orphan directories were proven. Every non-registered NEEDS-ATTENTION entry retained either live payload, a broken git pointer, or probe-failure uncertainty, so the only safe classification is preserve/unknown.

## Artifacts

- `reports/needs-attention-orphan-dirs-20260830.json`
- `reports/needs-attention-orphan-dirs-20260830.excluded-registered.json`
