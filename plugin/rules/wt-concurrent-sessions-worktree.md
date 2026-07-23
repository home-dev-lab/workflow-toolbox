# Concurrent sessions — isolate work in a git worktree, re-integrate only on your go

When you are already on a branch and another Claude Code session may be working the same repo,
isolate your work in a git worktree branched off the CURRENT branch:
`git worktree add ../<dir> -b <session-branch>`. Concurrent sessions that share one working tree
corrupt each other's edits and git state; a per-session worktree gives each an isolated tree over
the shared `.git`.

Two traps to watch:
- A fresh worktree starts from the COMMITTED tree only — untracked / git-ignored files
  (`.env`, local scratch, build artifacts, local config the work depends on) do NOT travel. Copy
  the ones this task needs into the new worktree before starting, and remember them again when you
  merge back.
- After the switch, every edit/read must target the WORKTREE path. An absolute path to the main
  tree — muscle memory, or one recalled from earlier — silently bypasses the isolation and edits
  the live tree. Tell: the path you are about to edit does not contain the worktree directory name.

Merge back only at the END, as a deliberate step (not incrementally), only when the user gives an
explicit go, and only after the other sessions have paused — so the merge target is not moving
under you. Carry back any needed untracked files too.
