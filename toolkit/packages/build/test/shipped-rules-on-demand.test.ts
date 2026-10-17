import { describe, expect, it } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'

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
  // Every child gets plugin-location state (HOME, config dir, npm prefix...) inside a directory removed afterwards.
  const sealRoot = mkdtempSync(join(base, 'rod-sealed-'))
  const sealed = sealedPluginCliEnv(sealRoot)
  const removeSeal = () => rmSync(sealRoot, { recursive: true, force: true })
  if (realpathSync(base) !== base) return { env: sealed, cleanup: removeSeal }
  const real = mkdtempSync(join(base, 'rod-real-tmp-'))
  const alias = `${real}-alias`
  symlinkSync(real, alias, 'junction')
  const env = { ...sealed, TMPDIR: alias, TMP: alias, TEMP: alias }
  return { env, cleanup: () => { rmSync(alias, { force: true }); rmSync(real, { recursive: true, force: true }); removeSeal() } }
}

// The spec reporter prints only 'test failed' for a test FILE whose process exited non-zero while every subtest passed.
// The exit reporter names that process's exit code and signal on stderr, which a failure message prints first.
const helper = (name: string) => new URL(`./helpers/${name}`, import.meta.url).href
const NODE_TEST_ARGS = ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout',
  `--test-reporter=${helper('node-test-exit-reporter.mjs')}`, '--test-reporter-destination=stderr']
// The plugin's spec output is far below this; the default 1 MiB would end the run with ENOBUFS once it grows past it.
const MAX_OUTPUT = 64 * 1024 * 1024

export function nodeTestOutcome(run: SpawnSyncReturns<string>): string {
  const spawnError = run.error ? `, spawn error ${run.error.message}` : ''
  return [`node --test exit status ${run.status}, signal ${run.signal ?? 'none'}${spawnError}`,
    '--- stderr ---', run.stderr ?? '', '--- stdout ---', run.stdout ?? ''].join('\n')
}

describe('shipped rules-on-demand', () => {
  it('runs dependency-free Node tests', () => {
    const temp = aliasedTempEnv()
    try {
      const run = spawnSync(process.execPath, NODE_TEST_ARGS, { cwd: plugin, encoding: 'utf8', env: temp.env, maxBuffer: MAX_OUTPUT })
      expect(run.status, nodeTestOutcome(run)).toBe(0)
    } finally { temp.cleanup() }
  // The plugin's own `node --test` took 67.9 s on the windows-latest runner (run 36971793287) and
  // 57.0 s on ubuntu-latest and 42.9 s on macos-latest in the same run; 180 s leaves about 2.6x the
  // slowest measurement.
  }, 180_000)
  it('names the exit code of a test file whose process failed after every subtest passed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rod-exit-reporter-'))
    try {
      writeFileSync(join(dir, 'quiet-exit.test.mjs'), "import { test } from 'node:test'\ntest('passes', () => {})\nprocess.exitCode = 3\n")
      const run = spawnSync(process.execPath, NODE_TEST_ARGS, { cwd: dir, encoding: 'utf8', env: sealedPluginCliEnv(join(dir, 'sealed'), { NODE_TEST_CONTEXT: undefined }) })
      expect(run.stdout).toContain("'test failed'")
      expect(run.stderr).toMatch(/quiet-exit\.test\.mjs exited with code 3 \(0x3\), signal none, failure type testCodeFailure/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 30_000)
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
