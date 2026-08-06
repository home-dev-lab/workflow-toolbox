// memory-index-check.test.ts — behavior gates for plugin/bin/wt-memory-index-check.mjs
// and plugin/bin/lib/memory-index-check-core.mjs.
//
// WHAT THIS PROTECTS (card #1833452310131377177): an auto-loaded memory
// index is silently truncated by the harness past a line count nobody sees
// a warning for. Counting index lines alone cannot tell a COMPRESSED index
// (fiches still reachable through a hub fiche's own `[[slug]]` references)
// apart from an AMPUTATED one (fiches genuinely lost) — a probe that only
// counts lines can be satisfied by DELETING entries, which is the defect
// itself. So the five cases below are the actual acceptance criterion, and
// the fourth is the one that decides the probe's worth: without it, the
// probe would reward erasure instead of catching it.
//   1. a short index, everything reachable         → silent, exit 0
//   2. a long index                                 → flagged, exit 1, exact count
//   3. an index compressed by hubs, under threshold,
//      all fiches reachable                         → silent, exit 0
//   4. fiches on disk reachable by NO path           → FLAGGED, exit 1,
//      even when the line count is low
//   5. a store with no index at all                  → silent, exit 0
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error — plain runtime .mjs helper, no .d.ts (matches the other
// plugin/bin/lib/*.mjs modules this suite drives, e.g. stale-date-guard-core.mjs)
import { checkStore } from '../../../../plugin/bin/lib/memory-index-check-core.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(REPO_ROOT, 'plugin/bin/wt-memory-index-check.mjs')

let tmpDirs: string[] = []
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'wt-memory-index-check-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  tmpDirs = []
})

function fiche(dir: string, slug: string, body: string) {
  writeFileSync(join(dir, `${slug}.md`), body)
}

function hubWithMembers(dir: string, slug: string, memberSlugs: string[], extraBody = '') {
  for (const memberSlug of memberSlugs) fiche(dir, memberSlug, `Body for ${memberSlug}.\n`)
  const memberLines = memberSlugs.map((memberSlug) => `- [[${memberSlug}]] — hook for ${memberSlug}`)
  fiche(dir, slug, `${extraBody}${memberLines.join('\n')}\n`)
}

interface Report {
  hasIndex: boolean
  threshold: number
  sizeThreshold: number
  entryLines: number
  indexBytes: number
  overThreshold: boolean
  overSizeThreshold: boolean
  diskFiches: number
  reachableFiches: number
  unreachableFiches: string[]
  retractedFiches: string[]
  danglingRefs: Array<{ from: string; target: string }>
  unresolvedCrossRefs: Array<{ from: string; target: string }>
  brokenRetractions: Array<{ from: string; target: string }>
  hubCountMismatches: Array<{ file: string; declared: number; actual: number }>
  notices: string[]
  flagged: boolean
  reasons: string[]
}

interface ExecError {
  stdout?: string
  status?: number | null
}

function runCli(dir: string, extraArgs: string[] = []) {
  let stdout = ''
  let status = 0
  try {
    stdout = execFileSync('node', [CLI, '--store', dir, '--json', ...extraArgs], { encoding: 'utf8' })
  } catch (e) {
    const err = e as ExecError
    stdout = err.stdout ?? ''
    status = err.status ?? 1
  }
  return { status, report: JSON.parse(stdout) as Report }
}

function retractionBlock(targetLine?: string) {
  const lines = ['> Retracted 2026-08-04.']
  if (targetLine !== undefined) lines.push(`> ${targetLine}`)
  return `${lines.join('\n')}\n\n`
}

