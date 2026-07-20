---
name: adopt-rules
description: Invoke ONLY when the user explicitly asks to install / adopt editable rule copies from workflow-toolbox into their config, or to check adopted rules for updates — e.g. "adopt the delegation rules", "install the workflow-toolbox rules as editable files", "keep an editable copy of the delegation ladder", "check my adopted workflow-toolbox rules for updates". Writes versioned, editable rule files ONLY on explicit request — never automatically. Re-invoke to detect stale copies (installed version behind the plugin) and refresh them. Not for authoring workflows (that is workflow-composer) or composing a pilot wave (pilot-wave).
---

# adopt-rules — install editable copies of workflow-toolbox's guardrails

The plugin already carries its cross-cutting guardrail — the delegation ladder — ambiently,
via a `SessionStart` hook that injects it where a project does tracked/delegated work. That
injection is ephemeral and version-locked to the plugin. This skill is the OPT-IN
alternative: on explicit request, it writes the same guardrail into the user's config as an
**editable rule file**, stamped with a versioned banner so a later run can tell whether the
copy has fallen behind the plugin.

Use it ONLY when the user explicitly asks for editable rule copies, or to check/refresh ones
they adopted earlier. Never run it as a side effect of other work — writing into a user's
config is a deliberate, user-initiated act.

## The contract (do not violate)

- **Opt-in, explicit only.** Write files ONLY when the user asked. A first-run suggestion (from
  the plugin's `SessionStart` hook) may POINT at this skill; it must never write on its own.
- **Every written file is stamped and editable.** The first line is a banner
  (`installed from workflow-toolbox v<version> …`). The body is the user's to edit afterward.
- **Refresh is user-decided.** On re-invoke, report which copies are stale (installed version
  behind the plugin) and let the user choose to refresh — refresh overwrites, so confirm when
  the file may carry their edits. A hand-authored file with no toolbox banner is left untouched.

## How to run it

The deterministic engine is `scripts/install-rules.mjs`. Orchestrate it, do not re-implement
its version/banner logic by hand:

- **Check status (read-only, the default):** `node scripts/install-rules.mjs --check`
- **Install / refresh:** `node scripts/install-rules.mjs --install`
- **Target a specific dir:** add `--dir <rulesDir>`

**Target dir — confirm scope with the user first.** The default is the PROJECT scope,
`.claude/rules/` under the current working directory (least invasive — the rules apply only in
this project). For a machine-wide install, pass `--dir` pointing at the user's global rules dir
(their `CLAUDE_CONFIG_DIR` rules dir, typically `~/.claude/rules/`). Ask which they want before
`--install`; default to project scope when unsure.

Recommended flow:
1. Run `--check` first and show the user the status (absent / up-to-date / stale / hand-edited).
2. If they want to proceed, confirm the target scope, then run `--install`.
3. Report exactly which files were written and where.

## What gets installed

- **`wt-delegation-ladder.md`** — the delegation ladder: route each task to the lowest rung
  that fits, pin model + effort at every spawn, heavy work goes down / judgment stays up, and
  the non-delegable main-session duties (wake-ups, user-gates, memory writes, the Workflow
  tool). It is cost-model-neutral — it carries the principle, not an account-specific model
  table — and fully editable once written.

The set is intentionally small: only the genuinely cross-cutting guardrail travels as an
adopted rule. Role-specific discipline already lives inside the shipped agent definitions, and
the workflow-authoring doctrine lives in the `workflow-toolbox:workflow-composer` skill — those
are not re-installed here.

## Detecting and refreshing stale copies

`--check` parses each installed file's banner version and compares it to the running plugin's
version:

- **ABSENT** — not installed; `--install` writes it.
- **UP-TO-DATE** — installed version equals the plugin's.
- **STALE** — installed version is behind; `--install` refreshes it (overwrites — confirm if the
  user edited it).
- **hand-authored (no banner)** — a same-named file the user wrote themselves; left untouched.

## Non-goals

- It never writes without an explicit user request, and never touches anything but the managed
  rule files in the chosen rules dir.
- It does not install the role invariants (already inside the agent definitions) or the
  authoring doctrine (in `workflow-toolbox:workflow-composer`).
- It is not how you compose a pilot wave — that is the `workflow-toolbox:pilot-wave` skill.
