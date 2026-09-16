import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// @ts-expect-error Function-hook modules ship as host-loaded JavaScript.
import { readSnapshot, register } from '../../../../plugin/hooks/hooks.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SELFTEST = join(REPO_ROOT, 'toolkit', 'packages', 'build', 'test', 'fixtures', 'what-is-running', 'hooks.selftest.mjs')

function runSelftest(filter?: string) {
  return spawnSync(process.execPath, [SELFTEST], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(filter ? { WT_WIR_SELFTEST_FILTER: filter } : {}), NODE_NO_WARNINGS: '1' },
  })
}

function collector(root: string, extra: Record<string, unknown> = {}) {
  const paths = {
    configDir: join(root, 'config'),
    livenessDir: join(root, 'liveness'),
    suiteRoot: join(root, 'suite'),
    procRoot: join(root, 'proc'),
    now: '2026-09-12T12:30:00Z',
    platform: 'linux',
    ...extra,
  }
  mkdirSync(join(paths.configDir, 'plugins', 'store'), { recursive: true })
  mkdirSync(join(paths.configDir, 'plugins', 'data'), { recursive: true })
  mkdirSync(paths.livenessDir, { recursive: true })
  mkdirSync(join(paths.suiteRoot, 'worktrees'), { recursive: true })
  mkdirSync(paths.procRoot, { recursive: true })
  return paths
}

const processCapability = (env: NodeJS.ProcessEnv = process.env) => ({
  run: async ([command, ...args]: string[]) => {
    if (!command) throw new Error('collector command is empty')
    return { exitCode: 0, stdout: execFileSync(command === 'node' ? process.execPath : command, args, { encoding: 'utf8', env }), stderr: '' }
  },
})

function renderedText(snapshot: unknown) {
  type Hook = (...args: unknown[]) => unknown
  const hooks: Array<{ event: string, matcher?: Record<string, string>, hook: Hook }> = []
  const component = (name: string) => (props: Record<string, unknown> = {}) => ({ name, props })
  const $ = {
    env: { get: async () => undefined },
    process: { run: async () => ({ exitCode: 0, stdout: JSON.stringify(snapshot), stderr: '' }) },
    store: { get: async () => false, set: async () => undefined },
    command: { register: async () => undefined },
    clock: { every: () => ({ cancel: () => undefined }) },
    ui: {
      open: async () => undefined, close: async () => undefined, invalidate: () => undefined, log: async () => undefined,
      resolve: async () => ({ Box: component('Box'), Text: component('Text'), Button: component('Button'), Link: component('Link') }),
    },
  }
  register((event: string, matcher: Record<string, string> | Hook, hook?: Hook) => hooks.push({ event, ...(hook ? { matcher: matcher as Record<string, string> } : {}), hook: hook ?? matcher as Hook }), {})
  const find = (event: string, componentName?: string) => hooks.find((hook) => hook.event === event && (!componentName || hook.matcher?.component === componentName))!
  return Promise.resolve(find('session.start').hook($, { cwd: '/workspace/project' }, async () => ({})))
    .then(() => find('command.run').hook($, { command: 'wir' }, async () => ({})))
    .then(() => find('ui.render', 'Pane').hook($, { component: 'Pane', requestId: 'wt-what-is-running' }, async () => ({})))
    .then((tree: unknown) => JSON.stringify(tree, (_key, value) => typeof value === 'function' ? '[function]' : value))
}

describe('What is running collector seam', () => {
  it.skipIf(process.platform !== 'linux')('runs every assertion from the ported hardened selftest (requires /proc)', () => {
    const result = runSelftest()
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(result.stdout).toContain('tests: ')
  }, 60_000)

  it('keeps pane-open state local to one session registration', () => {
    const result = runSelftest('[per-session pane state] one registration')
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(result.stdout).toContain('tests: 1/1')
  })

  it('keeps a detail toggle open while a slow snapshot poll overlaps it', () => {
    const result = runSelftest('[toggle race]')
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(result.stdout).toContain('tests: 1/1')
  })

  it('renders non-Linux process discovery as unavailable instead of an empty process list', async () => {
    const text = await renderedText({
      discovery: 'available', rows: [], sessions: [],
      services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] },
      processDiscovery: 'unknown', processPartialReason: 'unavailable on this platform',
    })
    expect(text).toContain('unavailable on this platform')
    expect(text).not.toContain('Nothing running in the background.')
  })

  it('renders unknown process age when getconf is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wir-clock-'))
    try {
      const paths = collector(root, { executablePlatform: 'linux' })
      writeFileSync(join(paths.procRoot, 'uptime'), '20000.00 1000.00\n')
      mkdirSync(join(paths.procRoot, '500'))
      writeFileSync(join(paths.procRoot, '500', 'status'), 'Name:\tcodex\nPPid:\t1\n')
      writeFileSync(join(paths.procRoot, '500', 'cmdline'), 'codex\0app-server\0')
      writeFileSync(join(paths.procRoot, '500', 'stat'), `500 (codex) S 1 ${Array(17).fill('0').join(' ')} 1880000\n`)
      const snapshot = await readSnapshot({ process: processCapability({ ...process.env, PATH: '/missing' }) }, paths)
      expect(snapshot.helpers.items[0].age).toBe('unknown')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('finds a lane launched by opencode.cmd on a simulated win32 executable surface', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wir-win32-'))
    try {
      const paths = collector(root, { executablePlatform: 'win32', processEnv: { PATH: '', PATHEXT: '.CMD;.EXE' } })
      const worktree = join(paths.suiteRoot, 'worktrees', 'cmd-lane')
      const lane = join(worktree, '.lane')
      mkdirSync(lane, { recursive: true })
      writeFileSync(join(lane, 'brief.md'), '# Brief: card 1862698281071544999: CMD lane\n')
      writeFileSync(join(lane, 'run.log'), 'working\n')
      writeFileSync(join(lane, 'pid'), '700')
      for (const file of ['brief.md', 'run.log', 'pid']) utimesSync(join(lane, file), new Date('2026-09-12T12:00:00Z'), new Date('2026-09-12T12:00:00Z'))
      mkdirSync(join(paths.procRoot, '700'))
      writeFileSync(join(paths.procRoot, '700', 'status'), 'Name:\topencode.exe\nPPid:\t1\n')
      writeFileSync(join(paths.procRoot, '700', 'cmdline'), ['opencode.cmd', 'run', '--dir', worktree].join('\0') + '\0')
      const snapshot = await readSnapshot({ process: processCapability() }, paths)
      expect(snapshot.rows.some((row: { id: string }) => row.id === '1862698281071544999')).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
