# Delegation ladder (workflow-toolbox) — at act

⚠ **"Adopted" = PRECONDITION, not adjective — verify type resolves BEFORE writing brief.**
Pilot pair deliberately UNREGISTERED in `plugin/agent-templates/`: harness ignores `observer:`
on plugin-registered agents → silent watchdog loss. Unadopted project has no `pilot`; ladder gives no
notice → spawn fails AFTER expensive, complete brief. `install.mjs --set agents --install`
adds version banner for later `--check` staleness reports; hand copy works, loses banner/check.
⚠ Adopted/new types may resolve same session, no restart, immediately or after a few minutes
under load. Allow delay; **re-probe after refusal rather than declare unavailable**; needed now
→ arrange verification when type resolves.

## Briefing an executor (the split that makes delegation safe)

Arbiter designs, briefs, gates, reviews, commits; executor implements, adjusts only within named
seams. Structural decisions (state-machine shape, API surface, seam boundaries, ownership,
data-flow) stay arbiter's. Open-ended "refactor this" = inadequate brief.

Strong brief: invariants to preserve (tests/reasons), known traps, non-goals/scope fences,
required evidence format (exit codes + output tails), operating boundaries (no commits/pushes, one
working directory, sequential execution). Under-specification → extra review rounds. Executor
flags possible completeness gap ("every X must produce Y") → arbiter requires guard or proves case
impossible; never files harmless scope note.

Every hand-written executor-lane brief requires `## Lessons for the memory` in report, with
`None.` legitimate, alongside gate evidence. At that lane's integration, harvest that one report;
never defer into end-of-run pile.

State INVARIANT/what must be TRUE, not guessed mechanism; let executor find route — different
mechanism, same invariant = brief working, not drift. Prescribe structure (shape, seams,
ownership), not technique: *how* caps executor at briefer's knowledge of layer executor reads.

⚠ REMAINING-WORK LEDGER = TREE CLAIM — BEFORE BRIEFING, RE-DERIVE: file at HEAD + involved paths'
log. One command, seconds: still true? "N of M done, these remain" reflects last writer's selected
commits; commit without tracker write → instantly stale, confidently formatted as verified fact,
no drift notice. AGE weak: same-day work can invalidate. Stale brief → already-done work.
Executor NOT safeguard: told defect exists → plausible second mechanism gates green; worst,
REWRITES existing work, silently loses hardening. ⚠ FAVOURABLE tell: clean tree, suspiciously
small diff, or already-satisfied report; looks easy → re-derive, never merge. ⚠ Say verification
run isn't pure waste: may prove EXISTING lock red, previously unproved; report verification
obtained beside brief defect. ⚠ BEFORE BRIEFING, VERIFY CAPABILITY STILL EXISTS: task checks
(invariants, fences, quoted definition of done) ≠ platform check. Last week's capability looks
permanent; withdrawn remedy still named by rule → brief wrong BEFORE executor reads it. Covers
tools, write paths, output channels, agent types. Correct executor cannot comply, explains;
both parties' competence hides wasted round trip. Confirm now; never infer availability from rule.

## Paste the definition of done verbatim — a paraphrase can invert a criterion

Task interpretation instead of text → inverted closure criterion. Brief = executor's sole
authority: correct obedience, green gates, red-then-green lock, honest report can look complete
while partial; missed criterion never seen.

Compression, not carelessness: main mechanism occupies attention; apparently load-bearing text
survives, peripheral-seeming edge criteria (legitimate empty, zero result, degraded path) become
scope fences — same sentence, sign flipped.

Quote definition of done as unedited block in brief; freely add invariants, traps, fences, never rewrite
criteria. Criterion genuinely inapplicable this round → name NEXT TO quote; visible deviation,
never omission.

Gates/executor report cannot catch unknown criterion; both honest. Only arbiter's diff-read
against task holds both documents → unconditional, independently required even for clean report.

## An example shown to illustrate a style is indistinguishable from one shown to use

Filler illustrating register gets pasted verbatim as real artifact content: brief's sole authority
makes concrete-looking strings material, not metaphor; nothing in phrasing says which.

Show shape WRONG to paste: real example already in artifact, or description without quotable
sentence. Never plausible template. Tell: sentence could survive unchanged in deliverable.

## "Read-only" is an ALLOW-LIST, never a subtraction and never a sentence in a brief

KNOWLEDGE-output delegate (investigate, ground, survey, audit): enforce read-only through WHAT
AGENT CAN CALL. "Do not modify anything" can be silently ignored → OUTWARD damage to others' trees.

**Withholding obvious writing tools ≠ read-only.** No file-write/editor/shell still leaves MCP
file-writing, code-executing, record-deleting, message-sending tools, invocable by delegate.
**Forbidden-tool enumeration cannot cover GROWING surface**: each installed MCP server adds
tools existing rules never name.

⚠ State evidence at real strength; weaker claim suffices: OBSERVED listing, one proven invocation,
disk file WRITTEN by built-in "read-only" type through installed server shell, read back by
spawner. Allow-list closes capability without first requiring demonstrated hazard.

State/enforce INVARIANT as MAY-call list: *holds nothing mutating anything outside own context*.
Allow-list closes even not-yet-installed tools; deny-list only already-considered tools.

⚠ **Allow-list may silently deliver LESS than declared.** Errs SAFE — fewer tools, never more;
fence holds, declared capabilities not assured. **Read running agent's ACTUAL surface;
declaration ≠ manifest.**

⚠ Executing/writing tool cannot be narrowed by wording; needed once → granted every later turn.
Spawn question: not "will it need this once?" but "is there any turn on which this is unsafe?".

⚠ Spawner cannot distinguish findings READ from findings produced by ACTING; only delegate
transcript or independent claim verification separates them.
