import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { suiteBrokerAddress, suiteBrokerFixture } from './helpers/suite-broker-fixture.js'

const ROOT = resolve(process.env.WT_SUITE_PRIORITY_TEST_ROOT ?? fileURLToPath(new URL('../../../..', import.meta.url)))
const RESOLVER = join(ROOT, 'plugin/bin/lib/suite-lock-priority.mjs')
const load = (file: string) => import(pathToFileURL(join(ROOT, file)).href)
const roots: string[] = []
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'wt-lane-priority-')); roots.push(root); return root }
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('one lane priority policy', () => {
  it('the owned priority carries lane context through the child environment filter', async () => {
    const { spawnOpencode } = await load('plugin/bin/lib/opencode-skill-fence.mjs')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const spawn = vi.fn().mockReturnValue({ status: 0 })
    spawnOpencode(spawn, 'opencode', [], { env: { HOME: temp(), WT_SUITE_LOCK_CONTEXT: 'lane', WT_SUITE_LOCK_PRIORITY: 'P2' } }, 'darwin', ['WT_SUITE_LOCK_PRIORITY'])
    expect(spawn.mock.calls[0]?.[2].env).toMatchObject({ WT_SUITE_LOCK_CONTEXT: 'lane', WT_SUITE_LOCK_PRIORITY: 'P2' })
  })

  it.each([undefined, '', '   ', 'invalid\n\u001b[31m', 'release'])('invalid lane ambient %j warns and resolves below P1', async (ambient) => {
    const { laneWorkerEnv } = await load('plugin/bin/wt-lane.mjs')
    const { suiteLockPriority } = await load('plugin/bin/lib/suite-lock-priority.mjs')
    const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const env = laneWorkerEnv({ WT_SUITE_LOCK_PRIORITY: ambient }, null)
    expect(env.WT_SUITE_LOCK_PRIORITY, 'invalid lane ambient must resolve to P2').toBe('P2')
    expect(warning).toHaveBeenCalled()
    expect(warning.mock.calls.map(([line]) => String(line)).join('')).toContain('using P2')
    for (const context of [{ WT_SUITE_LOCK_CONTEXT: 'lane' }, { WT_SUITE_LOCK_BROKER: 'broker.sock' }]) {
      expect(suiteLockPriority({}, { ...context, WT_SUITE_LOCK_PRIORITY: ambient })).toBe('P2')
    }
    // The context survives a child losing or corrupting its ambient declaration.
    expect(suiteLockPriority({}, { ...env, WT_SUITE_LOCK_PRIORITY: ambient })).toBe('P2')
  })

  it.each(['P0', 'P1', 'P2'])('valid lane declaration %s wins on every resolver route', async (priority) => {
    const { suiteLockPriority, laneSuiteLockPriority } = await load('plugin/bin/lib/suite-lock-priority.mjs')
    const { staticSemaphoreOptions } = await load('plugin/bin/lib/host/suite-lock-static-semaphore.mjs')
    const env = { WT_SUITE_LOCK_CONTEXT: 'lane', WT_SUITE_LOCK_PRIORITY: 'invalid' }
    expect(laneSuiteLockPriority({ priority }, env)).toBe(priority)
    expect(suiteLockPriority({ priority }, env)).toBe(priority)
    expect(staticSemaphoreOptions(temp(), { env, priority, journalPriority: 'P2' }).priority).toBe(priority)
  })
})

describe('static acquisition priority', () => {
  it.each([undefined, '', 'bad', 'P0', 'P1', 'P2'])('static wrapper lane acquisition retains the resolved level for ambient %j', async (ambient) => {
    const api = await load('plugin/bin/lib/suite-lock.mjs')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const root = temp()
    const lease = await api.acquireSuiteLock({ root, static: true, light: true,
      env: { WT_SUITE_LOCK_CONTEXT: 'lane', WT_SUITE_LOCK_PRIORITY: ambient, WT_SUITE_LOCK_STATIC_LANE: '1' },
      argv: ['node', 'scripts/lint-gate.mjs'] })
    try {
      const holder = JSON.parse(readFileSync(join(root, 'static-lane/lock.d/holder.json'), 'utf8'))
      const level = ambient?.match(/^P[012]$/) ? Number(ambient.slice(1)) : 2
      expect(holder.level, 'static lane wrapper must not inflate a routine level to P1').toBe(level)
      expect(lease.staticDomain).toBe(true)
    } finally { api.releaseSuiteLock(lease) }
  })

  it.each([undefined, '', 'bad', 'P0', 'P1', 'P2'])('non-lane defaults and static FIFO stay unchanged for ambient %j', async (ambient) => {
    const { suiteLockPriority } = await load('plugin/bin/lib/suite-lock-priority.mjs')
    const { staticSemaphoreOptions } = await load('plugin/bin/lib/host/suite-lock-static-semaphore.mjs')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const env = { WT_SUITE_LOCK_PRIORITY: ambient }
    expect(suiteLockPriority({}, env)).toBe(ambient?.match(/^P[012]$/) ? ambient : 'P1')
    expect(staticSemaphoreOptions(temp(), { env, priority: 'P0' }).priority).toBe('P1')
  })
})

