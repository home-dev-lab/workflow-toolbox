import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { artifactStateDir } from '../../../../plugin/bin/lib/artifact-server.mjs'

const LOCK = new URL('../../../../plugin/bin/lib/suite-lock.mjs', import.meta.url).href
const ARTIFACT = new URL('../../../../plugin/bin/lib/artifact-server.mjs', import.meta.url).href
const SANDBOX = new URL('../../../../plugin/bin/lib/host/lane-sandbox.mjs', import.meta.url).href
const RESOLVER = new URL('../../../../plugin/bin/lib/host/suite-lock-dir.mjs', import.meta.url).href
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function privateHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'wt-lock-home-'))
  roots.push(root)
  return root
}

function probe<T = string>(options: Record<string, unknown> = {}, setup = '', expression = `lock.suiteLeaseDomain(${JSON.stringify(options)})`) {
  const home = privateHome()
  const source = `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module';
    ${setup}; syncBuiltinESMExports(); const lock = await import(${JSON.stringify(LOCK)});
    try { console.log(JSON.stringify({root: ${expression}})) }
    catch (error) { console.log(JSON.stringify({code: error.code, message: error.message, cause: error.cause?.message})) }`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, WT_SUITE_LOCK_DIR: '', XDG_STATE_HOME: '', LOCALAPPDATA: '', WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '' },
  })
  expect(result.status, result.stderr).toBe(0)
  return { home, value: JSON.parse(result.stdout.trim()) as { root?: T; code?: string; message?: string; cause?: string } }
}

describe('suite lock OS home resolution', () => {
  it('keeps the real user lock root when HOME and USERPROFILE are pinned to a temporary directory', () => {
    const expected = join(dirname(artifactStateDir({}, userInfo().homedir)), 'wt-suite-lock')
    const { home, value } = probe<string[]>({}, '', '[lock.suiteLeaseDomain(), lock.readSuiteLock().root, lock.readSuiteLockStatus().root]')
    expect(value.root, 'HOME-pinned gates must use the real user suite lock for domain, read and status').toEqual([expected, expected, expected])
    for (const root of value.root!) expect(root).not.toContain(home)
  })

  it.each(['linux', 'darwin', 'win32'])('uses OS user information rather than caller home variables on %s', (platform) => {
    const realHome = privateHome()
    const { value } = probe({ env: { HOME: '/caller-home', USERPROFILE: '/caller-profile' }, platform }, `os.userInfo = () => ({homedir: ${JSON.stringify(realHome)}})`)
    expect(value.root).toBe(join(dirname(artifactStateDir({}, realHome, platform)), 'wt-suite-lock'))
  })

  it('names an unavailable OS home instead of falling back to a caller-controlled HOME', () => {
    const { value } = probe({}, 'os.userInfo = () => { throw new Error("no account entry") }')
    expect(value.code).toBe('WT_SUITE_LOCK_HOME_UNAVAILABLE')
    expect(value.message).toContain('WT_SUITE_LOCK_DIR=<shared-directory> wt-suite-lock run -- <command>')
    expect(value.cause).toBe('no account entry')
  })

  it.each(['', 'relative-home', null])('refuses an invalid OS home (%s) without a plausible fallback', (home) => {
    expect(probe({}, `os.userInfo = () => ({homedir: ${JSON.stringify(home)}})`).value.code).toBe('WT_SUITE_LOCK_HOME_UNAVAILABLE')
  })
})

