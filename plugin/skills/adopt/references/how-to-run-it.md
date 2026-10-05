This reference belongs to the adopt skill; all paths are relative to the skill directory (the parent of references/).

## How to run it

The deterministic engine is `scripts/install.mjs`. Orchestrate it, do not re-implement
its version/banner logic by hand. `--set` picks which managed set (default `rules` for
backward compatibility):

When adopting into a project that already has rules, reconcile first — see the
"Reconciling your existing project rules" section in `../../rules/README.md`.

- **Check status (read-only, the default):** `node scripts/install.mjs --set <rules|agents|autonomy|all> --check`
- **Inspect an edited copy (read-only):** `node scripts/install.mjs --set <set> --diff <file> --dir <found-directory>`
  prints the journalled text as adopted, the local text, and the currently shipped text.
- **Install / refresh (absent + unedited only):** `node scripts/install.mjs --set <rules|agents|autonomy|all> --install`
- **Overwrite a locally-edited copy (deliberate):** add `--force` to `--install`
- **Adopt scripts ahead of the installed plugin (deliberate):** `--install` refuses a `scripts` set
  whose source is newer than, or at the same version but with different libraries from, any
  plugin root the adopted scripts load at run time, and prints the commands that clear it. Add
  `--allow-ahead` only when you develop the scripts and the plugin together; each banner then
  records the installed version it was adopted against. The other sets are not checked.
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
- **Audit overlap (read-only):** `node scripts/install.mjs --audit-overlap --user-dir <dir>`
  compares the user rules directory mechanically with the plugin's shipped rules bundle.
  Use `--pairs-file <path>` to provide an editable JSON array of user/shipped basename pairs
  (otherwise the bundled `scripts/rule-pairs.json` is used), and `--declarations-file <path>` to
  provide an editable JSON array of author-declared ship statuses (otherwise the bundled
  `scripts/ship-declarations.json` is used). A concern permanently excluded from
  the swap by policy (its shipped counterpart is never meant to be installed for it — e.g. a
  machine-specific rule that will never converge with a generic shipped one) should NOT be a
  declared pair at all: leave it out so it reports as `UNMAPPED` like any other machine-only
  rule, rather than as permanent, noisy `DRIFT`. It reports `DUPLICATE` when both
  layers contain a paired file, `DRIFT` for user lines absent from the shipped file,
  `CLEAN` when no such difference is found, and `ABSENT` when a declared user file is not
  present. In the declarations file, `private` stays silent and counts as declared-private,
  `undecided` reports a non-gating `UNDECIDED`, and `shipped-as` requires a `target` basename
  under `plugin/rules/` and stays silent only while that shipped target exists (otherwise it is
  a gating `DECLARATION-ERROR`). It also reports unpaired Markdown files as `UNMAPPED`; none of
  these findings is auto-classified or auto-ported. This deliberately NEVER guesses a private
  file's status from its prose: an undeclared file behaves exactly as before (`UNMAPPED`,
  non-gating), and `undecided` does not gate — only a broken `shipped-as` declaration does. A
  pair marked `"partial": true` in the pairs file (a
  deliberate, bounded, accepted overlap — e.g. machine bindings that intentionally coexist
  with their generic shipped counterpart) reports `DUPLICATE`/`DRIFT` informationally instead of
  as a failing finding. The command exits 1 when any non-partial `DUPLICATE` or `DRIFT` is
  found, when a shipped rule has no pairing entry (`UNPAIRED`), when the `agents` set has a
  declared pair with no user file present (`ABSENT`), or when a `shipped-as` declaration points
  at a shipped file that does not exist (`DECLARATION-ERROR`) — 0 otherwise. `UNMAPPED` and
  `UNDECIDED` are both purely informational and never affect the exit code.

**Target dirs — confirm scope with the user first.** Each set has its own default under the
current working directory: rules → `.claude/rules/wt/`, agents → `.claude/agents/` (project
scope, least invasive — they apply only in this project). For a machine-wide RULE install,
pass `--set rules --global` and let the script resolve the config dir (rules land under
`<config dir>/rules/wt/`) — do NOT type a path yourself. Agent copies are almost always
project-scoped (the watchdog pairing is a per-project concern) — the default
`.claude/agents/` is normally right; ask before overriding it.

### Rules live under a `wt/` subfolder (card 1835727457)

Adopted rule copies default to `.claude/rules/wt/`, not the flat `.claude/rules/` root. The
boundary between "my rules" and "the plugin's adopted rules" then exists in the directory
tree itself, instead of only in the `wt-` filename prefix nothing enforced:

```
~/.claude/rules/
├── delegation-lanes.md          ← the user's own rules
├── machine-calibrations.md
└── wt/                          ← the plugin's, adopted
    ├── wt-delegation-ladder.md
    ├── wt-delegation-ladder-at-act.md
    ├── wt-sdlc.md
    ├── wt-verify-by-ground-truth-at-act.md
    └── …
```

