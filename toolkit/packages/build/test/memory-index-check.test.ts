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
  entryLines: number
  overThreshold: boolean
  diskFiches: number
  reachableFiches: number
  unreachableFiches: string[]
  danglingRefs: Array<{ from: string; target: string }>
  hubCountMismatches: Array<{ file: string; declared: number; actual: number }>
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
    expect(report.reasons.join(' ')).toContain('hub-topic.md')
    expect(report.reasons.join(' ')).toContain('missing.md')
    expect(report.flagged).toBe(true)
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
    expect(report.flagged).toBe(false)
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

  it('a healthy store with modest hubs and comfortable headroom stays exit 0, no notices, no flags', () => {
    const dir = makeStore()
    makeHub(dir, 'modest-hub', 5)
    const report = checkStore(dir, { threshold: 200, hubMax: 45 })
    expect(report.flagged).toBe(false)
    expect(report.notices).toEqual([])
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

  it('a flat store under threshold, comfortably clear of the band, exits 0 with the same output shape as before this change', () => {
    const dir = makeStore()
    fiche(dir, 'fact-a', 'Fact.\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Fact A](fact-a.md) — a fact\n')
    const stdout = execFileSync('node', [CLI, '--store', dir], { encoding: 'utf8' })
    expect(stdout).toBe(
      'index: 1 entry line(s) (threshold applied: 200) — 1 fiche(s) on disk, 1 reachable, 0 invisible; 0 dangling\n',
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
})
