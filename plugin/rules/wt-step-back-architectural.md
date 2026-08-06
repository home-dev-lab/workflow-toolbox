# Step back to the architectural root — and ground "it doesn't exist" before a workaround

Fix shared root, don't point-patch shared cause. Review findings (own fixes too) landing same
file/area/shape repeatedly = signal of shared architectural root. Stop, question the shape.
Trigger on: 2+ rounds same area; adding second patch to just-patched thing; fix that spawns next
finding. Right moment = FIRST sign, not five commits later.

Survey before Nth copy (Rule of Three). Before writing a shape that exists elsewhere: grep/read,
count real occurrences codebase-wide, variants included. 1st time: write it. 2nd: duplicate. 3rd:
default = generalize. Only when instances share REASON TO CHANGE — same shape ≠ same concept.
Alike but different reasons to evolve → keep duplication (wrong abstraction couples unrelated
things, costly to undo), name in one line why coincidental. Abstract only for present concrete
consumers, never a speculative future one.

Ground premise before workaround. Before building around "doesn't exist" / "not possible": read
real source (or fan read-only agents for coverage) to confirm — confident architectural prior is
cheap to check, often wrong. Incremental fix can still ship; log the root for next pass.

## A fix whose defect has a TWIN elsewhere is carried in the same pass

Fixing one copy of a duplicated defect = point-patching shared cause. Costly specifically when
twin sits across a distribution boundary: local private copy + published one. Fix only private
side → inverts: fix stays with you, defect ships to every adopter, nothing says so.

Editing a file with a possible published counterpart — rule, script, hook, helper, anything
distributed — answer this SAME pass, not later:

> **Does this file have a shipped twin, and must this fix be carried there now?**
>
> Same look: **what does that copy already have that this one does not?**

**Drift runs both ways — the unwatched direction is the one that matters.** Review/issue/
contribution lands on the DISTRIBUTED copy first, can't reach a private copy it can't see — so a
shipped twin routinely carries hardening the private one lacks. Not laziness: "private =
experiment, shipped = lands" is a plausible workflow model, makes "private ahead" feel like law
not habit. Opening a twin to fix → read what it already has. Carry fix out + carry improvements
back = one pass, not two.

Three things make this fail in practice, each worth naming:

- **Detection usually isn't the failure.** Twin often known, sometimes filed. Skipped: the
  immediate half — carrying the fix — usually excused by an unchecked conflict/collision that
  takes seconds to check.
- **Pairing can't be mechanised.** Twins share no filename → no name-match guard finds them. A
  guard can RAISE the question at edit time, never ANSWER it. Build the reminder, but don't
  credit it with coverage.
- **A reminder firing every edit gets switched off**, taking its real case with it. Let it warn
  until false-positive rate is measured on material it didn't choose.

Judgment left: which half is durable/environment-free → published copy; which half is local
calibration/path/account-specific → stays private. Unstated decision = how the two copies
quietly drift while both look maintained.
