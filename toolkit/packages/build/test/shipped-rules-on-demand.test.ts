import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const plugin = join(root, 'plugins', 'wt-rules-on-demand')
function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (entry.isFile()) yield path
  }
}
// macOS (/var -> /private/var) and Windows (8.3 short names) hand out temp paths that are not their own real path,
// so a fixture that confuses a path with its physical identity passes on Linux and fails there. Where the OS temp
// directory is already physical, run the suite under an aliased one so Linux gates catch that class too.
export function aliasedTempEnv(): { env: NodeJS.ProcessEnv, cleanup: () => void } {
  const base = tmpdir()
  if (realpathSync(base) !== base) return { env: process.env, cleanup: () => {} }
  const real = mkdtempSync(join(base, 'rod-real-tmp-'))
  const alias = `${real}-alias`
  symlinkSync(real, alias, 'junction')
  const env = { ...process.env, TMPDIR: alias, TMP: alias, TEMP: alias }
  return { env, cleanup: () => { rmSync(alias, { force: true }); rmSync(real, { recursive: true, force: true }) } }
}

describe('shipped rules-on-demand', () => {
  it('runs dependency-free Node tests', () => {
    const temp = aliasedTempEnv()
    try {
      const run = spawnSync(process.execPath, ['--test'], { cwd: plugin, encoding: 'utf8', env: temp.env })
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)
    } finally { temp.cleanup() }
  // The plugin's own `node --test` took 67.9 s on the windows-latest runner (run 36971793287) and
  // 57.0 s on ubuntu-latest and 42.9 s on macos-latest in the same run; 180 s leaves about 2.6x the
  // slowest measurement.
  }, 180_000)
  it('runs the plugin suite under a temp directory that is not its own real path', () => {
    const temp = aliasedTempEnv()
    try {
      const dir = temp.env.TMPDIR ?? tmpdir()
      expect(realpathSync(dir)).not.toBe(dir)
    } finally { temp.cleanup() }
  })
  it('contains no private data or machine path', () => {
    const forbidden = ['.claude-work', 'planka', 'atrium', 'embedded-rules']
    const hits: string[] = []
    for (const file of files(plugin)) {
      const content = readFileSync(file, 'utf8')
      if (content.includes(homedir()) || /(?<!\d)\d{19}(?!\d)/.test(content) || forbidden.some((word) => content.toLowerCase().includes(word))) hits.push(relative(root, file))
    }
    expect(hits).toEqual([])
  })
})
