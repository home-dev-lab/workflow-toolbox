# Scale verification to the change's risk

<!-- embedded-copy:proportionate-verification-ladder:start -->
Verification mandatory. How MUCH you spin up scales with what changed.

Gates (test/typecheck/lint by exit code) and your own diff-read are unconditional at every rung.
The ladder only decide how many INDEPENDENT review agents the change buy.

- **Feature / production-logic range** — new behaviour, larger diff, or touch money · security ·
  data-loss logic → full multi-lens adversarial review.
- **Follow-up range** — implementing an approving round's own findings, small diff, no new design
  → ONE targeted diff-grounded verifier, OR your own careful diff-read plus gates. Not a fresh
  full fan-out.
- **Test-only / comment-only / docs-only** → your diff-read plus gates. No agents.
- **Batch, do not dribble** — review the CONSOLIDATED range once (base..head). Never each
  micro-commit.

On any fan-out: pin cheap model for bulk, strong model for verifiers. Must cut to one verifier?
Cut the COUNT, never the MODEL.

## What actually decorrelates — IN THIS ORDER

Adding agents does NOT add independence. These levers do. **The ORDER is the point**: each one
worth more than everything below it. Spend the cheap top before buying the expensive bottom.

**1. Mechanical ground truth — strongest lever. NOT self-validating.**
Claim decidable by exit code, rendered pixel, source re-read at right revision, re-run of failing
case? Decide it that way. Not by judgment.
BUT instrument answer the question IT ask, not always the question you meant. Plausible value plus
zero exit code ≠ correct. Observed, all mechanical, all confidently wrong: process scan truncated
by its own `head`, reporting absence of what sat past the cut · checksum over concatenated files
differing only by directory-walk order, while file-by-file compare said identical · file-age
filter reading modification time to answer a question about READS · usage probe that fail exactly
when usage is exhausted, the condition it exist to report.
So: **corroborate a consequential measurement with a SECOND one that fail DIFFERENTLY** — other
instrument, other route to same fact, check at other end of the claim. Two differently-built
measurements agreeing = evidence. One instrument agreeing with itself = not.
Trigger is mechanical, else this clause become paralysis: second measurement required when result
is CONSEQUENTIAL **and** instrument was built from same understanding as thing it measure — you
wrote probe and expected answer in one motion. That is where wrong instrument and wrong belief
agree perfectly. Third tell: measurement landing exactly where you hoped deserve the second
instrument MORE, not less.

**2. Method diversity — strongest lever on what remain.**
Reach the same question by genuinely different ROUTES: static reading, dynamic execution,
property/proof, fuzzing, differential compare against known-good. Two agents reading same code
twice = ONE method run twice, however different their prompts.
**MUTATION is sharpest: only way to know a check CAN fail is to make it fail.** Test written from
same understanding as code agree with the code's mistakes — go green on the very bug it was meant
to catch. Its green is then evidence of nothing.
So, on a copy OUTSIDE the repository: put the defect back (revert fix, flip condition, delete
guard), count which assertions go red. **None red = suite never covered that defect**, whatever
it say today.
REQUIREMENT, and it is cheap: **every fix is proven RED in isolation before it is accepted as green.** One
revert, one run. Converts "tests pass" into "test CAN fail for this reason". Fix whose lock cannot
be shown red is not locked. It is decorated.
Mutating a whole module to hunt surviving mutants = genuinely different, much larger commitment
(tooling, runtime, its own false-positive triage). Legitimate to choose. NOT required here. Taking
the cheap per-fix form is not a down-payment on the expensive one.
This is the operational answer to "was the failure it prevent actually exercised" — a question a
green suite cannot settle about itself.

**3. Hypothesis independence.** Each verifier construct its OWN explanation BEFORE seeing anyone
else's, and state what it could NOT verify. Verifier handed a conclusion to check is anchored on
it.

**4. Information diversity.** Different sources, tools, slices. Shared source list cap coverage at
what it happened to include.

**5. Functional diversity.** Distinct lenses, distinct objectives (correctness, security,
performance, does-it-reproduce). Not N identical reviewers.

**6. Model-family diversity — ONE axis among these. NOT the master lever.**
Real and worth using, documented reason: LLM judges score their OWN outputs higher AND rate
same-family outputs higher — >5000 prompt-completion pairs against expert human annotation, nine
judges (arXiv:2508.06709). Same-family verifier is not merely blind in same places. It is BIASED
IN FAVOUR of the work.
But different family does NOT buy independence on every axis. Two different families can share a
ROLE-LEVEL blind spot — severity ranking is the observed one: one lane flatten it, another is
unstable across runs on the same input.

