# Concurrent sessions — isolate in git worktree, re-integrate only on your go

When another session works the same checkout, isolate your work in a git worktree before the
first edit; sessions sharing one tree corrupt each other's edits and git state. A
harness-isolated spawn may start from the repository's default branch.

Its act-bound half is `wt-concurrent-sessions-worktree-at-act.md`, loaded alongside this file or
served on demand where an engine is installed.
