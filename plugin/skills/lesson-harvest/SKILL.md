---
name: lesson-harvest
user-invocable: false
description: >-
  Invoke **PROACTIVELY** whenever you are integrating a closed pilot or executor report — nobody
  will ask you to — to get its "## Lessons for the memory" section without rereading the whole
  file. Extract candidate lesson items verbatim
  and return a distinct verdict for three cases: the section says "None.", the section is missing
  entirely, or the section carries content. Detection and extraction only: never write to a
  knowledge base, invent wording, classify a fiche, or decide whether to persist the lesson.
---

# lesson-harvest — mechanize finding the lessons a report already wrote

## Why this exists

A pilot or executor's closure report already carries a "## Lessons for the memory" section by
convention (see the `pilot` agent definition's "Final report contract"). Nobody automatically
reads it. The manual alternative — a human re-reading every report, every card, to find what's
worth keeping — doesn't scale and gets skipped under time pressure, which is exactly how a
documented gotcha gets rediscovered the hard way a second time.

This tool closes only that one gap: given a report file, tell the session **whether there is
anything to harvest, and what it is** — nothing more. It is deliberately NOT a memory writer: the
project's memory store may have exactly one writer (the session doing the integration), and
deciding a fiche's name, type, and wording, or whether it duplicates an existing fiche, is a
judgment call this tool cannot make.

## The two-sided contract this enforces

- A report whose section explicitly says **"None."** produces **no output artifact and no
  noise** — `hasLessons: false`. Do nothing.
- A report whose section carries content produces the **candidate items, verbatim** —
  `hasLessons: true`, `items: [...]`. Read each one and decide, per the project's own memory
  discipline (one lesson → one operative fiche home, a short index line, never restating detail
  in the index), whether and how to persist it.
- A report with **no such section at all** is reported as `sectionFound: false` — distinct from
  an explicit "None.". This is a malformed report; read it directly rather than treating the
  absence as "nothing to harvest".

## Usage

```bash
node plugin/skills/lesson-harvest/scripts/harvest-lessons.mjs <report.md>            # human-readable
node plugin/skills/lesson-harvest/scripts/harvest-lessons.mjs <report.md> --json     # machine-readable
```

Exit codes: `0` section found (with or without lessons) · `1` the file could not be read ·
`2` the report has no such section at all.

Run it once per closed card's report, at the moment the session integrates that card — not on
every report indiscriminately, and not as a substitute for the session-level checkpoint, which
still covers what arrives outside any card (a correction made mid-conversation has no report to
harvest from at all).

## ⚠ TRIAGE EVERY CANDIDATE BEFORE WRITING ANYTHING — a note is the FALLBACK, not the default

The candidates this tool returns are not "fiches waiting to be written". Extracting them and
filing them all as notes quietly converts every mechanisable defect into a note that only
fires for someone already suspecting the problem — which is the person NOT looking it up.
So ask this of each candidate, in order, and act on the first answer that fits:

1. **Could a mechanism make this impossible to repeat?** A hook, a gate, a test, a guard, a
   check in the tool that produced the lesson. If yes, **that mechanism is the deliverable**,
   built in the same pass — and the note, if any, becomes its rationale rather than its
   substitute. Do not file the note and move on.
2. **Is it a FACT?** A path, an option name, a measured number, an API's real shape. Nothing
   to mechanise; a note is exactly right.
3. **Is it a behaviour that must apply every time?** Then it belongs in whatever your setup
   auto-loads (a rule, a standing instruction), not in a recall-on-demand note — a note does
   not trigger.
4. **Is it already covered?** Say where, and write nothing. Recording the deliberate omission
   is what stops a later pass from creating a second, drifting copy.

⚠ **When a lesson is mechanisable but you file it as a note anyway** — because the mechanism
is large, or needs a judgment a guard would get wrong — say so explicitly in the note and name
what is left unmechanised. The failure this closes is not laziness: it is that a tidy note
LOOKS like the problem was handled, and nothing anywhere says otherwise.

Category 1 is the one this triage exists for, and it is easy to miss precisely because a
harvested lesson arrives already phrased as a lesson — the shape of a note, not the shape of a
defect. Read past the phrasing to what actually went wrong.

## What this does NOT do

- It does not write a fiche, an index line, or any file in a knowledge base.
- **It does not perform the triage above for you.** It detects and extracts; deciding whether
  a candidate earns a mechanism, a rule, a note, or nothing is the session's judgment, and it
  is the step that decides whether harvesting was worth doing at all.
- It does not classify a lesson's type (user / feedback / project / reference) or judge whether
  it duplicates an existing fiche — that stays the session's call.
- It does not run automatically at every report write; the session invokes it deliberately at
  card integration.
