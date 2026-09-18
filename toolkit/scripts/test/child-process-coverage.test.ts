import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { disableChildProcessCoverage, enableChildProcessCoverage } from '../child-process-coverage-provider.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('child-process coverage instrument', () => {
  it('captures code executed only by a spawned Node process and cleans its run directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-child-coverage-'))
    roots.push(root)
    const executable = join(root, 'spawn-only.mjs')
    writeFileSync(executable, 'const coveredOnlyInChild = 21 * 2\nprocess.stdout.write(String(coveredOnlyInChild))\n')

    const instrument = enableChildProcessCoverage(root)
    const result = spawnSync(process.execPath, [executable], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('42')
    const entries = readdirSync(instrument.directory).map((file) => JSON.parse(readFileSync(join(instrument.directory, file), 'utf8')))
    const childScript = entries.flatMap((entry) => entry.result).find((script) => script.url.endsWith('/spawn-only.mjs'))
    expect(childScript?.functions.some((fn) => fn.ranges.some((range) => range.count > 0))).toBe(true)

    disableChildProcessCoverage(instrument)
    expect(() => readdirSync(instrument.directory)).toThrow()
  })
})
