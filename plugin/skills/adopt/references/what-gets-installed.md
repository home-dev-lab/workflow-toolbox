This reference belongs to the adopt skill. Its text moved here verbatim from that skill's SKILL.md, so every path and link in it means what it meant there: a link to another reference file resolves from the skill directory (the parent of this references/ folder), and a project or repository path keeps its own base.

## What gets installed

**Optional `ssh-sign-retry` → `.claude/scripts/` (or `<config dir>/scripts/` with `--global`):**

- `wt-ssh-sign-retry.mjs`, a standalone Node program with an adopt banner and fingerprint.
  Only `--set ssh-sign-retry` opts in; `--set all` excludes it. The install step can set an
  absent `gpg.ssh.program` in the selected Git scope. Existing values are reported and
  preserved. See [SSH signing retry](ssh-sign-retry.md) for the runtime contract.

**rules → `.claude/rules/`:**

- Every `*.md` in the plugin's `rules/` bundle (its single source) except `README.md`,
  copied VERBATIM under a line-1 banner. The shipped set is the plugin's cross-cutting,
  project-agnostic guardrails — the delegation ladder (`wt-delegation-ladder.md`: route each
  task to the lowest rung, pin model + effort at every spawn, heavy work goes down / judgment
  stays up, plus the non-delegable main-session duties) alongside companion rules for
  verification, decision-making, grounding, and tracked-work hygiene. All are
  cost-model-neutral principles (no account-specific model tables), machine-free, and fully
  editable once written. The set is whatever the plugin bundles, so it grows as guardrails
  are added — no per-rule change to the installer.

**agents → `.claude/agents/` (or, with `--global`, the user config dir's `agents/`):**

- **`pilot.md`**, **`pilot-watchdog.md`**, **`pilot-orchestrator.md`**,
  **`pilot-orchestrator-watchdog.md`** — copied VERBATIM from the plugin's
  `agent-templates/` directory (their single source), each under a banner. Installing all four
  is harmless: `pilot.md` + `pilot-watchdog.md` are what a single pilot needs for the
  watchdog pairing; `pilot-orchestrator.md` + `pilot-orchestrator-watchdog.md` are the wave
  pair and sit idle otherwise. Once these copies exist, in one place only (a project copy shadows a user copy of the same
  name), spawn the BARE names
  (`pilot`, `pilot-orchestrator`) so the watchdog pairing attaches.

The rule set is the plugin's shipped, project-agnostic guardrails (pure directives — no
environment-specific narrative); the workflow-authoring doctrine lives in the
`workflow-toolbox:workflow-composer` skill and is not re-installed here.
