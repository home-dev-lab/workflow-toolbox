# Verify by ground truth, not plausibility — at act

## A gate is its exit code, never its printed text

**Gate = EXIT CODE. Not printed text.** Redirect command to file. Write `$?` to same file right
after. Read file back.

Never pipe gate. Pipe exit status belong to LAST element. Failing gate piped anywhere report
success.

⚠ Code you read must belong to GATE. Not to thing that ran AFTER. Any command between gate and
read replace value. Wrapper script final `echo` succeed even when gate it wrap failed. Last
command in chain almost always the one whose code survive. Rarely the one that matter.
Real case: batch report `exit 0`. Typecheck had failed `exit 2`. Number read back was wrapper
trailing `echo`, not gate.
**Corroborate with SECOND signal that fail differently** — tool own summary line, failure count,
error marker in log. Read BESIDE code. Not instead of code.
One instrument agree with itself = not corroboration.

## A gate must certify the intended tree

**Exit code answer for the COMMAND, never the SUBJECT.** Gate can genuinely belong to gate, run
un-piped, code read correctly — and still certify the WRONG TREE. A merge that aborts leaves
subject unchanged; gate chained right after runs honestly on the stale tree, reports real
success about a subject nobody intended to certify. Before trusting a green: establish WHICH
TREE it ran on. Distinct question from "did the gate succeed".

**Branch adds tests → merged count must be STRICTLY GREATER, never merely not-lower.** Equal
count after a merge is the tell the merge never landed, whatever the gate's own exit code says.
State this one mechanically, not as a thing to remember — a threshold that EXECUTES beats a
check that depends on recall.

Enforced by `wt-merge-chain-guard-hook.mjs` (PreToolUse Bash: warns when `git merge` is chained with a gate or unclassified command through `&&`, `;`, `|`, `||`, or a newline; a diagnostic read is silent but journaled. It deliberately ignores a merge preceded by earlier commands and `git merge --abort/--continue/--quit` — run the merge alone, read its result, then gate).

Enforced by `wt-piped-gate-exit-code-guard-hook.mjs` (PreToolUse Bash: warns, never blocks, when a control gate is piped and `$?` then reads the last pipeline element's code; capture instead with `command > file; echo EXIT=$? >> file`, or use `${pipestatus[1]}` on zsh).

## Parallel branches require a seam review

**Merging parallel branches requires THREE reviews: each branch, then their seam.** Hold sibling
branches and merge them together. Before merging, compare their contracts by hand; branch gates
validate each branch alone, not their seam. Run the merged tree's gates after the merge: they are
the first mechanical checks that can judge the seam. A conflict-free merge and green sibling gates
do not certify it.

## Before measuring fix, prove subject RUN that fix

Separate process resolve its OWN copy: installed cache, published version, bundled build. Editing
working tree change none of them.

1. **WHICH FILE does process load?** Read off running process — command line, resolved module
   path, open file handles. Path observed on process is strong evidence. Version number INSIDE
   that path is part of it.
2. **WHICH VERSION of that file content?** Grep for sentence that exist only in the fix.

⚠ What lie is a DECLARED version — manifest entry, `--version`, package field. Can be perfectly
accurate while file actually loaded come from elsewhere. Path read off process is a DIFFERENT
thing. Conflating the two make reader discard valid evidence. Local commit prove the edit, never
the load.

Fix sentence absent from loaded file → measurement answer question about OLD code. Discard it in
BOTH directions. Clean result there is not evidence of success. It is evidence of NOTHING.
