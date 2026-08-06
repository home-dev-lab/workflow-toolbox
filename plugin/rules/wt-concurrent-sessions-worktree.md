# Concurrent sessions — isolate in git worktree, re-integrate only on your go

Create worktree YOURSELF for concurrent work → branch off CURRENT branch:
`git worktree add ../<dir> -b <session-branch>`. Sessions sharing one tree corrupt each other's
edits/git state. Per-session worktree = isolated tree over shared `.git`.

Harness-managed isolated spawns = different mechanism/trap: may start from repo's DEFAULT
branch, not yours. Work must build on unmerged branch → verify base at spawn time, not after.

- NOT on default branch → FIRST instruction to spawned agent: rebase onto `<branch>` at
  `<sha>`, verify BOTH `git merge-base --is-ancestor <sha> HEAD` exits `0` AND a named
  target-branch-only file is present.
- Branch-only file check is part of the proof, not belt-and-suspenders: sha comparison alone
  reads same whether agent rebased correctly or fetched nothing; a file existing only on target
  branch distinguishes those states mechanically.

Don't use harness-managed isolation for an agent delegating writes elsewhere then idling on
them. Auto-cleaned isolation tree can look unchanged at the exact moment agent stops though
delegated work is still in flight — tree can be removed under a live writer. Implementation
delegated outside agent's own tree → create worktree yourself, pass path in brief instead.

Two traps:
- Fresh worktree = COMMITTED tree only — untracked/git-ignored files (`.env`, local scratch,
  build artifacts, local config work depends on) do NOT travel. Copy what task needs into new
  worktree before starting; remember again on merge back.
- After switch, every edit/read targets WORKTREE path. Absolute path to main tree — muscle
  memory, or one recalled earlier — silently bypasses isolation, edits live tree. Tell: path
  you're editing lacks the worktree directory name.

Agent in isolated worktree → every git command targets THAT worktree. A command falling back
to a shared checkout can look normal while bypassing isolation.

Merge back only at END, as a deliberate step (not incremental), only on user's explicit go,
only after other sessions paused — merge target isn't moving under you then. Carry back needed
untracked files too.
