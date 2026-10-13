# Concurrent sessions — isolate in git worktree, re-integrate only on your go — at act

Concurrent work: create worktree YOURSELF under `<project root>/.claude/worktrees/<name>`,
off CURRENT branch: `git worktree add .claude/worktrees/<name> -b <session-branch>`.
Git-ignore where governing: `.claude/` own repo → `worktrees/` in `.claude/.gitignore`;
otherwise `.claude/worktrees/` in root `.gitignore`. Harness convention: exempt from `.claude/`
protection, visible to root-confined tools, normal repo globs/tests don't descend. Shared tree
corrupts sessions' edits/git state; per-session worktree isolates tree over shared `.git`.
Never mass-move existing worktrees; leave until deliberately purged.

Harness-managed isolation differs: may start from DEFAULT branch, not yours. Unmerged-branch
dependency → verify base AT SPAWN, not after.

- NOT on default branch → **SPAWNER re-bases immediately after spawn returns, never delegate.**
  Pilot guard REFUSES delegate rebase: protects gated base. Brief ordering rebase → correct
  refusal/relay/wait, full round trip per delegate before work. Keep CHECK in brief;
  delegate verifying own base is right.
- ⚠ **FRESH worktree: `reset --hard`, NOT `rebase`.** Default-branch fresh tree rebase replays
  UPSTREAM commits onto integration branch, conflicts at divergence.
- ⚠ **First discriminate: own commits yet?** Immediately post-spawn, no → `reset --hard`.
  Later, yes → reset DESTROYS work, rebase right. State case before choosing; otherwise
  correction inverts.
- Verify BOTH `git merge-base --is-ancestor <sha> HEAD` exits `0` AND named target-branch-only
  file present.
- File check = proof, not redundancy: sha alone reads same for correct re-basing/fetching
  nothing; target-only file distinguishes mechanically.
- ⚠ Possibly dirty tree → `--autostash`; TELL delegate work survived. Pop may leave conflict
  markers WITHOUT rebase failure; clean exit ≠ clean files. Never re-base under RUNNING lane:
  two writers corrupt tree. Let lane finish, have delegate commit, then re-base.

Never harness-managed isolation for agents delegating writes elsewhere then idling: auto-cleaned
tree can look unchanged at agent stop while delegated writes remain in flight → removed under
live writer. Implementation outside own tree → create worktree yourself, pass path in brief.

Two traps:
- Fresh = COMMITTED only; untracked/git-ignored `.env`, scratch, build artifacts, needed local
  config do NOT travel. Copy task needs before starting; remember again at merge back.
- After switch, ALL reads/edits target WORKTREE. Main-tree absolute path (muscle memory/earlier
  recall) silently bypasses isolation, edits live tree. Tell: path lacks worktree directory name.

Isolated agent → ALL git commands target THAT worktree; shared-checkout fallback looks normal,
bypasses isolation.

Merge back deliberately only at END, never incrementally, only user's explicit go, other sessions
paused → target not moving. Carry needed untracked files too.
