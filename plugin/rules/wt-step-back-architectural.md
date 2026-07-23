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
