import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// @ts-expect-error Function-hook modules ship as host-loaded JavaScript.
import { readSnapshot, register } from '../../../../plugin/hooks/hooks.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SELFTEST = join(REPO_ROOT, 'toolkit', 'packages', 'build', 'test', 'fixtures', 'what-is-running', 'hooks.selftest.mjs')
const PHASE_COST_FIXTURE = join(REPO_ROOT, 'toolkit', 'packages', 'build', 'test', 'fixtures', 'what-is-running', 'phase-cost.json')

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

async function renderedTree(snapshot: unknown, beforeFirstResult = false) {
  type Hook = (...args: unknown[]) => unknown
  const hooks: Array<{ event: string, matcher?: Record<string, string>, hook: Hook }> = []
  const component = (name: string) => (props: Record<string, unknown> = {}) => ({ name, props })
  let finishCollection: ((value: { exitCode: number; stdout: string; stderr: string }) => void) | undefined
  const $ = {
    env: { get: async () => undefined },
    process: { run: async () => beforeFirstResult
      ? new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => { finishCollection = resolve })
      : ({ exitCode: 0, stdout: JSON.stringify(snapshot), stderr: '' }) },
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
  await find('session.start').hook($, { cwd: '/workspace/wt-suite' }, async () => ({}))
  const opening = Promise.resolve(find('command.run').hook($, { command: 'wir' }, async () => ({})))
  if (beforeFirstResult) {
    while (!finishCollection) await Promise.resolve()
    const tree = await find('ui.render', 'Pane').hook($, { component: 'Pane', requestId: 'wt-what-is-running' }, async () => ({}))
    finishCollection({ exitCode: 0, stdout: JSON.stringify(snapshot), stderr: '' })
    await opening
    return tree
  }
  await opening
  return find('ui.render', 'Pane').hook($, { component: 'Pane', requestId: 'wt-what-is-running' }, async () => ({}))
}

async function renderedText(snapshot: unknown) {
  return JSON.stringify(await renderedTree(snapshot), (_key, value) => typeof value === 'function' ? '[function]' : value)
}

function textChildren(tree: unknown): string[] {
  if (!tree || typeof tree !== 'object') return []
  const node = tree as { name?: string; props?: { children?: unknown } }
  const own = node.name === 'Text'
    ? (Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]).filter((value): value is string => typeof value === 'string')
    : []
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]
  return [...own, ...children.flatMap(textChildren)]
}

