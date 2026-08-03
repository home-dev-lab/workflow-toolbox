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

interface Report {
  hasIndex: boolean
  threshold: number
  entryLines: number
  overThreshold: boolean
  diskFiches: number
  reachableFiches: number
  unreachableFiches: string[]
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

  it('the human-readable (non --json) output names the threshold applied', () => {
    const dir = makeStore()
    fiche(dir, 'fact-a', 'Fact.\n')
    writeFileSync(join(dir, 'MEMORY.md'), '- [Fact A](fact-a.md) — a fact\n')
    const stdout = execFileSync('node', [CLI, '--store', dir, '--threshold', '50'], { encoding: 'utf8' })
    expect(stdout).toContain('threshold applied: 50')
  })
})