describe('suite lock OS home resolution — overrides', () => {
  it.each(['linux', 'darwin', 'win32'])('keeps WT_SUITE_LOCK_DIR first and does not require OS home on %s', (platform) => {
    const root = privateHome()
    const { value } = probe({ env: { WT_SUITE_LOCK_DIR: root, XDG_STATE_HOME: '/other-state', LOCALAPPDATA: '/other-local' }, platform }, 'os.userInfo = () => { throw new Error("unavailable") }')
    expect(value.root).toBe(resolve(root))
  })

  it.each(['linux', 'darwin', 'win32'])('preserves deliberate XDG_STATE_HOME without OS home on %s', (platform) => {
    const state = privateHome()
    const { value } = probe({ env: { XDG_STATE_HOME: state, LOCALAPPDATA: '/other-local' }, platform }, 'os.userInfo = () => { throw new Error("unavailable") }')
    expect(value.root).toBe(join(state, 'wt-suite-lock'))
  })

  it('preserves LOCALAPPDATA on Windows without OS home', () => {
    const state = privateHome()
    const { value } = probe({ env: { LOCALAPPDATA: state }, platform: 'win32' }, 'os.userInfo = () => { throw new Error("unavailable") }')
    expect(value.root).toBe(join(state, 'wt-suite-lock'))
  })

  it.each(['linux', 'darwin', 'win32'])('ignores relative XDG_STATE_HOME on %s', (platform) => {
    const realHome = privateHome()
    const { value } = probe({ env: { XDG_STATE_HOME: 'state' }, platform }, `os.userInfo = () => ({homedir: ${JSON.stringify(realHome)}})`)
    expect(value.root, 'relative XDG state must fall back to the account default').toBe(join(dirname(artifactStateDir({}, realHome, platform)), 'wt-suite-lock'))
  })

  it('falls through relative XDG_STATE_HOME to absolute LOCALAPPDATA on Windows', () => {
    const state = privateHome()
    const { value } = probe({ env: { XDG_STATE_HOME: 'state', LOCALAPPDATA: state }, platform: 'win32' }, 'os.userInfo = () => { throw new Error("unavailable") }')
    expect(value.root).toBe(join(state, 'wt-suite-lock'))
  })
})

describe('suite lock OS home resolution — consumers', () => {
  it('keeps the artifact server following its existing HOME contract', () => {
    const { home, value } = probe({}, '', `(await import(${JSON.stringify(ARTIFACT)})).artifactStateDir({})`)
    expect(value.root).toBe(artifactStateDir({}, home))
  })

  it('resolves a broker domain without any OS home lookup', () => {
    const { value } = probe({ env: { WT_SUITE_LOCK_BROKER: '/lane/lock/broker.sock' } }, 'os.userInfo = () => { throw new Error("unavailable") }')
    expect(value.root).toBe('broker:/lane/lock/broker.sock')
  })
})

describe('suite lock Windows writable preflight', () => {
  const accountHome = 'C:\\Users\\owner'
  const pinnedHome = 'C:\\private'
  const defaultRoot = win32.join(accountHome, 'AppData', 'Local', 'wt-suite-lock')
  it.each([
    [{ HOME: pinnedHome }, defaultRoot],
    [{ USERPROFILE: pinnedHome }, defaultRoot],
    [{ HOME: pinnedHome, USERPROFILE: pinnedHome }, defaultRoot],
    [{ LOCALAPPDATA: 'D:\\state' }, 'D:\\state\\wt-suite-lock'],
    [{ XDG_STATE_HOME: 'D:\\xdg', LOCALAPPDATA: 'D:\\state' }, 'D:\\xdg\\wt-suite-lock'],
    [{ XDG_STATE_HOME: 'state' }, defaultRoot],
    [{ XDG_STATE_HOME: 'state', LOCALAPPDATA: 'D:\\state' }, 'D:\\state\\wt-suite-lock'],
    [{ WT_SUITE_LOCK_DIR: 'D:\\lock', XDG_STATE_HOME: 'D:\\xdg' }, 'D:\\lock'],
  ])('agrees with the shared resolver under Windows path semantics: %j', (overrides, expected) => {
    const env = { HOME: accountHome, USERPROFILE: accountHome, ...overrides }
    const expression = `await (async () => {
      const {laneWritableForLaunch} = await import(${JSON.stringify(SANDBOX)});
      const env = ${JSON.stringify(env)};
      const writable = laneWritableForLaunch({cwd: 'C:\\\\work\\\\tree', env, optionEnv: {}, platform: 'win32', fs: {realpath: () => null, readText: () => null}});
      return {actual: writable(${JSON.stringify(win32.join(expected, 'holder.json'))}), obsolete: writable('C:\\\\private\\\\AppData\\\\Local\\\\wt-suite-lock\\\\holder.json')};
    })()`
    const setup = `os.userInfo = () => ({homedir: ${JSON.stringify(accountHome)}})`
    const { value } = probe<{ actual: boolean; obsolete: boolean }>({}, setup, expression)
    expect(value.code, value.message).toBeUndefined()
    expect(value.root, 'preflight must admit the real lock and reject the private lock').toEqual({ actual: true, obsolete: false })
    const resolved = probe({}, setup, `(await import(${JSON.stringify(RESOLVER)})).suiteLockDir(${JSON.stringify(env)}, undefined, 'win32', (await import('node:path')).win32)`)
    expect(resolved.value.root).toBe(expected)
  })
})
