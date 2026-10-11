---
name: adopt
user-invocable: true
description: >-
  Invoke ONLY when you are about to install, check, refresh, or propose adopted editable copies
  from workflow-toolbox into a config or project directory and need the versioned,
  fingerprinted path, or when the user explicitly asks to "adopt the delegation rules",
  "install the workflow-toolbox rules as editable files", "install project copies of the pilot
  agents", "adopt the pilot watchdog into this project", or "check my adopted
  workflow-toolbox rules/agents for updates". Write only on a direct request or when the
  adoption hook orders a skipped refresh.
  Not for authoring workflows or composing a pilot wave.
---

# adopt — install editable copies of workflow-toolbox's guardrails and pilot agents

This skill writes **editable, versioned copies** of workflow-toolbox material into the
user's project, on explicit request or an exact stale-copy action from the adoption
hook. It manages three sets — `rules`, `agents`,
and `autonomy` (below); `--set all` covers them, and the `scripts` set, in one pass:

- **rules** — the cross-cutting guardrail rule files, SOURCED from the plugin's `rules/`
  bundle (every `*.md` there except `README.md` — currently the delegation ladder; the set
  is exactly what the plugin bundles and grows with it, the mirror of how the agents set
  sources `agents/`). **Until adopted, these rules are NOT in force.** A plugin's `rules/`
  directory is inert — nothing loads it into a session. The only ambient injection is a
  `SessionStart` hook that emits a SIX-LINE digest of the delegation ladder alone; every
  other rule in the set (proportionate verification, ground-truth verification, answer-first
  reporting, memory hygiene, checkpointing, task tracking, …) reaches a session ONLY as a
  copy this skill writes into a real config dir. Adopting is therefore what puts them in
  force — not merely what makes them editable.
- **agents** — project copies of the pilot delegation suite's agent definitions, SOURCED from
  the plugin's `agent-templates/` bundle (`pilot.md`, `pilot-watchdog.md`,
  `pilot-orchestrator.md`, `pilot-orchestrator-watchdog.md`). These templates are
  deliberately NOT plugin-registered agents — current Claude Code versions do NOT honor the
  `observer:` frontmatter for a plugin-installed agent, so a registered pilot would run
  WITHOUT its watchdog, silently. There is no namespaced "workflow-toolbox:pilot" type to
  fall back to: a pilot only exists to spawn once adopted. The pairing works only when
  `pilot.md` + `pilot-watchdog.md` live in the project's `.claude/agents/` under their bare
  names. Copying by hand works too, but a hand copy has NO staleness detection: this set
  closes that gap — every copy carries a version banner + content fingerprint, so a later
  `--check` reports when the plugin has moved ahead.
- **autonomy** — the session-autonomy mandate (`AUTONOMY.md`), standing-authorization format
  (`AUTHORIZATIONS.md`), and recommended permission classes (`PERMISSIONS.md`), SOURCED from the
  plugin's `autonomy/` bundle. Same banner/fingerprint shape as `rules`.
- **docs** — retired. The shipped rules no longer point at rationale files, so this set installs
  nothing and `--set docs` exits with that explanation. A `<config-dir>/docs/wt/` copy adopted
  earlier is left untouched and may be deleted.

A third kind of agent needs no adoption: the plugin's
`agents/` directory (`fidelity-checker`, `index-groomer`, `leaf`, `lean`, `opencode-verifier`,
`wave-fidelity-checker` as of this writing) is **registered directly by the plugin** — each
is already callable as `workflow-toolbox:<name>` the instant the plugin is installed, with no
adoption step at all. From an adoptant's side this is easy to confuse with "missing": both
states look like "the name is absent from `.claude/agents/`". So `--set agents --check` and
`--install` both end their run with a note listing every currently-registered agent under its
`workflow-toolbox:<name>` form, DERIVED from `agents/` at run time (never a hard-coded list —
an agent added there later shows up with nobody editing this skill). Use that note, not a
guess, to tell "already available, registered" apart from "genuinely absent, needs adopting".

Both sets are stamped, fingerprinted, and editable. Use this skill only when requested,
or to check/refresh previously adopted copies.
Never run it as a side effect of other work — writing into a user's config is a deliberate,
user-initiated act.

## Account-level environment prerequisites

`adopt` also checks the active config profile's `settings.json` `env` block and, on
`--install`, adds ONLY the plugin prerequisites whose keys are ABSENT there:

- `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` — required for the pilot/orchestrator/executor chain.
  Without it, the remote spawn-depth ceiling can drop below the three nested levels the suite
  uses, and the executor lane can die silently.
