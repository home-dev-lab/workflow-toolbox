# workflow-toolbox bundled rules

This directory is the single source of the **rule files** that the
`workflow-toolbox:adopt-rules` skill installs as editable copies into a user's
config (the `rules` set — the mirror of the `agents` set, which is sourced from
`../agents/`).

Each `*.md` file here is a **pure directive**: a project-agnostic, machine-free
guardrail that states what to do and the invariant that makes it right, with no
environment-specific narrative (no dates, no repo/agent names, no account model
tables). The rationale, calibration anchors, and field cases that justify a rule
live elsewhere (in the operator's own notes), never in the shipped file.

`README.md` is documentation, not a managed rule — the installer discovers every
`*.md` in this directory **except this file** and manages each one under a
versioned, fingerprinted banner so a later `--check` can tell an adopted copy is
behind the plugin (and `--install` refreshes only unedited copies).

To adopt these as editable rules, run the `workflow-toolbox:adopt-rules` skill:

```bash
node scripts/install-rules.mjs --set rules --check     # report status, write nothing
node scripts/install-rules.mjs --set rules --install   # write absent + refresh unedited copies
```

If a target `<config-dir>/rules/<name>.md` is a **symlink** (for example a config
dir whose rules are symlinked from another one), the installer never writes
through it: it reports the symlink and leaves it untouched unless you pass
`--replace-symlinks`, which replaces the link with a managed copy in place.
