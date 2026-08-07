// plugin-changelog-gate.test.ts — mechanical same-heading gate for the plugin's
// OWN version, distinct from changeset-gate.test.ts (which tracks the published
// npm packages under toolkit/packages/*, never plugin/.claude-plugin/plugin.json).
//
// Closes a measured drift: plugin.json reached 0.127.0 while the changelog's
// highest RELEASED heading stayed at 0.67.0 — roughly sixty version bumps with
// no matching `## [x.y.z]` heading, silently. The consequence is not cosmetic:
// `adopt --check` diffs an adopting project's stale version against the current
// one and slices CHANGELOG.md between them to show what changed. Over a range
// with no headings that slice is empty, and an empty slice reads as "nothing
// changed" at exactly the moment many versions of change went past.
//
// The invariant is deliberately narrow: the CURRENT plugin.json version must
// have a matching released heading in plugin/CHANGELOG.md. It does NOT require
// every heading to have a version (older releases are untouched history), and
// it does NOT fire on an `## [Unreleased]` section — that heading has no
// version token, so the version-anchored regex below never matches it; a
// version being merely PRESENT under an unrelated heading (mid-prose mention,
// a changelog entry for a different package) is likewise not what this checks —
// only a heading of the exact form `## [x.y.z]` / `## x.y.z` counts, matching
// changeset-provenance.ts's changelogRecordsVersion so both gates share one
// definition of "recorded".
//
// A version bump landing in the SAME commit as its changelog entry (the normal
// release flow here) passes: the gate reads the working tree as it stands, not
// a git baseline, so both files being present together is the expected case.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { changelogRecordsVersion } from './changeset-provenance.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGIN_JSON_PATH = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')
const CHANGELOG_PATH = join(REPO_ROOT, 'plugin/CHANGELOG.md')

describe('plugin changelog gate — plugin.json version has a matching CHANGELOG heading', () => {
  it('the current plugin.json version is recorded as a released heading', () => {
    const pluginJson = JSON.parse(readFileSync(PLUGIN_JSON_PATH, 'utf8')) as { version: string }
    const version = pluginJson.version
    const changelog = readFileSync(CHANGELOG_PATH, 'utf8')
    expect(
      changelogRecordsVersion(changelog, version),
      `\nplugin/.claude-plugin/plugin.json is at ${version}, but plugin/CHANGELOG.md has no ` +
        `matching "## [${version}]" heading.\n` +
        `→ add a changelog entry for ${version} in the same commit as the version bump.\n`,
    ).toBe(true)
  })

  // Falsification lock: an `## [Unreleased]` section (no version token) must
  // never be mistaken for a released heading recording some other version.
  it('an Unreleased section does not satisfy a real version', () => {
    const changelog = '## [Unreleased]\n\nsome pending notes\n'
    expect(changelogRecordsVersion(changelog, '9.9.9')).toBe(false)
  })

  // Falsification lock: an OLDER release heading present in the changelog does
  // not exempt the CURRENT version from needing its own heading — the check is
  // one-directional (current version → heading present), never the reverse.
  it('an older recorded version does not satisfy the current one', () => {
    const changelog = '## [1.0.0] - 2026-01-01\n\nold notes\n'
    expect(changelogRecordsVersion(changelog, '2.0.0')).toBe(false)
  })
})
