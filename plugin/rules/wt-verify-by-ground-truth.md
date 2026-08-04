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
- When you are about to EXCLUDE work, NARROW scope, skip a step, or exempt a mechanism *because a
  component behaves a certain way*, cite the file that decides that premise in the same sentence,
  or write `unverified` and check before acting. This applies especially to your OWN prior notes:
  a note you wrote is a declaration, not a verified fact, and it does not exempt the claim from
  grounding.
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
- **A search proves absence only within the set it was given; an ID LOOKUP proves presence
  anywhere.** Whenever an identifier is available — from a code comment, a commit body, a report,
  an error message — resolve it directly instead of searching for it. A lookup ignores whatever
  partition a search is confined to, so it settles in one call what a search can only bound.
  ⚠ Two consequences that are easy to state backwards. First, when you COMMISSION a search, the
  brief chooses the set: a probe told to look in the wrong place is perfectly diligent and
  perfectly wrong, and no thoroughness inside that set can reach outside it — so ask what would
  have to be true for the answer to lie outside the set you just named. Second, requiring a probe
  to state its reach does not protect the person who commissioned it; it protects the next reader,
  who is the one able to notice that the stated reach and some other evidence cannot both be true.
  And a keyword search adds its own floor: a target described in different words than the query is
  invisible to it, whatever set it covers.
- A guard/probe's literal pass-signal is not the invariant it exists to prove: check the property
  in PER-UNIT terms, not the aggregate the mechanism emitted.
- **A probe result RELAYED to anyone carries the set it scanned and its self-exclusion, or it is
  not relayed.** The dangerous moment is not the measurement, it is the hand-off: a number stripped
  of its provenance stops being a reading and becomes a fact, and the next reader has no way to
  recover what it actually covered. So an outbound claim derived from a measurement states what was
  claimed, the exact set scanned, the instrument, and how the instrument excluded itself — a probe
  that counts its own process is the ordinary case, not an exotic one. Repeating the same hollow
  measurement is not corroboration: two readings from one instrument agree by construction.
  And when a relayed claim later turns out to rest on a hollow probe, the correction goes back to
  **the same recipients**, never absorbed into a report nobody re-reads — an uncorrected claim keeps
  working long after the probe that produced it has been discredited.
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

Anything you ship carries an explicit CROSS-PLATFORM verdict. Name the system dependencies the
behavior rests on and say, per dependency, whether a platform mismatch throws, degrades to a named
`unknown`, or silently returns a plausible value. The third case is the dangerous one: a monitor
that reports a reassuring number on a platform where it cannot actually measure is worse than no
monitor, because the broken state looks healthy. Linux-only is a legitimate conclusion; leaving the
reader to assume portability is not.

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

## Before measuring a fix, prove the subject is RUNNING that fix

A fix is worth nothing until it has been observed working, and an observation is worth nothing
if the observed process is running a different copy of the code. A separate process — another
session, a daemon, a delegated agent, a packaged artifact — resolves its own copy: an installed
cache, a published version, a bundled build. Editing a working tree changes none of them.

Two questions, in this order, and they compose:

1. **WHICH FILE does the process load?** Read it off the running process itself — its command
   line, its resolved module path, its open file handles. A path observed on the process is
   strong evidence, and a version number INSIDE that path is part of it.
2. **WHICH VERSION of that file's content?** Grep it for a sentence that exists only in the fix.

⚠ What lies is a DECLARED version — a manifest entry, a `--version` flag, a package field. It
can be perfectly accurate while the file actually loaded comes from somewhere else entirely.
That is a different thing from a path read off the process, and conflating the two makes a
reader discard valid evidence. A local commit proves the edit, never the load.

If the fix's sentence is absent from the loaded file, the measurement answers a question about
the old code and must be discarded in BOTH directions — a clean result there is not evidence of
success, it is evidence of nothing. The tell that this was skipped: a result matching the
hoped-for outcome, obtained from a process nobody checked the provenance of.

## A control must be readable in BOTH outcomes, not only in failure

Design the check so it produces a reading whether the fix worked or not. The trap is specific
and easy to walk into when the fix's whole purpose is to make something STOP happening: the
natural control reads an artifact that the fix removes. It then executes only when the fix
failed, and success becomes indistinguishable from "the check could not run".

Before trusting a control, ask what it reads in the SUCCESS case. If the answer is "nothing —
the thing it reads no longer exists", it is not a control; find a source that exists either
way, ideally one the fix does not touch at all. Same family as a probe that fails precisely
under the condition it exists to report.

## A summary that asserts a guarantee is verified against its body, in the same pass

Whenever a docstring, header, or comment claims a PROPERTY — "this path is literal", "this
cursor derives from acknowledgements", "this returns everything after X" — read the body under
it before moving on. Not later, not as a review step: in the same pass, because the claim and
the code diverge at the moment the code changes and the claim does not.

The failure is not carelessness, and treating it as such is why it repeats: when you rewrite a
body and then adjust its summary, you describe **what you intended**, not what you wrote. And
that summary is precisely what the next reader trusts when checking quickly — so it misleads
exactly when it matters. This is a GESTURE, not an intuition: it needs no suspicion and no
knowledge of the code's history. The tell that it is needed is that the sentence is reassuring.
