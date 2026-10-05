This reference belongs to the pilot-wave skill; all paths are relative to the skill directory (the parent of references/).

## Step 1 — resolve the environment brief

The environment brief is a set of prose blocks the spawn prompt carries. Each block has a safe
fallback, but the cascade differs PER BLOCK: only `KNOWLEDGE_BASE_INDEX` has a real
environment-variable fallback (`WT_KNOWLEDGE_BASE_INDEX`); every other block is **prompt >
auto-detection / default** (no env var — don't invent one). Resolve them like this, then embed
the resolved values in the spawn prompt:

- **`KNOWLEDGE_BASE_INDEX`** — the session knowledge-base index the agents read (READ-ONLY).
  Resolve: an explicit path the user gives → env `WT_KNOWLEDGE_BASE_INDEX` → derive
  `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/<slug>/memory/MEMORY.md`, where `<slug>` is
  the absolute project root with every character outside `[A-Za-z0-9-]` replaced by `-`. If
  no such index exists, pass none — the agents degrade to their own memory + the card.
- **`TASK_TRACKER`** — where the cards live and how to reach them. Resolve: an explicit
  tracker the user names → auto-detect (a kanban board pointer file, e.g. a planka.json board
  descriptor, reached through its MCP; else the ticketing CLI the project configures, e.g.
  Jira; else a plain task file). Pass which one and how to query it.
- **`EXECUTOR_LANE`** — the lane for heavy mechanical increments, gated by CONSENT, not mere
  availability. Resolve in two steps:
  1. **Availability**: is a cross-family CLI bridge on `PATH` (e.g. `command -v codex`,
     `command -v opencode`)? A missing one degrades cleanly to step 2's fallback — never
     assume a bridge is present.
   2. **Consent** (checked only if available): use the shared `wt-lane-consent` resolver. Its
      account source is the plugin's persisted `userConfig.executor_lane_consent` value in
      `~/.claude/settings.json` (opt-in, default OFF); the existing
      `WT_EXECUTOR_LANE_CONSENT` settings `env` value remains an account source and must agree
      when both are present. Then check the CURRENT project's
      `<project>/.claude/settings.local.json` `env` block for the same key: it may only NARROW
      (set it to something other than `"true"`), never widen an account ceiling that is off. A
      refusal or disagreement at either level wins.
  **The shipped CLI answers both halves of this without hand-editing JSON**, and it is what
  you point a user at when they ask how to see or change the switch:

  ```bash
  wt-lane-consent                       # what is it right now: account, project, effective
  wt-lane-consent --on | --off          # set the ACCOUNT ceiling
  wt-lane-consent --project [dir] --off # NARROW it for one project only
  wt-lane-consent --json                # the same state, machine-readable
  ```

  It reports the state in words (`ALLOWED` / `REFUSED` / `not set` / `UNKNOWN`), never the
  raw stored value, and when it refuses it names WHICH level refused — an account that never
  opted in and a project that narrows an allowing account read identically otherwise. A write
  backs the file up first and preserves every other key.
  ⚠ **Two readers, two latencies, and the CLI says so after a write**: anything reading the
   settings FILE (this CLI, the consent check, this skill) sees the change immediately; anything
  reading the environment VARIABLE sees it only in a session started afterwards, because the
  settings `env` block is applied at session start. A correct write can otherwise look like it
  did nothing.

  If BOTH available AND consented → name the bridge as the executor/verifier lane.
  Otherwise (no bridge, OR a bridge present but not consented) → **the lane is absent; the
  pilot/orchestrator SPLITS** (its own tier for design/plan/arbitration, a spawned cheaper
  sub-agent for the increment) — never "implement inline" on the arbiter's own tier. State
  which of the two ("absent" vs "present but not consented") in the brief you compose, since
  it changes what a later session should check before re-probing.
  ⚠ **When you name a bridge, name its invocation shape too — a CLI invoked from a shell with
  no terminal can block on standard input.** An agent's Bash tool is exactly that shell: stdin
  is open but nothing will ever arrive, so a CLI that waits for it returns ZERO output until
  something times out. Redirect stdin from the null device (`… < /dev/null`) and bound the call
  with a timeout. The failure looks INTERMITTENT — an inherited stdin sometimes closes on its
  own — which sends people hunting through the working directory, the database, the token, and
  the model before they suspect the shell. State the shape in the brief; a pilot that only
  receives the bridge's NAME will write the call itself, and write it without this.
- **`WORKTREES_DIR`** — where pilots create isolation worktrees when the repo may have
  concurrent writers. Resolve: an explicit dir → a sibling worktrees dir next to the repo.
- **`REPORT_DIR`** — where file-reports land (the nested-routing workaround: a named agent's
  final message routes to the main session, so reports go to files the arbiter polls).
  Resolve: an explicit dir → a scratch dir you create and name. **Naming constraint**: the
  CLI hard-blocks a sub-agent's `Write` when the file's basename starts with `report`,
  `summary`, `findings`, or `analysis` (case-insensitive) — put the word at the END instead
  (`<cardId>-report.md`, not `report-<cardId>.md`).
- **`QUOTA_POSTURE`** — how much verification fan-out the budget allows, so reviews scale to
  the change class. Resolve: an explicit posture the user states → "comfortable" default. Under
  pressure, the agents degrade to the single cross-family verifier shape.
- **`WATCHER_REGISTRY`** — a path/command a delegate can query to see which watchers (hooks,
  monitors, disk/staleness checks) currently cover it and on what signal each fires — see the
  three-state contract (watched / not watched / unknown, never collapsed) already carried in
  `pilot.md` and `pilot-orchestrator.md`. This skill does not ship a concrete instrument: what
  counts as a "watcher" is entirely project/machine-specific (a systemd timer, a hook-armed
  marker directory, a cron job — nothing about the shape is portable). Resolve: an explicit
  command the user gives → a project-level convention documented in the project's own rules
  (e.g. a private rule naming a reader script) → absent. When absent, **say so once in your own
  final report** rather than omitting the field from every brief silently — an omitted field
  and a deliberately absent registry read identically to a pilot unless the report states which
  one it was.

