// changelog.test.ts — unit tests for the PURE changelog-inspection logic of the
// upgrade canary (Phase B). No I/O: the fs reader lives in changelog-source.ts
// (impure, out of `pnpm test`). The fixture mirrors the REAL Claude Code changelog
// shape — `## x.y.z` headings newest-first, `- ` bullets, a `# Changelog` header,
// intro prose, and a deliberate GAP (2.1.164 is absent, exactly like upstream).

import { describe, expect, it } from 'vitest'
import { buildChangelogReport, extractEntries, highlightRelevant, parseChangelog } from '../src/changelog.js'

const CHANGELOG = `# Claude Code Changelog

> Some intro prose that is not a version heading.

---

## 2.1.168

- Workflow tool now supports nested pipelines
- Bug fixes

## 2.1.167

- Bug fixes and reliability improvements

## 2.1.166

- Added \`fallbackModel\` setting
- Hardened agent cross-session messaging
- Fixed a rendering glitch

## 2.1.165

- Improved SDK streaming throughput
- Misc cleanup

## 2.1.163

- Unrelated UI tweak only
`

describe('parseChangelog', () => {
  it('parses every clean `## x.y.z` heading in file order, ignoring prose and `# Changelog`', () => {
    const entries = parseChangelog(CHANGELOG)
    expect(entries.map((e) => e.version)).toEqual(['2.1.168', '2.1.167', '2.1.166', '2.1.165', '2.1.163'])
  })

  it('captures bullet lines without the `- ` prefix', () => {
    const entries = parseChangelog(CHANGELOG)
    const v167 = entries.find((e) => e.version === '2.1.167')
    expect(v167?.lines).toEqual(['Bug fixes and reliability improvements'])
    const v166 = entries.find((e) => e.version === '2.1.166')
    expect(v166?.lines).toHaveLength(3)
    expect(v166?.lines[1]).toBe('Hardened agent cross-session messaging')
  })

  it('never throws on garbage or empty input', () => {
    expect(parseChangelog('')).toEqual([])
    expect(parseChangelog('no headings here\njust\nlines')).toEqual([])
    expect(parseChangelog('## not.a.version\n## 1.2\n# Changelog')).toEqual([])
  })
})

describe('extractEntries (half-open range, single decision table)', () => {
  it('returns the half-open range (from, to]: excludes from, includes to', () => {
    const v = extractEntries(CHANGELOG, '2.1.165', '2.1.168').map((e) => e.version)
    expect(v).toEqual(['2.1.168', '2.1.167', '2.1.166']) // 165 excluded, 163 below range
  })

  it('handles a `from` that is a GAP version absent from the changelog (the common case)', () => {
    // 2.1.164 was never published; numeric > 164 still includes 165..167.
    const v = extractEntries(CHANGELOG, '2.1.164', '2.1.167').map((e) => e.version)
    expect(v).toEqual(['2.1.167', '2.1.166', '2.1.165'])
  })

  it('first run (from null) returns ONLY the entry equal to `to`, never the whole history', () => {
    const v = extractEntries(CHANGELOG, null, '2.1.166').map((e) => e.version)
    expect(v).toEqual(['2.1.166'])
  })

  it('first run with a `to` absent from the changelog returns nothing', () => {
    expect(extractEntries(CHANGELOG, null, '2.1.200')).toEqual([])
  })

  it('returns [] when `to` is null (current version unknowable)', () => {
    expect(extractEntries(CHANGELOG, '2.1.165', null)).toEqual([])
  })

  it('returns [] when from == to (no move)', () => {
    expect(extractEntries(CHANGELOG, '2.1.167', '2.1.167')).toEqual([])
  })

  it('returns [] on a downgrade (from > to)', () => {
    expect(extractEntries(CHANGELOG, '2.1.168', '2.1.166')).toEqual([])
  })

  it('tolerates a stale mirror: `to` ahead of the newest entry returns present entries in range', () => {
    const v = extractEntries(CHANGELOG, '2.1.167', '2.1.200').map((e) => e.version)
    expect(v).toEqual(['2.1.168']) // only present entry strictly above 167
  })

  it('never throws on garbage md', () => {
    expect(extractEntries('garbage', '2.1.165', '2.1.168')).toEqual([])
  })
})

describe('highlightRelevant', () => {
  it('keeps only lines matching workflow/agent/tool/sdk and drops entries with none', () => {
    const entries = parseChangelog(CHANGELOG)
    const hl = highlightRelevant(entries)
    const byVer = new Map(hl.map((h) => [h.version, h.lines]))
    expect(byVer.get('2.1.168')).toEqual(['Workflow tool now supports nested pipelines'])
    expect(byVer.get('2.1.166')).toEqual(['Hardened agent cross-session messaging'])
    expect(byVer.get('2.1.165')).toEqual(['Improved SDK streaming throughput'])
    // 2.1.167 ("Bug fixes...") and 2.1.163 ("Unrelated UI tweak") have no relevant line.
    expect(byVer.has('2.1.167')).toBe(false)
    expect(byVer.has('2.1.163')).toBe(false)
  })

  it('matches case-insensitively', () => {
    const hl = highlightRelevant([{ version: '9.9.9', lines: ['WORKFLOW rework', 'unrelated'] }])
    expect(hl).toEqual([{ version: '9.9.9', lines: ['WORKFLOW rework'] }])
  })

  it('returns [] for entries with no relevant lines', () => {
    expect(highlightRelevant([{ version: '1.0.0', lines: ['cosmetic fix', 'docs'] }])).toEqual([])
  })
})

describe('buildChangelogReport (status decision table)', () => {
  it('status "no-source" when md is null (mirror absent), without throwing', () => {
    const r = buildChangelogReport(null, '2.1.166', '2.1.168')
    expect(r.status).toBe('no-source')
    expect(r.relevant).toEqual([])
  })

  it('status "unknown-version" when the measured `to` is null', () => {
    expect(buildChangelogReport(CHANGELOG, '2.1.166', null).status).toBe('unknown-version')
  })

  it('status "first-run" when there is no prior version', () => {
    const r = buildChangelogReport(CHANGELOG, null, '2.1.166')
    expect(r.status).toBe('first-run')
    // 2.1.166 carries one relevant (agent) line; the other two are counted as "other".
    expect(r.relevant.map((h) => h.version)).toEqual(['2.1.166'])
    expect(r.otherCount).toBe(0) // single entry, and it IS relevant → no remainder
  })

  it('status "no-move" when from == to', () => {
    expect(buildChangelogReport(CHANGELOG, '2.1.167', '2.1.167').status).toBe('no-move')
  })

  it('status "downgrade" when from > to', () => {
    expect(buildChangelogReport(CHANGELOG, '2.1.168', '2.1.166').status).toBe('downgrade')
  })

  it('status "shown" with relevant highlights + an other-count on a forward move', () => {
    const r = buildChangelogReport(CHANGELOG, '2.1.165', '2.1.168')
    expect(r.status).toBe('shown')
    // range = [168, 167, 166]; relevant = [168, 166]; 167 ("Bug fixes") is the remainder.
    expect(r.relevant.map((h) => h.version)).toEqual(['2.1.168', '2.1.166'])
    expect(r.otherCount).toBe(1)
  })

  it('normalizes noisy version strings before comparing', () => {
    const r = buildChangelogReport(CHANGELOG, '2.1.165 (Claude Code)', '2.1.168\n')
    expect(r.status).toBe('shown')
    expect(r.from).toBe('2.1.165')
    expect(r.to).toBe('2.1.168')
  })
})
