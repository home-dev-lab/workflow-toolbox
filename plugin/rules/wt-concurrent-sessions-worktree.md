# Concurrent sessions — isolate in git worktree, re-integrate only on your go

Per-session worktree = isolated tree over shared `.git`. Do not mass-move existing worktrees;
leave them where they are until deliberately purged.

Harness-managed isolated spawns = different mechanism/trap: may start from repo's DEFAULT
branch, not yours. Work must build on unmerged branch → verify base at spawn time, not after.

The act-bound half of this rule is served on demand as `wt-concurrent-sessions-worktree-at-act.md`.
