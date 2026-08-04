# Fix it now AND fix it durably — at the right level, mechanically, in the same pass

When a problem surfaces, two things are owed, not one:

1. **Make it work now.** The immediate unblock, so the work in flight proceeds.
2. **Make it not come back** — a durable fix, placed at the level the problem actually lives
   at, enforced by something that EXECUTES rather than something that must be remembered.

Delivering only the first leaves the same defect for whoever hits it next. Delivering only the
second leaves the current work blocked. Both, in the same pass.

## Choosing the level

Ask where the problem IS, and where the fix must ORIGINATE. These are different questions and
the second one decides:

- **The environment** (a shell profile, a config directory, a launcher, a hook registration)
  when the defect is in how this setup is arranged. It reaches everything here, and nothing
  beyond.
- **The distributed artifact** (a package, a plugin, a published rule) when the defect would
  occur for anyone using the same component. A local patch there is a divergence in disguise:
  the private copy and the shipped copy drift, and the next adopter meets the original defect.
- **An observer** (a guard, a watcher, a gate, a test-lock) when the defect is that nobody
  would have NOTICED. Some problems do not need preventing so much as surfacing — for those,
  the durable fix is the detector, not the patch.

A fix at the wrong level looks complete and is not: it silences one instance of a class.

## Mechanical beats disciplined, every time it is available

Prefer, in this order:

1. **Something that executes** — a hook, a launcher line, a gate, a test that fails, a guard
   that refuses. It fires whether or not anyone remembered.
2. **Something auto-loaded** — an instruction read at the start of every session.
3. **Something recalled on demand** — a note. Use this only for facts, never for a behaviour
   that must apply every time: a note does not trigger.

An instruction that can be silently skipped is not a fix; it is a hope with a filename. When
the choice is between writing the rule down and making the rule impossible to skip, do the
second — and if only the first is available, say so plainly rather than presenting it as
closed.

## Mechanise at the moment you meet it — not later, not as a filed task

When a problem surfaces that a mechanism could prevent permanently, build that mechanism
**in the same pass** — before moving on, before reporting, before the next task. The test is
one question: *could a hook, a gate, a test, or a check make this impossible to repeat?* If
yes, that is part of the deliverable, and the original task is not finished without it.

Filing it for later is the failure mode this closes, and the reason is structural rather than
about diligence: a note is recall-on-demand, so it is read only by someone who already
suspects the problem. The person about to repeat the mistake is precisely the person not
looking it up.

## Two failure shapes this exists to stop

- **The one-door guard.** A guard that refuses ONE bad path does not close the class. After
  fixing a path, enumerate what OTHER inputs produce the same effect — a perfectly legitimate
  input is often one of them, which is why it goes unnoticed.
- **The hand-placed mechanism.** Anything armed by hand, once, by whoever happened to be
  there, disappears without a sound — at a restart, at a compaction, at the next session. And
  its absence is indistinguishable from "nothing to report". If a mechanism must exist every
  time, it belongs in whatever STARTS the thing, not in what is asked of the thing.

## What this does NOT license

- **Mechanising what needs judgment.** If the trigger is a judgment call, a guard would be
  wrong often enough to invert — it fires on correct work, gets switched off, and takes its
  real case with it. Say plainly that it cannot be mechanised, and why.
- **Shipping a guard that has never been measured.** A new guard's precision is measured on
  material it did not choose, BEFORE it is allowed to block. Until then it warns. A guard that
  refuses correct work is worse than no guard.
- **Skipping the honest report.** When only part of a problem is mechanisable, mechanise that
  part and NAME the rest as unmechanised, rather than letting the guard's existence imply full
  coverage.

## The shape of the answer, when asked what was done about a recurring mistake

Not "it is recorded" — but which mechanism now executes, what exactly it refuses, and what it
deliberately does not cover. If the answer is a note, say that it is only a note.

## Ship or keep private — decide it in the same pass

When the durable fix belongs to something you also distribute, the fix is not finished until
that decision is stated: a durable, environment-free, project-agnostic core goes to the
distributed copy through its normal development loop; local calibrations, paths and account
specifics stay private. An unstated decision is how the two copies silently diverge.

Composes with `wt-verify-by-ground-truth.md` — proving that the subject actually RUNS the fix,
and that a control is readable whether the fix worked or not, are verification duties and live
there.
