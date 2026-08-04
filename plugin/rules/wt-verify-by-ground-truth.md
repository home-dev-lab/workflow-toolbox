# Verify by ground truth, not plausibility

Plausibility judgment degrades under pressure and across model tiers; ground truth does not.
Replace "this looks right" with a mechanical check on the signal that actually decides the claim:

- Gates by EXIT CODE, not visible output. Redirect the command to a file, echo `$?`, then read
  the file — never pipe a gate (a pipe's own exit 0 masks the failure, and `PIPESTATUS` is
  shell-specific and easy to misread).
  ⚠ **The code you read must belong to the GATE, never to something that ran AFTER it.**
  Redirect-then-`$?` is necessary but not sufficient: any command placed between the gate and
  the read replaces the value, and a wrapping script's final `echo` succeeds even when the
  gate it wraps failed — the last command in a chain is almost always the one whose code
  survives to be read, and it is rarely the one that matters. A real case: a batch reported
  `exit 0` for a gate run where `typecheck` had actually failed with `exit 2`, because the
  number read back was a wrapper's trailing `echo`, not the gate's. **Corroborate with a
  second signal that would fail differently** — the tool's own summary line, a failure count,
  a grep for its error marker in the captured log — read BESIDE the code, not instead of it.
  A misread code does not spoil one result: it retroactively voids every "gates green" claim
  built on the same capture path. Where available, prefer a runner that makes this
  structurally impossible rather than merely disciplined (no shell, no chaining, the code
  written to its own file the instant the gate returns) over a hand-typed redirect-and-echo.
- UI claims by RENDERED PIXELS, not API payloads — a field can be in the JSON and dropped before
  the DOM. Drive the real browser.
- Claims about code by READING THE SOURCE at the actual revision, not from memory. To read a
  file at a past revision use `git show <rev>:<file>` (read-only) — never
  `git checkout <rev> -- <file>`, which silently overwrites the working copy.
- CI conclusions by the JOB that decides the behavior you are claiming, not by the RUN's aggregate
  status. A run can mix jobs from different operating systems or environments, and the top-level
  conclusion can therefore read as the inverse of the job that actually proves or refutes your
  claim. Descend to the job list and read the deciding job directly.
- Suspicious UI state: triage the DATA SOURCE before claiming a bug — server payload vs client
  state vs a sibling component with its own fetch. One API read often reveals the "bug" is
  another component's unrelated data.
- State every verdict at the REACH its evidence has. Before "X doesn't exist anywhere", enumerate
  the possible producers and check the consumer — if something displays X, X exists. Before
  "X is blocked by Y", verify Y's reach. Scope is spatial, temporal, and semantic.
- A guard/probe's literal pass-signal is not the invariant it exists to prove: check the property
  in PER-UNIT terms, not the aggregate the mechanism emitted.
- A delegate's green report, and a plausible result from a routed/bridged executor, are input —
  not proof of the work nor of WHERE it ran. Re-run the gates yourself; verify provenance from
  execution traces.
- ANY surprise — good, bad, or novel — is an anomaly to EXPLAIN before you label it; the
  favorable surprise is the one that silently skips verification. This includes the FIRST
  occurrence of a class you have never observed before (a message from an unexpected source, an
  unknown channel, a file or behavior with no known producer) — even mid-flow, off-task,
  harmless-looking. The skip-tell: you are BUSY with something else and the event is peripheral.

When a symptom disappears right after you changed something, report that sequence as correlation
until you have checked what else could have moved in the same window. Name the other candidate
variables and what you found when you looked. Cheap decisive checks include listing candidate state
by modification time, diffing the things you believe differ, and re-running the OLD approach once:
if the previous method now works too, your change was not the cause.

Environment facts count as candidate variables. If a green result depends on ambient state such as
`PATH`, a config directory, a pre-existing file, or an installed binary, name that dependency and
ask whether you created it earlier for some other reason. When several jobs of one CI run disagree,
compare those environments side by side before reading any one of them deeply.

After claiming a mechanism, grep for the code that would have to exist for that claim to be false,
then report what you found. This is the fastest guard against an explanation built from a quote that
actually says the opposite of the conclusion drawn from it.

For a high-impact or high-risk change (a guard, a safety mechanism, anything touching money,
security, data loss, availability, or a published surface), state your verdict on all three:
was the failure it prevents actually exercised (not just a happy-path test written from the
same understanding as the code); did it run under real conditions/volume or only fixtures; and
what can go wrong in the mechanism itself, not just the problem it addresses. Shipping with a
"no" is legitimate — leaving the reader to assume it was asked is not, so say explicitly which
of the three you can answer and which you cannot, at the same prominence as the result. A check
deferred to a later step ("the integrating review will cover it") is not done until that later
step's own record names it — read the executing system's own trace before crediting it, never a
summary's silence.

Evidence must OUTLIVE the process that produced it: a check run at execution time and not
archived is not re-verifiable — the proof dies with the process, and every later reader is left
with the claim alone. Archive the input beside the output — the file itself, or its hash, plus
the exact command — so a later reader can tell VERIFIED apart from ASSERTED BY WHOEVER RAN IT.
Corroboration can make a claim likely; likely-by-corroboration is still not verified, and a
report must say which one it is.

A guard whose model of the system it protects is wrong does not degrade gracefully — it
INVERTS, granting confidence exactly when the thing it guards is about to break. That is why
question three checks the mechanism's own failure modes, not only the hazard it addresses.

When a check outgrows a single mechanical read — evidence across several sources, leads to chase,
a surprise needing a root cause — escalate to the `deep-grounding` skill (the recursive
collect-verify pass that tags conclusions by evidence tier) rather than chaining ad-hoc reads.
