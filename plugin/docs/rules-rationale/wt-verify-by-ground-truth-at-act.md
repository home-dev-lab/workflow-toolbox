# wt-verify-by-ground-truth-at-act - rationale and field cases

## Never chain a merge with its gates in one command

**Never chain a merge with its gates in one command.** `&&`, `;`, `|`, `||`, or a newline hand the next
command a stale tree to certify — same failure as piping a gate, one step earlier.

## Parallel-branch seam

Separate branch gates can each validate a contract against the sibling state that existed when
work began. Only a contract comparison before the combined merge and gates on the merged tree can
evaluate the interaction between both completed branches.
