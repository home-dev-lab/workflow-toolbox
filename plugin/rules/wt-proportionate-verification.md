# Scale verification to the change's risk

<!-- embedded-copy:proportionate-verification-ladder:start -->
Verification is mandatory; how much of it you spin up scales with what changed. Gates
(test/typecheck/lint by exit code) and your own diff-read are unconditional at every rung — the
ladder only decides how many INDEPENDENT review agents the change buys. Match the shape to the
range:

- **Feature / production-logic range** (new behavior, larger diffs, or touches money · security
  · data-loss grade logic) → a full multi-lens adversarial review.
- **Follow-up range** (implementing an approving round's own findings, small diff, no new
  design) → ONE targeted diff-grounded verifier, or your own careful diff-read plus the gates.
  Not a fresh full fan-out.
- **Test-only / comment-only / docs-only range** → your diff-read plus the gates. No agents.
- **Batch, don't dribble:** review the CONSOLIDATED batch range once (base..head), never each
  micro-commit separately.

On any fan-out: pin an explicit cheap model for the bulk and reserve the strong model for
verifiers. If you must cut to a single verifier, cut the COUNT, not the model.

## What actually decorrelates — in this order

Adding agents does not add independence. These levers do, and the ordering is the point:
each one is worth more than everything below it, so spend the cheap top of the list before
buying the expensive bottom.

1. **Mechanical ground truth — the strongest lever, and NOT self-validating.** If the claim is
   decidable by an exit code, a rendered pixel, a re-read of the source at the right revision,
   or a re-run of the failing case, decide it that way rather than by judgment.

   But an instrument answers the question IT asks, which is not always the question you meant,
   and it can be perturbed by its own environment. A measurement returning a plausible value
   with a zero exit code is not therefore correct. Observed failures, all mechanical, all
   confidently wrong: a process scan truncated by its own `head` and reporting the absence of
   what sat past the cut; a checksum over concatenated files that differed only because the
   directory walk ordered them differently, while a file-by-file compare said identical; a
   file-age filter reading modification time to answer a question about reads; a usage probe
   that fails precisely when usage is exhausted, which is the condition it exists to report.

   So: **corroborate a consequential measurement with a SECOND one that would fail
   differently** — a different instrument, a different route to the same fact, a check at the
   other end of the claim. Agreement between two differently-constructed measurements is
   evidence; one instrument agreeing with itself is not.

   The trigger is mechanical, not a judgment call, or this clause becomes paralysis: a second
   measurement is required when the result is CONSEQUENTIAL **and** the instrument was built
   from the same understanding as the thing it measures — you wrote the probe and the expected
   answer in the same motion. That is the case where a wrong instrument and a wrong belief
   agree perfectly. Add a third tell: a measurement that lands exactly where you hoped deserves
   the second instrument more, not less.
2. **Method diversity — the strongest lever on what remains.** Have the checks reach the same
   question by genuinely different ROUTES: static reading, dynamic execution, a property or
   proof, fuzzing/adversarial input, differential comparison against a known-good. Two agents
   reading the same code twice is one method run twice, however different their prompts.
3. **Hypothesis independence.** Require each verifier to construct its OWN explanation of the
   failure before seeing anyone else's, and to state what it could not verify. A verifier
   handed a conclusion to check is anchored on it.
4. **Information diversity.** Different sources, different tools, different slices of the
   evidence. A shared source list caps coverage at what it happened to include.
5. **Functional diversity.** Distinct lenses with distinct objectives (correctness, security,
   performance, does-it-reproduce) rather than N identical reviewers.
6. **Model-family diversity — one axis among these, not the master lever.** It remains real
   and worth using, for a documented reason: LLM judges systematically score their own
   outputs higher AND rate same-family outputs higher — measured over >5000 prompt-completion
   pairs against expert human annotation across nine judges (arXiv:2508.06709). So a
   same-family verifier is not merely blind in the same places; it is biased in favour of the
   work. But a different family does NOT buy independence on every axis: two different
   families can share a role-level blind spot — severity ranking is the observed one, where
   one lane flattens it and another is unstable across runs on the same input.
7. **Temporal re-verification.** Re-check after the fix, against the case that failed, not
   against the author's account of it.
8. **Human arbitration** on anything high-risk. The arbiter is not a tiebreaker of last
   resort; they own the call.

## Never buy independence and then spend it on a debate

Verdicts are collected in PARALLEL and in ISOLATION. The moment one verifier sees another's
answer, the independence you paid for is gone — and it does not degrade gracefully.
Inter-agent sycophancy collapses debates into premature consensus before the correct
conclusion is reached, and measured multi-agent debate under it scores LOWER than a single
agent on the same task, through distinct debater-driven and judge-driven failure modes
(arXiv:2509.23055).

So: no sequential rounds where agents read each other, no "reviewer 2 comments on reviewer 1",
no consensus-seeking step. Aggregate mechanically (majority, or any-critical-wins) and let the
arbiter resolve the disagreement — disagreement is the signal you were buying, not a defect to
smooth away before reporting.

A cross-family verifier has no project context, so weight its findings by type: high signal on
checkable / reproducible-crash issues, low on "this convention is wrong". It is input, never an
autonomous verdict: you stay the arbiter, and a verdict that contradicts your richer in-context
read does not auto-win.

## Breadth is a second, independent axis

The ladder above scales verification to what the CHANGE introduces — that is DEPTH. It is
structurally blind to a different failure class: a defect already sitting elsewhere on the same
exposed surface (a rendered interface, an API shape, a CLI's output, a generated artifact — any
outward-facing result), because no assertion derived from a diff covers what nobody had a
hypothesis about. A scoped check finds only what it was pointed at, however deep it goes.

- Before presenting an exposed surface as ready, sweep the WHOLE surface once, the way its real
  consumer would encounter it — not only the assertions the diff suggested.
- Depth and breadth are independent: assess both, and neither substitutes for the other. A
  narrow, low-risk change can still land on a surface that deserves a full breadth sweep; a
  surface nobody else touches may need only the change's own depth once assessed.
- Handle a breadth finding like any other finding: fix it in scope, record what is not — never
  fold an out-of-scope find into a silent extra fix. A code fix earns a test that fails before
  the fix and passes after, like any other review finding.

This never licenses skipping verification: the gates (test / typecheck / lint by exit code) and
your own diff-read are unconditional on both axes. When unsure between two rungs, pick the higher
one for irreversible or outward-facing changes, the lower one otherwise.
<!-- embedded-copy:proportionate-verification-ladder:end -->

<!-- Embedded elsewhere in this plugin (delegated agents run with no ambient rules — only
     their own definition reaches them): plugin/agents/pilot.md and
     plugin/agents/pilot-orchestrator.md each carry a byte-identical copy of the block above,
     between the same `embedded-copy:proportionate-verification-ladder` markers. This file is
     the canonical source — if you edit the ladder, copy the exact text into those embedded
     copies too; never edit an embedded copy independently of this source. -->
