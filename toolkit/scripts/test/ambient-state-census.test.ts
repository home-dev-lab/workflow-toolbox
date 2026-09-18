import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { approvalEntry, checkAmbientState, findingKey, scanAmbientState } from '../ambient-state-census.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ambient-state census', () => {
  it('detects controls for every mechanical signal', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-ambient-census-'))
    roots.push(root)
    mkdirSync(join(root, 'packages/example/test'), { recursive: true })
    writeFileSync(join(root, 'packages/example/test/control.test.ts'), `
import { spawnSync, execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
const requests = 0
spawnSync('node', [], { env: { ...process.env } })
execFileSync('pgrep', ['-f', 'control'])
execFileSync('npm', ['root', '-g'])
server.listen(0)
requests += 1
expect(result.stdout).not.toContain('5h')
homedir()
`)

    expect(scanAmbientState(root).map((finding) => finding.signal)).toEqual([
      'inherited-env-to-child',
      'real-process-table',
      'global-npm-root',
      'ephemeral-unfiltered-counter',
      'short-negative-output-match',
      'real-home-directory',
    ])
  })

  it('keeps an approval key stable when unrelated lines move the signal, and tells identical lines apart', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-ambient-census-'))
    roots.push(root)
    mkdirSync(join(root, 'packages/example/test'), { recursive: true })
    const file = join(root, 'packages/example/test/moved.test.ts')
    const body = `import { homedir } from 'node:os'\nconst a = homedir()\nconst a = homedir()\n`
    writeFileSync(file, body)
    const before = scanAmbientState(root).map(findingKey)
    writeFileSync(file, `// one\n// two\n// three\n${body}`)
    const after = scanAmbientState(root).map(findingKey)

    expect(after).toEqual(before)
    expect(new Set(before).size).toBe(2)
    expect(before[0]).toBe('packages/example/test/moved.test.ts:real-home-directory:const a = homedir()')
  })

  it('hands the paste-ready approval entry for an unapproved signal', () => {
    expect(approvalEntry({ file: 'a.test.ts', line: 3, signal: 'real-home-directory', detail: 'os.homedir()', key: "a.test.ts:real-home-directory:it('x')" }))
      .toBe(`  ["a.test.ts:real-home-directory:it('x')", '<one-line reason>'],`)
  })

  it('requires every repository signal to be fixed or justified at its exact statement', () => {
    const result = checkAmbientState()
    expect(result.unapproved, `Approve or isolate:\n${result.unapproved.map((finding) => `${finding.file}:${finding.line} ${finding.signal}: ${finding.detail}`).join('\n')}`).toEqual([])
    expect(result.stale, `Remove stale approvals:\n${result.stale.join('\n')}`).toEqual([])
  })
})
