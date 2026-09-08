---
name: changelog
user-invocable: true
description: >-
  Invoke after changing plugin code or published toolkit package source, and before committing, to
  write the Unreleased changelog entry and any required changeset without exposing private tracker ids.
---

# Write release records

After a change under `plugin/` or `toolkit/packages/<package>/src`, run the deterministic
writer from the repository root before committing:

```bash
node plugin/bin/wt-changelog-entry.mjs --summary "One-line adopter-facing change" --section Added --paths "plugin/bin/example.mjs,toolkit/packages/build/src/example.ts"
```

Use exactly one of `Added`, `Changed`, or `Fixed` for `--section`. Omit `--paths` only when
the current Git working tree is the intended change set; then the writer reads `git diff --name-only HEAD`.
Use `--dry-run` to inspect the decision before it writes.

The writer places one idempotent entry under `plugin/CHANGELOG.md` `## [Unreleased]`. For each
touched public package source directory it reads `toolkit/packages/<package>/package.json`; a
package with `publishConfig` that is not `private` receives a patch changeset in
`toolkit/.changeset/`. Private or unpublished source receives no changeset.

Do not ask it to write a version heading on a branch: versions are bumped on `main` only. The
writer removes 19-digit private tracker ids from the entry text and reports that it did so; replace
an id with meaningful public wording in the summary rather than relying on removal.
