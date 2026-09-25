# wt-verify-by-ground-truth — rationale and field cases

The operative directives now live in `plugin/rules/wt-verify-by-ground-truth.md` and its
`-at-act` half. The merge-chain rationale moved with its directive to the matching `-at-act`
rationale file.

`wt-piped-gate-exit-code-guard-hook.mjs` is the complementary warn-only check: it detects a control gate piped to another command when `$?` is then read, because that status belongs to the final pipeline element without `pipefail`. Its paste-ready remedy is `command > file; echo EXIT=$? >> file`; zsh users who need a pipeline stage can read `${pipestatus[1]}`.