- `CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS` — required ONLY when adopting the pilot agents
  set. Without it, Claude Code silently ignores an adopted pilot's `observer:` field, so the
  watchdog never attaches.

Safety contract for settings writes:

- `--check` names missing keys by NAME only. It never prints env values.
- A present key is left intact even when it differs from the managed default.
- The tool writes only the active `CLAUDE_CONFIG_DIR` profile's `settings.json`; if the user
  keeps several profiles, tell them to rerun under each one.
- Before writing an existing settings file, the tool creates a backup, then re-reads the file
  and verifies that no root key or pre-existing env key was lost.
- Traceability is out-of-band: the tool records only the keys it inserted in a profile-local
  sidecar under the `workflow-toolbox/` subdir, because `settings.json` itself must stay strict
  JSON with no banner.

## The contract (do not violate)

- **Bounded hook refresh.** `SessionStart` uses `--install --refresh-only`, re-checks, and names
  refreshed rules/agents in one line. It skips absent copies, detected body/head or banner edits,
  settings, and per-file duplicate/misplaced/unverified findings. An edit/removal after the final
  byte check can still be overwritten/recreated by rename; no portable compare-and-swap exists.
  Skips and `PostToolUse` keep their actions; first adoption needs a request. Orphan removal advice
  is POSIX-shell (Bash; Git Bash on Windows); nothing is deleted.
- **Single-writer opt-out.** Set `WT_ADOPT_REFRESH=notice-only` or plugin option
  `adopt_refresh: "notice-only"` in a non-writer session. The notice still names the directory
  and exact command, but hands it to the session that owns that directory.
- **Every written file is stamped, fingerprinted, and editable.** The banner carries the
  plugin version AND a content fingerprint
  (`installed from workflow-toolbox v<version> · content sha256:<hex> …`). For a rule it is
  the file's first line; for an agent it is an HTML comment placed right AFTER the YAML
  frontmatter, so the file still begins with `---` and the agent def parses and registers
  normally. The fingerprint is how a later run distinguishes an edited copy from a pristine
  one.
- **Safe by construction, not by discipline.** `--install` NEVER overwrites a locally-edited
  copy (its content no longer matches the stamped fingerprint) or a hand-authored file with
  no toolbox banner — it refreshes only ABSENT or UNEDITED copies. Overwriting an edited copy
  takes an explicit `--force`. A user's edits cannot be silently destroyed by a refresh.
  Normal install has a banner-line fingerprint blind spot; refresh-only refuses banner appendages
  and edited/kept/unverified heads. See [refresh safety](references/detecting-and-refreshing-stale-copies.md).
- **Atomic publication.** Unique same-directory temps and rename; see the refresh safety reference
  for permissions, hard links and the remaining edit race.
- **Never write THROUGH a symlink.** If a target `<dir>/<name>.md` is a symlink (e.g. a
  config dir whose rules are symlinked from another one), `--install` does NOT follow it —
  following it would clobber the link's real target. The symlink is reported and left
  untouched; replacing it with a managed copy in place is an explicit opt-in
  (`--replace-symlinks`), never silent, and a refusal is an announced skip.
- **Announce before writing.** Tell the user exactly WHICH files go WHERE before `--install`,
  and report exactly what was written after. The answer to "will it copy my agents, and will
  it tell me?" is: it copies only when asked, it names each file and target first, and the
  copies are refresh-detectable thereafter.

## How to run it

The deterministic engine is `scripts/install.mjs`. Orchestrate it, do not re-implement
its version/banner logic by hand. `--set` picks which managed set (default `rules` for
backward compatibility):

When adopting into a project that already has rules, reconcile first — see the
"Reconciling your existing project rules" section in `../../rules/README.md`.

- **Check status (read-only, the default):** `node scripts/install.mjs --set <rules|agents|autonomy|scripts|all> --check`
- **Fail on script drift (read-only):** `node scripts/install.mjs --set scripts --check --global --fail-on-drift`. The four script items are thin launchers for the installed plugin, not copies of its bodies. Stale/edited managed shims, symlinked scripts (including dangling links), hand-authored files under shipped names, and missing canonical targets fail this check; absent items mean not adopted and do not fail. Preserve a symlink's destination before using `--install --replace-symlinks` to install a regular managed copy. A hand-authored file is never overwritten, even with `--force`: preserve and move it to a backup before adopting that name.

