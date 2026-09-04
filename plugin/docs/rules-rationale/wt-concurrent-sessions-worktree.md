# wt-concurrent-sessions-worktree — rationale and field cases

Nothing extracted. Every paragraph of `plugin/rules/wt-concurrent-sessions-worktree.md` fuses its directive with the
evidence for it at paragraph granularity — the split invariant (whole paragraphs only, never a
mid-paragraph cut) leaves nothing isolable as pure story or dated field case. Some clauses do map onto shipped hooks: `wt-pilot-guard-hook.mjs` refuses a delegate's own merge of `main`/`master`, and `wt-isolated-spawn-report-path-hook.mjs` warns on an isolated spawn briefed to write its report outside its own worktree.