describe('memory-index-check-core: reachability', () => {
  it('case 1 — short index, everything directly reachable → not flagged', () => {
    const dir = makeStore()
    fiche(dir, 'fact-a', '---\nname: fact-a\n---\nSome fact.\n')
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory index\n- [Fact A](fact-a.md) — a fact\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.hasIndex).toBe(true)
    expect(report.overThreshold).toBe(false)
    expect(report.diskFiches).toBe(1)
    expect(report.reachableFiches).toBe(1)
    expect(report.unreachableFiches).toEqual([])
    expect(report.flagged).toBe(false)
  })

  it('case 2 — a long index is flagged with the exact entry count', () => {
    const dir = makeStore()
    const lines = ['# Memory index']
    for (let i = 1; i <= 6; i++) {
      fiche(dir, `fact-${i}`, `Fact number ${i}.\n`)
      lines.push(`- [Fact ${i}](fact-${i}.md) — fact ${i}`)
    }
    writeFileSync(join(dir, 'MEMORY.md'), lines.join('\n') + '\n')
    const report = checkStore(dir, { threshold: 5 })
    expect(report.entryLines).toBe(6)
    expect(report.overThreshold).toBe(true)
    expect(report.flagged).toBe(true)
    expect(report.reasons.join(' ')).toContain('6 entry line(s), over threshold 5')
  })

  it('case 3 — index compressed by a hub, under threshold, all fiches reachable → not flagged', () => {
    const dir = makeStore()
    const memberSlugs = Array.from({ length: 20 }, (_, i) => `member-${i}`)
    for (const slug of memberSlugs) fiche(dir, slug, `Body for ${slug}.\n`)
    const hubBody = `---\nname: hub-topic\n---\n${memberSlugs.map((s) => `- [[${s}]] — hook for ${s}`).join('\n')}\n`
    fiche(dir, 'hub-topic', hubBody)
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory index\n- [Hub: topic](hub-topic.md) — 20 grouped facts\n')
    const report = checkStore(dir, { threshold: 10 }) // 1 entry line, well under threshold
    expect(report.entryLines).toBe(1)
    expect(report.overThreshold).toBe(false)
    expect(report.diskFiches).toBe(21) // 20 members + the hub itself
    expect(report.reachableFiches).toBe(21)
    expect(report.unreachableFiches).toEqual([])
    expect(report.flagged).toBe(false)
  })

  it('case 3c — few entry lines but oversized index is flagged by byte threshold', () => {
    const dir = makeStore()
    fiche(dir, 'hub-topic', '- [[member-a]] — hook\n')
    fiche(dir, 'member-a', 'Reachable.\n')
    const indexText = '# Memory index\n- [Hub: topic](hub-topic.md) — grouped facts with a long enough hook to exceed the byte ceiling\n'
    writeFileSync(join(dir, 'MEMORY.md'), indexText)
    const report = checkStore(dir, { threshold: 200, sizeThreshold: 50 })
    expect(report.entryLines).toBe(1)
    expect(report.overThreshold).toBe(false)
    expect(report.overSizeThreshold).toBe(true)
    expect(report.flagged).toBe(true)
    expect(report.reasons).toContain(`index is ${report.indexBytes} byte(s), over threshold 50`)
  })

  it('case 3d — under both thresholds reports indexBytes and stays silent', () => {
    const dir = makeStore()
    fiche(dir, 'fact-a', 'Fact.\n')
    const indexText = '# Memory index\n- [Fact A](fact-a.md) — a fact\n'
    writeFileSync(join(dir, 'MEMORY.md'), indexText)
    const report = checkStore(dir, { threshold: 200, sizeThreshold: 1000 })
    expect(report.overThreshold).toBe(false)
    expect(report.overSizeThreshold).toBe(false)
    expect(report.indexBytes).toBe(Buffer.byteLength(indexText))
    expect(report.flagged).toBe(false)
  })

  it('case 3b — a hub-of-hubs resolves transitively (two hops)', () => {
    const dir = makeStore()
    fiche(dir, 'leaf-fact', 'Deep fact.\n')
    fiche(dir, 'sub-hub', '- [[leaf-fact]] — the deep fact\n')
    fiche(dir, 'top-hub', '- [[sub-hub]] — a sub-hub\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Top hub](top-hub.md) — everything\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.diskFiches).toBe(3)
    expect(report.reachableFiches).toBe(3)
    expect(report.unreachableFiches).toEqual([])
  })

  it('a [[slug]] containing a space resolves — cross-model review finding: an earlier version enumerated a filename character class and dropped it', () => {
    const dir = makeStore()
    fiche(dir, 'topic 1', 'A fiche whose filename has a space.\n')
    fiche(dir, 'hub-topic', '- [[topic 1]] — hook with a space in the target name\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Hub](hub-topic.md) — grouped\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.unreachableFiches).toEqual([])
    expect(report.flagged).toBe(false)
  })

  it('case 4 — a fiche on disk reachable by NO path is flagged, even with a low line count', () => {
    const dir = makeStore()
    fiche(dir, 'linked-fact', 'Reachable.\n')
    fiche(dir, 'orphan-fact', 'Never linked from anywhere.\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Linked](linked-fact.md) — reachable fact\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.overThreshold).toBe(false) // line count is low
    expect(report.diskFiches).toBe(2)
    expect(report.reachableFiches).toBe(1)
    expect(report.unreachableFiches).toEqual(['orphan-fact.md'])
    expect(report.flagged).toBe(true) // decided by reachability, not line count
    expect(report.reasons.join(' ')).toContain('1 fiche(s)')
  })

  it('case 4b — deleting an index entry to shrink the count does NOT clear the flag', () => {
    // The exact failure this probe exists to reward-proof: a store that
    // "fixes" a long index by dropping lines still has the fiche on disk.
    const dir = makeStore()
    fiche(dir, 'still-here', 'Fact whose index line was deleted.\n')
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory index\n') // no entry lines at all
    const report = checkStore(dir, { threshold: 200 })
    expect(report.entryLines).toBe(0)
    expect(report.overThreshold).toBe(false)
    expect(report.unreachableFiches).toEqual(['still-here.md'])
    expect(report.flagged).toBe(true)
  })

  it('case 5 — a store with no index at all is silent, never a block', () => {
    const dir = makeStore()
    fiche(dir, 'some-note', 'A project keeping no index convention.\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.hasIndex).toBe(false)
    expect(report.flagged).toBe(false)
  })

  it('archived fiches (a subdirectory) are excluded from the reachability graph, not flagged as invisible', () => {
    const dir = makeStore()
    fiche(dir, 'live-fact', 'Still active.\n')
    mkdirSync(join(dir, 'archive'))
    writeFileSync(join(dir, 'archive', 'closed-fact.md'), 'Archived on purpose.\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Live](live-fact.md) — active fact\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.diskFiches).toBe(1) // archive/closed-fact.md not counted
    expect(report.unreachableFiches).toEqual([])
    expect(report.flagged).toBe(false)
  })

  it('a [[slug]] with uppercase characters resolves case-sensitively (not silently dropped)', () => {
    const dir = makeStore()
    fiche(dir, 'reference_payload_pipeline_commencedAt_field', 'Camel-cased slug.\n')
    fiche(dir, 'hub-topic', '- [[reference_payload_pipeline_commencedAt_field]] — a field note\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Hub](hub-topic.md) — grouped\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.unreachableFiches).toEqual([])
    expect(report.flagged).toBe(false)
  })

  it('custom --index-file is honoured', () => {
    const dir = makeStore()
    fiche(dir, 'fact-a', 'Fact.\n')
    writeFileSync(join(dir, 'INDEX.md'), '- [Fact A](fact-a.md) — a fact\n')
    const report = checkStore(dir, { threshold: 200, indexFile: 'INDEX.md' })
    expect(report.hasIndex).toBe(true)
    expect(report.reachableFiches).toBe(1)
  })

  it('an index link to a missing file is named as dangling with the index as its source', () => {
    const dir = makeStore()
    writeFileSync(join(dir, 'MEMORY.md'), '- [Missing](missing.md) — broken pointer\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.danglingRefs).toEqual([{ from: 'MEMORY.md', target: 'missing.md' }])
    expect(report.reasons.join(' ')).toContain('dangling reference')
    expect(report.reasons.join(' ')).toContain('MEMORY.md')
    expect(report.reasons.join(' ')).toContain('missing.md')
    expect(report.flagged).toBe(true)
  })

  it('a member-shaped missing [[slug]] inside a hub body is named as dangling with its source file', () => {
    const dir = makeStore()
    fiche(dir, 'hub-topic', '- [[missing]] — broken member line\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Hub](hub-topic.md) — grouped\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.danglingRefs).toEqual([{ from: 'hub-topic.md', target: 'missing.md' }])
    expect(report.unresolvedCrossRefs).toEqual([])
    expect(report.reasons.join(' ')).toContain('hub-topic.md')
    expect(report.reasons.join(' ')).toContain('missing.md')
    expect(report.flagged).toBe(true)
  })

  it('a member-shaped missing [[slug]] inside a long ordinary fiche is informational, not a finding', () => {
    const dir = makeStore()
    const proseLines = Array.from(
      { length: 12 },
      (_, i) => `Narrative line ${i} mentioning context without making this fiche a hub.`,
    )
    proseLines.push('- [[missing]] — sibling rule, same session.')
    fiche(dir, 'ordinary-fiche', `${proseLines.join('\n')}\n`)
    writeFileSync(join(dir, 'MEMORY.md'), '- [Ordinary](ordinary-fiche.md) — running narrative\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.danglingRefs).toEqual([])
    expect(report.unresolvedCrossRefs).toEqual([{ from: 'ordinary-fiche.md', target: 'missing.md' }])
    expect(report.notices).toContain(
      'informational only: 1 unresolved cross-reference(s) in non-hub bodies; see unresolvedCrossRefs for per-item detail',
    )
    expect(report.flagged).toBe(false)
  })

  it('a missing [[slug]] mentioned only in prose stays informational, not a finding', () => {
    const dir = makeStore()
    fiche(dir, 'hub-topic', 'Running prose mentions [[missing]] for later.\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Hub](hub-topic.md) — grouped\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.reachableFiches).toBe(1)
    expect(report.danglingRefs).toEqual([])
    expect(report.flagged).toBe(false)
  })

  it('a hub declaring a matching member_count is silent', () => {
    const dir = makeStore()
    hubWithMembers(dir, 'hub-topic', ['member-a', 'member-b'], '---\nmember_count: 2\n---\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Hub](hub-topic.md) — grouped\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.hubCountMismatches).toEqual([])
    expect(report.notices).not.toContain(
      'declared-count cross-check inactive: hubs exist, but none declares member_count; silence here means not measured, not verified',
    )
    expect(report.flagged).toBe(false)
  })

  it('a hub declaring member_count nested under metadata: (the real on-disk shape) is caught, not silently skipped', () => {
    // Byte-faithful to a real hub frontmatter shape observed in the field:
    // `member_count` sits two spaces under a `metadata:` key, not at column 0.
    // A regex anchored to column 0 never matches this shape, so the mismatch
    // below went undetected on every real hub carrying it.
    const dir = makeStore()
    hubWithMembers(
      dir,
      'hub-topic',
      ['member-a', 'member-b'],
      '---\nmetadata: \n  node_type: memory\n  member_count: 3\n  type: reference\n---\n',
    )
    writeFileSync(join(dir, 'MEMORY.md'), '- [Hub](hub-topic.md) — grouped\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.hubCountMismatches).toEqual([{ file: 'hub-topic.md', declared: 3, actual: 2 }])
    expect(report.flagged).toBe(true)
  })

  it('a hub declaring a mismatched member_count is named with both numbers', () => {
    const dir = makeStore()
    hubWithMembers(dir, 'hub-topic', ['member-a', 'member-b'], '---\nmember_count: 3\n---\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Hub](hub-topic.md) — grouped\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.hubCountMismatches).toEqual([{ file: 'hub-topic.md', declared: 3, actual: 2 }])
    expect(report.reasons.join(' ')).toContain('hub-topic.md')
    expect(report.reasons.join(' ')).toContain('declared 3')
    expect(report.reasons.join(' ')).toContain('actual 2')
    expect(report.flagged).toBe(true)
  })

  it('a hub declaring no member_count stays silent', () => {
    const dir = makeStore()
    hubWithMembers(dir, 'hub-topic', ['member-a', 'member-b'])
    writeFileSync(join(dir, 'MEMORY.md'), '- [Hub](hub-topic.md) — grouped\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.hubCountMismatches).toEqual([])
    expect(report.notices).toContain(
      'declared-count cross-check inactive: hubs exist, but none declares member_count; silence here means not measured, not verified',
    )
    expect(report.flagged).toBe(false)
  })

  it('multiple hubs with no member_count stay exit 0 but say the declared-count cross-check is inactive', () => {
    const dir = makeStore()
    hubWithMembers(dir, 'hub-a', ['member-a'])
    hubWithMembers(dir, 'hub-b', ['member-b'])
    writeFileSync(join(dir, 'MEMORY.md'), '- [Hub A](hub-a.md) — grouped\n- [Hub B](hub-b.md) — grouped\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.notices).toContain(
      'declared-count cross-check inactive: hubs exist, but none declares member_count; silence here means not measured, not verified',
    )
    expect(report.flagged).toBe(false)
  })
})

describe('memory-index-check-core: warning band (card follow-up — countdown before the flag)', () => {
  function indexWithNEntries(dir: string, n: number) {
    const lines = ['# Memory index']
    for (let i = 1; i <= n; i++) {
      fiche(dir, `fact-${i}`, `Fact ${i}.\n`)
      lines.push(`- [Fact ${i}](fact-${i}.md) — fact ${i}`)
    }
    writeFileSync(join(dir, 'MEMORY.md'), lines.join('\n') + '\n')
  }

  it('comfortable headroom → no band, no notice, not flagged', () => {
    const dir = makeStore()
    indexWithNEntries(dir, 5) // threshold 200, band width max(10, 30) = 30 → headroom 195, way outside
    const report = checkStore(dir, { threshold: 200 })
    expect(report.inWarningBand).toBe(false)
    expect(report.notices).toEqual([])
    expect(report.flagged).toBe(false)
  })

  it('inside the band → exit-0 shape (flagged stays false) but a countdown notice fires', () => {
    const dir = makeStore()
    // threshold 20 → band width = max(10, round(20*0.15)=3) = 10 → band starts at headroom<=10, i.e. entryLines>=10
    indexWithNEntries(dir, 12)
    const report = checkStore(dir, { threshold: 20 })
    expect(report.overThreshold).toBe(false)
    expect(report.inWarningBand).toBe(true)
    expect(report.notices).toEqual(['index headroom: 8 line(s) before the threshold of 20'])
    expect(report.flagged).toBe(false) // a notice is never a finding
  })

  it('over threshold → no band notice (the stronger over-threshold signal owns it, not both)', () => {
    const dir = makeStore()
    indexWithNEntries(dir, 25)
    const report = checkStore(dir, { threshold: 20 })
    expect(report.overThreshold).toBe(true)
    expect(report.inWarningBand).toBe(false)
    expect(report.notices).toEqual([])
    expect(report.flagged).toBe(true)
  })
})

describe('memory-index-check-core: retractions (card #1833831689994896673)', () => {
  it('TEST-LOCK: retracted note, resolving link target → silent', () => {
    const dir = makeStore()
    fiche(dir, 'replacement', 'Current truth.\n')
    fiche(dir, 'old-note', `${retractionBlock('Target: [replacement](replacement.md)')}Old content kept only for inbound links.\n`)
    writeFileSync(join(dir, 'MEMORY.md'), '- [Old](old-note.md) — retained name\n- [Replacement](replacement.md) — current truth\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.brokenRetractions).toEqual([])
    expect(report.flagged).toBe(false)
  })

  it('TEST-LOCK: retracted note, unresolvable link target → finding with both names', () => {
    const dir = makeStore()
    fiche(dir, 'old-note', `${retractionBlock('Target: [replacement](missing.md)')}Old content kept only for inbound links.\n`)
    writeFileSync(join(dir, 'MEMORY.md'), '- [Old](old-note.md) — retained name\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.brokenRetractions).toEqual([{ from: 'old-note.md', target: 'missing.md' }])
    expect(report.reasons.join(' ')).toContain('old-note.md')
    expect(report.reasons.join(' ')).toContain('missing.md')
    expect(report.flagged).toBe(true)
  })

  it('TEST-LOCK: retracted note, resolvable PATH target → silent', () => {
    const dir = makeStore()
    fiche(dir, 'replacement', 'Current truth.\n')
    fiche(dir, 'old-note', `${retractionBlock('Target: `./replacement.md`')}Old content kept only for inbound links.\n`)
    writeFileSync(join(dir, 'MEMORY.md'), '- [Old](old-note.md) — retained name\n- [Replacement](replacement.md) — current truth\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.brokenRetractions).toEqual([])
    expect(report.flagged).toBe(false)
  })

  it('TEST-LOCK: retracted note, descriptive target → silent', () => {
    const dir = makeStore()
    fiche(dir, 'old-note', `${retractionBlock('Target: replaced by a persistent monitor')}Old content kept only for inbound links.\n`)
    writeFileSync(join(dir, 'MEMORY.md'), '- [Old](old-note.md) — retained name\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.brokenRetractions).toEqual([])
    expect(report.flagged).toBe(false)
  })

  it('TEST-LOCK: retracted note with no forward pointer → silent', () => {
    const dir = makeStore()
    fiche(dir, 'old-note', `${retractionBlock()}Old content kept only for inbound links.\n`)
    writeFileSync(join(dir, 'MEMORY.md'), '- [Old](old-note.md) — retained name\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.brokenRetractions).toEqual([])
    expect(report.flagged).toBe(false)
  })

  it('TEST-LOCK card #1835690485 — a well-formed retracted fiche, deliberately DE-INDEXED (not linked from MEMORY.md), is EXEMPT from unreachableFiches: wt-memory-hygiene.md calls this intentional, the probe must agree', () => {
    const dir = makeStore()
    fiche(dir, 'replacement', 'Current truth.\n')
    fiche(dir, 'old-note', `${retractionBlock('Target: [replacement](replacement.md)')}Old content kept only for inbound links.\n`)
    // old-note.md is deliberately NOT linked from MEMORY.md or any hub —
    // the exact "kept only so old references still resolve" case.
    writeFileSync(join(dir, 'MEMORY.md'), '- [Replacement](replacement.md) — current truth\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.unreachableFiches).toEqual([])
    expect(report.retractedFiches).toEqual(['old-note.md'])
    expect(report.flagged).toBe(false)
  })

  it('TEST-LOCK card #1835690485 — a de-indexed fiche whose retraction pointer does NOT resolve earns no exemption and stays flagged unreachable, on top of the brokenRetractions finding it already produced', () => {
    const dir = makeStore()
    fiche(dir, 'old-note', `${retractionBlock('Target: [replacement](missing.md)')}Old content kept only for inbound links.\n`)
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory index\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.unreachableFiches).toEqual(['old-note.md'])
    expect(report.retractedFiches).toEqual([])
    expect(report.brokenRetractions).toEqual([{ from: 'old-note.md', target: 'missing.md' }])
    expect(report.flagged).toBe(true)
  })

  it('TEST-LOCK: ordinary note with an unresolved see-also stays informational, not a finding', () => {
    const dir = makeStore()
    fiche(
      dir,
      'ordinary-note',
      ['# Ordinary note', '', '## Retracted subsection', '', '> Retracted 2026-08-04.', '> Target: [replacement](missing.md)', '', 'Still live overall.'].join('\n'),
    )
    writeFileSync(join(dir, 'MEMORY.md'), '- [Ordinary](ordinary-note.md) — running narrative\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.brokenRetractions).toEqual([])
    expect(report.flagged).toBe(false)
  })
})

describe('memory-index-check-core: hub sizing (card follow-up — the ceiling relocates, it does not vanish)', () => {
  function makeHub(dir: string, hubSlug: string, memberCount: number) {
    const memberSlugs = Array.from({ length: memberCount }, (_, i) => `${hubSlug}-member-${i}`)
    for (const slug of memberSlugs) fiche(dir, slug, `Body for ${slug}.\n`)
    const body = `${memberSlugs.map((s) => `- [[${s}]] — hook`).join('\n')}\n`
    fiche(dir, hubSlug, body)
    writeFileSync(join(dir, 'MEMORY.md'), `# Memory index\n- [Hub](${hubSlug}.md) — grouped\n`)
    return memberSlugs
  }

  it('a flat store (no hubs) reports hubCount 0 and largestHub null', () => {
    const dir = makeStore()
    fiche(dir, 'fact-a', 'Fact.\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Fact A](fact-a.md) — a fact\n')
    const report = checkStore(dir, { threshold: 200 })
    expect(report.hubCount).toBe(0)
    expect(report.largestHub).toBeNull()
    expect(report.flagged).toBe(false)
  })

  it('a hub under hubMax is reported but not flagged', () => {
    const dir = makeStore()
    makeHub(dir, 'hub-topic', 20)
    const report = checkStore(dir, { threshold: 200, hubMax: 45 })
    expect(report.hubCount).toBe(1)
    expect(report.largestHub).toEqual({ file: 'hub-topic.md', members: 20 })
    expect(report.flagged).toBe(false)
  })

  it('a hub OVER hubMax is flagged, naming the file and its size', () => {
    const dir = makeStore()
    makeHub(dir, 'huge-hub', 50)
    const report = checkStore(dir, { threshold: 200, hubMax: 45 })
    expect(report.hubCount).toBe(1)
    expect(report.largestHub).toEqual({ file: 'huge-hub.md', members: 50 })
    expect(report.flagged).toBe(true)
    expect(report.reasons.join(' ')).toContain('huge-hub.md')
    expect(report.reasons.join(' ')).toContain('50 member(s)')
    expect(report.reasons.join(' ')).toContain('hubMax 45')
  })

  it('a NARRATIVE fiche with many inline [[links]] in prose and few list-shaped member lines is NOT counted as a hub — cross-model review finding against the real store', () => {
    const dir = makeStore()
    const neighborSlugs = Array.from({ length: 6 }, (_, i) => `neighbor-${i}`)
    for (const slug of neighborSlugs) fiche(dir, slug, `Body for ${slug}.\n`)
    // A long resume-anchor style fiche: prose paragraphs that happen to
    // cross-reference several neighbours inline, plus ONE real list item.
    // Reachability must still resolve every [[link]] (prose included) —
    // but classification must NOT call this body a hub, because it is not
    // structurally a member list.
    const proseLines = []
    for (let i = 0; i < 40; i++) {
      proseLines.push(`Some narrative paragraph mentioning [[${neighborSlugs[i % neighborSlugs.length]}]] in passing.`)
    }
    proseLines.push(`- [[${neighborSlugs[0]}]] — the only actual list item`)
    fiche(dir, 'resume-anchor', proseLines.join('\n') + '\n')
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory index\n- [Anchor](resume-anchor.md) — running narrative\n')
    const report = checkStore(dir, { threshold: 200, hubMax: 45 })
    // Reachability still resolves every mentioned neighbour.
    expect(report.unreachableFiches).toEqual([])
    // But the anchor is not classified as a hub at all.
    expect(report.hubCount).toBe(0)
    expect(report.largestHub).toBeNull()
    expect(report.flagged).toBe(false)
  })

  it('a healthy store with modest hubs and comfortable headroom stays exit 0 with the count-check inactivity notice, never flags', () => {
    const dir = makeStore()
    makeHub(dir, 'modest-hub', 5)
    const report = checkStore(dir, { threshold: 200, hubMax: 45 })
    expect(report.flagged).toBe(false)
    expect(report.notices).toEqual([
      'declared-count cross-check inactive: hubs exist, but none declares member_count; silence here means not measured, not verified',
    ])
    expect(report.inWarningBand).toBe(false)
  })
})

describe('wt-memory-index-check.mjs CLI: warning band + hub sizing exit codes and output', () => {
  it('a bad --hub-max exits 2, mirroring --threshold validation', () => {
    const dir = makeStore()
    fiche(dir, 'fact-a', 'Fact.\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Fact A](fact-a.md) — a fact\n')
    let status = 0
    let stderr = ''
    try {
      execFileSync('node', [CLI, '--store', dir, '--hub-max', '0'], { encoding: 'utf8' })
    } catch (e) {
      const err = e as ExecError & { stderr?: string }
      status = err.status ?? 1
      stderr = err.stderr ?? ''
    }
    expect(status).toBe(2)
    expect(stderr).toContain('--hub-max must be a positive number')
  })

  it('a bad --size-threshold exits 2, mirroring --threshold validation', () => {
    const dir = makeStore()
    fiche(dir, 'fact-a', 'Fact.\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Fact A](fact-a.md) — a fact\n')
    let status = 0
    let stderr = ''
    try {
      execFileSync('node', [CLI, '--store', dir, '--size-threshold', '0'], { encoding: 'utf8' })
    } catch (e) {
      const err = e as ExecError & { stderr?: string }
      status = err.status ?? 1
      stderr = err.stderr ?? ''
    }
    expect(status).toBe(2)
    expect(stderr).toContain('--size-threshold must be a positive number')
  })

  it('a flat store under threshold, comfortably clear of the band, exits 0 and includes the unresolved-cross-reference count in the summary', () => {
    const dir = makeStore()
    fiche(dir, 'fact-a', 'Fact.\n')
    const indexText = '- [Fact A](fact-a.md) — a fact\n'
    writeFileSync(join(dir, 'MEMORY.md'), indexText)
    const stdout = execFileSync('node', [CLI, '--store', dir], { encoding: 'utf8' })
    expect(stdout).toBe(
      `index: 1 entry line(s) (threshold applied: 200), ${Buffer.byteLength(indexText)} byte(s) (size threshold applied: 25000) — 1 fiche(s) on disk, 1 reachable, 0 invisible; 0 dangling; 0 unresolved cross-reference(s)\n`,
    )
  })

  it('nothing dangling: exits 0 and the summary states both emptiness conditions explicitly', () => {
    const dir = makeStore()
    fiche(dir, 'fact-a', 'Fact.\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Fact A](fact-a.md) — a fact\n')
    const { status } = runCli(dir)
    expect(status).toBe(0)
    const stdout = execFileSync('node', [CLI, '--store', dir], { encoding: 'utf8' })
    expect(stdout).toContain('0 invisible; 0 dangling')
  })

  it('a dangling reference exits 1 and the human-readable output names both source and target', () => {
    const dir = makeStore()
    fiche(dir, 'hub-topic', '- [[missing]] — broken member line\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Hub](hub-topic.md) — grouped\n')
    let status = 0
    let stdout = ''
    try {
      stdout = execFileSync('node', [CLI, '--store', dir], { encoding: 'utf8' })
    } catch (e) {
      const err = e as ExecError
      stdout = err.stdout ?? ''
      status = err.status ?? 1
    }
    expect(status).toBe(1)
    expect(stdout).toContain('0 invisible; 1 dangling')
    expect(stdout).toContain('FLAG: dangling reference from hub-topic.md to missing.md')
  })

  it('an unresolved cross-reference in a non-hub body stays exit 0, appears in the summary count, and prints only an informational pointer', () => {
    const dir = makeStore()
    const proseLines = Array.from(
      { length: 12 },
      (_, i) => `Narrative line ${i} mentioning context without making this fiche a hub.`,
    )
    proseLines.push('- [[missing]] — sibling rule, same session.')
    fiche(dir, 'ordinary-fiche', `${proseLines.join('\n')}\n`)
    writeFileSync(join(dir, 'MEMORY.md'), '- [Ordinary](ordinary-fiche.md) — running narrative\n')
    const stdout = execFileSync('node', [CLI, '--store', dir], { encoding: 'utf8' })
    expect(stdout).toContain('0 invisible; 0 dangling; 1 unresolved cross-reference(s)')
    expect(stdout).toContain(
      'informational only: 1 unresolved cross-reference(s) in non-hub bodies; see --json or --out for per-item detail',
    )
    expect(stdout).not.toContain('FLAG: dangling reference from ordinary-fiche.md to missing.md')
  })

  it('a hub count mismatch exits 1 and the human-readable output names the hub, declared count, and actual count', () => {
    const dir = makeStore()
    hubWithMembers(dir, 'hub-topic', ['member-a', 'member-b'], '---\nmember_count: 3\n---\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Hub](hub-topic.md) — grouped\n')
    let status = 0
    let stdout = ''
    try {
      stdout = execFileSync('node', [CLI, '--store', dir], { encoding: 'utf8' })
    } catch (e) {
      const err = e as ExecError
      stdout = err.stdout ?? ''
      status = err.status ?? 1
    }
    expect(status).toBe(1)
    expect(stdout).toContain('FLAG: hub hub-topic.md declared 3 member(s); actual 2')
  })

  it('inside the band: exits 0, prints a countdown line, JSON carries inWarningBand + notices', () => {
    const dir = makeStore()
    const lines = ['# Memory index']
    for (let i = 1; i <= 12; i++) {
      fiche(dir, `fact-${i}`, `Fact ${i}.\n`)
      lines.push(`- [Fact ${i}](fact-${i}.md) — fact ${i}`)
    }
    writeFileSync(join(dir, 'MEMORY.md'), lines.join('\n') + '\n')
    const { status, report } = runCli(dir, ['--threshold', '20'])
    expect(status).toBe(0)
    expect(report.flagged).toBe(false)
    expect((report as unknown as { inWarningBand: boolean }).inWarningBand).toBe(true)
    expect((report as unknown as { notices: string[] }).notices).toEqual([
      'index headroom: 8 line(s) before the threshold of 20',
    ])
    const stdout = execFileSync('node', [CLI, '--store', dir, '--threshold', '20'], { encoding: 'utf8' })
    expect(stdout).toContain('index headroom: 8 line(s) before the threshold of 20')
  })

  it('a hub over --hub-max exits 1 and names the file + size in the human-readable output', () => {
    const dir = makeStore()
    const memberSlugs = Array.from({ length: 5 }, (_, i) => `member-${i}`)
    for (const slug of memberSlugs) fiche(dir, slug, `Body for ${slug}.\n`)
    fiche(dir, 'hub-topic', memberSlugs.map((s) => `- [[${s}]] — hook`).join('\n') + '\n')
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory index\n- [Hub](hub-topic.md) — grouped\n')
    let status = 0
    let stdout = ''
    try {
      stdout = execFileSync('node', [CLI, '--store', dir, '--hub-max', '3'], { encoding: 'utf8' })
    } catch (e) {
      const err = e as ExecError
      stdout = err.stdout ?? ''
      status = err.status ?? 1
    }
    expect(status).toBe(1)
    expect(stdout).toContain('largest hub: hub-topic.md (5 member(s), hubMax 3)')
    expect(stdout).toContain('FLAG: hub hub-topic.md has 5 member(s), over hubMax 3')
  })

  it('a hub over --hub-max exits 1 (thrown form) and the JSON names the largest hub', () => {
    const dir = makeStore()
    const memberSlugs = Array.from({ length: 5 }, (_, i) => `member-${i}`)
    for (const slug of memberSlugs) fiche(dir, slug, `Body for ${slug}.\n`)
    fiche(dir, 'hub-topic', memberSlugs.map((s) => `- [[${s}]] — hook`).join('\n') + '\n')
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory index\n- [Hub](hub-topic.md) — grouped\n')
    const { status, report } = runCli(dir, ['--hub-max', '3'])
    expect(status).toBe(1)
    const r = report as unknown as { largestHub: { file: string; members: number }; hubCount: number }
    expect(r.hubCount).toBe(1)
    expect(r.largestHub).toEqual({ file: 'hub-topic.md', members: 5 })
  })
})

describe('wt-memory-index-check.mjs CLI: retraction exemption stays legible (card #1835690485)', () => {
  it('a well-formed retracted fiche is excluded from "invisible" but named in a visible notice — never a bare 0', () => {
    const dir = makeStore()
    fiche(dir, 'replacement', 'Current truth.\n')
    fiche(dir, 'old-note', `${retractionBlock('Target: [replacement](replacement.md)')}Old content kept only for inbound links.\n`)
    writeFileSync(join(dir, 'MEMORY.md'), '- [Replacement](replacement.md) — current truth\n')
    const stdout = execFileSync('node', [CLI, '--store', dir], { encoding: 'utf8' })
    expect(stdout).toContain('0 invisible; 0 dangling')
    expect(stdout).toContain(
      '1 fiche(s) excluded from unreachable — a deliberate retraction whose forward pointer resolves (see wt-memory-hygiene.md); not a defect',
    )
    const { status } = runCli(dir)
    expect(status).toBe(0)
  })

  it('a broken retraction earns no exemption: still counted invisible AND still flagged, exit 1', () => {
    const dir = makeStore()
    fiche(dir, 'old-note', `${retractionBlock('Target: [replacement](missing.md)')}Old content kept only for inbound links.\n`)
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory index\n')
    let status = 0
    let stdout = ''
    try {
      stdout = execFileSync('node', [CLI, '--store', dir], { encoding: 'utf8' })
    } catch (e) {
      const err = e as ExecError
      stdout = err.stdout ?? ''
      status = err.status ?? 1
    }
    expect(status).toBe(1)
    expect(stdout).toContain('1 invisible')
    expect(stdout).not.toContain('excluded from unreachable')
    expect(stdout).toContain('FLAG: retraction forward pointer from old-note.md to missing.md does not resolve')
  })
})

describe('wt-memory-index-check.mjs CLI: exit codes are the ground truth', () => {
  it('exits 0 on a clean short store', () => {
    const dir = makeStore()
    fiche(dir, 'fact-a', 'Fact.\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Fact A](fact-a.md) — a fact\n')
    const { status, report } = runCli(dir)
    expect(status).toBe(0)
    expect(report.flagged).toBe(false)
  })

  it('exits 1 when the index is over threshold, and reports it in the JSON output', () => {
    const dir = makeStore()
    const lines = ['# Memory index']
    for (let i = 1; i <= 3; i++) {
      fiche(dir, `fact-${i}`, `Fact ${i}.\n`)
      lines.push(`- [Fact ${i}](fact-${i}.md) — fact ${i}`)
    }
    writeFileSync(join(dir, 'MEMORY.md'), lines.join('\n') + '\n')
    const { status, report } = runCli(dir, ['--threshold', '2'])
    expect(status).toBe(1)
    expect(report.overThreshold).toBe(true)
    expect(report.threshold).toBe(2)
  })

  it('exits 1 when a fiche is unreachable, regardless of a low line count', () => {
    const dir = makeStore()
    fiche(dir, 'orphan', 'Never linked.\n')
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory index\n')
    const { status, report } = runCli(dir)
    expect(status).toBe(1)
    expect(report.unreachableFiches).toEqual(['orphan.md'])
  })

  it('exits 0 and reports hasIndex:false on a store with no index file', () => {
    const dir = makeStore()
    fiche(dir, 'note', 'No index convention here.\n')
    const { status, report } = runCli(dir)
    expect(status).toBe(0)
    expect(report.hasIndex).toBe(false)
  })

  it('usage error (no --store) exits 2', () => {
    let status = 0
    try {
      execFileSync('node', [CLI], { encoding: 'utf8' })
    } catch (e) {
      status = (e as ExecError).status ?? 1
    }
    expect(status).toBe(2)
  })

  it('a nonexistent store path exits 2, not a false "no index" silence', () => {
    let status = 0
    try {
      execFileSync('node', [CLI, '--store', '/nonexistent/path/does-not-exist'], { encoding: 'utf8' })
    } catch (e) {
      status = (e as ExecError).status ?? 1
    }
    expect(status).toBe(2)
  })

  it('a flag missing its value exits 2 — cross-model review finding: it previously silently fell back to a default', () => {
    const dir = makeStore()
    fiche(dir, 'fact-a', 'Fact.\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Fact A](fact-a.md) — a fact\n')
    let status = 0
    let stderr = ''
    try {
      execFileSync('node', [CLI, '--store', dir, '--index-file'], { encoding: 'utf8' })
    } catch (e) {
      const err = e as ExecError & { stderr?: string }
      status = err.status ?? 1
      stderr = err.stderr ?? ''
    }
    expect(status).toBe(2)
    expect(stderr).toContain('--index-file requires a value')
  })

  it('a bad --out path exits 2 with a clean message, not an uncaught crash — cross-model review finding', () => {
    const dir = makeStore()
    fiche(dir, 'fact-a', 'Fact.\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Fact A](fact-a.md) — a fact\n')
    let status = 0
    let stderr = ''
    try {
      execFileSync(
        'node',
        [CLI, '--store', dir, '--json', '--out', join(dir, 'missing-parent-dir', 'out.json')],
        { encoding: 'utf8' },
      )
    } catch (e) {
      const err = e as ExecError & { stderr?: string }
      status = err.status ?? 1
      stderr = err.stderr ?? ''
    }
    expect(status).toBe(2)
    expect(stderr).toContain('cannot write --out file')
    expect(stderr).not.toContain('at writeFileSync') // no raw Node stack trace
  })

  it('the human-readable (non --json) output names the threshold applied', () => {
    const dir = makeStore()
    fiche(dir, 'fact-a', 'Fact.\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Fact A](fact-a.md) — a fact\n')
    const stdout = execFileSync('node', [CLI, '--store', dir, '--threshold', '50'], { encoding: 'utf8' })
    expect(stdout).toContain('threshold applied: 50')
  })

  it('the human-readable (non --json) output names both entry and byte thresholds', () => {
    const dir = makeStore()
    fiche(dir, 'fact-a', 'Fact.\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Fact A](fact-a.md) — a fact\n')
    const stdout = execFileSync('node', [CLI, '--store', dir, '--threshold', '50', '--size-threshold', '75'], {
      encoding: 'utf8',
    })
    expect(stdout).toContain('1 entry line(s) (threshold applied: 50)')
    expect(stdout).toContain('byte(s) (size threshold applied: 75)')
  })
})

// ── Archived fiches: a link into archive/ RESOLVES ────────────────────────
//
// The hygiene convention this probe serves tells stores to archive closed
// work by MOVING it into archive/, and explicitly NOT to rewrite inbound
// `[[links]]` afterward, because "archived links resolve on demand". The
// probe could not see archive/ at all, so every one of those correct links
// was reported as an unresolved cross-reference.
//
// Measured on a real store before the fix: 47 fiches, 32 archived, and the
// probe reported "15 unresolved cross-reference(s)". All 15 resolved in
// archive/. Because archiving is the very mechanism the convention
// prescribes, that count only ever GROWS — and a line showing a permanently
// nonzero number nobody can act on is a line people stop reading, which is
// how a checker loses the cases that matter.
//
// ⚠ The two link kinds are deliberately NOT merged. Collapsing them would
// trade this false positive for a false negative: an INDEX pointer at an
// archived fiche is a real defect the same convention names (archiving
// requires dropping the pointer), and it must stay loud.
describe('archived fiches', () => {
  function archived(dir: string, slug: string, body = 'archived body\n') {
    mkdirSync(join(dir, 'archive'), { recursive: true })
    writeFileSync(join(dir, 'archive', `${slug}.md`), body)
  }

  it('a BODY link into archive/ is not unresolved — it resolves, and says so without alarm', () => {
    const dir = makeStore()
    // A MEMBER-shaped line (`- [[slug]] — hook`) is what the probe collects,
    // and it is the shape the real store uses — prose mentions are not
    // classified at all. Kept in a NON-hub body on purpose: that is the branch
    // that produced the 15 false "unresolved" on the measured store.
    fiche(dir, 'live-note', 'Narrative body line.\nAnother line.\n- [[closed-work]] — the history\n')
    archived(dir, 'closed-work')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Live note](live-note.md) — a hook\n')

    const report = checkStore(dir)
    expect(report.unresolvedCrossRefs).toEqual([])
    expect(report.archivedRefs).toHaveLength(1)
    expect(report.archivedRefs[0].target).toBe('closed-work.md')
    expect(report.flagged).toBe(false)
    expect(report.notices.join('\n')).toContain('resolve in archive/')
  })

  it('an INDEX pointer at an archived fiche is FLAGGED — that pointer should have been dropped', () => {
    const dir = makeStore()
    fiche(dir, 'live-note', 'body\n')
    archived(dir, 'closed-work')
    writeFileSync(
      join(dir, 'MEMORY.md'),
      '- [Live note](live-note.md) — a hook\n- [Closed work](closed-work.md) — stale pointer\n',
    )

    const report = checkStore(dir)
    expect(report.staleIndexPointers).toHaveLength(1)
    expect(report.staleIndexPointers[0].target).toBe('closed-work.md')
    // Not dangling: the file exists. Sending a reader to hunt a missing file
    // that is sitting in archive/ is its own wasted trip.
    expect(report.danglingRefs).toEqual([])
    expect(report.flagged).toBe(true)
    expect(report.reasons.join('\n')).toContain('has been archived')
  })

  it('a genuinely missing target is still DANGLING, not excused by the archive lookup', () => {
    const dir = makeStore()
    fiche(dir, 'live-note', 'body\n')
    archived(dir, 'something-else')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Ghost](never-existed.md) — points at nothing\n')

    const report = checkStore(dir)
    expect(report.danglingRefs).toHaveLength(1)
    expect(report.danglingRefs[0].target).toBe('never-existed.md')
    expect(report.staleIndexPointers).toEqual([])
    expect(report.flagged).toBe(true)
  })

  it('a store with no archive/ directory behaves exactly as before — no new noise', () => {
    const dir = makeStore()
    fiche(dir, 'live-note', 'body\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Live note](live-note.md) — a hook\n')

    const report = checkStore(dir)
    expect(report.archivedRefs).toEqual([])
    expect(report.staleIndexPointers).toEqual([])
    expect(report.flagged).toBe(false)
    expect(report.notices.join('\n')).not.toContain('archive/')
  })

  it('archived fiches never join the reachability graph — they are not live-store members', () => {
    const dir = makeStore()
    fiche(dir, 'live-note', 'Narrative body line.\nAnother line.\n- [[closed-work]] — the history\n')
    archived(dir, 'closed-work')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Live note](live-note.md) — a hook\n')

    const report = checkStore(dir)
    expect(report.diskFiches).toBe(1)
    expect(report.unreachableFiches).toEqual([])
  })
})
