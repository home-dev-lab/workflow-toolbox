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

function run(markdown: string, env: Record<string, string> = {}, args: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'wt-report-findings-'))
  roots.push(root)
  const report = join(root, 'report.md')
  writeFileSync(report, markdown)
  const result = spawnSync(process.execPath, [SCRIPT, ...args, report], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('wt-report-findings-check', () => {
  const closingSections = [
    '## Implemented\n\nCompleted the change.',
    '## Verification\n\nPassed.',
    '## Independent Review\n\nNo findings.',
    '## Decisions\n\nNo decisions.',
    '## Remaining Risks\n\nNone.',
  ]
  const findings = '## Findings\n\nNone.'

  it('does not print a shape line when every required closing-report section is present', () => {
    const result = run([...closingSections, findings].join('\n\n'))
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('closing report shape:')
  })

  it('names a missing required closing-report section', () => {
    const result = run([...closingSections.filter((section) => !section.startsWith('## Decisions')), findings].join('\n\n'))
    expect(result.stdout).toContain('closing report section: Decisions is missing or empty')
  })

  it('names an empty required closing-report section', () => {
    const result = run([...closingSections.map((section) => section.startsWith('## Verification') ? '## Verification\n\n   ' : section), findings].join('\n\n'))
    expect(result.stdout).toContain('closing report section: Verification is missing or empty')
  })

  it('skips the closing-report shape check with --no-shape', () => {
    const result = run(findings, {}, ['--no-shape'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('closing report shape: skipped (--no-shape)')
  })

  it('blocks a missing required closing-report section in block mode', () => {
    const result = run(findings, { WT_FINDINGS_DISPOSITION_MODE: 'block' })
    expect(result.status).toBe(1)
  })

  it('accepts a Verification section that names pasted e2e output', () => {
    const sections = closingSections.map((section) => section.startsWith('## Verification')
      ? '## Verification\n\nE2E output (`node plugin/bin/wt-report-findings-check.mjs report.md`):\n\n```text\nfindings: 0 rows\n```'
      : section)
    const result = run([...sections, findings].join('\n\n'))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('e2e verification: output recorded')
    expect(result.stdout).not.toContain('e2e verification warning:')
  })

  it('accepts e2e not run when the Verification section includes a reason', () => {
    const sections = closingSections.map((section) => section.startsWith('## Verification')
      ? '## Verification\n\ne2e not run: the required host is unavailable in CI.'
      : section)
    const result = run([...sections, findings].join('\n\n'))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('e2e verification: not run with reason')
    expect(result.stdout).not.toContain('e2e verification warning:')
  })

  it('warns when e2e not run has no reason', () => {
    const sections = closingSections.map((section) => section.startsWith('## Verification')
      ? '## Verification\n\ne2e not run'
      : section)
    const result = run([...sections, findings].join('\n\n'))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('e2e verification warning:')
  })

  it('warns but never blocks when Verification records neither e2e form', () => {
    const result = run([...closingSections, findings].join('\n\n'), {
      WT_FINDINGS_DISPOSITION_MODE: 'block',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('e2e verification warning: name the e2e output or state "e2e not run" with a reason (non-blocking)')
  })

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
