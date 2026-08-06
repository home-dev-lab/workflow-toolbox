# Why this gate blocked you, and how to satisfy it

The gate refused a turn ending. Its message is deliberately short; the reasoning lives here
because it is read once, by whoever is deciding what to do next, and printing it on every block
turns a signal into noise.

## What it actually catches

Not "you did not look at the queue" — **you are ending a turn to REPORT while tracked work
continues**. A report is a turn ending, and a turn ending is a full stop: nothing resumes until
the user speaks again. Closing a report with "I'll pick this back up" promises a next turn that
does not exist.

Measured cost of missing this, on the machine this hook was ported from: a session finished a
batch it had itself created, wrote "the queue is empty", and stopped — its tracker held 114 open
items. The finished batch had been mistaken for the whole queue. The claim was checkable in one
query and the query was never run.

## The two ways out

**Continue in this turn** (work the next item, or delegate it), or **state why you are stopping**.
This gate never judges the reason; it only makes it impossible to give none.

## Why it can go silent on you

This hook only ever speaks when your project has wired a freshness marker to it (see the header
comment in the hook file for the exact contract) — no marker, no opinion, ever. And even with a
marker, it respects an explicit `workPossible: false` + `workBlockedUntil` signal: if whatever
tracks your capacity says work is genuinely impossible right now (a spent usage window, a
saturated context), the gate goes fully silent for that window rather than nag about a condition
nothing can act on.

## Why it lets you through eventually

A cooldown bounds how often it can speak (see `COOLDOWN_MIN` in the hook). A gate that could never
be satisfied would deadlock the work it protects, get switched off, and take its real case with it.

## This file's status

This hook ships for backward compatibility with adopters who wired it directly before it was
superseded by a consecutive-block, tracker-agnostic successor. If your project's `settings.json`
still points at this file by path, it still works as documented above; consider migrating to the
current Stop-hook wiring shipped in this plugin's manifest.
