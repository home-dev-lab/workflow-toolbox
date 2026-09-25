# wt-concurrent-sessions-worktree — rationale and field cases

The core keeps the pre-edit isolation directive. The detailed worktree creation, rebase, and
reintegration procedures live in `plugin/rules/wt-concurrent-sessions-worktree-at-act.md`. Some
clauses map onto shipped hooks: `wt-pilot-guard-hook.mjs` refuses a delegate's own merge of
`main`/`master`, and `wt-isolated-spawn-report-path-hook.mjs` warns on an isolated spawn briefed to
write its report outside its own worktree.
