# Fix it now AND fix it durably — at the right level, mechanically, in the same pass

Problem surfaces → two things owed, not one:

1. **Make it work now.** Immediate unblock, work in flight proceeds.
2. **Make it not come back** — durable fix, at the level the problem actually lives, enforced by
   something that EXECUTES, not something to be remembered.

First only → same defect for next person. Second only → work stays blocked. Both, same pass.

## Choosing the level

Where's the problem, and where must the fix ORIGINATE — different questions, second decides:

- **The environment** (shell profile, config dir, launcher, hook registration) — defect is in
  how setup's arranged. Reaches everything here, nothing beyond.
- **The distributed artifact** (package, plugin, published rule) — defect occurs for anyone
  using the component. Local patch = divergence in disguise: private/shipped copies drift, next
  adopter meets original defect.
- **An observer** (guard, watcher, gate, test-lock) — defect is nobody would have NOTICED. Some
  problems need surfacing, not preventing — durable fix is the detector, not the patch.

Wrong-level fix looks complete, isn't: silences one instance of a class.

## Mechanical beats disciplined, every time available

Prefer, in order:

1. **Something that executes** — hook, launcher line, gate, failing test, refusing guard. Fires
   whether or not anyone remembered.
2. **Something auto-loaded** — instruction read at every session start.
3. **Something recalled on demand** — a note. Only for facts, never a must-apply-every-time
   behaviour: a note doesn't trigger.

Silently-skippable instruction ≠ fix; hope with a filename. Rule-down vs impossible-to-skip →
pick second. Only first available → say so, don't present as closed.

## Mechanise at the moment you meet it — not later, not as a filed task

Mechanism could prevent problem permanently → build it **same pass** — before moving on,
reporting, next task. One test: *could a hook/gate/test/check make this impossible to repeat?*
Yes → part of the deliverable, task unfinished without it.

Filing for later is the failure this closes — structural, not diligence: note is recall-on-
demand, read only by someone already suspecting the problem. Person about to repeat the mistake
is precisely the one not looking it up.

## Two failure shapes this exists to stop

- **The one-door guard.** Refusing ONE bad path ≠ closing the class. After fixing a path,
  enumerate OTHER inputs producing the same effect — a legitimate one is often among them, why
  it goes unnoticed.
- **The hand-placed mechanism.** Armed by hand, once → vanishes silently at a restart,
  compaction, next session. Absence indistinguishable from "nothing to report". Must-exist-
  every-time → belongs in whatever STARTS the thing, not what's asked of it.

## What this does NOT license

- **Mechanising what needs judgment.** Judgment-call trigger → guard wrong often enough to
  invert: fires on correct work, gets switched off, takes its real case along. Say plainly it
  can't be mechanised, why.
- **Shipping an unmeasured guard.** New guard's precision measured on unchosen material BEFORE
  allowed to block. Until then: warns only. A guard refusing correct work is worse than none.
- **Skipping the honest report.** Part mechanisable → mechanise that part, NAME the rest
  unmechanised — don't let guard's existence imply full coverage.

## The shape of the answer, when asked what was done about a recurring mistake

Not "it's recorded" — which mechanism now executes, what exactly it refuses, what it
deliberately doesn't cover. Answer = a note → say it's only a note.

## Ship or keep private — decide it in the same pass

Fix belongs to something also distributed → unfinished until decided: durable, environment-free,
project-agnostic core → distributed copy, normal dev loop; local calibrations/paths/account
specifics → stay private. Unstated decision = how copies silently diverge.

Composes with `wt-verify-by-ground-truth.md` — proving subject RUNS the fix, control readable
whether fix worked or not = verification duties, live there.
