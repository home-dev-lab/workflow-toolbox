# Verify by ground truth, not plausibility

Plausibility judgment degrades under pressure and across model tiers; ground truth does not.
Replace "this looks right" with a mechanical check on the signal that actually decides the claim:

- Gates by EXIT CODE, not visible output. Redirect the command to a file, echo `$?`, then read
  the file — never pipe a gate (a pipe's own exit 0 masks the failure, and `PIPESTATUS` is
  shell-specific and easy to misread). 
- UI claims by RENDERED PIXELS, not API payloads — a field can be in the JSON and dropped before
  the DOM. Drive the real browser.
- Claims about code by READING THE SOURCE at the actual revision, not from memory.
- State every verdict at the REACH its evidence has. Before "X doesn't exist anywhere", enumerate
  the possible producers and check the consumer — if something displays X, X exists. Before
  "X is blocked by Y", verify Y's reach. Scope is spatial, temporal, and semantic.
- A guard/probe's literal pass-signal is not the invariant it exists to prove: check the property
  in PER-UNIT terms, not the aggregate the mechanism emitted.
- A delegate's green report, and a plausible result from a routed/bridged executor, are input —
  not proof of the work nor of WHERE it ran. Re-run the gates yourself; verify provenance from
  execution traces.
- ANY surprise — good, bad, or novel — is an anomaly to EXPLAIN before you label it; the
  favorable surprise is the one that silently skips verification.

When a check outgrows a single mechanical read — evidence across several sources, leads to chase,
a surprise needing a root cause — escalate to the `deep-grounding` skill (the recursive
collect-verify pass that tags conclusions by evidence tier) rather than chaining ad-hoc reads.
