# wt-verify-by-ground-truth — rationale and field cases

The operative directives now live in `plugin/rules/wt-verify-by-ground-truth.md`. This file carries the paragraph the shipped `wt-merge-chain-guard-hook.mjs` now enforces mechanically, kept here verbatim for provenance.

## Never chain a merge with its gates in one command

**Never chain a merge with its gates in one command.** `;`, or a newline, hand the next command
a stale tree to certify — same failure as piping a gate, one step earlier.
