# workflow-composer

A Claude Code skill that teaches Claude how to **author runnable workflow
scripts** for Claude Code's Workflow tool — the deterministic multi-agent
orchestration files where plain JavaScript drives the loops, conditionals, and
fan-out, and only the leaf `agent()` calls spend model tokens.

This README is the human-facing tour. The skill's own brain is `SKILL.md`,
which is written for Claude, not for you.

There are two authoring paths, and the skill picks the right one for the job:

- **`@dwt` toolkit** — for workflows you intend to keep, re-run, and maintain.
  You write a typed TypeScript file against a tested pattern library and compile
  it to a self-contained `.js` artifact.
- **Raw `.js`** — for one-offs, or shapes that fit none of the patterns. You
  hand-write the orchestrator directly against the runtime globals.

## What lives where

| Path | What it is |
|------|------------|
| `SKILL.md` | The Claude-facing skill: file format, the `pipeline` vs `parallel` call, schemas, determinism rules, gotchas, a worked example. |
| `references/api-reference.md` | The evidence-tiered runtime reference — every global, option, cap, and failure mode. |
| `references/patterns.md` | The seven orchestration patterns as copy-paste recipes. |
| `assets/templates/` | Three starter skeletons: `fan-out`, `pipeline`, `loop`. |
| `assets/examples/` | Two runnable raw examples, plus a `toolkit/` subdir with four `@dwt` composition sources to read. See its own README. |
| `scripts/validate-workflow.mjs` | The linter — checks a workflow file against the parser's hard rules before you spend a run. |

## Availability

The Workflow tool is a **research preview**: Claude Code v2.1.154 or later, on
all paid plans, with Pro users opting in from the *Dynamic workflows* row in
`/config`. Full availability, opt-in, and disable details live in
`references/api-reference.md`.

## How to use it

Just ask Claude to build a workflow — "make me a workflow that reviews each
changed package", "turn this multi-step job into a workflow", "scaffold a
fan-out pipeline". The skill triggers on requests like these and walks Claude
through choosing a path, picking a topology, and validating the result. You do
not invoke it by hand.

## A note on accuracy

The runtime facts in this corpus are **evidence-tiered**. Each non-obvious claim
carries one of three markers: **[documented]** (in Claude Code's official docs,
stable), **[verified]** (confirmed against the binary by this plugin's authors,
but unofficial and unstable), or **[observed]** (publicly visible but
unverified by us). Part of the surface is verified against the binary only — it
works today and a Claude Code upgrade may change it. Re-verify after upgrades
before trusting a workflow in anger.

## Credits

This skill was originally inspired by
[claude-code-workflow-creator](https://github.com/ray-amjad/claude-code-workflow-creator)
by [Ray Amjad](https://www.youtube.com/@RAmjad). The current corpus is an
original rewrite.
