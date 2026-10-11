This reference belongs to the adopt skill. Its text moved here verbatim from that skill's SKILL.md, so every path and link in it means what it meant there: a link to another reference file resolves from the skill directory (the parent of this references/ folder), and a project or repository path keeps its own base.

## Detecting and refreshing stale copies

`--check` parses each installed file's banner version and compares it to the running plugin's
version — for both sets:

At `SessionStart`, the adopt check examines only the managed rule and agent paths in
the project and active config profile. It stays silent when every adopted copy matches. For each
differing managed copy it names `behind vX` or `ahead of vX` from the banner-version ordering;
equal-version drift is classified from the stripped copy body when one side only adds content.
If content changed in both directions, it says that direction is unknown rather than guessing.
The hook refreshes each fingerprint-proven unedited stale physical rule or agent copy through
the installer's `--install --refresh-only` path, re-checks disk, and reports one line. It never
creates absent copies or changes settings, edited bodies, edited/kept/unverified trigger heads,
or banner-line appendages. Duplicate, misplaced and unverified findings are not selected for
automatic refresh. A stale running plugin root suppresses refresh and orphan advice. A shared
eight-second budget bounds refresh starts and child timeouts; skipped or failed refreshes retain
the exact session action. `WT_ADOPT_REFRESH=notice-only` keeps the read-only notices, and
`PostToolUse` performs no refresh. For an edited copy, the session runs `--diff`, then either takes shipped text deliberately with
`--install --force --file <file>` or keeps the
edit and opens a card against the shipped rule. Successful installer writes are journalled with
file, directory, before/after versions, and the adopted shipped snapshot. A directory symlink and
its real target are one target; a second real config directory is checked and refreshed separately.

- **ABSENT** — not installed; `--install` writes it.
- **ORPHAN** — a regular adopted Markdown copy whose name is absent from a successfully read,
  non-empty shipped inventory (including registered agents, case-insensitively). The hook names
  the quoted removal command, but never deletes it. Keep a deliberate local variant if intended.
- **MIGRATED-ON-DEMAND** — a static rule absent here because it was moved into the on-demand
  directory beside this one, where it carries its own on-demand head (the status names where it was
  moved; it does not check that the engine is enabled in this profile). `--install` writes
  nothing, even with `--force`: a static copy would load it twice. Delete the on-demand copy first
  to bring it back as a static rule. When this rules directory is a link into another profile's,
  the status says the rule is migrated there but not loaded by this profile; nothing is written
  either, since the copy would land in that other profile. Only a head the rules-on-demand engine
  accepts counts (the installer asks the engine's own parser).
- **ON-DEMAND-UNVERIFIED** — the on-demand copy carries an on-demand head the installer cannot
  confirm: the engine it found rejects the head (the status gives the parser's reason and the
  engine path used), or no engine could be found or loaded (the status names the paths tried).
  The engine the session actually runs may be one the installer cannot see (a `--plugin-dir`
  copy), so a static copy could load the rule twice: the installer writes nothing, even with
  `--force`, and exits 1. Fix the head, set `WT_RULES_ON_DEMAND_ROOT` to the root of the engine
  the session runs, or delete the on-demand copy to bring the rule back as a static rule. The
  SessionStart check reports it on its own line at every session and orders no install.
- **SYMLINK** — the target is a symlink; `--install` reports it and leaves it (and its real
  target) untouched. `--install --replace-symlinks` replaces the link with a managed copy in
  place (the former target preserved).
- **UP-TO-DATE** — installed, unedited, version equals the plugin's; `--install` is a no-op
  (use `--force` to reset it to pristine).
- **STALE** — installed, unedited, version behind; `--install` refreshes it (safe — no edits to lose).
- **STALE (on-demand triggers behind the shipped spec)** — an installer-stamped head is
  behind the shipped spec; run plain `--install` to refresh the head, even if the body is
  edited or ahead. A head-only write keeps the body bytes and banner version unchanged.
- **EDITED (on-demand triggers unresolved)** — an edited or unverifiable head is preserved.
  Run either exact per-file `--refresh-triggers` or `--keep-triggers` command from the status.
  An accepted keep stays quiet until the shipped spec moves or the head is edited again.
- **EDITED** — installed, but the content no longer matches its stamped fingerprint (the user
  changed it); `--install` SKIPS it, `--install --force` overwrites.
- **hand-authored / pre-fingerprint banner** — a same-named file with no toolbox banner (never
  overwritten, even with `--force` — this protects a user's own `pilot.md` and any copy they
  made by hand before this skill existed; to bring such a copy under management, remove it and
  re-run `--install`), or an older managed banner with no fingerprint (treated as
  possibly-edited: skipped unless `--force`).

## Refresh-only safety and publication

`--install --refresh-only` writes only a managed copy classified as clean at the writer's own
decision, with no trigger state or a current/stale shipped trigger head. Absent, symlinked,
hand-authored, edited and unverified copies are skipped, as are locally kept heads. Settings,
settings backups and settings traces are skipped entirely. Do not combine it with `--force`,
`--refresh-triggers`, `--keep-triggers` or `--replace-symlinks`.

**Known fingerprint blind spot in normal install:** the banner line is stripped in full before
hashing. Text appended after its closing marker reads as clean and a normal refresh can overwrite
it without `--force`. Editing the body is detected. Refresh-only additionally refuses any text
after the first banner terminator, including an appendage ending in another closing marker.

Managed writes use an exclusive, unique temp in the target directory and rename it over the
target, preserving permission bits best-effort. Refresh-only checks the classified bytes again
immediately before rename. Concurrent refreshes publish complete files; a user edit in the
remaining check-to-rename window is still a risk. Rename breaks hard links and does not preserve
all extended metadata. A refused rename keeps the original copy; ordinary failure paths remove
the owned temp. A hard kill can leave a non-Markdown dot-temp for manual cleanup.
