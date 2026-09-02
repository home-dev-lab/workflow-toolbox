# Concurrent sessions — isolate in git worktree, re-integrate only on your go

Create worktree YOURSELF for concurrent work → branch off CURRENT branch:
`git worktree add ../<dir> -b <session-branch>`. Sessions sharing one tree corrupt each other's
edits/git state. Per-session worktree = isolated tree over shared `.git`.

Harness-managed isolated spawns = different mechanism/trap: may start from repo's DEFAULT
branch, not yours. Work must build on unmerged branch → verify base at spawn time, not after.

- NOT on default branch → **the SPAWNER re-bases the tree, immediately after the spawn call
  returns. Never the spawned agent.** The pilot guard REFUSES a delegate's own rebase — changing
  the base its gates ran against is what that guard exists to prevent — so a brief ordering the
  agent to rebase orders something it cannot do: it behaves correctly, relays, and waits. One
  full round trip per delegate, before any work starts. Keep the CHECK in the brief; the agent
  verifying its own base is right to.
- ⚠ **The operation is `reset --hard` on a FRESH worktree, NOT `rebase`.** A fresh worktree
  branched off the repo's DEFAULT branch, so a rebase replays UPSTREAM's own commits onto the
  integration branch and conflicts wherever the two diverged. Measured: `git rebase --autostash
  <tip>` exits 1 with a conflict; `git reset --hard <tip>` completes instantly and both proofs
  below pass.
- ⚠ **The discriminator, or the correction inverts later: does the worktree carry commits of its
  OWN yet?** Immediately after a spawn it does not, so `reset --hard` is right. Later in an arc
  it does, and `reset --hard` would DESTROY that work — rebase is right there. State which case
  you are in before choosing.
- Verify BOTH `git merge-base --is-ancestor <sha> HEAD` exits `0` AND a named
  target-branch-only file is present.
- Branch-only file check is part of the proof, not belt-and-suspenders: sha comparison alone
  reads same whether the tree was re-based correctly or fetched nothing; a file existing only on
  target branch distinguishes those states mechanically.
- ⚠ `--autostash` when the tree may be dirty, and TELL the delegate its work survived: an
  autostash pop can leave conflict markers WITHOUT failing the rebase. Clean exit code ≠ clean
  files. Re-basing under a RUNNING lane corrupts the tree — two writers; let the lane finish,
  have the delegate commit, then re-base.

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