**7. Temporal re-verification.** Re-check after the fix, against the case that FAILED. Not against
the author's account of it.

**8. Human arbitration** on anything high-risk. Arbiter is not a tiebreaker of last resort. They
OWN the call.

## Say WHICH axes you varied — a ranking nobody cite is decoration

Ladder usable only by a reader told where the work landed on it. Verification report NAME the axes
actually varied, and the ones NOT. One line enough: "mechanical ground truth + method diversity;
same model family; no independent hypothesis."

Failure runs in BOTH directions — that is why naming the STRONG axis matter as much as admitting
the weak one:
- Report only the WEAK axis, stay silent on a STRONG one you also used → sound finding discounted
  for a reason that was never true.
- Report only the STRONG-SOUNDING axis — "a different model family reviewed it" → reader credit
  independence you did not buy.
Both are the same mistake: reader left guessing the axis from the shape of the report.
Cross-family review that found real defects usually found them by METHOD (enumerating failure
modes, running the thing, reading the source), NOT by being a different family. Say that, or the
ranking teach the wrong lesson to whoever read the outcome.
State it at same prominence as the result. An unstated axis reads as an axis covered.

## Never buy independence then spend it on a debate

Verdicts are collected in PARALLEL and in ISOLATION. Moment one verifier see another's answer, the
independence you paid for is GONE. It does not degrade gracefully.
Inter-agent sycophancy collapse debate into premature consensus before the correct conclusion is
reached. Measured multi-agent debate under it score LOWER than a single agent on the same task,
through distinct debater-driven and judge-driven failure modes (arXiv:2509.23055).
So: no sequential rounds where agents read each other. No "reviewer 2 comments on reviewer 1". No
consensus-seeking step. Aggregate MECHANICALLY (majority, or any-critical-wins). Arbiter resolve
the disagreement — **disagreement is the signal you were buying**, not a defect to smooth away
before reporting.

Cross-family verifier has no project context. Weight its findings BY TYPE: high signal on
checkable / reproducible-crash issues, low on "this convention is wrong". It is INPUT, never an
autonomous verdict. You stay arbiter. A verdict contradicting your richer in-context read does not
auto-win.

## Breadth is a SECOND, independent axis

The ladder scale verification to what the CHANGE introduce — that is DEPTH. It is structurally
BLIND to a different failure class: a defect already sitting elsewhere on the same exposed surface
(rendered interface, API shape, CLI output, generated artifact — any outward-facing result). No
assertion derived from a diff cover what nobody had a hypothesis about. A scoped check find only
what it was pointed at, however deep it go.

- Before presenting an exposed surface as ready, sweep the WHOLE surface once, the way its real
  consumer would meet it. Not only the assertions the diff suggested.
- Depth and breadth are independent: assess both, and neither substitutes for the other. A narrow
  low-risk change can still land on a surface deserving a full breadth sweep. A surface nobody
  else touch may need only the change's own depth.
- Breadth finding handled like any finding: fix in scope, record what is not. Never fold an
  out-of-scope find into a silent extra fix. Its lock proven red the same way as any other fix.
  No separate standard here.

Never licenses skipping verification: gates (test / typecheck / lint by exit code) and your own
diff-read are UNCONDITIONAL on both axes. Unsure between two rungs? Higher rung for irreversible
or outward-facing changes. Lower rung otherwise.
<!-- embedded-copy:proportionate-verification-ladder:end -->

<!-- Embedded elsewhere in this plugin (delegated agents run with no ambient rules — only
     their own definition reaches them): the pilot and pilot-orchestrator definitions each carry
     a byte-identical copy of the block above, between the same
     `embedded-copy:proportionate-verification-ladder` markers. This file is the canonical
     source — if you edit the ladder, copy the exact text into every embedded copy; never edit
     an embedded copy independently of this source.

     ⚠ Find the copies by SEARCHING FOR THE MARKER, not by the paths that used to hold them:
       grep -rl "embedded-copy:proportionate-verification-ladder" <plugin dir>
     This note previously named two paths that a later reorganisation emptied, so it sent a
     reader to files that no longer existed while reading perfectly plausible. A tree move is
     exactly the kind of change nobody re-reads as a change to a safety mechanism. -->
