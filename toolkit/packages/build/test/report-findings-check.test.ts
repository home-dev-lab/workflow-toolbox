import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/bin/wt-report-findings-check.mjs')
const roots: string[] = []

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function run(markdown: string, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wt-report-findings-'))
  roots.push(root)
  const report = join(root, 'report.md')
  writeFileSync(report, markdown)
  const result = spawnSync(process.execPath, [SCRIPT, report], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('wt-report-findings-check', () => {
  it('accepts an explicit None.', () => {
    const result = run('# Report\n\n## Findings\n\nNone.\n')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('findings: 0 rows, 0 without disposition (mode=warn, probation until 2026-09-14)')
  })

  it('accepts rows with the allowed dispositions', () => {
    const result = run([
      '## Findings',
      '',
      '| Finding | Disposition |',
      '| --- | --- |',
      '| Missing lock | fixed with red lock report-findings-check.test.ts |',
      '| Follow-up | out-of-scope card 1859135350434170291 |',
    ].join('\n'))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('findings: 2 rows, 0 without disposition')
  })

  it('warns but exits zero for a row without a disposition during probation', () => {
    const result = run('## Findings\n\n| Finding | Disposition |\n| --- | --- |\n| Missing lock | pending |\n')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('findings: 1 rows, 1 without disposition (mode=warn, probation until 2026-09-14)')
  })

  it('blocks a row without a disposition when block mode is selected', () => {
    const result = run('## Findings\n\n| Finding | Disposition |\n| --- | --- |\n| Missing lock | pending |\n', {
      WT_FINDINGS_DISPOSITION_MODE: 'block',
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('findings: 1 rows, 1 without disposition (mode=block, probation until 2026-09-14)')
  })

  it('warns for a missing section during probation and blocks it afterward', () => {
    const markdown = '# Report\n\nNo findings section.\n'
    const warn = run(markdown, { WT_FINDINGS_DISPOSITION_NOW: '2026-09-13' })
    const block = run(markdown, { WT_FINDINGS_DISPOSITION_NOW: '2026-09-14' })
    expect(warn.status).toBe(0)
    expect(warn.stdout).toContain('findings: 0 rows, 1 without disposition (mode=warn, probation until 2026-09-14)')
    expect(block.status).toBe(1)
    expect(block.stdout).toContain('findings: 0 rows, 1 without disposition (mode=block, probation until 2026-09-14)')
  })
})