`--dir` still targets any directory exactly, including the flat pre-migration root, for
inspection during the transition. An install aimed at a parent that already contains adopted
`wt/` files is refused rather than creating a second loaded copy.

Core and `-at-act` rule halves are both installed here. A separate on-demand engine may move
the latter using its adjacent source trigger spec; without that engine both remain static.

**During the transition, `--check` and `--audit-overlap` search BOTH locations** for the
rules set — the pre-migration flat dir and the new `wt/` default — and union the results.
Checking only the new location would read a perfectly healthy, simply-not-yet-migrated
project as "nothing adopted"; checking only the flat one would miss a project that already
migrated. A file found ONLY at the flat location reports as `MIGRATION-PENDING` under
`--check` rather than `ABSENT` — and a plain `--install` never writes a fresh copy over it
(that would create exactly the duplicate the migration exists to avoid: the same rule
loaded from two places at once). The `wt-adopt-check-hook` SessionStart hook and the
delegation-ladder injection hook apply the same dual-location search, so neither nags a
correctly-migrated project nor stays silent on an un-migrated one.

**Moving an existing flat install to `rules/wt/` is a SEPARATE, explicit step — this skill's
`--install` never does it automatically.** Preview it first, read-only:

```bash
node scripts/install.mjs --migrate --dry-run [--dir <…/rules/wt>] [--global] \
  [--secondary-dir <path-to-a-second-config-dir's-rules-dir>]
node scripts/install.mjs --migrate --execute [--dir <…/rules/wt>] [--global] \
  --secondary-dir <path-to-a-second-config-dir's-rules-dir>
```

`--migrate` without `--dry-run` or `--execute` refuses outright, on purpose. Preview first,
then use `--execute` only after the human decision to stop other sessions that might compact
mid-move and read a half-migrated directory. The dry-run writes nothing and reports, in order: (1)
every file it would move, source → destination, absolute paths; (2) every file it would
LEAVE at the root, with the reason (hand-authored, locally edited, symlinked, or a name
collision with an existing destination file); (3) the set LOADED before vs. after, in file
count and bytes, so a doubling reads as a number rather than an intuition; (4) what happens
to a second config dir's per-file symlinks, when `--secondary-dir` names one. It exits
non-zero whenever it would produce a duplicate (a file loaded from both locations at once)
— a dry-run that describes a dangerous state and exits 0 would be a report, not a guard.

`--execute --secondary-dir <dir>` performs the second-config reconciliation only after every
planned file move is byte-verified: it removes each per-file symlink in `<dir>` whose target was
one of those moved files, then creates the single **absolute** directory symlink
`<dir>/wt -> <primary>/rules/wt`. Absolute matches this machine's documented setup and makes the
link independent of the invoking cwd. It prints the removed, created/already-correct, and left
link counts; a remaining moved-file link makes the command exit non-zero with its path. Links to
hand-authored root files are untouched. Re-running it reports `directory link already correct` and
does not recreate the link. When a move is planned and `--secondary-dir` is absent, `--execute`
refuses loudly rather than silently leaving an unknowable second configuration broken; pass
`--ignore-secondary` only to acknowledge and explicitly accept that risk.

**Design decision — the second config dir's symlink arrangement.** This machine's own setup
(`~/.claude-work/rules/` symlinking each managed file individually into `~/.claude/rules/`)
predates the `wt/` subfolder and cannot survive it unchanged: a per-file symlink does not
follow a rename. The decision, made for this card and applying to any similar setup: replace
the per-file symlinks with ONE directory symlink, `<secondary>/rules/wt -> <primary>/rules/wt`.
Reason — a per-file link has to be re-created by hand every time a rule is added or removed
(a hand-placed mechanism that goes silently stale the moment someone forgets the second
half of an edit); a directory symlink covers the whole managed set at once and needs no
maintenance as it grows or shrinks. Any locally-authored, non-`wt/` rules in the secondary
dir are unaffected and stay as direct files (never covered by a directory symlink meant for
the managed subset alone). `--migrate --dry-run --secondary-dir <dir>` names each existing
per-file symlink into the migrating set and states whether it goes stale; `--migrate --execute
--secondary-dir <dir>` carries out the replacement above rather than leaving it as a manual
follow-up.

Recommended flow:
1. Run `--check` first (for the relevant set, or `--set all`) and show the user the status
   (absent / up-to-date / stale / edited / hand-authored).
2. If they want to proceed, confirm the target scope, then run `--install`.
3. Report exactly which files were written and where.

When a copy is behind, the installer also computes the changelog span between the installed and
current plugin versions: the most recent entries in that range are shown, any omitted tail is
counted as `omittedCount`, and a gap inside the version range is reported as
`missingVersionCount` rather than being read as "no changes". If the installed version predates
the oldest recorded heading, the tool reports `recorded:false` with `oldestRecordedVersion`
instead of fabricating a partial history.

