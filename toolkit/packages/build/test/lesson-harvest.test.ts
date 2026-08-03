import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

// Mechanize the harvest of a pilot/executor closure report's own "## Lessons for the memory"
// section, so the session integrating the card doesn't have to read the whole report to find
// it. This is DETECTION + EXTRACTION only: the tool never writes
// to the knowledge base itself (single-writer constraint — see knowledge-base-recall.md) and
// never invents wording — it hands the session a manifest to act on with its own judgment.

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/skills/lesson-harvest/scripts/harvest-lessons.mjs')
const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
function mkDir(): string { const r = mkdtempSync(join(tmpdir(), 'wt-lesson-harvest-')); roots.push(r); return r }
function writeReport(dir: string, body: string): string {
  const p = join(dir, 'report.md')
  writeFileSync(p, body, 'utf8')
  return p
}
function run(reportPath: string, extraArgs: string[] = []) {
  const res = spawnSync(process.execPath, [SCRIPT, reportPath, ...extraArgs], { encoding: 'utf8' })
  return { ...res, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

describe('lesson-harvest: explicit "None." — the case a mechanism must not pollute the index with', () => {
  it('reports NO-LESSONS and exit 0, no candidate items', () => {
    const d = mkDir()
    const p = writeReport(d, '# Report\n\nBody text.\n\n## Lessons for the memory\n\nNone.\n')
    const res = run(p, ['--json'])
    expect(res.status).toBe(0)
    const out = JSON.parse(res.stdout)
    expect(out.sectionFound).toBe(true)
    expect(out.hasLessons).toBe(false)
    expect(out.items).toEqual([])
  })
})

describe('lesson-harvest: a real, non-trivial section (bullet form)', () => {
  it('extracts each top-level bullet as one item, and stops at the next H2', () => {
    const d = mkDir()
    const p = writeReport(d, [
      '# Report',
      '',
      '## Lessons for the memory',
      '',
      '- **First lesson, bold lead.** Continuation text that wraps onto',
      '  a second physical line, still part of item one.',
      '- **Second lesson.** One line only.',
      '',
      '## Provenance of the log files',
      '',
      '- this must NOT be swallowed into the lessons harvest',
      '',
    ].join('\n'))
    const res = run(p, ['--json'])
    expect(res.status).toBe(0)
    const out = JSON.parse(res.stdout)
    expect(out.sectionFound).toBe(true)
    expect(out.hasLessons).toBe(true)
    expect(out.items).toHaveLength(2)
    expect(out.items[0]).toContain('First lesson, bold lead.')
    expect(out.items[0]).toContain('second physical line')
    expect(out.items[1]).toContain('Second lesson.')
    // the boundary is the mechanically load-bearing part of this test:
    for (const item of out.items) expect(item).not.toContain('Provenance')
    expect(JSON.stringify(out)).not.toContain('must NOT be swallowed')
  })
})

describe('lesson-harvest: numbered-list form (observed in real pilot reports)', () => {
  it('extracts each top-level numbered item as one item', () => {
    const d = mkDir()
    const p = writeReport(d, [
      '## Lessons for the memory',
      '',
      '1. **First.** Body one.',
      '2. **Second.** Body two,',
      '   continued.',
      '3. **Third.** Body three.',
    ].join('\n'))
    const res = run(p, ['--json'])
    const out = JSON.parse(res.stdout)
    expect(out.hasLessons).toBe(true)
    expect(out.items).toHaveLength(3)
    expect(out.items[1]).toContain('continued.')
  })
})

describe('lesson-harvest: section absent entirely — distinct from an explicit "None."', () => {
  it('reports sectionFound:false, never conflated with the no-lessons case', () => {
    const d = mkDir()
    const p = writeReport(d, '# Report\n\nNo such section here at all.\n')
    const res = run(p, ['--json'])
    expect(res.status).toBe(2)
    const out = JSON.parse(res.stdout)
    expect(out.sectionFound).toBe(false)
    expect(out.hasLessons).toBe(false)
  })
})

describe('lesson-harvest: missing file', () => {
  it('fails loudly rather than reporting a hollow no-lessons verdict', () => {
    const res = run('/nonexistent/report.md', ['--json'])
    expect(res.status).toBe(1)
  })
})

describe('lesson-harvest: human-readable mode (default, no --json)', () => {
  it('prints a plain-text summary the session can read directly', () => {
    const d = mkDir()
    const p = writeReport(d, '## Lessons for the memory\n\n- **One lesson.** Body.\n')
    const res = run(p)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('1 candidate')
    expect(res.stdout).toContain('One lesson.')
  })
})
