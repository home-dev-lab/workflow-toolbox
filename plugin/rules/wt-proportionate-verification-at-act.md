# Scale verification to the change's risk — at act

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
