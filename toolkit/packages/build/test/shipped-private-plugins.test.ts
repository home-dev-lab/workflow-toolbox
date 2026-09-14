import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGINS = ['wt-secret-guard']
const PRIVATE_HOME_PATH = /\/home\/doublefx/
const PRIVATE_ID = /(?<!\d)\d{19}(?!\d)/

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (entry.isFile()) yield path
  }
}

describe('shipped private plugins', () => {
  for (const plugin of PLUGINS) {
    it(`${plugin} selftest exits successfully`, () => {
      const result = spawnSync(process.execPath, [join(REPO_ROOT, 'plugins', plugin, 'hooks', 'hooks.selftest.mjs')], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
      expect(result.status, result.stderr || result.stdout).toBe(0)
    })
  }

  it('contains no machine-specific home path or private 19-digit identifier', () => {
    const hits: string[] = []
    for (const plugin of PLUGINS) for (const file of files(join(REPO_ROOT, 'plugins', plugin))) {
      const text = readFileSync(file, 'utf8')
      if (PRIVATE_HOME_PATH.test(text) || PRIVATE_ID.test(text)) hits.push(relative(REPO_ROOT, file))
    }
    expect(hits).toEqual([])
  })
})
