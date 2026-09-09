import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CHECK = join(REPO_ROOT, 'plugin/bin/wt-claimed-test-check.mjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(doc: string, tests: Array<{ name: string; source: string }> = []): string {
  const root = mkdtempSync(join(tmpdir(), 'wt-claimed-test-check-'))
  roots.push(root)
  mkdirSync(join(root, 'plugin/rules'), { recursive: true })
  writeFileSync(join(root, 'plugin/rules/claim.md'), `${doc}\n`)
  for (const test of tests) {
    const file = join(root, 'toolkit/packages/build/test', test.name)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, test.source)
  }
  return root
}

function run(root: string) {
  return spawnSync(process.execPath, [CHECK, '--root', root], { encoding: 'utf8' })
}

describe('wt-claimed-test-check.mjs', () => {
  it('is silent when a claimed subject is mentioned by a test', () => {
    const root = fixture('A test fails if `widget` becomes stale.', [
      { name: 'widget-guard.test.ts', source: "it('guards widget', () => {})" },
    ])
    const result = run(root)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('prints one warn-only line for an unpaired claim', () => {
    const root = fixture('The suite fails when `widget` becomes stale.')
    const result = run(root)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('plugin/rules/claim.md:1')
    expect(result.stdout).toContain('The suite fails when `widget` becomes stale.')
    expect(result.stdout).toContain('searched: widget')
  })

  it('ignores a sentence that merely mentions a test', () => {
    const root = fixture('Run the test suite before release.')
    const result = run(root)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })
})
