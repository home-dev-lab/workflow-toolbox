---
name: stale-card-sweep
user-invocable: true
description: >-
  Invoke ONLY when a task-tracker card is about to close and you need to check whether its diff
  already covered the defect another open card still describes, or when the user says "sweep for
  stale cards", "check what this closes", or "did this diff subsume anything else". Shortlist
  candidates from the changed files, then judge each one against the diff. Advisory only: flag
  candidate cards with a comment; never close, move, or rewrite them. Not for card creation or
  age-triggered dormant-card sweeps.
---

# stale-card-sweep — flag what a closing diff just made stale

## Why this exists

A card is created for a defect. Before it is picked up, a different, larger card gets
implemented and covers the same ground. The first card stays open. Nothing connects "this
diff just landed" to "these open cards describe exactly what it fixed" — until someone
happens to notice by eye and writes it down by hand. That noticing does not repeat reliably.

Measured cost of the gap this skill closes: a pilot spawned on a card whose work had already
shipped in an earlier commit produced an empty branch — ~209,000 tokens spent discovering, the
hard way, that the card should have been flagged stale at the closure of the covering card. A
`grep`-cheap mechanical check would have cost nothing.

## When to run this

At the moment a card is about to move to its terminal "closed" list (`Done`/`NotDoing` on this
project's board convention — adapt to whatever the tracker calls closed). Run it **before**
the move, using the closing card's own diff.

## The two layers — mechanical shortlist, then judgment

**Layer 1 (mechanical, free)** — the closing diff's changed files are the only reliable,
language- and wording-independent signal. The companion script
`toolkit/scripts/stale-card-sweep.ts` takes the changed-file list and the board snapshot and
returns every OPEN card whose name or description mentions one of those paths (full path, or a
sufficiently distinctive basename):

```bash
npx tsx toolkit/scripts/stale-card-sweep.ts --board <boardId> \
  --changed-file <path1> --changed-file <path2> ... \
  --closing-card <the card that is about to close>
```

`--closing-card` is not optional in practice: without it, the closing card's own diff trivially
mentions its own text and the script shortlists the card as "stale" against itself.

(from a toolbox checkout with `toolkit/` vendored; use `--snapshot <file.json>` against a
fetched card array when scripting against a saved snapshot instead of live MCP).

**Layer 2 (judgment, not mechanical)** — the shortlist is candidates, never a verdict. For
each one, read the open card's description against the actual diff and decide: does this diff
genuinely fix the defect the card describes, or is the card merely adjacent/related? Only the
first case gets flagged. This step cannot be replaced by string matching — "subsumed" is a
semantic question about whether a description's defect is actually gone, and the founding
card's own DESIGN QUESTION ("is this mechanical or judgment?") resolves here: candidate
generation is mechanical, the subsumption call is judgment.

## The threshold — read everything below ~200 open cards

**Strictly below ~200 open cards on the board (the script filters at or above the threshold, see
`shouldFilterByDiff`), skip Layer 1 entirely and read every open card's title +
description directly.** Measured: 90 open cards (Backlog + Next + In Progress + Blocked — the
count MUST name this set; a count excluding `Blocked` undercounts by exactly that list, since a
blocked card is still open work and is exactly the kind that goes unnoticed) read in about two
minutes. At that size the mechanical filter is a needless place to miss a reformulated
duplicate — **reading everything cannot miss a rewording; the filter can.** The filter
(`shouldFilterByDiff` in the script) is a degradation accepted only above the threshold for
volume, never an improvement.

## Applying the flag — two-way, and advisory only

- **Positive**: a card genuinely subsumed by the closing diff gets ONE comment: name the
  closing card, the matched file(s)/reason, and ask the reader to verify before resuming work
  on it. Never move or close it — the flag is input to a human/pilot judgment, not a verdict
  strong enough to act alone (a false positive that auto-closes a card is worse than the
  problem this skill exists to solve).
- **Negative**: a merely neighbouring card — same family, same time window, related topic, but
  not actually fixed by this diff — stays untouched. This is the half that decides whether the
  tool survives: a sweep that flags everything nearby gets ignored within days, and an ignored
  check occupies the place of a working one. When in doubt, do not flag — silence costs a future
  re-discovery; a wrong flag costs trust in every future flag.

## What this does not cover

- Card creation (structurally impossible — the covering work does not exist yet).
- Long-dormant cards with no triggering closure (`working-methodology.md` clause 1bis).
- A defect described only in a card's PAST COMMENTS rather than its current description/name —
  the mechanical layer 1 script does not scan comments; a human/agent doing the judgment pass
  should still read comments on any card the diff's file list makes plausible.
- Retraction sweeps (a stale FACT that circulated, not a card subsumed by new code) and
  citation sweeps (a referenced TEXT that changed) — related, different triggers, different
  cards on this board.
