# Scale verification to the change's risk — at act

<!-- embedded-copy:proportionate-verification-decorrelation:start -->
Rank levers 3 to 6 below mechanical ground truth and method diversity, above temporal re-verification and human arbitration.

### 3. Hypothesis independence.
Each verifier construct its OWN explanation BEFORE seeing anyone
else's, and state what it could NOT verify. Verifier handed a conclusion to check is anchored on
it.

### 4. Information diversity.
Different sources, tools, slices. Shared source list cap coverage at
what it happened to include.

### 5. Functional diversity.
Distinct lenses, distinct objectives (correctness, security,
performance, does-it-reproduce). Not N identical reviewers.

### 6. Model-family diversity — ONE axis among these. NOT the master lever.
Real and worth using, documented reason: LLM judges score their OWN outputs higher AND rate
same-family outputs higher — >5000 prompt-completion pairs against expert human annotation, nine
judges (arXiv:2508.06709). Same-family verifier is not merely blind in same places. It is BIASED
IN FAVOUR of the work.
But different family does NOT buy independence on every axis. Two different families can share a
ROLE-LEVEL blind spot — severity ranking is the observed one: one lane flatten it, another is
unstable across runs on the same input.

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
<!-- embedded-copy:proportionate-verification-decorrelation:end -->
