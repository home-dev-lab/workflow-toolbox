import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = join(import.meta.dirname, '../../../..')

describe('plugin data directory resolver', () => {
  it('accepts only this plugin data directory and preserves the XDG fallback', () => {
    const result = spawnSync(process.execPath, [join(ROOT, 'plugin/bin/lib/plugin-data-dir.selftest.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: mkdtempSync(join(tmpdir(), 'wt-plugin-data-test-')) },
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('11 passed')
  })
})
