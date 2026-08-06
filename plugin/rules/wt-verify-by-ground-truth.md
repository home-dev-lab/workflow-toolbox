# Verify by ground truth, not plausibility

Plausibility break under pressure. Ground truth not break. Check signal that decide claim.

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
Misread code not spoil one result. It retroactively VOID every "gates green" claim built on same
capture path.

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

**Guard pass-signal ≠ the invariant it prove.** Check property PER UNIT. Not aggregate mechanism
emitted.

**Probe result RELAYED carry set it scanned and its self-exclusion. Else not relayed.**
Danger moment is hand-off, not measurement. Number stripped of provenance stop being reading,
become fact. Next reader cannot recover what it covered.
Probe that count its own process = ordinary case, not exotic.
Same hollow measurement twice = not corroboration. Two readings, one instrument, agree by
construction.
Relayed claim later shown hollow → correction go back to SAME recipients. Not absorbed into
report nobody re-read.

**Delegate green report = input. Not proof of work. Not proof of WHERE it ran.** Re-run gates
yourself. Verify provenance from execution traces.

**ANY surprise — good, bad, novel — is anomaly to EXPLAIN before you label it.** Favorable
surprise is the one that silently skip verification. Include FIRST occurrence of class never
observed before. Even mid-flow, off-task, harmless-looking. Skip-tell: you are BUSY and event is
peripheral.

**Symptom vanish right after your change = CORRELATION.** Name other variables that could move in
same window. Say what you found when you looked.
Cheapest decisive check: re-run OLD approach once. Old approach work now too → your change was
never the cause.
Environment count as variable. Green result depend on `PATH`, config dir, pre-existing file,
installed binary? Name that dependency. Ask if YOU created it earlier for other reason.

**Ship anything → explicit CROSS-PLATFORM verdict.** Name system dependencies. Per dependency say:
throw, degrade to named `unknown`, or silently return plausible value.
Third case is the dangerous one. Monitor reporting reassuring number on platform where it cannot
measure is WORSE than no monitor — broken state look healthy.
Linux-only is legitimate conclusion. Letting reader assume portability is not.

**After claiming mechanism, grep for code that must exist for claim to be FALSE.** Report what you
found. Fastest guard against explanation built from quote that say opposite of conclusion drawn
from it.

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

## Control must be readable in BOTH outcomes, not only in failure

Trap appear when fix purpose is to make something STOP happening. Natural control read artifact
the fix REMOVE. It then execute only when fix FAILED. Success become indistinguishable from
"check could not run".

Before trusting control, ask what it read in SUCCESS case. Answer "nothing — thing it read no
longer exist"? Not a control. Find source that exist either way.

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
