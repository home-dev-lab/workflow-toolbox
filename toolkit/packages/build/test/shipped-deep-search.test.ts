import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGIN = join(REPO_ROOT, 'plugins', 'wt-deep-search')
// Derived from the machine the gate RUNS on, never written down: a literal home path in this file
// would be the very thing it exists to keep out of a public repository. A synthetic fixture path
// like /home/tester is legitimate and must not fire, which a broad /home/<name>/ pattern cannot tell.
const PRIVATE_HOME_PATH = homedir()
const PRIVATE_ID = /(?<!\d)\d{19}(?!\d)/

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (entry.isFile()) yield path
  }
}

describe('shipped wt-deep-search', () => {
  // The plugin carries its own locks under `test/`, run by node's test runner because the
  // plugin has ZERO dependencies — that property is what makes installing it riskless, so the
  // gate runs them where they are rather than porting them into vitest and adding a dependency.
  it('its own test suite passes', () => {
    const run = spawnSync(process.execPath, ['--test'], { cwd: PLUGIN, encoding: 'utf8' })
    expect(run.status, run.stdout.slice(-4000) || run.stderr).toBe(0)
  })

  it('declares no dependency, at build time or at run time', () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([])
    expect(Object.keys(manifest.devDependencies ?? {})).toEqual([])
  })

  it('its cross-platform verdict matches the hook home resolution', () => {
    const verdict = readFileSync(join(PLUGIN, 'CROSS-PLATFORM.md'), 'utf8')
    expect(verdict).not.toContain('That copy still reads `HOME` alone and still joins with `/`.')
    expect(verdict).toContain('`USERPROFILE`')
    expect(verdict).toContain('`HOMEDRIVE` plus `HOMEPATH`')
  })

  it('contains no machine-specific home path or private 19-digit identifier', () => {
    const hits: string[] = []
    for (const file of files(PLUGIN)) {
      const text = readFileSync(file, 'utf8')
      if (text.includes(PRIVATE_HOME_PATH) || PRIVATE_ID.test(text)) hits.push(relative(REPO_ROOT, file))
    }
    expect(hits).toEqual([])
  })
})
