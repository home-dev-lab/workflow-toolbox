---
name: planka-tracking
user-invocable: true
description: >-
  Onboard the CURRENT project onto a Planka kanban board for task tracking — create a
  project/board/lists/labels via the `planka` MCP, migrate an existing .claude/progress.md
  into reformulated, classified cards (zero-loss), and write the .claude/planka.json pointer
  that this skill's companion, `what-next`, reads. Requires the `planka` MCP server to be
  installed and reachable in the session — this skill cannot run without it. Use when a project
  has no .claude/planka.json and the user wants to start board-based task tracking, or says
  things like "onboard this project to Planka", "set up the board here", "start tracking tasks
  on Planka", "track my tasks on a kanban board".
---

# planka-tracking — onboard a project onto a Planka board

This skill brings the **current project** under board-based task tracking: one Planka project
+ board, a small set of lists and labels, and (if the project already has a .claude/progress.md
buffer) a zero-loss migration of its tasks into cards. It runs *in the project's own session* —
never on behalf of another project from a different session (the domain discovery and the
zero-loss migration both need the project's own files and conversation loaded).

> **Hard dependency: the `planka` MCP server.** This skill only works if a `planka` MCP server
> is installed and reachable in the session — it is how every board/list/label/card is created,
> there is no REST-credential fallback. If you don't have one set up, stop here and set one up
> first (any MCP server that implements Planka's API against your own Planka instance). Don't
> attempt a partial onboarding without it.

## Preconditions — check before doing anything

1. **Confirm the project is unmanaged**: no .claude/planka.json at the project root. If it
   exists, the project is already onboarded — stop and tell the user (offer to reconcile the
   board against the current .claude/progress.md/state instead of re-onboarding).
2. **Confirm the `planka` MCP is reachable** in this session. The tools are MCP tools —
   discover their exact names with `ToolSearch` (`query: "planka"`) before calling them; do not
   hardcode signatures, they vary by server implementation. If the MCP is unreachable, **stop**:
   onboarding needs it (ongoing task work can still degrade to `progress.md` once a project is
   already managed — see Degradation below — but the one-time board *setup* can't).
3. **Get the user's go-ahead** — onboarding creates a Planka project and (if migrating) reads
   their `progress.md`. One short confirmation, then proceed autonomously.

## Conventions this skill uses

These are this skill's own defaults, kept self-contained here (no external rule file assumed).
**If the project already has its own established task-tracking conventions** — different list
names, a different label taxonomy, documented in its own `CLAUDE.md` or elsewhere — prefer those
over the defaults below and say so before creating anything.

- **Standard lists**, created in order: `Backlog` · `Next` · `In Progress` · `Blocked` · `Done` ·
  `NotDoing`.
- **Universal labels** — every card gets all three: priority (`P0` / `P1` / `P2`), type
  (`feature` / `chore` / `bug` / `research`), and effort (`effort:S` for under ~2h, `effort:M`
  for about half a day, `effort:L` for multi-day). Beyond these, **discover 3-6 domain labels by
  reading the project** (README, `CLAUDE.md`, directory structure, `progress.md`) — don't impose
  a generic domain set that doesn't fit.
- **Card quality**: a concise plain-text title (no `**`/`###`/emoji, roughly ≤70 chars,
  action-oriented), a markdown description trimmed to essentials, and long history/context moved
  to **card comments** rather than crammed into the description. Comments carry the narrative —
  when new history overlaps an existing comment, merge into one consolidated comment rather than
  stacking duplicates.
- **Dependencies** (Planka has no native card-relation field): encode them in the description as
  `Depends-on: #<cardId> (<title>)`, one line per dependency. A card whose dependencies aren't
  all `Done` is a blocked chain, not a candidate for "what's next".
- **Degradation**: if the `planka` MCP becomes unreachable *after* onboarding, ongoing task work
  can fall back to writing into .claude/progress.md under a dated `## Unsynced (Planka down)`
  section, to be folded back into the board once the MCP is reachable again. That fallback is
  for day-to-day work on an already-managed project — not for the onboarding run itself (see
  Preconditions #2).

## Procedure

### 1. Create the Planka project + board (via the `planka` MCP — no REST creds)

- Create the **project** with **`type: 'shared'`** (ownerless → `ownerProjectManagerId = null`
  → the human admin sees it automatically; see Gotchas). Name it for the repo — a clean human
  name (e.g. the repo's display name), not the raw directory slug if that reads badly.
- Create one **board** in it (the same name is fine).
- Create the **standard lists** in order (see Conventions above).
- Create the **universal labels** (priority + type + effort, see Conventions above). Then
  **discover domain labels by reading the project** — don't impose a fixed global set.

### 2. Migrate an existing .claude/progress.md (zero-loss) — if present

If the project has a .claude/progress.md:

1. **Back it up first** (zero-loss is non-negotiable):
   ```bash
   cp -f .claude/progress.md ".claude/progress.md.backup-$(date +%Y%m%d)"
   ```
   *(A workflow artifact bans a non-deterministic `date` call, but this skill runs in a normal
   interactive session, not inside a Workflow-tool script — `date` in Bash is fine here.)*
   Verify the backup matches (`md5sum` on both) before touching anything.
2. **Parse the file** — adapt to its actual structure; it varies per project. Common shapes are
   status-tagged sections (active / pending / blocked / done) or a flat task list with inline
   status markers. If nothing recognizable is found, read it as free text and extract candidate
   tasks conservatively rather than guessing a structure that isn't there.
3. **Create one card per real task**, placed on the list matching its recorded state
   (in-flight → `In Progress`, pending/bench → `Next` or `Backlog`, blocked → `Blocked`,
   recently-done → `Done`). **Reformulate — never blind copy/paste**: a clean plain-text title,
   a markdown description trimmed to essentials, long history/context → **card comments**.
4. **Classify** each card: priority + type + effort, plus the discovered domain labels.
5. **Encode dependencies** with `Depends-on: #<id> (<title>)` in the description, one per line.
6. **Migrate the historical narrative too, not just the task rows.** Per-task history (commits,
   PR/ticket links, a session-by-session changelog) → **card comments** on the matching card: one
   consolidated, dated "migrated from progress.md" comment per card. A cross-cutting changelog
   paragraph goes to the single most-relevant card, not duplicated across many.
7. **Then reduce `progress.md` to the degraded-mode stub** — once cards + comments are in place
   AND the `.backup-<date>` from step 1 is verified present. The file is **never deleted** (it
   persists as the degraded-mode buffer described in Conventions above), but on a managed project
   it must **not** keep a full copy of the board. Reduce it to: a short header pointing at the
   board + the dated backup, plus an empty `## Unsynced (Planka down)` section.
8. **If the project separately maintains its own reusable-knowledge notes** (some setups keep a
   knowledge index alongside task tracking — e.g. a running notes file with one entry per
   lesson/decision) **and any of those notes are really project-task narrative rather than
   reusable knowledge, fold that narrative into the matching card as a comment** and thin the
   note down to a short pointer back to the card. **Skip this step entirely if the project has no
   such knowledge-note convention** — most don't, and it's not something this skill should assume.

If there is no `progress.md`, skip migration — the board simply starts empty.

### 3. Write the pointer

Create .claude/planka.json at the project root:

```json
{ "projectId": "<id>", "boardId": "<id>", "projectName": "<clean name>" }
```

This is what makes the project "managed" — the presence of this file is the signal
board-aware tooling (starting with the `what-next` skill) keys off.

### 4. `what-next` is available directly — deposit a project copy only on request

The `what-next` skill ships alongside this one and works out of the box against the board you
just created — no extra step is needed for a newly onboarded project.

If the user wants a project-specific, freely-editable version (to add domain framing, a
project's own tracker-CLI specifics, or anything else they want to specialize), copy the shipped
skill into the project on request:

```bash
mkdir -p .claude/skills/what-next
cp -f "<this skill's own directory>/../what-next/SKILL.md" .claude/skills/what-next/SKILL.md
```

Only do this when asked — an unwanted project copy would silently shadow future improvements to
the shipped skill. If .claude/skills/what-next/SKILL.md already exists, leave it alone; the
project already has a (possibly specialized) copy.

### 5. Report

Report concisely: project + board created (with the Planka URL if known), lists + labels, how
many cards migrated (and that `progress.md` was backed up and preserved), the pointer written,
and whether a project copy of `what-next` was deposited. Note anything that could NOT be
migrated cleanly (ambiguous entries left for the user to triage).

## Gotchas (Planka 2.1 — hard-won; don't relearn them)

- **Project visibility**: a project with **no owner** (`ownerProjectManagerId = null`, which is
  what `type: 'shared'` sets at creation) is auto-visible to the human admin (the "Shared With
  Me" bucket in Community). A project *with* an owner is private to its managers/members. The
  "Team" bucket is a **Pro/Enterprise** feature — don't rely on it. To convert an existing owned
  project: `PATCH /api/projects/:id {ownerProjectManagerId:null}`.
- **Terms of service (2.1)**: accepting the terms is required before a token works. If you hit a
  403 `{pendingToken, step:'accept-terms'}`, the account hasn't accepted them yet:
  `GET /api/terms` → `POST /api/access-tokens/accept-terms {pendingToken, signature}`.
- **User creation** requires a `role` ∈ `admin | projectOwner | boardUser`.
- **`get_board` hides the card↔label link** → filtering by label through the MCP costs one
  `get_card` call per card. Filtering by **status (list)** has no such cost.
- **Adding a member/manager via the API** returns 403 (it needs a browser session cookie) → do
  it in the Planka UI instead. With ownerless `shared` projects you rarely need to — the admin
  already sees them.
- **No native card dependencies** → the `Depends-on: #<id> (<title>)` description convention
  (see Conventions above) is the only mechanism.

## Degradation

If the `planka` MCP drops mid-onboarding, do not leave a half-migrated board silently: report
what was created, what wasn't, and tell the user to re-run once the MCP is back. Don't fall back
to writing tasks into `progress.md` *during onboarding* — that degraded path is for ongoing task
work on an already-managed project, not for the one-time board setup.
