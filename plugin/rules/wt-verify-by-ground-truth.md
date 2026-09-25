# Verify by ground truth, not plausibility

Plausibility break under pressure. Ground truth not break. Check signal that decide claim.

## Corroboration requires independent conditions

**Two readings taken in one window are ONE reading.** Independence is property of CONDITION,
never source. Two instruments, two processes, two directories sampling same loaded machine in
same window agree about machine. Before calling second reading corroboration, ask what two runs
SHARED, not how they differed — and whether YOU are shared condition. Concurrent processes you
started count, not only commits you made. Measurement run on system it measures adds condition
while sampling it: absolute rate is upper bound, and going quiet is part of instrument.

**Witness line must be one the BROKEN instrument could MISS.** Seeded row that reads correctly
under both working and broken interpretation test nothing. Choose against suspected failure mode:
row that must be PRESENT when mode is truncation; row that must be ABSENT when mode is
over-matching. Same family as control readable in both outcomes; this applies it to choice of
witness.
Misread code not spoil one result. It retroactively VOID every "gates green" claim built on same
capture path.

**Comparing two arms — record the condition beside each result, and alternate the arms.** One run
of each, taken in sequence, is not two readings of two arms; it is one reading of the machine taken
twice. Alternation is a design constraint applied before the runs, not a question asked after —
asking after depends on someone remembering to ask it.
⚠ Discriminator between a regression and a condition: a regression breaks the SAME thing every run.
A load-sensitive suite drops whatever sits nearest its margin at that instant, so the failing SET
MOVES. Two red runs sharing no failing test in common is not broad instability — it is something
taking the margin.

## Verify claims against their actual evidence

**UI claim = RENDERED PIXELS.** Not API payload. Field can sit in JSON and be dropped before DOM.
Drive real browser.

**Code claim = SOURCE at actual revision.** Not memory. Read past revision with
`git show <rev>:<file>`. Read-only. Never `git checkout <rev> -- <file>` — it overwrite working
copy, uncommitted work gone.

**Excluding work, narrowing scope, skipping step, exempting mechanism because component behave
some way?** Cite file that decide premise, same sentence. Else write `unverified`, then check.
Your OWN note = declaration, not verified fact. Note not exempt claim from grounding.

**CI claim = the JOB that exercise behaviour.** Not RUN aggregate status. Run mix jobs from
different OS. Top-level conclusion can read as INVERSE of deciding job. Descend to job list.

**Suspicious UI state?** Triage DATA SOURCE first. Server payload vs client state vs sibling
component with own fetch. One API read often show "bug" is other component unrelated data.

**State verdict at REACH its evidence has.** Before "X exist nowhere": enumerate producers, check
consumer. If something display X, X exist. Scope is spatial, temporal, semantic.

**Search prove absence only inside set it was given. ID LOOKUP prove presence anywhere.**
Identifier available? Resolve it. Do not search for it.
⚠ When you COMMISSION search, brief choose the set. Probe told to look wrong place is perfectly
diligent and perfectly wrong. No thoroughness inside that set reach outside it.
⚠ Requiring probe to state reach not protect commissioner. It protect NEXT reader — the one who
can notice stated reach and other evidence cannot both be true.
⚠ Keyword search own floor: target described in different words than query is invisible to it.

**ANY surprise — good, bad, novel — is anomaly to EXPLAIN before you label it.** Favorable
surprise is the one that silently skip verification. Include FIRST occurrence of class never
observed before. Even mid-flow, off-task, harmless-looking. Skip-tell: you are BUSY and event is
peripheral.

## Symptom vanishing after a change is correlation

**Symptom vanish right after your change = CORRELATION.** Name other variables that could move in
same window. Say what you found when you looked.
Cheapest decisive check: re-run OLD approach once. Old approach work now too → your change was
never the cause.
Environment count as variable. Green result depend on `PATH`, config dir, pre-existing file,
installed binary? Name that dependency. Ask if YOU created it earlier for other reason.

## A HOSTED PLATFORM's behaviour is read in its documentation, never inferred from your traces

**Claim about what a PLATFORM does — CI trigger fired, webhook did not, rate limit hit, permission
refused? Deciding source is THAT PLATFORM's reference.** Your repository, your logs, your event
metadata say what YOU did. They never say what the platform does with it. So the sentence tying the
two together is INVENTED — and invented confidently, because every fact under it is true and
correctly read.

Read the platform's own documentation FIRST, and QUOTE the reference in the claim. Repository
archaeology is the fallback, never the opening move.

⚠ **Tell is grammatical, needs no suspicion**: a sentence of the form *"it must have fired because
<something I changed>"* about a system whose rules you have not read this turn.

⚠ **Corollary, and it is what makes this expensive**: a correction built the same way inherits the
same defect. It READS as progress, because each version fits more evidence than the last. Two wrong
explanations in a row is the signature — stop building the third from the same material.

## Shipping requires an explicit cross-platform verdict

**Ship anything → explicit CROSS-PLATFORM verdict.** Name system dependencies. Per dependency say:
throw, degrade to named `unknown`, or silently return plausible value.
Third case is the dangerous one. Monitor reporting reassuring number on platform where it cannot
measure is WORSE than no monitor — broken state look healthy.
Linux-only is legitimate conclusion. Letting reader assume portability is not.

**After claiming mechanism, grep for code that must exist for claim to be FALSE.** Report what you
found. Fastest guard against explanation built from quote that say opposite of conclusion drawn
from it.

## High-impact mechanisms require three answers

**High impact or high risk — guard, safety mechanism, money, security, data loss, availability,
published surface — answer all three:**
1. Was the failure it prevent actually exercised? Not happy-path test written from same
   understanding as the code.
2. Did it run under real conditions and volume, or only fixtures? Name which.
3. What can go wrong in the MECHANISM itself? Not the problem it address.
Shipping with a "no" is legitimate. Letting reader assume the questions were asked is not.
Say which of the three you can answer and which you cannot, SAME prominence as result.
Check deferred to later step is NOT done until that step own record name it. Read executing
system trace. Never a summary silence.

**Evidence must OUTLIVE the process that produced it.** Check run at execution time and not
archived is not re-verifiable. Proof die with process. Later reader left with claim alone.
Archive input beside output — the file, or its hash, plus exact command. Later reader can then
separate VERIFIED from ASSERTED-BY-WHOEVER-RAN-IT.
Corroboration make claim likely. Likely-by-corroboration is still NOT verified. Report must say
which one it is.

**Guard with wrong model of system it protect does not degrade. It INVERTS.** It grant confidence
exactly when guarded thing is about to break. That is why question 3 check the mechanism, not the
hazard.

**One mechanical read not enough — evidence across sources, leads to chase, surprise needing root
cause?** Escalate to `deep-grounding` skill. Do not chain ad-hoc reads.

The act-bound half of this rule is served on demand as `wt-verify-by-ground-truth-at-act.md`.
