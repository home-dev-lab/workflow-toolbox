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
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

/** Preserve the heading, line endings and trailing whitespace, up to the next level-two heading. */
function releasedByteBlocks(bytes: Buffer): { version: string; bytes: Buffer }[] {
  // Latin-1 gives one character per byte, so UTF-8 prose cannot shift the slice offsets.
  const headings = [...bytes.toString('latin1').matchAll(/^## [^\r\n]*/gm)]
  return headings.flatMap((heading, index) => {
    const version = heading[0].match(/^## \[(\d+\.\d+\.\d+)\](?:[ \t]|$)/)?.[1]
    if (!version) return []
    return [{ version, bytes: bytes.subarray(heading.index, headings[index + 1]?.index ?? bytes.length) }]
  })
}

function changelogGit(args: string[], root = REPO_ROOT) {
  // No shell, checkout or fetching: absent local history is explicitly unverified.
  return spawnSync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  })
}

type ByteBlock = ReturnType<typeof releasedByteBlocks>[number]
type ReleasedEdit = { tagSha256: string; currentSha256: string; reason: string }
type ReleasedEdits = ReadonlyMap<string, ReleasedEdit>

// These are exact historical corrections, not permission to edit either version again.
// Pin the historical side by digest only: it can contain text deliberately removed from publication.
const RELEASED_EDITS: ReleasedEdits = new Map([
  ['0.171.0', {
    tagSha256: 'f246abf9a527646b8a32a4b64c112bf43588e4b7f5bcf5ae78b5914160b81d5f',
    currentSha256: 'e7e10f7ab897a0c5dcd8d38faad0e76c18506bb4ea7ca7f57288b2936ef815a2',
    reason: 'Historical whitespace cleanup removed exactly seven empty lines from the released block.',
  }],
  ['0.174.0', {
    tagSha256: '877f285e2b1e9a04bbd0707b60f8a0a0064d486d3702c9f209d9ace8c2a2e6e2',
    currentSha256: '966727fae9119a730e98b4da7d2be6d6ba974016bd090af65c2ee3eae3978809',
    reason: 'A deliberate correction removed a private default and documented the empty default.',
  }],
])

function blockSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Check the current half even without local tags, so removed versions and stale pins fail. */
function releasedEditIssue(version: string, edit: ReleasedEdit, blocks: ByteBlock[]): string | null {
  const matching = blocks.filter((block) => block.version === version)
  if (matching.length !== 1) return `Unused exception [${version}]: expected exactly one current block`
  if (!edit.reason.trim()) return `Exception [${version}] requires a reason`
  if (blockSha256(matching[0]!.bytes) !== edit.currentSha256) {
    return `Exception [${version}] does not match the current block digest`
  }
  return null
}

function releasedBlockIssue(root: string, block: ByteBlock, edits: ReleasedEdits): string | null {
  const { version, bytes } = block
  const tag = `workflow-toolbox--v${version}`
  const archived = changelogGit(['show', `refs/tags/${tag}:plugin/CHANGELOG.md`], root)
  if (archived.error || archived.status !== 0) return `Cannot read ${tag}:plugin/CHANGELOG.md`
  const matching = releasedByteBlocks(archived.stdout).filter((entry) => entry.version === version)
  if (matching.length !== 1) return `${tag} must contain exactly one [${version}] block`
  const original = matching[0]!.bytes
  const edit = edits.get(version)
  if (!edit) return bytes.equals(original) ? null : `Released changelog block [${version}] differs from ${tag}`
  if (bytes.equals(original)) return `Unused exception [${version}]: current block equals its release tag`
  const currentIssue = releasedEditIssue(version, edit, [block])
  if (currentIssue) return currentIssue
  if (blockSha256(original) !== edit.tagSha256) return `Exception [${version}] does not match the tag block digest`
  return null
}

const changelogBytes = readFileSync(CHANGELOG)
const byteBlocks = releasedByteBlocks(changelogBytes)
const tagListing = changelogGit(['for-each-ref', '--format=%(refname)', 'refs/tags/workflow-toolbox--v*'])
const localTags = new Set(tagListing.stdout?.toString('utf8').trim().split('\n'))
const unavailableGit = tagListing.error
  ? `Git unavailable (${(tagListing.error as NodeJS.ErrnoException).code ?? tagListing.error.name})`
  : tagListing.status !== 0 ? `Git tag refs unavailable (exit ${tagListing.status}, signal ${tagListing.signal})` : null

describe('released changelog blocks equal their release tags', () => {
  it('finds a byte block for every released heading', () => {
    expect(byteBlocks.map(({ version }) => version)).toEqual(releasedHeadings(changelogBytes.toString('utf8')))
  })

  for (const [version, edit] of RELEASED_EDITS) {
    it(`keeps the reasoned exception for [${version}] pinned to an existing current block`, () => {
      expect(releasedEditIssue(version, edit, byteBlocks)).toBeNull()
    })
  }

  for (const { version, bytes } of byteBlocks) {
    const tag = `workflow-toolbox--v${version}`
    it(`keeps [${version}] byte-identical to ${tag}`, (context) => {
      const reason = unavailableGit ?? (localTags.has(`refs/tags/${tag}`) ? null : 'tag unavailable locally')
      if (reason) {
        // Default reporters must show why this block was not checked, even with no tags at all.
        console.warn(`SKIP ${tag}: ${reason}`)
        context.skip(reason)
      }
      // Diagnostics contain no archived prose: a deliberate correction may have removed private text.
      expect(releasedBlockIssue(REPO_ROOT, { version, bytes }, RELEASED_EDITS),
        'Move new entries under ## [Unreleased]; only the exact reasoned corrections are permitted.',
      ).toBeNull()
    })
  }
})

const FIXTURE_VERSION = '1.2.3'
const FIXTURE_TAG = `workflow-toolbox--v${FIXTURE_VERSION}`
const FIXTURE_ARCHIVE = '# Changelog\n\n## [Unreleased]\n\n- New entry.\n\n## [1.2.3]\n\n- Original café.  \n\n'
const FIXTURE_CURRENT = FIXTURE_ARCHIVE.replace('Original café', 'Corrected café')
type ReleaseFixture = { root: string; block: ByteBlock; edits: Map<string, ReleasedEdit> }

function fixtureGit(root: string, args: string[]): void {
  const result = changelogGit([
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture.invalid', ...args,
  ], root)
  if (result.error || result.status !== 0) throw new Error(`Fixture git ${args[0]} failed`)
}

function tagFixtureChangelog(root: string, markdown: string): void {
  writeFileSync(join(root, 'plugin/CHANGELOG.md'), markdown)
  fixtureGit(root, ['add', 'plugin/CHANGELOG.md'])
  fixtureGit(root, ['commit', '--no-gpg-sign', '-m', 'Fixture release'])
  fixtureGit(root, ['tag', '-f', FIXTURE_TAG])
}

function withReleaseFixture(run: (fixture: ReleaseFixture) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'changelog-policy-'))
  try {
    mkdirSync(join(root, 'plugin'))
    fixtureGit(root, ['init', '--quiet'])
    tagFixtureChangelog(root, FIXTURE_ARCHIVE)
    writeFileSync(join(root, 'plugin/CHANGELOG.md'), FIXTURE_CURRENT)
    const block = releasedByteBlocks(readFileSync(join(root, 'plugin/CHANGELOG.md')))[0]!
    const edit = {
      tagSha256: blockSha256(releasedByteBlocks(Buffer.from(FIXTURE_ARCHIVE))[0]!.bytes),
      currentSha256: blockSha256(block.bytes),
      reason: 'Correct the fixture release wording.',
    }
    run({ root, block, edits: new Map([[FIXTURE_VERSION, edit]]) })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('released changelog exceptions against real fixture tags', () => {
  it('accepts an unchanged release without an exception', () => withReleaseFixture(({ root }) => {
    const block = releasedByteBlocks(Buffer.from(FIXTURE_ARCHIVE))[0]!
    expect(releasedBlockIssue(root, block, new Map())).toBeNull()
  }))

  it('rejects an entry moved from Unreleased into an unallowlisted release', () => withReleaseFixture(({ root }) => {
    const moved = FIXTURE_ARCHIVE.replace('- New entry.\n\n', '').replace('- Original', '- New entry.\n- Original')
    const block = releasedByteBlocks(Buffer.from(moved))[0]!
    expect(releasedBlockIssue(root, block, new Map())).toBe(
      `Released changelog block [${FIXTURE_VERSION}] differs from ${FIXTURE_TAG}`,
    )
  }))

  it('accepts only the exact pinned correction', () => withReleaseFixture(({ root, block, edits }) => {
    expect(releasedBlockIssue(root, block, edits)).toBeNull()
  }))

  it('rejects further drift of an allowlisted block', () => withReleaseFixture(({ root, block, edits }) => {
    block.bytes = Buffer.concat([block.bytes, Buffer.from('\n')])
    expect(releasedBlockIssue(root, block, edits)).toBe(
      `Exception [${FIXTURE_VERSION}] does not match the current block digest`,
    )
  }))

  it('rejects a changed tag even when the current pin still matches', () => withReleaseFixture(({ root, block, edits }) => {
    tagFixtureChangelog(root, FIXTURE_ARCHIVE.replace('Original café', 'Another release'))
    expect(releasedBlockIssue(root, block, edits)).toBe(
      `Exception [${FIXTURE_VERSION}] does not match the tag block digest`,
    )
  }))
})

describe('released changelog exception staleness', () => {
  it('rejects an exception after the drift is reverted even if its current pin is updated', () => withReleaseFixture(({ root, edits }) => {
    const block = releasedByteBlocks(Buffer.from(FIXTURE_ARCHIVE))[0]!
    edits.get(FIXTURE_VERSION)!.currentSha256 = blockSha256(block.bytes)
    expect(releasedBlockIssue(root, block, edits)).toBe(
      `Unused exception [${FIXTURE_VERSION}]: current block equals its release tag`,
    )
  }))

  it.each([['removed', 0], ['duplicated', 2]] as const)(
    'rejects an exception whose version is %s', (_label, count) => withReleaseFixture(({ block, edits }) => {
      expect(releasedEditIssue(FIXTURE_VERSION, edits.get(FIXTURE_VERSION)!, Array<ByteBlock>(count).fill(block))).toBe(
        `Unused exception [${FIXTURE_VERSION}]: expected exactly one current block`,
      )
    }),
  )

  it('rejects a stale current pin without needing the tag', () => withReleaseFixture(({ block, edits }) => {
    block.bytes = Buffer.concat([block.bytes, Buffer.from('another edit\n')])
    expect(releasedEditIssue(FIXTURE_VERSION, edits.get(FIXTURE_VERSION)!, [block])).toBe(
      `Exception [${FIXTURE_VERSION}] does not match the current block digest`,
    )
  }))

  it('requires a nonempty reason', () => withReleaseFixture(({ block, edits }) => {
    edits.get(FIXTURE_VERSION)!.reason = ' \n'
    expect(releasedEditIssue(FIXTURE_VERSION, edits.get(FIXTURE_VERSION)!, [block])).toBe(
      `Exception [${FIXTURE_VERSION}] requires a reason`,
    )
  }))
})

describe('release tag evidence is required for a comparison', () => {
  it.each([['missing', '## [9.9.9]\n'], ['duplicated', '## [1.2.3]\n## [1.2.3]\n']])(
    'rejects a %s block in the tag', (_label, markdown) => withReleaseFixture(({ root, block, edits }) => {
      tagFixtureChangelog(root, markdown)
      expect(releasedBlockIssue(root, block, edits)).toBe(`${FIXTURE_TAG} must contain exactly one [${FIXTURE_VERSION}] block`)
    }),
  )

  it('reports an unreadable tag instead of treating it as matching', () => withReleaseFixture(({ root, block, edits }) => {
    fixtureGit(root, ['tag', '-d', FIXTURE_TAG])
    expect(releasedBlockIssue(root, block, edits)).toBe(`Cannot read ${FIXTURE_TAG}:plugin/CHANGELOG.md`)
  }))
})
