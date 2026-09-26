# Distributed fixes — at act

## Ship or keep private — decide it in the same pass

Fix belongs to something also distributed → unfinished until decided: durable, environment-free,
project-agnostic core → distributed copy, normal dev loop; local calibrations/paths/account
specifics → stay private. Unstated decision = how copies silently diverge.

⚠ **"Does the distributed set already carry this?" is answered against the SOURCE at a named
revision — never against an installed copy.** An installed copy is a build artefact, and nothing in
its content says which tree it was built from: ahead of the released line, behind it, or locally
edited all read identically. Resolve the question the way a distributor would — read the file at
the revision you would ship from.
Getting this backwards inverts the decision silently: a clause that exists only on an unmerged
branch reads as already distributed, so the port that would have carried it never gets made, and
the copy adopters receive stays behind while everyone believes it is current. It fails in the other
direction too: advice about what adopters have, given from a machine running an ahead-of-release
copy, is wrong by exactly the difference, with no signal that anything is off.

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