Script resolution uses the first present candidate: explicit `WT_PLUGIN_ROOT`, otherwise the highest-priority applicable installed-plugin registry entry, otherwise `CLAUDE_PLUGIN_ROOT`. A broken selected candidate refuses; it never falls through to another installation. Only `user` scope applies globally; `project`/`local` entries apply in their canonical project directory and descendants, taking priority over user entries. Equal ranks keep registry order. Root and registry project paths must be absolute. The check verifies canonical target existence, not whether Node can load its imports; direct execution has the same load failures and follows the same target symlinks.
- **Inspect an edited copy (read-only):** `node scripts/install.mjs --set <set> --diff <file> --dir <found-directory>`
  prints the journalled text as adopted, the local text, and the currently shipped text.
- **Install / refresh (absent + unedited only):** `node scripts/install.mjs --set <rules|agents|autonomy|all> --install`
- **Proven-clean copies only:** `--install --refresh-only` skips creation, settings and edits;
  eligibility and incompatible flags are in the refresh safety reference.
- **Overwrite a locally-edited copy (deliberate):** add `--force` to `--install`
- **Overwrite one arbitrated copy only:** add `--force --file <file>` to `--install`; do not
  use set-wide `--force` when the three-way decision covered only one file.
- **Resolve an on-demand trigger finding:** run the exact printed `--set rules --install
  --refresh-triggers --file <file> --dir <dir>` to take the shipped head while leaving the
  body and its banner version intact. Run `--keep-triggers` instead to accept the local
  head against the current spec; a later spec change reports it again. Use either flag only
  with a managed spec-backed on-demand copy. Do not combine `--keep-triggers` with `--force`.
  `--force` takes the shipped head as well as the shipped body.
- **Replace a symlinked target (deliberate):** add `--replace-symlinks` to `--install` — a
  symlinked target is otherwise reported and SKIPPED (never written through); this unlinks
  the symlink and writes a managed copy in its place, leaving the former target untouched.
- **Target a specific dir:** add `--dir <dir>` — requires a SINGLE `--set` (with `--set all`
  each set uses its own default dir).
  A static rules tree containing a subdirectory literally named `rules-on-demand` is not a supported layout; that name is reserved for on-demand rules.
- Use `--dir` for the exact destination directory; use `--global` for the config directory and
  its managed subdirectories. For rules, passing a parent that already contains adopted
  `wt/` files is refused to prevent flat duplicates; use `--dir <root>/wt` or `--global`.
- **Target the CONFIG dir:** add `--global` — the script resolves `CLAUDE_CONFIG_DIR` itself
  (falling back to `~/.claude` only when it is unset). Never hand-build that path and pass it
  via `--dir`: a hardcoded `~/.claude` is correct on a default machine and silently WRONG on
  one with a second config profile, and the report then describes a directory nobody meant.
  Unlike `--dir`, `--global` composes with `--set all`; the two flags cannot be combined.

**Target dirs — confirm scope with the user first.** Each set has its own default under the
current working directory: rules → `.claude/rules/wt/`, agents → `.claude/agents/` (project
scope, least invasive — they apply only in this project). For a machine-wide RULE install,
pass `--set rules --global` and let the script resolve the config dir (rules land under
`<config dir>/rules/wt/`) — do NOT type a path yourself. Agent copies are almost always
project-scoped (the watchdog pairing is a per-project concern) — the default
`.claude/agents/` is normally right; ask before overriding it.

Recommended flow:
1. Run `--check` first (for the relevant set, or `--set all`) and show the user the status
   (absent / up-to-date / stale / edited / hand-authored).
2. If they want to proceed, confirm the target scope, then run `--install`.
3. Report exactly which files were written and where.

Open [references/how-to-run-it.md](references/how-to-run-it.md) before using conditional installer flags, auditing overlap, or migrating existing flat rule copies.

## What gets installed

Open [references/what-gets-installed.md](references/what-gets-installed.md) when explaining the files installed by the selected managed set.

## Detecting and refreshing stale copies

Open [references/detecting-and-refreshing-stale-copies.md](references/detecting-and-refreshing-stale-copies.md) when checking status or refreshing an existing adopted copy.

## Non-goals

- It never writes without an explicit user request, and never touches anything but the managed
  files in the chosen set's dir.
- It does not install the workflow-authoring doctrine (in `workflow-toolbox:workflow-composer`).
- It is not how you compose a pilot wave — that is the `workflow-toolbox:pilot-wave` skill,
  which PROPOSES the agent-copy install (via this skill) at the moment a spawn would otherwise
  go out without the watchdog attached.
