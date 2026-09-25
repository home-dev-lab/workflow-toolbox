import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { isInvokedDirectly } from '../../../plugin/bin/lib/host/entry-guard.mjs'

const roots: string[] = []
const REPORT_FINDINGS_CHECK = join(import.meta.dirname, '../../../plugin/bin/wt-report-findings-check.mjs')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('host entry guard', () => {
  it('recognizes the same canonical file', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-entry-guard-')); roots.push(root)
    const file = join(root, 'entry.mjs')
    writeFileSync(file, '')

    expect(isInvokedDirectly(pathToFileURL(file).href, file)).toBe(true)
  })

  it('rejects another canonical file', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-entry-guard-')); roots.push(root)
    const entry = join(root, 'entry.mjs')
    const other = join(root, 'other.mjs')
    writeFileSync(entry, '')
    writeFileSync(other, '')

    expect(isInvokedDirectly(pathToFileURL(entry).href, other)).toBe(false)
  })

  it('returns false when either path is unavailable', () => {
    expect(isInvokedDirectly('file:///definitely-absent-entry.mjs', '/definitely-absent-argv.mjs')).toBe(false)
    expect(isInvokedDirectly(import.meta.url, '')).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('runs a hook invoked through a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-entry-guard-')); roots.push(root)
    const link = join(root, 'report-findings-check.mjs')
    symlinkSync(REPORT_FINDINGS_CHECK, link)

    const result = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' })

    expect(result.stdout).toContain('wt-report-findings-check')
  })
})
