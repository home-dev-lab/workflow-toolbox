// changeset-gate.test.ts — mechanical same-commit gate for published packages
// (Tier-1 release-discipline gate; sibling of docs-contract.test.ts).
//
// RED when a published package's SOURCE changed since its last release without a
// pending changeset — the version-skew class (local content diverges from the
// same npm version; or local version runs ahead of npm). "Last release" is the
// commit that last wrote the package's CHANGELOG.md: under changesets discipline
// `changeset version` rewrites the changelog + bumps the version atomically, so
// that commit IS the package's release point. The working tree is compared
// against that baseline, so the gate fires PRE-commit — the same commit that
// touches the source must carry the changeset.
//
// Remedy on failure: `pnpm changeset` (from toolkit/), select the flagged
// package + bump level, describe the change; commit the `.changeset/*.md`
// alongside the source. Only widen the tracked set / ignore list for a real
// reason (a new published package gets a CHANGELOG; an unpublished public
// package is ignored until its first-publish is decided).

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  trackedPackages,
  changesetPackages,
  packagesNeedingChangeset,
  changelogRecordsVersion,
  type PackageMeta,
  type PackageChangeStatus,
} from './changeset-provenance.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CONFIG_PATH = join(REPO_ROOT, 'toolkit/.changeset/config.json')
const CHANGESET_DIR = join(REPO_ROOT, 'toolkit/.changeset')

// ---------------------------------------------------------------------------
// Unit tests — the pure logic, verifiable without a repo. These are the
// falsification locks: each asserts the gate FIRES on a violation, not just
// that it passes on the current clean tree.
// ---------------------------------------------------------------------------

describe('changeset-provenance — trackedPackages', () => {
  const metas: PackageMeta[] = [
    { name: '@wt/pub', private: false, hasChangelog: true, ignored: false },
    { name: '@wt/priv', private: true, hasChangelog: true, ignored: false },
    { name: '@wt/ignored', private: false, hasChangelog: true, ignored: true },
    { name: '@wt/no-changelog', private: false, hasChangelog: false, ignored: false },
  ]

  it('keeps only public, non-ignored, changelog-tracked packages', () => {
    expect(trackedPackages(metas)).toEqual(['@wt/pub'])
  })

  it('a public package without a CHANGELOG is not yet tracked (opt-in by adding one)', () => {
    expect(trackedPackages([metas[3]!])).toEqual([])
  })
})

describe('changeset-provenance — changesetPackages', () => {
  it('parses a single quoted bump line', () => {
    const md = "---\n'@workflow-toolbox/build': minor\n---\n\nDescription."
    expect(changesetPackages(md)).toEqual(['@workflow-toolbox/build'])
  })

  it('parses multiple lines with mixed quoting', () => {
    const md = `---\n'@workflow-toolbox/build': minor\n"@workflow-toolbox/runtime": patch\n@workflow-toolbox/std: major\n---\nx`
    expect(changesetPackages(md)).toEqual([
      '@workflow-toolbox/build',
      '@workflow-toolbox/runtime',
      '@workflow-toolbox/std',
    ])
  })

  it('returns [] for a file with no frontmatter (README) or an invalid bump', () => {
    expect(changesetPackages('# Changesets\n\nSome prose.')).toEqual([])
    expect(changesetPackages("---\n'@wt/x': wobble\n---\n")).toEqual([])
  })
})

describe('changeset-provenance — packagesNeedingChangeset (the verdict)', () => {
  const statuses: PackageChangeStatus[] = [
    { name: 'changed-no-changeset', srcChanged: true, hasPendingChangeset: false },
    { name: 'changed-with-changeset', srcChanged: true, hasPendingChangeset: true },
    { name: 'unchanged', srcChanged: false, hasPendingChangeset: false },
  ]

  it('flags exactly a changed source with no changeset (the skew class)', () => {
    expect(packagesNeedingChangeset(statuses)).toEqual(['changed-no-changeset'])
  })

  it('is empty when every changed package carries a changeset', () => {
    expect(
      packagesNeedingChangeset(statuses.filter((s) => s.name !== 'changed-no-changeset')),
    ).toEqual([])
  })
})