describe('broker wrapper priority', () => {
  it.each([undefined, '', 'bad', 'P0', 'P1', 'P2'])('broker package-script wrapper uses host ambient %j', async (ambient) => {
    const api = await load('plugin/bin/lib/suite-lock.mjs')
    const { createSuiteLockBroker } = await load('plugin/bin/lib/host/lane-suite-lock-broker.mjs')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const root = temp(); const address = suiteBrokerAddress(root)
    const broker = createSuiteLockBroker({ env: { WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_PRIORITY: ambient, WT_SUITE_LOCK_STATIC_LANE: '1' } })
    const fixture = suiteBrokerFixture(broker)
    await fixture.listen(address)
    try {
      const lease = await api.acquireSuiteLock({ env: { WT_SUITE_LOCK_BROKER: address, WT_SUITE_LOCK_PRIORITY: 'P0' },
        light: true, argv: ['node', 'scripts/lint-gate.mjs'] })
      try {
        const holder = JSON.parse(readFileSync(join(root, 'static-lane/lock.d/holder.json'), 'utf8'))
        expect(holder.level).toBe(ambient?.match(/^P[012]$/) ? Number(ambient.slice(1)) : 2)
      } finally { api.releaseSuiteLock(lease) }
    } finally { broker.releaseAll(); await fixture.close() }
  })
})

function modules(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) return modules(file)
    return /\.(?:mjs|mts|ts)$/.test(entry.name) && !/\.(?:test|selftest)\./.test(entry.name) ? [file] : []
  })
}

function containsLevel(node: ts.Node): boolean {
  if (ts.isStringLiteral(node) && /^P[012]$/.test(node.text)) return true
  return ts.forEachChild(node, containsLevel) === true
}

function levelAssignment(node: ts.Node): boolean {
  if (ts.isPropertyAssignment(node) && /priority|level|WT_SUITE_LOCK_PRIORITY/i.test(node.name.getText())) return containsLevel(node.initializer)
  if (ts.isVariableDeclaration(node) && node.initializer) return containsLevel(node.initializer)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return containsLevel(node.right)
  return false
}

function selectsLevel(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node) && /priority/i.test(node.name?.text ?? '')) return containsLevel(node)
  return levelAssignment(node)
}

const ACQUIRE = /^(?:acquire(?:.*SuiteLock|(?:BrokerJournal|Journal|Cli)Lease)|static(?:Semaphore|Lock)Options|laneWorkerEnv)$/
function acquisitionImport(node: ts.ImportDeclaration) {
  if (/suite-lock(?:-static(?:-semaphore)?)?\.mjs$/.test((node.moduleSpecifier as ts.StringLiteral).text)) return true
  const bindings = node.importClause?.namedBindings
  return bindings && ts.isNamedImports(bindings) && bindings.elements.some((binding) => ACQUIRE.test((binding.propertyName ?? binding.name).text))
}

function acquisitionNode(node: ts.Node, source: ts.SourceFile) {
  if (ts.isCallExpression(node)) return ACQUIRE.test(node.expression.getText(source).split('.').at(-1) ?? '')
  if (ts.isFunctionDeclaration(node)) return ACQUIRE.test(node.name?.text ?? '')
  return false
}

function moduleFacts(file: string, text = readFileSync(file, 'utf8')) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const imports: string[] = []; const selections: string[] = []; let acquires = false
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('.')) {
      imports.push(resolve(dirname(file), node.moduleSpecifier.text))
      if (acquisitionImport(node)) acquires = true
    }
    if (acquisitionNode(node, source)) acquires = true
    if (selectsLevel(node)) selections.push(node.getText(source))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { imports, selections, acquires }
}

function acquisitionViolations(files: Map<string, ReturnType<typeof moduleFacts>>) {
  function reachesResolver(file: string, seen = new Set<string>()): boolean {
    if (file === RESOLVER) return true
    if (seen.has(file)) return false
    seen.add(file)
    return files.get(file)?.imports.some((dependency) => reachesResolver(dependency, seen)) ?? false
  }
  return [...files].flatMap(([file, facts]) => {
    if (!facts.acquires || file === RESOLVER) return []
    return [...(!reachesResolver(file) ? [`${file}: no resolver dependency`] : []),
      ...facts.selections.map((selection) => `${file}: local level selection ${selection}`)]
  })
}

describe('acquisition entry points by property', () => {
  it('every acquisition module reaches the resolver and contains no local level selection', () => {
    const files = ['plugin/bin', 'toolkit/scripts', 'toolkit/test-support'].flatMap((directory) => modules(join(ROOT, directory)))
    const facts = new Map(files.map((file) => [file, moduleFacts(file)]))
    expect(acquisitionViolations(facts)).toEqual([])
    const extra = join(ROOT, 'plugin/bin/new-acquisition.mjs')
    facts.set(extra, moduleFacts(extra, "import { acquireSuiteLock } from './lib/suite-lock.mjs'; acquireSuiteLock({ priority: 'P1' })"))
    expect(acquisitionViolations(facts), 'a newly added acquisition cannot bypass policy with its own default').toEqual([
      `${extra}: local level selection priority: 'P1'`,
    ])
  })
})
