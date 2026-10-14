// guard-journal-global-setup.test.ts — locks the fix for card 1843667432-journal-soletest: the
// mechanical journal-pollution backstop in test-support/guard-journal-isolation.global-setup.ts
// must throw only when this run can reasonably believe it is the journal's sole writer (CI, or
// the opt-in WT_GUARD_JOURNAL_ISOLATION_STRICT), and must warn-without-failing otherwise — because
// the watched directory (~/.local/state/wt-guard-journal by default) is MACHINE-GLOBAL, not
// per-run, and a `pnpm test` exit code must not depend on what another session on the same
// machine writes there while this run is in flight.
//
// This test never touches the real machine-global journals: every case points WT_GUARD_JOURNAL_DIR,
// CLAUDE_CONFIG_DIR and the injected home list at fresh temp directories, so the watched set
// (watchedJournalDirs) holds only directories the case owns.
//
// Every case exercises the SAME exported setupBackstop()/teardown() pair the real vitest globalSetup
// delegates to, with only the home list injected — a direct import, not a subprocess, so a future
// edit that reintroduces "throw unconditionally" or "never throw" breaks one of these
// deterministically instead of only showing up as a machine-dependent flake in someone's local run.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setupBackstop, watchedJournalDirs } from '../../../test-support/guard-journal-isolation.global-setup'
// @ts-expect-error ESM runtime module
import { resolvePluginDataDir } from '../../../../plugin/bin/lib/plugin-data-dir.mjs'

const OWN_PLUGIN_VERSION: string = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'plugin', '.claude-plugin', 'plugin.json'), 'utf8')).version

const ENV_KEYS = ['CI', 'WT_GUARD_JOURNAL_DIR', 'WT_GUARD_JOURNAL_ISOLATION_STRICT', 'HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PLUGIN_DATA'] as const

let savedEnv: Record<string, string | undefined>
let tempDirs: string[]

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  tempDirs = []
})

afterEach(() => {
  // Restore exactly what was there before — leaking CI or the strict var into a sibling test
  // would make other files' results depend on execution order, the same class of bug this file
  // exists to lock shut for the journal directory itself.
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function freshJournalDir(): string {
  const dir = mkdtempSync(join(os.tmpdir(), 'wt-guard-journal-global-setup-test-'))
  tempDirs.push(dir)
  process.env.WT_GUARD_JOURNAL_DIR = dir
  // The watch also covers the writer's fallback dirs; point them at an empty throw-away home and config so no case
  // ever watches the real machine's journals, which other sessions grow at any moment.
  const home = mkdtempSync(join(os.tmpdir(), 'wt-guard-journal-global-setup-emptyhome-'))
  tempDirs.push(home)
  isolatedHome = home
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
  delete process.env.CLAUDE_PLUGIN_DATA
  return dir
}

let isolatedHome = ''
/** The backstop as vitest runs it, with the home list injected so only throw-away directories are watched. */
function setup(): () => void {
  return setupBackstop({ dirs: watchedJournalDirs({ homes: [isolatedHome] }) })
}

function simulateGrowth(dir: string): void {
  writeFileSync(join(dir, 'leak.ndjson'), '{"guard":"fake"}\n')
}

describe('guard-journal-isolation.global-setup: sole-writer-conditional throw', () => {
  it('CI truthy + journal growth: teardown throws', () => {
    delete process.env.WT_GUARD_JOURNAL_ISOLATION_STRICT
    process.env.CI = 'true'
    const dir = freshJournalDir()
    const teardown = setup()
    simulateGrowth(dir)
    expect(() => teardown()).toThrow(/GUARD JOURNAL CHANGED/)
  })

  it('WT_GUARD_JOURNAL_ISOLATION_STRICT truthy + journal growth: teardown throws', () => {
    delete process.env.CI
    process.env.WT_GUARD_JOURNAL_ISOLATION_STRICT = '1'
    const dir = freshJournalDir()
    const teardown = setup()
    simulateGrowth(dir)
    expect(() => teardown()).toThrow(/GUARD JOURNAL CHANGED/)
  })

  it('neither signal set + journal growth: teardown does NOT throw, and warns', () => {
    delete process.env.CI
    delete process.env.WT_GUARD_JOURNAL_ISOLATION_STRICT
    const dir = freshJournalDir()
    const teardown = setup()
    simulateGrowth(dir)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => teardown()).not.toThrow()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/GUARD JOURNAL CHANGED/)
  })

  it('no growth at all: teardown neither throws nor warns, in either sole-writer mode', () => {
    // Guards against a mutation that makes the throw/warn unconditional — a check firing on every
    // CLEAN run is exactly as broken as one that never fires on a dirty one, and case-by-case
    // assertions above wouldn't catch it: they only look at what happens WHEN there is growth.
    delete process.env.CI
    delete process.env.WT_GUARD_JOURNAL_ISOLATION_STRICT
    const dirWarnMode = freshJournalDir()
    const teardownWarnMode = setup()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => teardownWarnMode()).not.toThrow()
    expect(warnSpy).not.toHaveBeenCalled()
    void dirWarnMode

    process.env.CI = 'true'
    const dirStrictMode = freshJournalDir()
    const teardownStrictMode = setup()
    expect(() => teardownStrictMode()).not.toThrow()
    void dirStrictMode
  })
})

