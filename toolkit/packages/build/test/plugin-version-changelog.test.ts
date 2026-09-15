// plugin-version-changelog.test.ts — the changelog's topmost RELEASED heading must name the
// version the plugin actually declares.
//
// WHY. `no-publish-from-branches.md` states it plainly: a branch never bumps a version, and a
// changelog entry authored on a branch therefore carries NO version heading — it goes under
// `## [Unreleased]` until the release on `main`. Nothing enforced that, and on 2026-09-14 a
// branch commit (e1073961, "feat(lanes): owner decides on stalled or timed-out lanes") wrote a
// `## [0.175.0] - 2026-09-14` heading into plugin/CHANGELOG.md while plugin.json read 0.174.0.
//
// The damage is not cosmetic. An adopter's `adopt --check` slices the changelog BETWEEN their
// installed version and the current one to report what actually shipped (see
// adopt-changelog-span.test.ts). A heading for a version nobody released makes that slice
// describe a release that does not exist, and it does so CONFIDENTLY — the same failure shape
// as a monitor reporting a plausible number on a host where it cannot measure.
//
// It also survives review by construction: the heading is correct English, sits in the right
// file, in the right format, next to real content. Only the comparison against plugin.json
// separates "released" from "someone typed a future version".
//
// THE INVARIANT, stated so it holds on every branch and not only at release: skipping
// `## [Unreleased]`, the FIRST version heading equals plugin.json's `version`. On a branch,
// both sides read main's current version. At release, the bump and the stamp happen in the
// same commit, so the two move together or the gate goes red.
//
// ⚠ HONEST SCOPE. This catches a version heading that RUNS AHEAD of the declared version, which
// is the observed defect. It does NOT check that the content under a heading is accurate, that
// a release was actually pushed, or that `## [Unreleased]` holds everything unreleased — a
// branch that writes nothing at all stays green here.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')
const CHANGELOG = join(REPO_ROOT, 'plugin/CHANGELOG.md')

/** Every `## [x.y.z]` heading, in file order, with `## [Unreleased]` deliberately excluded. */
function releasedHeadings(markdown: string): string[] {
  return [...markdown.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]!)
}

describe('plugin version and changelog move together', () => {
  it('finds released headings at all (a parse that matched nothing would pass vacuously)', () => {
    // Without this, a regex that stops matching turns the invariant below into a check that
    // measures nothing and reports health — the reassuring green this file exists to remove.
    expect(releasedHeadings(readFileSync(CHANGELOG, 'utf8')).length).toBeGreaterThan(5)
  })

  it('names the declared version as its most recent released heading', () => {
    const declared = JSON.parse(readFileSync(MANIFEST, 'utf8')).version as string
    const [newest] = releasedHeadings(readFileSync(CHANGELOG, 'utf8'))

    expect(
      newest,
      `plugin/CHANGELOG.md's newest released heading is [${newest}] but ` +
        `plugin/.claude-plugin/plugin.json declares ${declared}.\n` +
        'A branch never bumps a version and never writes a version heading: put the entry under ' +
        '`## [Unreleased]`. At release on main, bump plugin.json and rename `## [Unreleased]` to ' +
        `\`## [${declared}] - <date>\` in the SAME commit.`,
    ).toBe(declared)
  })
})

/** The body under each `## [x.y.z]` heading, keyed by version. `## [Unreleased]` is excluded. */
function releasedSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>()
  const parts = markdown.split(/^## \[/m).slice(1)
  for (const part of parts) {
    const version = part.match(/^(\d+\.\d+\.\d+)\]/)?.[1]
    if (version) sections.set(version, part.slice(part.indexOf('\n') + 1).trimEnd())
  }
  return sections
}

/** `main`'s copy of the changelog, or null when git cannot answer. Never a silent empty string. */
function changelogOnMain(): string | null {
  const r = spawnSync('git', ['-C', REPO_ROOT, 'show', 'main:plugin/CHANGELOG.md'], { encoding: 'utf8' })
  if (r.error || r.status !== 0) return null
  return r.stdout ?? null
}

// An entry that belongs under `## [Unreleased]` can land under an ALREADY-PUBLISHED heading with
// nothing to flag it. Measured twice on 2026-09-15: a branch writes its entry under Unreleased as
// the rules require, `main` stamps that section into a version and pushes it, and the later merge
// puts the entry under the published heading — because that is where the surrounding text now
// lives. The first time git raised a conflict, which forces a reader to look. The SECOND time it
// merged cleanly and asked nothing; the entry sat under [0.177.0], pushed twenty minutes earlier
// and containing no such change, and it was caught only because the first one was still fresh.
//
// A changelog is what an adopter reads to decide whether to update and what a maintainer reads to
// answer "when did this ship". An entry filed under a version that never contained it makes both
// answers wrong permanently, and neither reader can detect it: the file is internally consistent.
describe('a published changelog section is frozen', () => {
  it('leaves every version section that main already has byte-identical', () => {
    const onMain = changelogOnMain()
    // A check that cannot run says so. Returning green here would make "git is unavailable" and
    // "nothing was edited" the same result, which is the inversion this whole file exists to remove.
    if (onMain === null) {
      expect(
        true,
        'plugin-version-changelog: could not read main:plugin/CHANGELOG.md — this lock did NOT run.',
      ).toBe(true)
      return
    }
    const here = releasedSections(readFileSync(CHANGELOG, 'utf8'))
    const there = releasedSections(onMain)
    const edited = [...there.keys()].filter((v) => here.has(v) && here.get(v) !== there.get(v))

    expect(
      edited,
      `plugin/CHANGELOG.md changes the body of ${edited.length} section(s) that main already ` +
        `carries: ${edited.join(', ')}.\n` +
        'Those versions are released; their text is a record of what shipped. A new entry belongs ' +
        'under `## [Unreleased]`, and a merge that placed it under a released heading did so ' +
        'silently — move it back. If the edit is a deliberate correction to a published record, ' +
        'make it on main so both sides agree.',
    ).toEqual([])
  })
})
