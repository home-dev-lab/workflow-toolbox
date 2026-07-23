---
name: adopt-rules
description: Invoke ONLY when the user explicitly asks to install / adopt editable copies from workflow-toolbox into their config, or to check adopted copies for updates. Two managed sets — the cross-cutting RULE files (the delegation ladder) and the pilot AGENT-definition copies (pilot / pilot-watchdog / pilot-orchestrator, whose project copies enable the watchdog observer pairing that plugin-installed agents can't). E.g. "adopt the delegation rules", "install the workflow-toolbox rules as editable files", "install project copies of the pilot agents", "adopt the pilot watchdog into this project", "check my adopted workflow-toolbox rules/agents for updates". Writes versioned, fingerprinted, editable files ONLY on explicit request — never automatically. Re-invoke to detect stale copies (installed version behind the plugin) and refresh them. Not for authoring workflows (workflow-composer) or composing a pilot wave (pilot-wave).
---

# adopt-rules — install editable copies of workflow-toolbox's guardrails and pilot agents

This skill writes **editable, versioned copies** of workflow-toolbox material into the
user's project, on explicit request only. It manages two sets:

- **rules** — the cross-cutting guardrail rule files, SOURCED from the plugin's `rules/`
  bundle (every `*.md` there except `README.md` — currently the delegation ladder; the set
  is exactly what the plugin bundles and grows with it, the mirror of how the agents set
  sources `agents/`). The plugin already injects the delegation-ladder PRINCIPLE ambiently
  via a `SessionStart` hook where a project does tracked/delegated work; that injection is
  ephemeral and version-locked. This set is the OPT-IN persistent, editable alternative.
- **agents** — project copies of the pilot delegation suite's agent definitions
  (`pilot.md`, `pilot-watchdog.md`, `pilot-orchestrator.md`). A project copy matters because
  current Claude Code versions do NOT honor the `observer:` frontmatter for plugin-installed
  agents — so a pilot spawned as `workflow-toolbox:pilot` runs WITHOUT its watchdog. The
  pairing works only when `pilot.md` + `pilot-watchdog.md` live in the project's
  `.claude/agents/` under their bare names. Copying by hand works too, but a hand copy has
  NO staleness detection: because project agent copies WIN over the plugin's own types, a
  copy left behind after a plugin update keeps winning silently. This set closes that gap —
  every copy carries a version banner + content fingerprint, so a later `--check` reports
  when the plugin has moved ahead.

Both sets are stamped, fingerprinted, and yours to edit afterward. Use this skill ONLY when
the user explicitly asks for such copies, or to check/refresh ones they adopted earlier.
Never run it as a side effect of other work — writing into a user's config is a deliberate,
user-initiated act.

## The contract (do not violate)

- **Opt-in, explicit only.** Write files ONLY when the user asked. A first-run suggestion
  (from the plugin's `SessionStart` hook) or the `pilot-wave` skill may POINT at this skill;
  it must never write on its own.
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

The deterministic engine is `scripts/install-rules.mjs`. Orchestrate it, do not re-implement
its version/banner logic by hand. `--set` picks which managed set (default `rules` for
backward compatibility):

- **Check status (read-only, the default):** `node scripts/install-rules.mjs --set <rules|agents|all> --check`
- **Install / refresh (absent + unedited only):** `node scripts/install-rules.mjs --set <rules|agents|all> --install`
- **Overwrite a locally-edited copy (deliberate):** add `--force` to `--install`
- **Replace a symlinked target (deliberate):** add `--replace-symlinks` to `--install` — a
  symlinked target is otherwise reported and SKIPPED (never written through); this unlinks
  the symlink and writes a managed copy in its place, leaving the former target untouched.
- **Target a specific dir:** add `--dir <dir>` — requires a SINGLE `--set` (with `--set all`
  each set uses its own default dir).

**Target dirs — confirm scope with the user first.** Each set has its own default under the
current working directory: rules → `.claude/rules/`, agents → `.claude/agents/` (project
scope, least invasive — they apply only in this project). For a machine-wide RULE install,
pass `--set rules --dir <the user's global rules dir>` (their `CLAUDE_CONFIG_DIR` rules dir,
typically `~/.claude/rules/`). Agent copies are almost always project-scoped (the watchdog
pairing is a per-project concern) — the default `.claude/agents/` is normally right; ask
before overriding it.

Recommended flow:
1. Run `--check` first (for the relevant set, or `--set all`) and show the user the status
   (absent / up-to-date / stale / edited / hand-authored).
2. If they want to proceed, confirm the target scope, then run `--install`.
3. Report exactly which files were written and where.

## What gets installed

**rules → `.claude/rules/`:**

- Every `*.md` in the plugin's `rules/` bundle (its single source) except `README.md`,
  copied VERBATIM under a line-1 banner. Currently **`wt-delegation-ladder.md`** — the
  delegation ladder: route each task to the lowest rung that fits, pin model + effort at
  every spawn, heavy work goes down / judgment stays up, and the non-delegable main-session
  duties (wake-ups, user-gates, memory writes, the Workflow tool). Cost-model-neutral (the
  principle, not an account-specific model table), and fully editable once written. The set
  is whatever the plugin bundles, so it grows as guardrails are added — no per-rule change
  to the installer.

**agents → `.claude/agents/`:**

- **`pilot.md`**, **`pilot-watchdog.md`**, **`pilot-orchestrator.md`** — copied VERBATIM from
  the plugin's `agents/` directory (their single source), each under a banner. Installing all
  three is harmless: `pilot.md` + `pilot-watchdog.md` are what a single pilot needs for the
  watchdog pairing; `pilot-orchestrator.md` is needed only for a wave and sits idle otherwise.
  Once these project copies exist, spawn the BARE names (`pilot`, `pilot-orchestrator`) so the
  watchdog pairing attaches.

The rule set is the plugin's shipped, project-agnostic guardrails (pure directives — no
environment-specific narrative); the workflow-authoring doctrine lives in the
`workflow-toolbox:workflow-composer` skill and is not re-installed here.

## Detecting and refreshing stale copies

`--check` parses each installed file's banner version and compares it to the running plugin's
version — for both sets:

- **ABSENT** — not installed; `--install` writes it.
- **SYMLINK** — the target is a symlink; `--install` reports it and leaves it (and its real
  target) untouched. `--install --replace-symlinks` replaces the link with a managed copy in
  place (the former target preserved).
- **UP-TO-DATE** — installed, unedited, version equals the plugin's; `--install` is a no-op
  (use `--force` to reset it to pristine).
- **STALE** — installed, unedited, version behind; `--install` refreshes it (safe — no edits to lose).
- **EDITED** — installed, but the content no longer matches its stamped fingerprint (the user
  changed it); `--install` SKIPS it, `--install --force` overwrites.
- **hand-authored / pre-fingerprint banner** — a same-named file with no toolbox banner (never
  overwritten, even with `--force` — this protects a user's own `pilot.md` and any copy they
  made by hand before this skill existed; to bring such a copy under management, remove it and
  re-run `--install`), or an older managed banner with no fingerprint (treated as
  possibly-edited: skipped unless `--force`).

## Non-goals

- It never writes without an explicit user request, and never touches anything but the managed
  files in the chosen set's dir.
- It does not install the workflow-authoring doctrine (in `workflow-toolbox:workflow-composer`).
- It is not how you compose a pilot wave — that is the `workflow-toolbox:pilot-wave` skill,
  which PROPOSES the agent-copy install (via this skill) at the moment a spawn would otherwise
  go out without the watchdog attached.