describe('What is running collector seam', () => {
  it('reads archived per-phase costs, preserves unknown, and records visible provenance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wir-phase-cost-'))
    try {
      const paths = collector(root)
      const cardId = '1866347363803596065'
      const worktree = join(paths.suiteRoot, 'worktrees', 'phase-cost')
      const lane = join(worktree, '.lane')
      const archive = join(paths.suiteRoot, 'reports', `${cardId}-fixture`)
      mkdirSync(lane, { recursive: true })
      mkdirSync(archive, { recursive: true })
      writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId, route: 'FULL' }))
      writeFileSync(join(lane, 'card.md'), `# card ${cardId}: Per-phase cost\n`)
      writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=discovery\nlifecycle: accepted phase=plan\n')
      writeFileSync(join(lane, 'summary.json'), JSON.stringify({ archive: { path: archive } }))
      writeFileSync(join(archive, 'cost.json'), readFileSync(PHASE_COST_FIXTURE, 'utf8'))

      const snapshot = await readSnapshot({ process: processCapability() }, paths)
      const row = snapshot.rows.find((item: { id: string }) => item.id === cardId)
      expect(row.phaseCosts.discovery).toEqual({ input: 1234, output: 901, cacheRead: 2345678, cacheWrite: 5678, total: 2353491 })
      expect(row.phaseCosts.plan).toBe('unknown')
      expect(row.phaseCostSource).toBe(join(archive, 'cost.json'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('falls back to the bounded live usage file and attributes messages by lifecycle timestamp', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wir-live-cost-'))
    try {
      const paths = collector(root)
      const cardId = '1866347363803596066'
      const worktree = join(paths.suiteRoot, 'worktrees', 'live-cost')
      const lane = join(worktree, '.lane')
      mkdirSync(lane, { recursive: true })
      writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId, route: 'LITE' }))
      writeFileSync(join(lane, 'card.md'), `# card ${cardId}: Live cost\n`)
      writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=discovery\n')
      writeFileSync(join(lane, 'lifecycle.json'), JSON.stringify({ phases: [{ phase: 'discovery', round: null, entered_at: 1000, exited_at: null }], lanes: [] }))
      writeFileSync(join(lane, 'usage.json'), JSON.stringify({ messages: [{ arrived_at: '1970-01-01T00:00:02.000Z', input: 10, output: 2, cache_read: 30, cache_creation: 4 }] }))

      const snapshot = await readSnapshot({ process: processCapability() }, paths)
      const row = snapshot.rows.find((item: { id: string }) => item.id === cardId)
      expect(row.phaseCosts.discovery).toEqual({ input: 10, output: 2, cacheRead: 30, cacheWrite: 4, total: 46 })
      expect(row.phaseCostSourceKind).toBe('live usage file')
      expect(row.phaseCostSource).toBe(join(lane, 'usage.json'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('removes every control character from Text children in the captured reproducing snapshot', async () => {
    const captured = join(REPO_ROOT, '.lane', 'snapshot-with-control-chars.json')
    const snapshot = existsSync(captured)
      ? JSON.parse(readFileSync(captured, 'utf8'))
      : {
          discovery: 'available',
          rows: [],
          sessions: [{
            id: 'session-control', project: 'wt-suite', name: 'session\tname',
            cards: [{
              id: '1866128345771541669', title: 'card\rtitle',
              actors: [{
                id: 'lane-control', kind: 'external', label: 'Lane\x1b[31m red\x1b[0m',
                title: 'visible\x1b]0;hidden\x07 title', activity: '$ echo\twords\x7f', phaseAvailability: 'plain\nlane',
              }],
            }], actors: [],
          }],
          services: { count: 1, items: [{ label: 'server\x00name', age: '1\tmin' }] },
          helpers: { count: 1, oldest: '2\rmin', items: [{ label: 'helper\x1b[32m green\x1b[0m', age: '2 min' }] },
        }
    const children = textChildren(await renderedTree(snapshot))
    expect(children.length).toBeGreaterThan(0)
    expect(children.join('\n')).toMatch(/(?:visible title|tail log red\s+bell)/)
    expect(children.every((child) => !/[\x00-\x1f\x7f]/.test(child))).toBe(true)
  })

  it('uses the test-only snapshot file seam instead of running the collector', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wir-fixed-snapshot-'))
    try {
      const file = join(root, 'snapshot.json')
      const expected = { discovery: 'available', rows: [], sessions: [], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'unknown', items: [] } }
      writeFileSync(file, JSON.stringify(expected))
      const calls: string[][] = []
      const snapshot = await readSnapshot({
        env: { get: async (name: string) => name === 'WT_WHAT_IS_RUNNING_SNAPSHOT_FILE' ? file : undefined },
        process: { run: async (argv: string[]) => { calls.push(argv); return processCapability().run(argv) } },
      }, {})
      expect(snapshot).toEqual(expected)
      expect(calls[0]?.at(-1)).toBe(file)
      expect(calls[0]?.join(' ')).not.toContain('const timingStartedAt')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('shows a reading state before the first collector result arrives', async () => {
    const text = JSON.stringify(await renderedTree({ discovery: 'available', rows: [], sessions: [] }, true))
    expect(text).toContain('Reading the running work…')
    expect(text).not.toContain('collector failed')
  })

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

  it.skipIf(process.platform === 'win32')('renders unknown process age when getconf is unavailable [synthetic Linux /proc collector]', async () => {
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

  it.skipIf(process.platform === 'win32')('finds a lane launched by opencode.cmd on a simulated win32 executable surface [synthetic Linux /proc evidence]', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wir-win32-'))
    try {
      const paths = collector(root, { executablePlatform: 'win32', processEnv: { PATH: '', PATHEXT: '.CMD;.EXE' } })
      const worktree = join(paths.suiteRoot, 'worktrees', 'cmd-lane')
      const lane = join(worktree, '.lane')
      mkdirSync(lane, { recursive: true })
      writeFileSync(join(lane, 'brief.md'), '# Brief: card 1862698281071544999: CMD lane\n')
      writeFileSync(join(lane, 'run.log'), '$ \x1b[31mecho visible\x1b[0m\twords\x07\r\n')
      writeFileSync(join(lane, 'pid'), '700')
      for (const file of ['brief.md', 'run.log', 'pid']) utimesSync(join(lane, file), new Date('2026-09-12T12:00:00Z'), new Date('2026-09-12T12:00:00Z'))
      mkdirSync(join(paths.procRoot, '700'))
      writeFileSync(join(paths.procRoot, '700', 'status'), 'Name:\topencode.exe\nPPid:\t1\n')
      writeFileSync(join(paths.procRoot, '700', 'cmdline'), ['opencode.cmd', 'run', '--dir', worktree].join('\0') + '\0')
      const snapshot = await readSnapshot({ process: processCapability() }, paths)
      const row = snapshot.rows.find((item: { id: string }) => item.id === '1862698281071544999')
      expect(row).toBeTruthy()
      expect(row.activity).toBe('$ echo visible words')
      expect(row.activity).not.toMatch(/[\x00-\x1f\x7f]/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
