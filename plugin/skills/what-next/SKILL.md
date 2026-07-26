---
name: what-next
description: >-
  Propose the logical next step given the project's task backlog — a Planka board (via
  .claude/planka.json, when the `planka` MCP is reachable) or, failing that, a
  .claude/progress.md file — plus the current conversation and, if the project keeps one, a
  knowledge index such as `MEMORY.md`. Use when the user types /what-next or asks "what's next",
  "what should I tackle now", "what comes after this", or has just finished a chunk of work and
  wants a recommendation grounded in their tracked backlog. Works even with none of the above
  present, falling back to conversation + memory and saying so plainly. Read-only — proposes,
  never mutates the board, progress.md, or task state. Pairs with the `planka-tracking` skill,
  which sets up the board this skill reads.
argument-hint: "[topic-filter]"
---

# /what-next — propose the logical next step

You help the user decide what to work on next, **grounded in what they actually track**, not
what sounds productive. Read the inputs in order, synthesize, output a focused recommendation.
**Read-only** throughout — never edit the board, `progress.md`, or any task state.

**Dependencies, stated up front:** the board path needs the `planka` MCP server reachable and a
.claude/planka.json pointer (written by the `planka-tracking` skill); the `progress.md` path
needs nothing beyond the file existing; the `MEMORY.md` input is used only if the project already
keeps one — most don't, and that's fine. When none of these are present, say so and fall back to
conversation + whatever the user tells you (see Fallback at the end).

## Inputs

Read in order; stop as soon as you have enough.

1. **The task backlog** (mandatory). **If the project is managed** — .claude/planka.json exists
   AND the `planka` MCP is reachable — the **board is the backlog**: read its lists/cards/labels
   via the MCP (discover exact tool names with `ToolSearch`, `query: "planka"`). Map the standard
   lists: `In Progress` → in-flight, `Next`/`Backlog` → the bench (`Next` = higher priority),
   `Blocked` → blocked, `Done` → recently accomplished. Priority/type/effort **labels** and any
   `Depends-on: #<id>` lines in card descriptions drive ranking — **never recommend a card whose
   dependencies aren't all `Done`**; flag it as a blocked chain instead. **Otherwise** (no
   pointer, or the MCP is down) fall back to **.claude/progress.md** if it exists: parse
   whatever status structure it actually uses — common patterns are labeled sections (active /
   pending / blocked / done) or a flat list with inline status markers — and look for some kind
   of "last updated" line or header to judge staleness. If the file doesn't follow a recognizable
   structure, read it as free text and extract candidate tasks conservatively. If neither a board
   nor a `progress.md` exists, see **Fallback** at the end.
2. **Conversation context** (free) — what did the user JUST finish? The recommendation should
   flow logically from that, not be a random pick from the bench.
3. **A knowledge index, if the project keeps one** (free, optional) — some projects maintain a
   running notes file (commonly named `MEMORY.md`) with gotchas, prior decisions, and
   cross-references tied to specific tasks. If one is already loaded in context, skim it for
   entries relevant to candidate tasks. If the project has no such convention, skip this input
   entirely — it is not required.
4. **`$ARGUMENTS`** — optional topic filter. If present, restrict candidates to tasks whose
   title/body mentions that topic (case-insensitive substring). Empty = no filter.
5. **Tracker live state** (optional, no topic arg only) — if the project has a tracker CLI (e.g.
   `gh` for GitHub, `glab` for GitLab, or an equivalent for whatever the project actually tracks
   PRs/tickets in), make ONE call for current PR + ticket counts (~3s). **Always project through
   `jq`** (or the CLI's own projection flag) for a count-only summary — raw payloads carry every
   PR's title/body/reviewers and will fill the context. Skip when a topic arg is passed, or when
   there's no such CLI. Tolerate failure silently (drop the live-state line).
6. **Git working tree** (free, no topic arg only) — `git status --porcelain=v1`, digested to ONE
   high-signal line ("uncommitted WIP in X") so the recommendation doesn't blindly stack Y on top
   of work already in flight.

## Output

### Step 1 (MANDATORY first) — scan for stalls

For each in-flight item (`In Progress` cards, or the equivalent "currently active" entries in
`progress.md`), find its last-touched date however the project records it — a card's activity
date, or a "last touched"/"last updated" line next to the task. **If it's more than 7 days before
today, it IS stalled** — no exceptions (not "it's blocked anyway", not "I'm thinking about it").
Emit, above the recommendation, at most the 2 oldest:

```
⏸️ Stalled — #<id> <title> (last touched YYYY-MM-DD, <N> days ago) — next action: <the task's own recorded "next step", trimmed, or "none recorded">
```

Omit the section only if nothing is stalled. The scan itself is non-negotiable.

### Step 2 — build the recommendation

**Two registers:**

- **No topic arg → narrative brief** (the default). Write for someone discovering the project
  today: open in plain language with *what the project is*, then narrow to the upcoming
  milestone, what today's state means, the one thing to do first, the other tracks ranked by
  usefulness, what's locked for later. Codes (`#id`, SHAs) are **anchored at the end of a plain
  sentence, never leading it**. Plain-sentence headers, prose paragraphs — not emoji-bullet
  skeletons. ~700 words.
- **Topic arg → compact answer.** The user is oriented; skip orientation. Scoped banner → top
  pick → runners-up. Terse. ~300 words.

**Every actionable item carries a stable `Option N` handle** — top pick = **Option 1**, bench
continues **2, 3, …** in usefulness order — so the user can follow up by digit ("dig into option
2", "let's do option 3"). Emit BOTH the `Option N` (conversational anchor) and the `#id` (tracker
anchor). Numbering is per-invocation. Locked-for-later items are still numbered but flagged.

**Top recommendation** (always Option 1): the single best pick given conversation + priority +
dependencies. Cover — *the situation* (who/what/since-when/what it unblocks) then *the concrete
first action* (file to open, command to run, person to ping). In narrative mode write this as
prose under a plain-language header; in compact mode a labelled field list (`What / Why now /
Effort / Dependencies / First step`) is fine. Effort: defer to the card/task's own estimate
verbatim if it has one, else t-shirt size S/M/L.

**Other tracks / short-list**: the bench, ranked, each line **self-describing** — `#647` means
nothing; `#647 — the monthly inventory-snapshot cron` does. Never collapse to a row of bare codes.

## Rules

- **Self-describing references** — never a bare `#id`/SHA; carry the substance in ≤8 words.
- **Read-only** — never edit the board, `progress.md`, or any task state. The user mutates it via
  the board's own tools, `planka-tracking`, or manual edits.
- **Respect blockers & dependencies** — skip `Blocked` items and any card with an unsatisfied
  `Depends-on:` unless there's evidence the blocker cleared.
- **Critical path / P0 beats the bench**, unless the user just finished an equivalent item.
- **Flow from what was just done.**
- **Recommendation, not a menu** — pick one, defend it briefly, rank the rest. Orientation-first
  in narrative mode is not a menu; dumping N equal options with no pick is.
- **Match the user's language** (per their `CLAUDE.md` / stated preference).

## Fallback when no backlog source exists

If there's no board (no .claude/planka.json, or the `planka` MCP is unreachable) AND no
.claude/progress.md, fall back to conversation context plus any project/feedback notes already
in context, and say so up front: "No board or `progress.md` found — recommendation based on
conversation + memory only; less reliable for medium-term priorities." If there's no
.claude/planka.json, also mention the project can be onboarded via the `planka-tracking` skill.
