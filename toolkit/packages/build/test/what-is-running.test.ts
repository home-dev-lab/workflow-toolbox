import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

// @ts-expect-error Function-hook modules ship as host-loaded JavaScript.
import { COLLECTOR_TIMEOUT_MS, fileUrlPath, readSnapshot, register, RENDER_JOURNAL_MAX_BYTES, renderPane } from '../../../../plugin/hooks/hooks.js'

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

async function paneHarness(initialSnapshot: unknown, options: Record<string, unknown> = {}, slowComponents = false, executeJournal = false, collectorRun?: (init?: Record<string, unknown>) => Promise<{ exitCode: number; stdout: string; stderr: string }>) {
  type Hook = (...args: unknown[]) => unknown
  const hooks: Array<{ event: string; matcher?: Record<string, string>; hook: Hook }> = []
  const timers: Array<() => Promise<void>> = []
  const journal: Array<Record<string, unknown>> = []
  const runInits: Array<{ argc: number; init: Record<string, unknown> | undefined }> = []
  let snapshot = initialSnapshot
  let opens = 0
  let closes = 0
  let invalidations = 0
  const component = (name: string) => (props: Record<string, unknown> = {}) => {
    if (slowComponents) {
      const until = Date.now() + 2
      while (Date.now() < until) { /* deterministic test-only render delay */ }
    }
    return { name, props }
  }
  const $ = {
    env: { get: async () => undefined },
    process: { run: async (argv: string[], init?: Record<string, unknown>) => {
      runInits.push({ argc: argv.length, init })
      if (argv.length === 6) {
        journal.push(JSON.parse(argv[4]!))
        if (executeJournal) execFileSync(argv[0] === 'node' ? process.execPath : argv[0]!, argv.slice(1))
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (collectorRun) return collectorRun(init)
      return { exitCode: 0, stdout: JSON.stringify(snapshot), stderr: '' }
    } },
    command: { register: async () => undefined },
    clock: { every: (_ms: number, fn: () => Promise<void>) => { timers.push(fn); return { cancel: () => undefined } } },
    ui: {
      open: async () => { opens += 1 }, close: async () => { closes += 1 }, invalidate: () => { invalidations += 1 }, log: async () => undefined,
      resolve: async () => ({ Box: component('Box'), Text: component('Text'), Button: component('Button'), Link: component('Link') }),
    },
  }
  register((event: string, matcher: Record<string, string> | Hook, hook?: Hook) => hooks.push({ event, ...(hook ? { matcher: matcher as Record<string, string> } : {}), hook: hook ?? matcher as Hook }), options)
  const find = (event: string, componentName?: string) => hooks.find((hook) => hook.event === event && (!componentName || hook.matcher?.component === componentName))!
  await find('session.start').hook($, { cwd: '/workspace/wt-suite' }, async () => ({}))
  await find('command.run').hook($, { command: 'wir' }, async () => ({}))
  return {
    render: () => find('ui.render', 'Pane').hook($, { component: 'Pane', requestId: 'wt-what-is-running', props: { bodyColumns: 120, bodyRows: 40 } }, async () => ({})),
    tick: () => timers[0]!(),
    tickLatest: () => timers.at(-1)!(),
    timerCount: () => timers.length,
    collectorInits: () => runInits.filter((call) => call.argc !== 6).map((call) => call.init),
    setSnapshot: (value: unknown) => { snapshot = value },
    journal,
    counts: () => ({ opens, closes, invalidations }),
  }
}

function allTreeStrings(tree: unknown, path = '$'): Array<{ path: string; value: string }> {
  if (typeof tree === 'string') return [{ path, value: tree }]
  if (!tree || typeof tree !== 'object') return []
  return Object.entries(tree).flatMap(([key, value]) => allTreeStrings(value, `${path}.${key}`))
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
  it('resolves the shipped price table URL to a native Windows drive path', () => {
    expect(fileUrlPath(new URL('file:///C:/workflow-toolbox/plugin/pricing/model-prices.json'), 'win32'))
      .toBe('C:\\workflow-toolbox\\plugin\\pricing\\model-prices.json')
  })

  it('resolves the price table URL inside a hooks sandbox that has no process global', async () => {
    // The hooks module runs in an environment without Node globals: a `process` reference at module
    // scope makes every collection fail with "process is not defined" on the real host.
    const source = readFileSync(new URL('../../../../plugin/hooks/hooks.js', import.meta.url), 'utf8')
    const sandbox = { URL, decodeURIComponent, console, exports: {} as Record<string, unknown> }
    const body = source
      .replace(/^export (function|const|class)/gm, '$1')
      .match(/function fileUrlPath[\s\S]*?\n}/)?.[0]
    expect(body).toBeTruthy()
    const fn = vm.runInNewContext(`${body}; fileUrlPath`, sandbox) as typeof fileUrlPath
    expect(fn(new URL('file:///home/doublefx/plugin/pricing/model-prices.json')))
      .toBe('/home/doublefx/plugin/pricing/model-prices.json')
    expect(fn(new URL('file:///C:/workflow-toolbox/plugin/pricing/model-prices.json')))
      .toBe('C:\\workflow-toolbox\\plugin\\pricing\\model-prices.json')
  })

  it('reports a live suite-lock holder from the fixture lock directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wir-suite-lock-live-'))
    try {
      const suiteLockRoot = join(root, 'suite-lock')
      const paths = collector(root, { suiteLockRoot })
      const lockDir = join(suiteLockRoot, 'lock.d')
      mkdirSync(lockDir, { recursive: true })
      writeFileSync(join(lockDir, 'holder.json'), JSON.stringify({
        pid: process.pid,
        argv: ['pnpm', 'test', '--', 'a-very-long-argument-that-makes-the-recorded-command-need-shortening-for-the-pane'],
        cwd: '/workspace/wt-suite/.claude/worktrees/card-one',
        startedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
      }))

      const snapshot = await readSnapshot({ process: processCapability() }, paths)
      expect(snapshot.suiteLock).toMatchObject({
        status: 'running',
        pid: process.pid,
        command: 'pnpm test -- a-very-long-argument-that-makes-the-recorded-command-nee...',
        worktree: '/workspace/wt-suite/.claude/worktrees/card-one',
      })
      // An elapsed age, never a clock time: a UTC "12:00Z" reads an hour off to a reader in London.
      expect(snapshot.suiteLock.age).toMatch(/^1[23] min$/)
      expect(snapshot.suiteLock).not.toHaveProperty('since')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('reports a dead suite-lock holder as stale, never running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wir-suite-lock-stale-'))
    try {
      const suiteLockRoot = join(root, 'suite-lock')
      const paths = collector(root, { suiteLockRoot })
      const lockDir = join(suiteLockRoot, 'lock.d')
      mkdirSync(lockDir, { recursive: true })
      writeFileSync(join(lockDir, 'holder.json'), JSON.stringify({
        pid: 2_147_483_647, argv: ['pnpm', 'test'], cwd: '/workspace/stale', startedAt: '2026-09-12T12:00:00.000Z',
      }))

      const snapshot = await readSnapshot({ process: processCapability() }, paths)
      expect(snapshot.suiteLock).toMatchObject({ status: 'stale', pid: 2_147_483_647, command: 'pnpm test', worktree: '/workspace/stale' })
      expect(snapshot.suiteLock.status).not.toBe('running')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('reports unreadable suite-lock data as unknown instead of omitting it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wir-suite-lock-unknown-'))
    const suiteLockRoot = join(root, 'suite-lock')
    const paths = collector(root, { suiteLockRoot })
    const lockDir = join(suiteLockRoot, 'lock.d')
    try {
      mkdirSync(lockDir, { recursive: true })
      writeFileSync(join(lockDir, 'holder.json'), '{not-json')
      chmodSync(lockDir, 0o000)

      const snapshot = await readSnapshot({ process: processCapability() }, paths)
      expect(snapshot.suiteLock).toEqual({ status: 'unknown' })
    } finally {
      chmodSync(lockDir, 0o700)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('renders one suite row with command, elapsed age, and the worktree name', async () => {
    const text = await renderedText({
      discovery: 'available', rows: [], sessions: [], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] },
      suiteLock: { status: 'running', pid: 42, command: 'pnpm test', age: '12 min', worktree: '/workspace/wt-suite/.claude/worktrees/card-one/toolkit' },
    })
    // The pane is read narrow: the worktree NAME, not the full path, so the row fits one line.
    expect(text).toContain('Test suite · pnpm test · running 12 min · card-one/toolkit')
    expect(text).not.toContain('/workspace/wt-suite/.claude/worktrees/')
    expect(text.match(/Test suite · pnpm test/g)).toHaveLength(1)
  })

  it('keeps the collector program out of the Windows-limited command line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wir-command-line-'))
    try {
      const paths = collector(root)
      let argv: string[] = []
      await readSnapshot({ process: { run: async (command: string[]) => {
        argv = command
        return processCapability().run(command)
      } } }, paths)
      expect(argv.find((argument) => /snapshot-program\.js$/.test(argument))).toBeTruthy()
      expect(argv.join(' ').length).toBeLessThan(8_000)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

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
      expect(row.phaseCosts.discovery).toMatchObject({ input: 1234, output: 901, cacheRead: 2345678, cacheWrite: 5678, usd: 1.23 })
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
      writeFileSync(join(lane, 'lifecycle.json'), JSON.stringify({ phases: [{ phase: 'discovery', round: null, entered_at: Date.parse('2026-09-12T12:01:00Z'), exited_at: null }], lanes: [] }))
      writeFileSync(join(lane, 'usage.json'), JSON.stringify({ messages: [
        { arrived_at: '2026-09-12T12:02:00.000Z', model: 'claude-opus-5', input: 10, output: 2, cache_read: 30, cache_creation: 4 },
        { arrived_at: '2026-09-12T12:00:00.000Z', model: 'claude-opus-5', input: 1, output: 1, cache_read: 1, cache_creation: 1 },
      ] }))

      const snapshot = await readSnapshot({ process: processCapability() }, paths)
      const row = snapshot.rows.find((item: { id: string }) => item.id === cardId)
      expect(row.phaseCosts.discovery).toMatchObject({ input: 10, output: 2, cacheRead: 30, cacheWrite: 4, usd: 0.00014 })
      expect(row.phaseCosts.discovery.models['claude-opus-5']).toMatchObject({ input: 10, output: 2, cacheRead: 30, cacheWrite: 4, usd: 0.00014 })
      expect(row.runCost).toMatchObject({ input: 11, output: 3, cacheRead: 31, cacheWrite: 5, usd: 0.00017675 })
      expect(row.phaseElapsed.discovery).toBe('29 min')
      expect(row.phaseCostSourceKind).toBe('live usage file')
      expect(row.phaseCostSource).toBe(join(lane, 'usage.json'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('keeps live phase cost unknown when required input usage is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wir-live-cost-unknown-'))
    try {
      const paths = collector(root)
      const cardId = '1866347363803596067'
      const worktree = join(paths.suiteRoot, 'worktrees', 'live-cost-unknown')
      const lane = join(worktree, '.lane')
      mkdirSync(lane, { recursive: true })
      writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId, route: 'LITE' }))
      writeFileSync(join(lane, 'card.md'), `# card ${cardId}: Live cost unknown\n`)
      writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=discovery\n')
      writeFileSync(join(lane, 'lifecycle.json'), JSON.stringify({ phases: [{ phase: 'discovery', round: null, entered_at: 1000, exited_at: null }], lanes: [] }))
      writeFileSync(join(lane, 'usage.json'), JSON.stringify({ messages: [{ arrived_at: '1970-01-01T00:00:02.000Z', output: 2 }] }))

      const snapshot = await readSnapshot({ process: processCapability() }, paths)
      const row = snapshot.rows.find((item: { id: string }) => item.id === cardId)
      expect(row.phaseCosts.discovery).toBe('unknown')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('ignores a 5000-file child coverage directory and keeps ordinary walk exhaustion row-local', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wir-child-coverage-'))
    try {
      const paths = collector(root)
      const cardId = '1867480027738670232'
      const lane = join(paths.suiteRoot, 'worktrees', 'coverage-load', '.lane')
      const coverage = join(lane, 'child-coverage-fixture')
      mkdirSync(coverage, { recursive: true })
      writeFileSync(join(lane, 'brief.md'), `# Brief: card ${cardId}: Coverage load\n`)
      writeFileSync(join(lane, 'run.log'), 'working\n')
      for (let index = 0; index < 5000; index += 1) writeFileSync(join(coverage, `${index}.json`), '{}')

      const snapshot = await readSnapshot({ process: processCapability() }, paths)
      expect(snapshot.discovery).toBe('available')
      expect(snapshot.cappedScans).toEqual([])
      expect(snapshot.rows.find((row: { cardId?: string }) => row.cardId === cardId)).toBeTruthy()

      const ordinary = join(paths.suiteRoot, 'worktrees', 'coverage-load', 'ordinary-volume')
      mkdirSync(ordinary)
      for (let index = 0; index < 1001; index += 1) writeFileSync(join(ordinary, `${index}.txt`), 'evidence')
      const approximate = await readSnapshot({ process: processCapability() }, paths)
      const row = approximate.rows.find((item: { cardId?: string }) => item.cardId === cardId)
      expect(approximate.discovery).toBe('available')
      expect(approximate.cappedScans).toEqual([])
      expect(row.activity).toMatch(/^last write at least /)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('uses the card file title when the lane brief starts with the standard preamble', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wir-preamble-title-'))
    try {
      const paths = collector(root)
      const cardId = '1867758992768370051'
      const lane = join(paths.suiteRoot, 'worktrees', 'preamble-title', '.lane')
      mkdirSync(lane, { recursive: true })
      writeFileSync(join(lane, 'brief.md'), [
        '# Standing preamble for every external-lane brief (paste at the top of `.lane/brief.md`)',
        '',
        '# Implementation brief',
        '',
        `Deliver card ${cardId}.`,
      ].join('\n'))
      writeFileSync(join(lane, `card-${cardId}.md`), '# What is running: show the card title\n')
      writeFileSync(join(lane, 'run.log'), 'working\n')

      const snapshot = await readSnapshot({ process: processCapability() }, paths)
      const row = snapshot.rows.find((item: { cardId?: string }) => item.cardId === cardId)
      expect(row?.title).toBe('What is running: show the card title')
      expect(row?.title).not.toContain('Standing preamble')

      rmSync(join(lane, `card-${cardId}.md`))
      writeFileSync(join(lane, 'brief.md'), [
        '# Standing preamble for every external-lane brief (paste at the top of `.lane/brief.md`)',
        '',
        `# Brief: card ${cardId}: First useful heading`,
      ].join('\n'))
      const fallback = await readSnapshot({ process: processCapability() }, paths)
      expect(fallback.rows.find((item: { cardId?: string }) => item.cardId === cardId)?.title).toBe('First useful heading')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('renders the SDK admission receipt as a queued position and wait reason', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wir-admission-queue-'))
    try {
      const paths = collector(root)
      const cardId = '1867509524609369334'
      const lane = join(paths.suiteRoot, 'worktrees', 'queued-pilot', '.lane')
      mkdirSync(lane, { recursive: true })
      writeFileSync(join(lane, `card-${cardId}.md`), '# Queued SDK pilot\n')
      writeFileSync(join(lane, 'admission.json'), JSON.stringify({
        state: 'queued', cardId, position: 2, waiting: { kind: 'load', load: 14.5, cores: 12 },
      }))

      const snapshot = await readSnapshot({ process: processCapability() }, paths)
      expect(snapshot.rows.find((row: { id: string }) => row.id === cardId)?.queue).toMatchObject({ position: 2, waiting: { kind: 'load' } })
      const scoped = { ...snapshot, sessions: undefined, rows: snapshot.rows.map((row: Record<string, unknown>) => ({ ...row, project: 'wt-suite' })) }
      expect(await renderedText(scoped)).toContain('queued · position 2 · waiting for load 14.5 / 12')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('shows live run total and elapsed time while a running lane cost is pending', async () => {
    const pilot = {
      id: 'pilot-live', kind: 'pilot', label: 'SDK pilot', project: 'wt-suite', sdkLifecycle: true, phase: 'tdd',
      phaseStates: { discovery: 'done', tdd: 'running' }, phaseCosts: { discovery: { input: 10, output: 2, cacheRead: 30, cacheWrite: 4, usd: 1.23 }, tdd: 'unknown' },
      phaseElapsed: { tdd: '29 min' }, runCost: { input: 10, output: 2, cacheRead: 30, cacheWrite: 4, usd: 1.23 },
    }
    const text = await renderedText({
      discovery: 'available', rows: [pilot], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] },
    })
    expect(text).toContain('run total so far: $1.23')
    expect(text).toContain('cost: waiting for the lane to finish · elapsed 29 min')
    const unknownPriceText = await renderedText({
      discovery: 'available', rows: [{ ...pilot, phaseCosts: { discovery: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 'price unknown' } }, runCost: { usd: 'price unknown' } }],
      services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] },
    })
    expect(unknownPriceText).toContain('run total so far: price unknown')
  })

  it('renders layout A with one card title, a stage spine, billed classes per model, and owner-attributed errors', () => {
    const component = (name: string) => (props: Record<string, unknown> = {}) => ({ name, props })
    const pilot = {
      id: 'pilot-layout', kind: 'pilot', label: 'SDK pilot', sdkLifecycle: true, phase: 'tdd', outcome: 'error: typecheck gate failed', route: 'LITE', elapsed: '18 min',
      phaseStates: { discovery: 'done', plan: 'skipped', critic: 'skipped', tdd: 'running', verify: 'not started', review: 'skipped', refutation: 'skipped', harden: 'skipped', report: 'not started' },
      phaseCosts: { discovery: { input: 12, output: 46, cacheRead: 206064, cacheWrite: 57558, usd: 1.23, models: { 'anthropic/claude-opus-5': { input: 12, output: 46, cacheRead: 206064, cacheWrite: 57558, usd: 1.23 } } }, tdd: 'unknown' },
      runCost: { usd: 1.23, models: { 'anthropic/claude-opus-5': { input: 12, output: 46, cacheRead: 206064, cacheWrite: 57558, usd: 1.23 } } },
      phaseElapsed: { tdd: '17 min' }, inspectors: { discovery: { summary: 'Route selected.' } }, gates: { test: 'pass', typecheck: 'fail (1)' }, review: {}, lanes: [],
    }
    const snapshot = { discovery: 'available', collectedAt: new Date().toISOString(), rows: [], sessions: [{ id: 'session-layout', project: 'wt-suite', sessionId: 'd25e8b32-full', cards: [{ id: '1867464091673560164', title: 'Orphan watch: recognise staging lanes and test fixtures before warning', actors: [pilot] }], actors: [] }], services: { count: 0, items: [] }, helpers: { count: 0, items: [] } }
    const render = (bodyColumns: number, expanded = new Set<string>()) => renderPane(
      { Box: component('Box'), Text: component('Text'), Button: component('Button'), Link: component('Link') }, snapshot, expanded, new Map(), 'wt-suite', false,
      { close: () => undefined, switchScope: () => undefined, toggle: () => undefined, select: () => undefined, closeView: () => undefined, bodyColumns },
    )
    for (const width of [40, 70, 80, 160]) {
      const collapsed = allTreeStrings(render(width)).map(({ value }) => value).join(' ')
      expect(collapsed.match(/Orphan watch:/g)).toHaveLength(1)
      expect(collapsed).toMatch(/SDK pilot.*drives the stages below/)
      expect(collapsed).toMatch(/TDD ✗.*ERROR/)
      expect(collapsed).toContain('next: Verify, Report · skipped: 5')
      expect(collapsed).toContain('for the pilot runner')
      expect(collapsed).not.toMatch(/(?:^|[ ·])unknown(?:$|[ ·])/i)
    }
    const expanded = allTreeStrings(render(80, new Set(['pilot-layout']))).map(({ value }) => value).join(' ')
    expect(expanded).toContain('anthropic/claude-opus-5 · input 12 · cache write 57 558 · cache read 206 064 · output 46 · $1.23')
    expect(expanded).toContain('owner: pilot runner')
  })

  it('accumulates repeated archived lifecycle rounds for one normalized phase', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wir-phase-rounds-'))
    try {
      const paths = collector(root)
      const cardId = '1866347363803596068'
      const worktree = join(paths.suiteRoot, 'worktrees', 'phase-rounds')
      const lane = join(worktree, '.lane')
      const archive = join(paths.suiteRoot, 'reports', `${cardId}-fixture`)
      mkdirSync(lane, { recursive: true }); mkdirSync(archive, { recursive: true })
      writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId, route: 'FULL' }))
      writeFileSync(join(lane, 'card.md'), `# card ${cardId}: Phase rounds\n`)
      writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=critic\n')
      writeFileSync(join(lane, 'summary.json'), JSON.stringify({ archive: { path: archive } }))
      writeFileSync(join(archive, 'cost.json'), JSON.stringify({ phases: [
        { phase: 'critic', round: 1, models: { opus: { input: 100, output: 1, cache_read: 2, cache_write: 3 } }, unknown: [] },
        { phase: 'critic', round: 2, models: { opus: { input: 20, output: 4, cache_read: 5, cache_write: 6 } }, unknown: [] },
      ] }))

      const snapshot = await readSnapshot({ process: processCapability() }, paths)
      const row = snapshot.rows.find((item: { id: string }) => item.id === cardId)
      expect(row.phaseCosts.critic).toMatchObject({ input: 120, output: 5, cacheRead: 7, cacheWrite: 9, usd: 'price unknown' })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('surfaces malformed archived cost instead of falling back to live usage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wir-malformed-archive-'))
    try {
      const paths = collector(root)
      const cardId = '1866347363803596069'
      const worktree = join(paths.suiteRoot, 'worktrees', 'malformed-archive')
      const lane = join(worktree, '.lane')
      const archive = join(paths.suiteRoot, 'reports', `${cardId}-fixture`)
      mkdirSync(lane, { recursive: true }); mkdirSync(archive, { recursive: true })
      writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId, route: 'LITE' }))
      writeFileSync(join(lane, 'card.md'), `# card ${cardId}: Malformed archive\n`)
      writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=discovery\n')
      writeFileSync(join(lane, 'summary.json'), JSON.stringify({ archive: { path: archive } }))
      writeFileSync(join(archive, 'cost.json'), '{broken')
      writeFileSync(join(lane, 'usage.json'), JSON.stringify({ messages: [{ arrived_at: '1970-01-01T00:00:02.000Z', input: 10, output: 2 }] }))

      const snapshot = await readSnapshot({ process: processCapability() }, paths)
      const row = snapshot.rows.find((item: { id: string }) => item.id === cardId)
      expect(row.phaseCostSource).toBe(join(archive, 'cost.json'))
      expect(row.phaseCostSourceKind).toBe('malformed archive cost.json')
      expect(row.phaseCosts.discovery).toBe('unknown')
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

  it('[grey pane criterion 1] strips control characters from every string in the whole returned tree', () => {
    const dirty = (value: string) => `${value}\x1b[31m\t\x7f`
    const snapshot = {
      discovery: 'available',
      rows: [{
        id: dirty('pilot-1'), kind: 'pilot', label: dirty('Pilot'), project: dirty('wt-suite'), branch: dirty('card/dirty'),
        title: dirty('A title'), phase: 'plan', phaseStates: { discovery: dirty('done'), plan: dirty('running') },
        model: dirty('opus'), activity: dirty('working'), elapsed: dirty('2 min'), outcome: dirty('running'),
        gates: { test: dirty('green') }, review: { decision: dirty('accepted') }, lanes: [{ id: dirty('lane-1'), kind: 'external', label: dirty('Lane'), title: dirty('Lane title'), activity: dirty('tail'), phaseAvailability: dirty('plain lane') }],
        inspectors: { discovery: { summary: dirty('Summary'), href: 'https://example.test/report' } }, phaseCosts: { discovery: 'unknown' },
        cardUrl: 'https://example.test/card',
      }],
      services: { count: 1, items: [{ label: dirty('server'), age: dirty('1 min') }] },
      helpers: { count: 1, oldest: dirty('2 min'), items: [{ label: dirty('helper'), age: dirty('2 min') }] },
    }
    const component = (name: string) => (props: Record<string, unknown> = {}) => ({ name, props })
    const repairs: unknown[] = []
    const tree = renderPane(
      { Box: component('Box'), Text: component('Text'), Button: component('Button'), Link: component('Link') },
      snapshot, new Set(), new Map(), 'wt-suite', true,
      { close: () => undefined, switchScope: () => undefined, toggle: () => undefined, select: () => undefined, closeView: () => undefined, bodyColumns: 120, onRepair: (items: unknown[]) => repairs.push(...items) },
    )
    const strings = allTreeStrings(tree)
    expect(strings.length).toBeGreaterThan(0)
    expect(repairs.length).toBeGreaterThan(0)
    expect(strings.filter(({ value }) => /[\x00-\x1f\x7f]/.test(value))).toEqual([])
    expect(strings.some(({ value }) => /^\[▶ Pilot\s*\]$/.test(value))).toBe(true)
  })

  it('[grey pane criterion 2] returns a valid explanatory pane with Close when rendering throws', async () => {
    const harness = await paneHarness({ discovery: 'available', rows: [{ id: 'broken', kind: 'pilot', label: 'Broken', project: 'wt-suite', phase: 'unknown', lanes: {} }] })
    const tree = await harness.render()
    const strings = allTreeStrings(tree).map(({ value }) => value)
    expect(strings.join(' ')).toContain('The display failed: (row.lanes || []).map is not a function')
    expect(strings).toContain('[Close]')
    expect(strings.every((value) => !/[\x00-\x1f\x7f]/.test(value))).toBe(true)
  })

  it('[grey pane criterion 3] journals repaired, thrown, and slow renders with bounded sanitized records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-wir-render-journal-'))
    try {
      const journalFile = join(root, 'plugins', 'data', 'wt-what-is-running-render.jsonl')
      mkdirSync(join(root, 'plugins', 'data'), { recursive: true })
      writeFileSync(journalFile, `${JSON.stringify({ old: 'x'.repeat(RENDER_JOURNAL_MAX_BYTES) })}\n`)
      const repaired = await paneHarness({ discovery: 'available', rows: [{ id: 'dirty', kind: 'pilot', label: 'Dirty\x1b[31m', project: 'wt-suite', phase: 'unknown', lanes: [] }] }, { slowRenderMs: 0, configDir: root }, true, true)
      await repaired.render()
      const thrown = await paneHarness({ discovery: 'available', rows: [{ id: 'broken', kind: 'pilot', label: 'Broken', project: 'wt-suite', phase: 'unknown', lanes: {} }] }, { configDir: root }, false, true)
      await thrown.render()
      await Promise.resolve()
      const records = [...repaired.journal, ...thrown.journal]
      expect(records.map((record) => record.kind)).toEqual(expect.arrayContaining(['repaired-tree', 'slow-render', 'render-throw']))
      expect(records.every((record) => typeof record.timestamp === 'string' && JSON.stringify(record.viewport) === '{"columns":120,"rows":40}')).toBe(true)
      expect(records.every((record) => !/[\x00-\x1f\x7f]/.test(String(record.detail)))).toBe(true)
      expect(statSync(journalFile).size).toBeLessThanOrEqual(RENDER_JOURNAL_MAX_BYTES)
      expect(readFileSync(journalFile, 'utf8').trim().split('\n').every((line) => JSON.parse(line))).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('[grey pane criterion 4] redraws normally on the existing scheduled refresh after a failed render', async () => {
    const harness = await paneHarness({ discovery: 'available', rows: [{ id: 'broken', kind: 'pilot', label: 'Broken', project: 'wt-suite', phase: 'unknown', lanes: {} }] })
    expect(JSON.stringify(await harness.render())).toContain('The display failed')
    harness.setSnapshot({ discovery: 'available', rows: [], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] } })
    await harness.tick()
    const recovered = JSON.stringify(await harness.render())
    expect(recovered).toContain('Nothing running in the background.')
    expect(recovered).not.toContain('The display failed')
    expect(harness.counts()).toEqual({ opens: 1, closes: 0, invalidations: 2 })
  })

  const idleSnapshot = { discovery: 'available', rows: [], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] } }
  const findByKey = (value: unknown, key: string): Record<string, unknown> | undefined => {
    if (Array.isArray(value)) { for (const item of value) { const hit = findByKey(item, key); if (hit) return hit } return undefined }
    if (!value || typeof value !== 'object') return undefined
    const props = (value as { props?: Record<string, unknown> }).props
    if (props?.key === key) return props
    return findByKey(props?.children, key)
  }

  it('bounds the real collector call with its timeout through the session wiring', async () => {
    const harness = await paneHarness(idleSnapshot, { collectorTimeoutMs: 30_000 })
    await harness.render()

    expect(harness.collectorInits().length).toBeGreaterThan(0)
    expect(COLLECTOR_TIMEOUT_MS).toBe(30_000)
    expect(harness.collectorInits().every((init) => init?.timeoutMs === 30_000)).toBe(true)
  })

  it('keeps the last snapshot through a timeout, journals the exact cause, and clears the notice after recovery', async () => {
    const good = { discovery: 'available', collectedAt: new Date(Date.now() - 40_000).toISOString(), rows: [{ id: 'still-visible', kind: 'external', project: 'wt-suite', label: 'Lane', title: 'Visible work', outcome: 'running' }], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] } }
    const recovered = { ...good, collectedAt: new Date().toISOString(), rows: [{ ...good.rows[0], title: 'Recovered work' }] }
    let call = 0
    const harness = await paneHarness(good, { collectorTimeoutMs: 30_000 }, false, false, async () => {
      call += 1
      if (call === 1) return { exitCode: 0, stdout: JSON.stringify(good), stderr: '' }
      if (call === 2) throw Object.assign(new Error('$.process.run(node) aborted: still running after 30000ms'), { code: 'ETIMEDOUT' })
      return { exitCode: 0, stdout: JSON.stringify(recovered), stderr: '' }
    })

    await harness.tick()
    let text = textChildren(await harness.render()).join('\n')
    expect(text).toContain('Visible work')
    expect(text).toContain('updated 40 s ago · last refresh failed, retrying')
    expect(text).toContain('workflow-toolbox plugin')
    expect(text).not.toContain('$.process.run(node)')
    expect(harness.journal.at(-1)).toMatchObject({ kind: 'collector-failure', pluginVersion: '0.184.0' })
    expect(harness.journal.at(-1)?.detail).toContain('$.process.run(node) aborted: still running after 30000ms')

    const details = findByKey(await harness.render(), 'detail-toggle:row:collector-failure')
    ;(details!.onPress as () => void)()
    text = textChildren(await harness.render()).join('\n')
    expect(text).toContain('$.process.run(node) aborted: still running after 30000ms')
    expect(text).toContain('journal: ')
    expect(text).toContain('what-is-running-errors.jsonl')

    await harness.tick()
    text = textChildren(await harness.render()).join('\n')
    expect(text).toContain('Recovered work')
    expect(text).not.toContain('last refresh failed')
  })

  it('names the plugin on a first-load failure and hides technical detail until expanded', async () => {
    const technical = 'collector failed (exit code 17; exact fixture failure)'
    const harness = await paneHarness(idleSnapshot, {}, false, false, async () => ({ exitCode: 17, stdout: '', stderr: 'exact fixture failure' }))
    let text = textChildren(await harness.render()).join('\n')
    expect(text).toContain('The workflow-toolbox plugin could not read the running work; it will retry.')
    expect(text).not.toContain(technical)

    const details = findByKey(await harness.render(), 'detail-toggle:row:collector-failure')
    ;(details!.onPress as () => void)()
    text = textChildren(await harness.render()).join('\n')
    expect(text).toContain(technical)
    expect(text).toContain('what-is-running-errors.jsonl')
  })

  it('never starts overlapping slow collections', async () => {
    let calls = 0
    let finishSlow: ((value: { exitCode: number; stdout: string; stderr: string }) => void) | undefined
    const harness = await paneHarness(idleSnapshot, {}, false, false, async () => {
      calls += 1
      if (calls === 1) return { exitCode: 0, stdout: JSON.stringify(idleSnapshot), stderr: '' }
      return new Promise((resolve) => { finishSlow = resolve })
    })
    const slow = harness.tick()
    while (!finishSlow) await Promise.resolve()
    await harness.tick()
    expect(calls).toBe(2)
    finishSlow({ exitCode: 0, stdout: JSON.stringify(idleSnapshot), stderr: '' })
    await slow
  })

  it('[grey pane latch] one tick without a render does not shut an open pane', async () => {
    const harness = await paneHarness(idleSnapshot)
    expect(JSON.stringify(await harness.render())).toContain('Nothing running in the background.')
    await harness.tick()
    await harness.tick()

    expect(JSON.stringify(await harness.render())).toContain('Nothing running in the background.')
    expect(harness.counts().closes).toBe(0)
  })

  it('[grey pane latch] a pane the host still renders re-arms itself after the no-render detector stopped it', async () => {
    const harness = await paneHarness(idleSnapshot)
    await harness.render()
    for (let index = 0; index < 6; index += 1) await harness.tick()
    const timersBefore = harness.timerCount()

    expect(JSON.stringify(await harness.render())).toContain('Nothing running in the background.')
    expect(harness.timerCount()).toBe(timersBefore + 1)
    await harness.tickLatest()
    expect(JSON.stringify(await harness.render())).toContain('Nothing running in the background.')
  })

  it('[grey pane latch] a pane closed through its Close control stays closed when a late render arrives', async () => {
    const harness = await paneHarness(idleSnapshot)
    const close = findByKey(await harness.render(), 'close')
    expect(typeof close?.onPress).toBe('function')
    await (close!.onPress as () => Promise<void>)()
    const timersBefore = harness.timerCount()

    expect(JSON.stringify(await harness.render())).toBe('{}')
    expect(harness.timerCount()).toBe(timersBefore)
    expect(harness.counts().closes).toBe(1)
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

  it('redraws this session pane after the hooks module reloads without reopening it', () => {
    const result = runSelftest('[hooks reload]')
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

  it('never prints a card id as a bare number on a row rendered outside a session', async () => {
    const cardId = '1863263447479747593'
    const snapshot = {
      discovery: 'available', sessions: undefined,
      rows: [
        { id: cardId, kind: 'pilot', label: 'Pilot', project: 'wt-suite', phase: 'unknown' },
        { id: 'lane-1', cardId, kind: 'external', label: 'External lane', project: 'wt-suite' },
      ],
      services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] },
    }
    const texts = textChildren(await renderedTree(snapshot))
    expect(texts.filter((value) => value.includes(cardId))).toEqual([`Card ${cardId}`, `Card ${cardId}`])
  })

  it('offers no button on a skipped or not-started stage even when evidence is recorded for it', async () => {
    const evidence = { summary: 'Something was recorded.' }
    const pilot = {
      id: 'pilot-1', kind: 'pilot', label: 'Pilot', project: 'wt-suite', sdkLifecycle: true, phase: 'tdd',
      phaseStates: { discovery: 'done', plan: 'skipped', tdd: 'running' },
      inspectors: { discovery: evidence, plan: evidence, verify: evidence },
      phaseCosts: { plan: 'unknown', verify: 'unknown' },
    }
    const buttonLabels = (tree: unknown): string[] => {
      if (!tree || typeof tree !== 'object') return []
      const item = tree as { name?: string; props?: { children?: unknown } }
      const children = Array.isArray(item.props?.children) ? item.props.children : [item.props?.children]
      return item.name === 'Button' ? children.filter((value): value is string => typeof value === 'string') : children.flatMap(buttonLabels)
    }
    for (const snapshot of [
      { discovery: 'available', rows: [pilot] },
      { discovery: 'available', rows: [], sessions: [{ id: 'session-1', project: 'wt-suite', cards: [{ id: '1863263447479747593', actors: [pilot] }], actors: [] }] },
    ]) {
      const labels = buttonLabels(await renderedTree({ ...snapshot, services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] } }))
      expect(labels.some((label) => label.includes('Discovery'))).toBe(true)
      expect(labels.filter((label) => /Plan|Verify/.test(label))).toEqual([])
    }
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
