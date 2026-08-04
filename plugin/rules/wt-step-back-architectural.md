# Step back to the architectural root — and ground "it doesn't exist" before a workaround

Fix the shared root, don't point-patch a shared cause. When review findings (or your own fixes)
keep landing on the same file / area / data shape, that clustering is the signal of a shared
architectural root — stop and question the shape itself. Trigger the step-back on observable
signs: two-plus rounds on the same area; about to add a second patch to a thing you just patched;
a fix that introduces the next finding. The right moment is the FIRST sign, not five commits
later.

Survey before adding the Nth copy (Rule of Three). Before writing a chunk whose shape already
exists elsewhere, grep/read to count the real occurrences across the whole codebase, variants
included. First time write it; second time duplicate; on the third the default flips to
generalize. But "generalize" holds only when the instances share a REASON TO CHANGE — same shape
is not same concept. If they look alike but evolve for different reasons, keep the duplication (the
wrong abstraction couples unrelated things and is costly to back out) and say in one line why they
are coincidental. Abstract only for present concrete consumers, never a speculative future one.

Ground the premise before a workaround. Before building around "the data/capability doesn't exist"
or "that's not possible", read the real source (or fan read-only agents for coverage) to confirm
it — a confident architectural prior is cheap to check and often wrong. The incremental fix can
still ship; just log the root so the next pass is coherent.

## A fix whose defect has a TWIN elsewhere is carried in the same pass

Fixing one copy of a duplicated defect is point-patching a shared cause, and it has a
particularly costly shape when the twin lives on the other side of a distribution boundary: a
local, private copy and a published one. Fix only the private side and the outcome inverts —
the fix stays with you and the defect ships to everyone who adopted it, with nothing anywhere
saying so.

So whenever you edit a file that could have a published counterpart — a rule, a script, a hook,
a helper, anything you also distribute — answer this in the SAME pass, not in a later one:

> **Does this file have a shipped twin, and must this fix be carried there now?**
>
> And, on the same look: **what does that copy already have that this one does not?**

**The drift is not one-directional, and the second direction is the one nobody watches.** A
review, an issue, or a contribution lands on the DISTRIBUTED copy first and cannot reach a
private copy it cannot see — so a shipped twin routinely carries a hardening its private
counterpart lacks. The reason this stays invisible is not laziness: "private is where you
experiment, shipped is where it lands" is a plausible model of how work flows, and it makes
"private is ahead" feel like a law rather than a habit. So when you open a twin to place a fix,
read what it already has. Carrying the fix out and carrying its improvements back are the same
pass, not two.

Three things make this fail in practice, and each is worth naming:

- **Detection is usually not what fails.** The twin is often already known, sometimes already
  filed. What gets skipped is the immediate half — carrying the fix — usually justified by a
  conflict or a collision that nobody checked and that takes seconds to check.
- **The pairing cannot be mechanised.** Twins routinely do not share a filename, so no
  name-matching guard finds them. A guard can RAISE the question at edit time; it cannot answer
  it. Build the reminder if you like, but do not credit it with the coverage.
- **A reminder that fires on every edit gets switched off**, and takes its real case with it. Let
  it warn until its false-positive rate has been measured on material it did not select.

The judgment that remains is which half of the change is durable and environment-free — that
part belongs in the published copy — and which half is a local calibration, a private path, or
an account specific, which stays private. An unstated decision is precisely how the two copies
drift apart while both look maintained.
