This reference belongs to the workflow-composer skill; all paths are relative to the skill directory (the parent of references/).

### The orchestration ladder — pick the lowest rung that does the job

"Workflow or nothing" is a false choice. A workflow is the *fourth* rung of five;
most fan-out that doesn't earn a compiled artifact still wants a **pattern shape**,
just run by hand instead of compiled. Route to the lowest rung that fits:

1. **Answer directly** — no delegation needed.
2. **One subagent** — a single isolated task; `Agent` once and read the result.
3. **Inline fan-out in the main conversation loop** — run a pattern's *logic*
   directly: the main loop emits several `Agent` calls and reconciles their results
   itself, **with no `.js` artifact and without the Workflow tool**. This is the rung
   the gate above was hiding. It buys you the pattern (refute-first verify,
   fan-out-synthesize, tournament, loop-until-dry) for a one-off, at zero build cost.
   The nine shapes and a sandbox→main-loop translation table are in
   [patterns.md](references/patterns.md) (*"Inline in the main conversation loop"*).
   This is the same default `deep-grounding` reaches for; eight of the nine patterns
   translate cleanly — only `planAndExecute` at scale really wants the artifact.
4. **Compiled workflow** (the rest of this guide) — graduate here the moment **any**
   of three holds, and not before: **reuse** (kept, re-run, version-pinned), **scale**
   (enough fan-out that intermediate results would flood the main loop's context — the
   one thing inline cannot give you; the test is context-flood, not a fixed file count),
   or **determinism/resume** (the journal + `resumeFromRunId`). Note these last two are
   distinct: *resume* recovers a **single partially-failed run within the same session**;
   re-running the workflow on each new PR (across sessions) is just a fresh launch every
   time — that's **reuse**, not resume, and resume's journal cache does not carry across
   sessions. Absent all three, stay on rung 3.
5. **Agent teams** — only when the workers must *talk to each other* mid-run
   (competing-hypothesis debate, hand-offs). Teams is opt-in and off by default; don't
   assume it's available — propose it to the user with the enable step when it fits.
   See [deep-grounding](../deep-grounding/SKILL.md) (*"Subagents vs. agent teams"*) for
   the decision axis and how to handle its opt-in availability — it owns that rung;
   don't duplicate it here.

The graduation that matters is **3 → 4**: keep work inline until reuse, context-scale,
or resume forces a compiled artifact.

