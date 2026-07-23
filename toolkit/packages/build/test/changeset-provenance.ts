// changeset-provenance.ts — pure logic for the changeset same-commit gate
// (release-discipline sibling of docs-provenance / docs-contract).
//
// The gate closes the version-skew class: a published package whose SOURCE
// changed since its last release without a version-advancing changeset. At the
// next publish that produces either an immutable-tarball collision (same version
// number, different content — the 0.7.0 stale-dist incident) or a local-ahead-of
// -npm divergence (pipeline-spec 0.1.0→0.2.0). Requiring a changeset in the same
// commit as the source change makes `changeset version` always bump + changelog
// the package, so neither skew can form.
//
// This module is PURE (no fs/git). The vitest wrapper (changeset-gate.test.ts)
// feeds it the real tree + git baselines; these functions are unit-tested with
// injected inputs so the logic is verifiable without a repo.

/** Metadata for one workspace package, as read from its package.json + tree. */
export interface PackageMeta {
  /** package name, e.g. '@workflow-toolbox/build'. */
  readonly name: string
  /** package.json `private: true`. */
  readonly private: boolean
  /** a CHANGELOG.md exists next to the package.json. */
  readonly hasChangelog: boolean
  /** the name appears in the changeset config's `ignore` list. */
  readonly ignored: boolean
}

/**
 * The release-tracked set the gate enforces: public (non-private), not ignored,
 * and already changelog-tracked. A public package WITHOUT a CHANGELOG is not yet
 * under the gate — it opts in by getting a CHANGELOG.md (so a package heading
 * toward its first publish isn't force-armed for a version bump prematurely).
 */
export function trackedPackages(metas: readonly PackageMeta[]): string[] {
  return metas.filter((m) => !m.private && !m.ignored && m.hasChangelog).map((m) => m.name)
}

/**
 * Parse the package names bumped by one changeset markdown file's YAML-ish
 * frontmatter. A changeset looks like:
 *
 *   ---
 *   '@workflow-toolbox/build': minor
 *   "@workflow-toolbox/runtime": patch
 *   ---
 *   <description>
 *
 * Returns [] for a file with no frontmatter block or no valid bump lines
 * (README.md, a malformed file) — the caller need not pre-filter beyond skipping
 * the literal README.md / config.json.
 */
export function changesetPackages(md: string): string[] {
  const fmMatch = md.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fmMatch) return []
  const names: string[] = []
  for (const line of (fmMatch[1] ?? '').split('\n')) {
    // `'<name>': <bump>` | `"<name>": <bump>` | `<name>: <bump>`
    const m = line.match(/^\s*['"]?(@?[\w./-]+)['"]?\s*:\s*(major|minor|patch)\s*$/)
    if (m && m[1]) names.push(m[1])
  }
  return names
}

/** Per-package change status the gate verdict is computed from. */
export interface PackageChangeStatus {
  readonly name: string
  /** source files changed since the package's last-release baseline. */
  readonly srcChanged: boolean
  /** at least one pending changeset bumps this package. */
  readonly hasPendingChangeset: boolean
}

/**
 * The gate verdict: the tracked packages whose source changed since their last
 * release WITHOUT a pending changeset. A non-empty result is the version-skew
 * class caught before it ships — each name must gain a changeset in this commit.
 */
export function packagesNeedingChangeset(statuses: readonly PackageChangeStatus[]): string[] {
  return statuses.filter((s) => s.srcChanged && !s.hasPendingChangeset).map((s) => s.name)
}

/**
 * Whether a package's current package.json version is recorded as a released
 * heading in its CHANGELOG. Matches both Keep-a-Changelog `## [X.Y.Z]` and the
 * changesets default `## X.Y.Z`. Used by the version-consistency check: a
 * tracked package whose version is neither in its changelog NOR covered by a
 * pending changeset is a manual/skew bump.
 */
export function changelogRecordsVersion(changelog: string, version: string): boolean {
  const v = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^##\\s+\\[?${v}\\]?(?:[\\s\\]]|$)`, 'm').test(changelog)
}
