import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error shipped dependency-free plugin source has no declaration file
import { detectProviders } from '../../../../plugins/wt-deep-search/src/detect.js'
// @ts-expect-error shipped dependency-free plugin source has no declaration file
import { startOpencode } from '../../../../plugins/wt-deep-search/src/deep/opencode.js'

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
    expect(run.status, `${run.stdout}\n${run.stderr}`.slice(-12_000)).toBe(0)
  })

  it('treats a POSIX EPERM process-group probe as still alive', () => {
    const timers: Array<() => void> = []
    const writes: string[] = []
    let probes = 0
    startOpencode(
      { prompt: 'full brief', dir: '/work', logPath: '/state/deep.log', timeoutMs: 90_000 },
      {
        appendFileSync: (_path: string, value: string) => writes.push(value),
        clearTimeout() {},
        closeSync() {},
        kill: () => {
          probes += 1
          throw Object.assign(new Error('not permitted'), { code: probes === 1 ? 'EPERM' : 'ESRCH' })
        },
        openSync: () => 8,
        platform: 'darwin',
        setTimeout: (callback: () => void) => { timers.push(callback); return timers.length },
        signalProcessFamily() {},
        spawn: () => ({ pid: 44, once() {}, unref() {} }),
      },
    )

    timers.shift()?.()
    timers.shift()?.()
    expect(writes).toEqual([])
    timers.shift()?.()
    expect(writes).toEqual(['\nTIMEOUT=90000\nEXIT=124\n'])
  })

  it('declares no dependency, at build time or at run time', () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([])
    expect(Object.keys(manifest.devDependencies ?? {})).toEqual([])
  })

  it('persists the Windows filesystem casing instead of PATHEXT casing', () => {
    const candidate = 'C:\\tools\\opencode.CMD'
    const fs = {
      constants: { R_OK: 4, X_OK: 1 },
      existsSync: (path: string) => path === candidate,
      statSync: () => ({ isDirectory: () => false, isFile: () => true }),
      accessSync: () => {},
      realpathSync: (path: string) => path,
      readdirSync: () => ['opencode.cmd'],
    }

    expect(detectProviders({ PATH: 'C:\\tools' }, fs, { platform: 'win32' }).opencode).toEqual({
      available: true,
      path: 'C:\\tools\\opencode.cmd',
    })
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