describe('changeset-provenance — changelogRecordsVersion', () => {
  it('matches Keep-a-Changelog and changesets heading styles', () => {
    expect(changelogRecordsVersion('## [0.3.1] - 2026-07-21\n', '0.3.1')).toBe(true)
    expect(changelogRecordsVersion('## 0.4.0\n\n### Minor Changes\n', '0.4.0')).toBe(true)
  })

  it('does not match a version that is only a prefix of a heading', () => {
    expect(changelogRecordsVersion('## [0.3.10] - x\n', '0.3.1')).toBe(false)
    expect(changelogRecordsVersion('a 0.3.1 mention mid-line\n', '0.3.1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration — the gate against the real tree. Git is used to establish each
// package's last-release baseline; if git is unavailable (shallow clone, no
// binary) the affected package is skipped LOUDLY rather than false-failing —
// the dev loop (full local clone) is the real enforcement point.
// ---------------------------------------------------------------------------

function safeGit(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function loadConfig(): { ignore: string[] } {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { ignore?: string[] }
  return { ignore: raw.ignore ?? [] }
}

/**
 * Repo-relative dirs of every pnpm workspace member, resolved from
 * toolkit/pnpm-workspace.yaml `packages:` globs (`packages/*` + the literal
 * `examples`). Parsed rather than hardcoded so a workspace-layout change surfaces
 * here instead of silently narrowing the ignore-hygiene set.
 */
function workspaceMemberDirs(): string[] {
  const yaml = readFileSync(join(REPO_ROOT, 'toolkit/pnpm-workspace.yaml'), 'utf8')
  const block = yaml.match(/^packages:\s*\n((?:[ \t]+-[ \t]+.*\n?)+)/m)
  const globs: string[] = []
  for (const m of (block?.[1] ?? '').matchAll(/-[ \t]+'?([^'\n]+?)'?[ \t]*$/gm)) {
    if (m[1]) globs.push(m[1].trim())
  }
  const dirs: string[] = []
  for (const g of globs) {
    if (g.endsWith('/*')) {
      const baseRel = join('toolkit', g.slice(0, -2))
      const baseAbs = join(REPO_ROOT, baseRel)
      if (!existsSync(baseAbs)) continue
      for (const e of readdirSync(baseAbs, { withFileTypes: true })) {
        if (e.isDirectory()) dirs.push(join(baseRel, e.name))
      }
    } else {
      dirs.push(join('toolkit', g))
    }
  }
  return dirs
}

function readMetas(): { metas: PackageMeta[]; dirs: Map<string, string>; versions: Map<string, string> } {
  const ignore = new Set(loadConfig().ignore)
  const metas: PackageMeta[] = []
  const dirs = new Map<string, string>()
  const versions = new Map<string, string>()
  for (const relDir of workspaceMemberDirs()) {
    const pjPath = join(REPO_ROOT, relDir, 'package.json')
    if (!existsSync(pjPath)) continue
    const pj = JSON.parse(readFileSync(pjPath, 'utf8')) as { name: string; private?: boolean; version: string }
    metas.push({
      name: pj.name,
      private: pj.private === true,
      hasChangelog: existsSync(join(REPO_ROOT, relDir, 'CHANGELOG.md')),
      ignored: ignore.has(pj.name),
    })
    dirs.set(pj.name, relDir)
    versions.set(pj.name, pj.version)
  }
  return { metas, dirs, versions }
}

/** Package names bumped by any pending changeset in .changeset/ (excl README). */
function pendingBumps(): Set<string> {
  const bumped = new Set<string>()
  if (!existsSync(CHANGESET_DIR)) return bumped
  for (const f of readdirSync(CHANGESET_DIR)) {
    if (!f.endsWith('.md') || f === 'README.md') continue
    for (const name of changesetPackages(readFileSync(join(CHANGESET_DIR, f), 'utf8'))) bumped.add(name)
  }
  return bumped
}

describe('changeset gate — real tree', () => {
  const { metas, dirs, versions } = readMetas()
  const tracked = trackedPackages(metas)
  const bumped = pendingBumps()

  it('the changeset config + tracking anchor are intact', () => {
    expect(existsSync(CONFIG_PATH), 'toolkit/.changeset/config.json missing').toBe(true)
    // The published set is runtime/patterns/build/pipeline-spec/std (comm is
    // ignored until its first publish). Falling to 0 means the enumeration
    // anchor moved, not a normal change.
    expect(tracked.length, `tracked published packages: ${tracked.join(', ')}`).toBeGreaterThanOrEqual(5)
  })

  it('every ignored entry names a real workspace package (no stale exemptions)', () => {
    const names = new Set(metas.map((m) => m.name))
    const dead = loadConfig().ignore.filter((n) => !names.has(n))
    expect(dead, `stale ignore entries (package gone?): ${dead.join(', ')}`).toEqual([])
  })

  // The core gate: no tracked package's source changed since its last release
  // without a changeset. Baseline = the commit that last wrote its CHANGELOG.
  it('no published source changed since its last release without a changeset', () => {
    const statuses: PackageChangeStatus[] = []
    const skipped: string[] = []
    for (const name of tracked) {
      const dir = dirs.get(name)!
      const changelogRel = `${dir}/CHANGELOG.md`
      const srcRel = `${dir}/src`
      const baseline = safeGit(['log', '-n1', '--format=%H', '--', changelogRel])
      if (baseline === null || baseline === '') {
        // No committed CHANGELOG yet (brand-new, uncommitted) or git
        // unavailable — cannot establish a "since last release" baseline.
        skipped.push(name)
        continue
      }
      const diff = safeGit(['diff', '--name-only', baseline, '--', srcRel])
      const untracked = safeGit(['ls-files', '--others', '--exclude-standard', '--', srcRel])
      if (diff === null || untracked === null) {
        skipped.push(name)
        continue
      }
      const srcChanged = diff !== '' || untracked !== ''
      statuses.push({ name, srcChanged, hasPendingChangeset: bumped.has(name) })
    }
    if (skipped.length > 0) {
      // Loud, not silent: a skipped package is unverified this run.
      console.warn(`[changeset-gate] baseline undeterminable, skipped: ${skipped.join(', ')}`)
    }
    const needing = packagesNeedingChangeset(statuses)
    expect(
      needing,
      `\npublished source changed since last release WITHOUT a changeset: ${needing.join(', ')}\n` +
        `→ run \`pnpm changeset\` from toolkit/ and commit the changeset with the source.\n`,
    ).toEqual([])
  })

  // Complementary version-skew closer (fs only, deterministic): a tracked
  // package's current version must be a released heading in its CHANGELOG, OR
  // be covered by a pending changeset (about to be released). A version present
  // in neither is a manual bump that skipped the changeset flow.
  it('every published version is recorded in its changelog or has a pending changeset', () => {
    const skew: string[] = []
    for (const name of tracked) {
      const dir = dirs.get(name)!
      const version = versions.get(name)!
      const changelog = readFileSync(join(REPO_ROOT, dir, 'CHANGELOG.md'), 'utf8')
      if (!changelogRecordsVersion(changelog, version) && !bumped.has(name)) {
        skew.push(`${name}@${version}`)
      }
    }
    expect(
      skew,
      `\nversions absent from their changelog and from any pending changeset: ${skew.join(', ')}\n`,
    ).toEqual([])
  })
})