/** A throw-away home whose installed_plugins.json names the plugin, with both journal dirs created and the env pointing at it. */
function fakeInstalledHome(version = '0.0.1'): { canonical: string; legacy: string; configDir: string } {
  const home = mkdtempSync(join(os.tmpdir(), 'wt-guard-journal-global-setup-home-'))
  tempDirs.push(home)
  const configDir = join(home, '.claude')
  mkdirSync(join(configDir, 'plugins'), { recursive: true })
  writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'workflow-toolbox@fixture-market': [{ scope: 'user', version }] },
  }))
  const canonical = join(configDir, 'plugins', 'data', 'workflow-toolbox-fixture-market', 'wt-guard-journal')
  const legacy = join(home, '.local', 'state', 'wt-guard-journal')
  mkdirSync(canonical, { recursive: true })
  mkdirSync(legacy, { recursive: true })
  isolatedHome = home
  delete process.env.WT_GUARD_JOURNAL_DIR
  delete process.env.CLAUDE_PLUGIN_DATA
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.WT_GUARD_JOURNAL_ISOLATION_STRICT = '1'
  return { canonical, legacy, configDir }
}

// Card 1878424989787490016: with nothing redirecting it, the plugin writer (plugin/bin/lib/guard-journal.mjs
// baseDir()) journals into the CANONICAL plugin data dir whenever installed_plugins.json names workflow-toolbox, and
// into the legacy ~/.local/state dir otherwise. A backstop watching only the legacy dir never sees a leak on an
// installed machine. These cases build a throw-away home whose installed_plugins.json names the plugin, so the
// canonical dir is the one a leaking test would write.
describe('guard-journal-isolation.global-setup: watches every directory the writer can resolve', () => {
  it('growth in the canonical plugin data dir: teardown throws (strict)', () => {
    const { canonical } = fakeInstalledHome()
    const teardown = setup()
    simulateGrowth(canonical)
    expect(() => teardown()).toThrow(/GUARD JOURNAL CHANGED/)
  })

  it('growth in the legacy dir: teardown still throws (strict)', () => {
    const { legacy } = fakeInstalledHome()
    const teardown = setup()
    simulateGrowth(legacy)
    expect(() => teardown()).toThrow(/GUARD JOURNAL CHANGED/)
  })

  it('no growth in either dir: teardown neither throws nor warns (strict)', () => {
    fakeInstalledHome()
    const teardown = setup()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => teardown()).not.toThrow()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  // The installed version equals this checkout's own, so carry-over is ALLOWED for this home: a resolving call would
  // move the legacy file. The control proves that on the same fixture, so the first half can only pass because the
  // backstop's resolution is the pure one.
  it('resolving the watched dirs never moves a legacy file, on a home where carry-over would move it', () => {
    const { canonical, legacy, configDir } = fakeInstalledHome(OWN_PLUGIN_VERSION)
    writeFileSync(join(legacy, '2026-W41.ndjson'), '{"guard":"private"}\n')
    const teardown = setup()
    expect(() => teardown()).not.toThrow()
    expect(existsSync(join(legacy, '2026-W41.ndjson'))).toBe(true)
    expect(existsSync(join(canonical, '2026-W41.ndjson'))).toBe(false)

    const resolved = resolvePluginDataDir({ env: {}, configDir, fallback: legacy, stderr: { write: () => true } }) as { dir: string }
    expect(resolved.dir).toBe(canonical)
    expect(existsSync(join(canonical, '2026-W41.ndjson'))).toBe(true)
  })
})

describe('guard-journal-isolation.global-setup: watchedJournalDirs is the union of the writer fallbacks', () => {
  it('lists the outer override, the canonical dir under each config dir, the legacy dir per home, and CLAUDE_PLUGIN_DATA', () => {
    const home = mkdtempSync(join(os.tmpdir(), 'wt-guard-journal-global-setup-union-'))
    tempDirs.push(home)
    const defaultConfig = join(home, '.claude')
    const altConfig = join(home, 'alt-config')
    for (const configDir of [defaultConfig, altConfig]) {
      mkdirSync(join(configDir, 'plugins'), { recursive: true })
      writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'workflow-toolbox@m': [{ version: '0.0.1' }] } }))
    }
    const dirs = watchedJournalDirs({
      env: { WT_GUARD_JOURNAL_DIR: join(home, 'override'), CLAUDE_CONFIG_DIR: altConfig, CLAUDE_PLUGIN_DATA: join(home, 'plugin-data') },
      homes: [home],
    })
    expect(dirs).toEqual([
      join(home, 'override'),
      join(altConfig, 'plugins', 'data', 'workflow-toolbox-m', 'wt-guard-journal'),
      join(defaultConfig, 'plugins', 'data', 'workflow-toolbox-m', 'wt-guard-journal'),
      join(home, '.local', 'state', 'wt-guard-journal'),
      join(home, 'plugin-data'),
    ])
  })
})
