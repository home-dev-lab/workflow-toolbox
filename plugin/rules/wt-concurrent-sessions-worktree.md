# Concurrent sessions — isolate work in a git worktree, re-integrate only on your go

When you create the worktree YOURSELF for concurrent work, branch it off the CURRENT branch:
`git worktree add ../<dir> -b <session-branch>`. Concurrent sessions that share one working tree
corrupt each other's edits and git state; a per-session worktree gives each an isolated tree over
the shared `.git`.

Harness-managed isolated spawns are a different mechanism and have a different trap: they may start
from the repository's DEFAULT branch rather than from the branch you are on. When the work must
build on an unmerged branch, verify the base at spawn time, not after the work lands.

- If you are NOT on the default branch, the FIRST instruction to the spawned agent must be:
  rebase onto `<branch>` at `<sha>`, then verify both that `git merge-base --is-ancestor <sha> HEAD`
  exits `0` and that a named file which exists only on the target branch is present.
- The branch-only file check is part of the proof, not belt-and-suspenders. A sha comparison alone
  reads the same whether the agent rebased correctly or fetched nothing; a file that exists only on
  the target branch distinguishes those states mechanically.

Do NOT use harness-managed isolation for an agent that delegates its writes elsewhere and goes idle
waiting for them. An auto-cleaned isolation tree can look unchanged at the exact moment the agent
stops even though delegated work is still in flight, so the tree can be removed under a live writer.
When implementation is delegated outside the agent's own tree, create the worktree yourself and pass
that path in the brief instead of relying on harness-managed isolation.

Two traps to watch:
- A fresh worktree starts from the COMMITTED tree only — untracked / git-ignored files
  (`.env`, local scratch, build artifacts, local config the work depends on) do NOT travel. Copy
  the ones this task needs into the new worktree before starting, and remember them again when you
  merge back.
- After the switch, every edit/read must target the WORKTREE path. An absolute path to the main
  tree — muscle memory, or one recalled from earlier — silently bypasses the isolation and edits
  the live tree. Tell: the path you are about to edit does not contain the worktree directory name.

If an agent is working in an isolated worktree, every git command must target THAT worktree
explicitly. A command that falls back to some shared checkout can look normal while bypassing the
isolation entirely.

Merge back only at the END, as a deliberate step (not incrementally), only when the user gives an
explicit go, and only after the other sessions have paused — so the merge target is not moving
under you. Carry back any needed untracked files too.
