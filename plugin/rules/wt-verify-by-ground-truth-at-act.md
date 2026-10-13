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

**Exit code: COMMAND, never SUBJECT.** Correctly-read own code, un-piped gate can certify WRONG
TREE: aborted merge leaves subject unchanged; chained gate honestly certifies stale tree.
Before trusting green, establish WHICH TREE ran, separately from "did gate succeed".

**Branch adds tests → merged count STRICTLY GREATER, never merely not-lower.** Equal → merge
never landed, whatever gate code. Enforce mechanically: EXECUTING threshold beats recall.

`wt-merge-chain-guard-hook.mjs` enforces (PreToolUse Bash): journals `git merge` chained to gate/
unclassified command via `&&`, `;`, `|`, `||`, newline; diagnostic read silent but journaled.
Deliberately ignores merge preceded by commands and `git merge --abort/--continue/--quit`:
merge alone, read result, then gate. Additional-context warning, subagents included, if gate
failure cannot stop later `git commit`: gate alone, read exit, then commit, or chain with `&&`.

`wt-piped-gate-exit-code-guard-hook.mjs` enforces (PreToolUse Bash): warns, never blocks, on piped
control gate whose `$?` reads last element's code. Capture: `command > file; echo EXIT=$? >> file`,
or zsh `${pipestatus[1]}`.

## Parallel branches require a seam review

**Merging parallel branches requires THREE reviews: each branch, then their seam.**
Hold sibling branches and merge them together. Before merge, compare contracts by hand:
branch gates judge branches alone, never seam. After merge, run merged-tree gates —
the first mechanical checks that can judge the seam. No conflicts + green siblings ≠ seam certified.

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

## Delegate green report is input, not proof

**Delegate green report = input. Not proof of work. Not proof of WHERE it ran.** Re-run gates
yourself. Verify provenance from execution traces.

**A gate log at a FIXED path is evidence for nobody — the brief is where the collision is
authored.** A brief that names a fixed log path hands that same path to every delegate who ever
reads it, across sessions and across time; two runs write it, two readers read it, and neither can
prove whose green they saw. A brief names a STAMPED path (`<what>-<timestamp>.log`) or names none
and lets the delegate choose its own. Reusing a path also makes a completion marker meaningless — a
dead run's marker lands mid-file in a live run's output, present and greppable and false — so
completion is decided from the LAST line of the file, never from a match anywhere in it.
⚠ Tell, readable without knowing the other writer exists: a gate log whose green CONTRADICTS the
failures someone is discussing. Two readers who both find failures, or both find green, agree by
construction and the collision stays invisible.

**ANY surprise — good, bad, novel — is anomaly to EXPLAIN before you label it.** Favorable
surprise is the one that silently skip verification. Include FIRST occurrence of class never
observed before. Even mid-flow, off-task, harmless-looking. Skip-tell: you are BUSY and event is
peripheral.

## Shipping requires an explicit cross-platform verdict

**Ship anything → explicit CROSS-PLATFORM verdict.** Name system dependencies; per dependency SAY: throws,
degrade to named `unknown`, or silently return plausible value. Third dangerous: reassuring
number where unmeasurable = WORSE than no monitor; broken looks healthy. Linux-only legitimate;
assumed portability isn't.

## Summary asserting a guarantee is verified against its body, SAME pass

Docstring, header, comment claim a PROPERTY — "this path is literal", "cursor derive from
acknowledgements", "return everything after X"? Read the body under it before moving on. Not
later. Not as review step. Same pass — claim and code diverge at the moment code change and claim
does not.

Failure is not carelessness. Treating it as carelessness is why it repeat. Rewrite body, then
adjust summary → you describe what you INTENDED, not what you WROTE. That summary is exactly what
next reader trust when checking quickly. So it mislead exactly when it matter.

This is a GESTURE. No suspicion needed. No knowledge of code history needed. Tell that it is
needed: the sentence is reassuring.
