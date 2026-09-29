import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalPath } from './helpers/canonical-path.js'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createSecondOpinionDependencies, listProcessRelationships, listProcessTable, requestNamedPaths, runSecondOpinion } from '../../../../plugin/bin/lib/second-opinion-core.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createHostAdapter } from '../../../../plugin/bin/lib/host/adapter.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { LaneSandboxRefusal } from '../../../../plugin/bin/lib/host/lane-sandbox.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { quoteRemedyWord } from '../../../../plugin/bin/lib/remedy-quote.mjs'

const CLI = resolve(__dirname, '../../../../plugin/bin/wt-second-opinion.mjs')
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function fixture(consented: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'wt-second-opinion-'))
  roots.push(root)
  const repo = join(root, 'repo')
  const config = join(root, 'config')
  const home = join(root, 'home')
  mkdirSync(repo)
  mkdirSync(config)
  mkdirSync(home)
  writeFileSync(join(config, 'settings.json'), JSON.stringify({
    pluginConfigs: {
      'workflow-toolbox@test': { options: { executor_lane_consent: consented } },
    },
  }))
  const request = join(root, 'request.md')
  const out = join(root, 'answer.log')
  writeFileSync(request, 'Question with facts and sources.')
  return {
    repo,
    home,
    request,
    out,
    env: { CLAUDE_CONFIG_DIR: config },
    options: { request, out, repo, effort: 'medium' },
  }
}

const BROKER_SEEN_MARKER = 'broker-seen-by-parent'

// The ownership tests below read broker PIDs the fake companion writes from inside its process, so
// they run the UNSANDBOXED path (macOS, Windows, no bwrap); inside the sandbox those would be
// namespace PIDs. The sandboxed end of the family is locked by the namespace test further down.
// 'fast' is a companion that records its broker in broker.json (as the real one does once the broker is
// ready) and exits at once, before any parent snapshot has had a chance to see the broker.
function companionEnd(mode: 'hang' | 'normal' | 'error' | 'fast') {
  if (mode === 'fast') {
    return [
      "writeFileSync(join(process.cwd(), 'companion.pid'), String(process.pid))",
      "const ready = setInterval(() => { if (!existsSync(join(process.cwd(), 'app-server.pid'))) return; clearInterval(ready); mkdirSync(stateDir, { recursive: true }); writeFileSync(join(stateDir, 'broker.json'), JSON.stringify({ pid: child.pid })); process.exit(0) }, 5)",
    ]
  }
  return [
    `setTimeout(() => { mkdirSync(stateDir, { recursive: true }); writeFileSync(join(stateDir, 'broker.json'), JSON.stringify({ pid: child.pid })) }, 1500)`,
    // A finishing companion ends only once the parent's process snapshot has SEEN the broker and its
    // app-server (the harness below drops BROKER_SEEN_MARKER): ownership captures the broker only
    // while the companion lives, so a fixed 100 ms lifetime raced a slow `ps` on loaded macOS runners.
    mode === 'hang'
      ? 'setInterval(() => {}, 1000)'
      : `const until = Date.now() + 10_000; const tick = setInterval(() => { if (existsSync(join(process.cwd(), ${JSON.stringify(BROKER_SEEN_MARKER)})) || Date.now() > until) { clearInterval(tick); process.exit(${mode === 'normal' ? 0 : 7}) } }, 10)`,
  ]
}

function detachedBrokerFixture(mode: 'hang' | 'normal' | 'error' | 'fast' = 'hang', sandbox = 'off') {
  const fixtureBase = fixture(true)
  const f = { ...fixtureBase, env: { ...fixtureBase.env, WT_LANE_SANDBOX: sandbox } }
  const companionDir = join(f.env.CLAUDE_CONFIG_DIR, 'plugins', 'cache', 'openai-codex', 'codex', '1.0.0', 'scripts')
  const appPidFile = join(f.repo, 'app-server.pid')
  const brokerPidFile = join(f.repo, 'broker.pid')
  mkdirSync(companionDir, { recursive: true })
  writeFileSync(join(companionDir, 'app-server-broker.mjs'), [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'app-server'], { stdio: 'ignore' })",
    "writeFileSync(join(process.cwd(), 'app-server.pid'), String(child.pid))",
    "process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0) })",
    'setInterval(() => {}, 1000)',
  ].join('\n'))
  writeFileSync(join(companionDir, 'codex-companion.mjs'), [
    "import { spawn } from 'node:child_process'",
    "import { existsSync, mkdirSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "const child = spawn(process.execPath, [join(import.meta.dirname, 'app-server-broker.mjs')], { detached: true, stdio: 'ignore' })",
    'child.unref()',
    "writeFileSync(join(process.cwd(), 'broker.pid'), String(child.pid))",
    "const stateDir = join(process.env.CLAUDE_PLUGIN_DATA, 'state', 'fixture')",
    ...companionEnd(mode),
  ].join('\n'))
  return { ...f, companionDir, appPidFile, brokerPidFile }
}

// Pins the sandbox decision so an exact-output assertion does not depend on this host's bubblewrap.
const noSandbox = () => ({ kind: 'none', line: 'lane sandbox: none (pinned by the test)', wrap: (bin: string, args: string[]) => [bin, args] })

function lines(file: string) {
  return readFileSync(file, 'utf8').trimEnd().split(/\r?\n/)
}

function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  return check()
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0)
    return !existsSync(`/proc/${pid}/stat`) || !/^\d+ \(.+\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch { return false }
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    resolveCodexCompanion: vi.fn(() => '/fake/codex-companion.mjs'),
    runCodex: vi.fn(() => ({ status: 0, stdout: 'astra answer\n', stderr: '' })),
    resolveSdkQuery: vi.fn(() => async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, result: 'opus answer' }
    }),
    ...overrides,
  }
}

describe('second-opinion advisor', () => {
  // What the host keeps from each candidate list: the first spelling that exists.
  const selected = (text: string, existing: string[], home = '/home/reader') =>
    requestNamedPaths(text, home).map((spellings: string[]) => spellings.find((spelling: string) => existing.includes(spelling))).filter(Boolean)

  it('never treats a URL, a relative path or a word-attached slash as a named path', () => {
    expect(requestNamedPaths('https://x/y ./relative a/b and/or file://z', '/home/reader')).toEqual([])
  })

  it('keeps the longest existing spelling whatever quoting, markup, punctuation or location surrounds it', () => {
    const existing = ['/o', '/o/design notes.md', '/o/design', '/o/plan.md', '/o/report.md', '/home/reader/notes.md', '/o/my plan.md', '/o/a.md', '/o/b.md', '/o/report[final].md', '/o/report(v2).md']
    const text = [
      "I'll review '/o/design notes.md' first.",
      'Then **/o/plan.md** and /o/report.md:12:3!',
      '```',
      '~/notes.md#L4',
      '```',
      'Also /o/my\\ plan.md, `/o/a.md /o/b.md`, /o/report[final].md,please and (/o/report(v2).md).',
    ].join('\n')
    expect(selected(text, existing)).toEqual(['/o/design notes.md', '/o/plan.md', '/o/report.md', '/home/reader/notes.md', '/o/my plan.md', '/o/a.md', '/o/b.md', '/o/report[final].md', '/o/report(v2).md'])
  })

  it('does not shrink a missing file to the existing directory above it', () => {
    expect(selected('Review /o/typo.md now', ['/o'])).toEqual([])
  })

  it('expands ~/ by concatenation so a symlink followed by .. is checked as the kernel resolves it', () => {
    expect(requestNamedPaths('Review ~/link/../r.md', '/home/u')[0]![0]).toBe('/home/u/link/../r.md')
  })

  it('bounds the spellings of one start by the Linux name and path limits on a very long line', () => {
    const lists = requestNamedPaths(`see /o/x.md ${'word '.repeat(20000)}`, '/h')
    expect(lists).toHaveLength(1)
    expect(Math.max(...lists[0]!.map((spelling: string) => spelling.length))).toBeLessThanOrEqual(4096)
    expect(lists[0]!.length).toBeLessThan(300)
  })

  it('refuses an outside named file before the reviewer starts, and releases launch resources', async () => {
    const f = fixture(true)
    const outside = join(resolve(f.repo, '..'), 'outside.md')
    writeFileSync(outside, 'outside')
    writeFileSync(f.request, `Review **${outside}**`)
    const unreadable = vi.fn(() => [outside])
    const dispose = vi.fn()
    // Nothing was launched, so a broker diagnostic from ownership.stop() would only mislead.
    const stop = vi.fn(() => ['app-server cleanup unavailable: broker not captured before companion exit'])
    const wrap = vi.fn()
    const adapter = { platform: 'linux', createCodexBrokerOwnership: (env: Record<string, string>) => ({ env, stop, capture: vi.fn() }) }
    const deps = createSecondOpinionDependencies(adapter, { resolveSandbox: () => ({ kind: 'bwrap', line: 'lane sandbox: bwrap (test)', unreadable, wrap, dispose }) })
    deps.resolveCodexCompanion = () => join(f.repo, 'scripts', 'codex-companion.mjs')
    const baseline = process.listenerCount('exit')
    expect(await runSecondOpinion({ ...f.options, route: 'astra' }, deps, f.env)).toBe(2)
    expect(unreadable).toHaveBeenCalledWith([expect.arrayContaining([outside])], expect.objectContaining({ env: expect.any(Object), exempt: [] }))
    expect(statSync(outside).ino).toBeGreaterThan(0)
    expect(lines(f.out).join('\n')).toContain(`REFUSED: the request names ${outside}`)
    expect(lines(f.out).join('\n')).toContain('WT_LANE_SANDBOX_READ=')
    expect(lines(f.out).at(-1)).toBe('EXIT=2')
    expect(lines(f.out).join('\n')).not.toContain('broker not captured')
    expect(wrap).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    expect(process.listenerCount('exit')).toBe(baseline)
  })

  it('refuses a bwrap plan lacking a path checker before the reviewer runs', async () => {
    const f = fixture(true)
    const outside = join(resolve(f.repo, '..'), 'outside.md')
    writeFileSync(outside, 'outside')
    writeFileSync(f.request, `Review ${outside}`)
    const wrap = vi.fn()
    const dispose = vi.fn()
    const stop = vi.fn(() => [])
    const adapter = { platform: 'linux', createCodexBrokerOwnership: (env: Record<string, string>) => ({ env, stop, capture: vi.fn() }) }
    const deps = createSecondOpinionDependencies(adapter, { resolveSandbox: () => ({ kind: 'bwrap', line: 'lane sandbox: bwrap (test)', wrap, dispose }) })
    deps.resolveCodexCompanion = () => join(f.repo, 'scripts', 'codex-companion.mjs')
    const baseline = process.listenerCount('exit')
    expect(await runSecondOpinion({ ...f.options, route: 'astra' }, deps, f.env)).toBe(2)
    expect(lines(f.out).join('\n')).toContain('sandbox plan cannot check request paths')
    expect(wrap).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    expect(process.listenerCount('exit')).toBe(baseline)
  })

  it.each([
    ['bold', (p: string) => `Review **${p}**`],
    ['punctuation', (p: string) => `Review ${p},please`],
    ['escaped space', (p: string) => `Review ${p.replace('design notes', 'design\\ notes')}`],
    ['quoted space', (p: string) => `Review "${p}"`],
  ])('refuses a %s named outside path end to end', async (_case, requestText) => {
    const f = fixture(true)
    const outside = join(resolve(f.repo, '..'), _case === 'escaped space' || _case === 'quoted space' ? 'design notes.md' : 'design.md')
    writeFileSync(outside, 'outside')
    writeFileSync(f.request, requestText(outside))
    const unreadable = vi.fn((candidates: string[][]) => candidates.filter((group) => group.includes(outside)).map(() => ({ path: outside, reason: null })))
    const adapter = { platform: 'linux', createCodexBrokerOwnership: (env: Record<string, string>) => ({ env, stop: vi.fn(() => []), capture: vi.fn() }) }
    const deps = createSecondOpinionDependencies(adapter, { resolveSandbox: () => ({ kind: 'bwrap', line: 'sandbox', unreadable, dispose: vi.fn(), wrap: vi.fn() }) })
    deps.resolveCodexCompanion = () => join(f.repo, 'scripts', 'codex-companion.mjs')
    expect(await runSecondOpinion({ ...f.options, route: 'astra' }, deps, f.env)).toBe(2)
    expect(lines(f.out).join('\n')).toContain(outside)
    expect(lines(f.out).at(-1)).toBe('EXIT=2')
    expect(unreadable.mock.calls[0]![0].some((group) => group.includes(outside))).toBe(true)
  })

  it('refuses both outside files named in one backticked span before starting Codex', async () => {
    const f = fixture(true)
    const a = join(resolve(f.repo, '..'), 'a.md')
    const b = join(resolve(f.repo, '..'), 'b.md')
    writeFileSync(a, 'a')
    writeFileSync(b, 'b')
    writeFileSync(f.request, `Review \`${a} ${b}\``)
    const unreadable = vi.fn((candidates: string[][]) => candidates.flatMap((group) => [a, b].filter((file) => group.includes(file)).map((file) => ({ path: file, reason: null }))))
    const wrap = vi.fn()
    const adapter = { platform: 'linux', createCodexBrokerOwnership: (env: Record<string, string>) => ({ env, stop: vi.fn(() => []), capture: vi.fn() }) }
    const deps = createSecondOpinionDependencies(adapter, { resolveSandbox: () => ({ kind: 'bwrap', line: 'sandbox', unreadable, dispose: vi.fn(), wrap }) })
    deps.resolveCodexCompanion = () => join(f.repo, 'scripts', 'codex-companion.mjs')
    expect(await runSecondOpinion({ ...f.options, route: 'astra' }, deps, f.env)).toBe(2)
    expect(lines(f.out).join('\n')).toContain(`${a}, ${b}`)
    expect(lines(f.out).at(-1)).toBe('EXIT=2')
    expect(wrap).not.toHaveBeenCalled()
  })

  it('passes explicit exemptions to the real selector; punctuation in an existing spelling cannot be exempted by stripping it', async () => {
    const f = fixture(true)
    const named = join(resolve(f.repo, '..'), 'report.md!')
    writeFileSync(named, 'exists')
    writeFileSync(f.request, `Review ${named}`)
    const unreadable = vi.fn((candidates: string[][], { exempt }: { exempt: string[] }) => candidates.filter((group) => !exempt.includes(group[0]!)).map((group) => ({ path: group[0]!, reason: null })))
    const adapter = { platform: 'linux', createCodexBrokerOwnership: (env: Record<string, string>) => ({ env, stop: vi.fn(() => []), capture: vi.fn() }) }
    const deps = createSecondOpinionDependencies(adapter, { resolveSandbox: () => ({ kind: 'bwrap', line: 'sandbox', unreadable, dispose: vi.fn(), wrap: () => [process.execPath, ['-e', '']] }) })
    deps.resolveCodexCompanion = () => join(f.repo, 'scripts', 'codex-companion.mjs')
    expect(await runSecondOpinion({ ...f.options, route: 'astra' }, deps, { ...f.env, WT_SECOND_OPINION_UNREAD: named.slice(0, -1) })).toBe(2)
    expect(unreadable.mock.calls[0]![1].exempt).toEqual([named.slice(0, -1)])
    expect(await runSecondOpinion({ ...f.options, route: 'astra' }, deps, { ...f.env, WT_SECOND_OPINION_UNREAD: JSON.stringify([named]) })).toBe(0)
    expect(unreadable.mock.calls[1]![1].exempt).toEqual([named])
  })

  it('reports probe failures as a refusal with EXIT=1 and releases ownership and listeners', async () => {
    const f = fixture(true)
    const outside = join(resolve(f.repo, '..'), 'outside.md')
    writeFileSync(outside, 'outside')
    writeFileSync(f.request, `Review ${outside}`)
    const stop = vi.fn(() => ['app-server cleanup unavailable: broker not captured before companion exit'])
    const dispose = vi.fn()
    const wrap = vi.fn()
    const adapter = { platform: 'linux', createCodexBrokerOwnership: (env: Record<string, string>) => ({ env, stop, capture: vi.fn() }) }
    const deps = createSecondOpinionDependencies(adapter, { resolveSandbox: () => ({ kind: 'bwrap', line: 'sandbox', unreadable: () => { throw new LaneSandboxRefusal('could not check the request\'s paths inside the sandbox: probe failed') }, dispose, wrap }) })
    deps.resolveCodexCompanion = () => join(f.repo, 'scripts', 'codex-companion.mjs')
    const baseline = process.listenerCount('exit')
    expect(await runSecondOpinion({ ...f.options, route: 'astra' }, deps, f.env)).toBe(1)
    expect(lines(f.out).join('\n')).toContain('REFUSED: could not check the request')
    expect(lines(f.out).join('\n')).not.toContain('broker not captured')
    expect(lines(f.out).at(-1)).toBe('EXIT=1')
    expect(stop).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    expect(wrap).not.toHaveBeenCalled()
    expect(process.listenerCount('exit')).toBe(baseline)
  })

  it.skipIf(process.platform === 'win32')('the real Linux planner supplies the path checker to Codex and refuses an invisible named file', async () => {
    const f = fixture(true)
    const outside = join(resolve(f.repo, '..'), 'outside.md')
    writeFileSync(outside, 'outside')
    writeFileSync(f.request, `Review ${outside}`)
    const codex = '/opt/good/bin/codex'
    const files = new Set([codex])
    const dirs = new Set([f.home, f.repo, '/opt/good/bin', '/opt/good'])
    const fs = {
      exists: (file: string) => files.has(file) || dirs.has(file) || file === '/usr/bin/bwrap',
      realpath: (file: string) => files.has(file) || dirs.has(file) ? file : null,
      identity: (file: string) => file === outside ? '1:3' : null,
      isFile: (file: string) => files.has(file), isExecutable: (file: string) => files.has(file),
      isDir: (file: string) => dirs.has(file), readText: () => null,
      ensureDir: (file: string) => { dirs.add(file) }, ensureFile: (file: string) => { files.add(file) }, copy: () => {},
    }
    const sandbox = await import(pathToFileURL(resolve(__dirname, '../../../../plugin/bin/lib/host/lane-sandbox.mjs')).href)
    const stop = vi.fn(() => [])
    const adapter = { platform: 'linux', createCodexBrokerOwnership: () => ({ env: { HOME: f.home, PATH: '/opt/good/bin' }, stop, capture: vi.fn() }) }
    const resolveSandbox = vi.fn((request: Record<string, unknown>) => {
      const actual = sandbox.resolveLaneSandbox({ ...request, fs, optionEnv: {}, bwrap: '/usr/bin/bwrap', socat: null, probe: () => ({ ok: true }), runtimeParent: f.home, spawnFn: (_cmd: string, args: string[]) => {
        const index = args.indexOf('--socket')
        if (index >= 0) fs.ensureFile(args[index + 1]!)
        return { kill: () => {} }
      } })
      return { ...actual, unreadable: (paths: string[][], options: Record<string, unknown>) => actual.unreadable(paths, { ...options, probe: (selected: string[]) => Object.fromEntries(selected.map((file) => [file, null])) }) }
    })
    const deps = createSecondOpinionDependencies(adapter, { resolveSandbox })
    deps.resolveCodexCompanion = () => join(f.repo, 'scripts', 'codex-companion.mjs')
    const baseline = process.listenerCount('exit')
    expect(await runSecondOpinion({ ...f.options, route: 'astra' }, deps, f.env)).toBe(2)
    expect(lines(f.out).join('\n')).toContain(`REFUSED: the request names ${outside}`)
    expect(lines(f.out).at(-1)).toBe('EXIT=2')
    expect(resolveSandbox).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(process.listenerCount('exit')).toBe(baseline)
  })
  it('gives the external Codex companion only its allow-listed environment', () => {
    const adapter = createHostAdapter({ platform: process.platform })
    const ownership = adapter.createCodexBrokerOwnership({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CODEX_HOME: '/codex-home',
      CLAUDE_CODE_OAUTH_TOKEN: 'session credential',
      ANTHROPIC_API_KEY: 'api credential',
      ANTHROPIC_AUTH_TOKEN: 'auth credential',
      COMPANY_VAULT_SECRET: 'unknown secret',
    })
    try {
      expect(ownership.env).toMatchObject({ PATH: process.env.PATH })
      if (process.env.HOME === undefined) expect(ownership.env).not.toHaveProperty('HOME')
      else expect(ownership.env).toHaveProperty('HOME', process.env.HOME)
      expect(ownership.env).not.toHaveProperty('CODEX_HOME')
      expect(ownership.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
      expect(ownership.env).not.toHaveProperty('ANTHROPIC_API_KEY')
      expect(ownership.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
      expect(ownership.env).not.toHaveProperty('COMPANY_VAULT_SECRET')
    } finally {
      ownership.stop()
    }
  })

  it('reads process discovery through the adapter supplied by its caller', () => {
    const expected = { supported: true, processes: [{ pid: 7, ppid: 1, elapsedMs: 2000, command: 'broker' }] }
    const adapter = { readProcessSnapshot: vi.fn(() => expected) }

    expect(listProcessTable(adapter)).toBe(expected)
    expect(adapter.readProcessSnapshot).toHaveBeenCalledOnce()
  })

  it('degrades to a named "unavailable" on a platform with no host implementation instead of throwing', () => {
    const adapter = createHostAdapter({ platform: 'openbsd', unavailableFallback: true })
    expect(adapter.available).toBe(false)
    expect(listProcessTable(adapter)).toEqual({ supported: false, processes: [], reason: 'process discovery unavailable on this platform' })
    expect(listProcessRelationships(adapter).status).toBe('unavailable')
    expect(() => adapter.endProcessFamily(123)).not.toThrow()
  })

  it('keeps automatic routing on Astra when lane consent is active', async () => {
    const f = fixture(true)
    const deps = dependencies()
    expect(await runSecondOpinion({ ...f.options, route: 'auto' }, deps, f.env)).toBe(0)

    expect(lines(f.out)[0]).toBe('ROUTE=gpt-astra')
    expect(deps.runCodex).toHaveBeenCalledOnce()
    expect(deps.resolveSdkQuery).not.toHaveBeenCalled()
  })

  it('refuses automatic routing without lane consent and names the user as the second opinion, never Opus', async () => {
    const f = fixture(false)
    const deps = dependencies()
    expect(await runSecondOpinion({ ...f.options, route: 'auto' }, deps, f.env)).toBe(1)

    const out = readFileSync(f.out, 'utf8')
    expect(out).toMatch(/^REFUSED: no consented external lane/)
    expect(out).toContain('ask the user')
    expect(out).toContain('GPT lane consent is off for this account')
    expect(out).toContain('run: wt-lane-consent --on\n')
    expect(out).not.toContain('--project')
    expect(out).not.toContain('ROUTE=claude-opus')
    expect(lines(f.out).at(-1)).toBe('EXIT=1')
    expect(deps.resolveSdkQuery).not.toHaveBeenCalled()
    expect(deps.runCodex).not.toHaveBeenCalled()
  })

  it('names the project-level remedy when the account consents but the project narrows consent', async () => {
    const f = fixture(true)
    mkdirSync(join(f.repo, '.claude'))
    writeFileSync(join(f.repo, '.claude', 'settings.local.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'false' } }))
    const deps = dependencies()
    expect(await runSecondOpinion({ ...f.options, route: 'auto' }, deps, f.env)).toBe(1)

    const out = readFileSync(f.out, 'utf8')
    expect(out).toMatch(/^REFUSED: no consented external lane/)
    expect(out).toContain('this project narrows GPT lane consent')
    expect(out).toContain(`run: wt-lane-consent --project ${quoteRemedyWord(f.repo)} --on\n`)
    expect(out).not.toMatch(/run: wt-lane-consent --on\b/)
    expect(lines(f.out).at(-1)).toBe('EXIT=1')
    expect(deps.resolveSdkQuery).not.toHaveBeenCalled()
    expect(deps.runCodex).not.toHaveBeenCalled()
  })

  it('quotes a project path that is not shell-safe in the suggested remedy', async () => {
    const f = fixture(true)
    const repo = join(f.repo, "it's a repo")
    mkdirSync(join(repo, '.claude'), { recursive: true })
    writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'false' } }))
    const deps = dependencies()
    expect(await runSecondOpinion({ ...f.options, repo, route: 'auto' }, deps, f.env)).toBe(1)

    expect(readFileSync(f.out, 'utf8')).toContain(`run: wt-lane-consent --project ${quoteRemedyWord(repo)} --on\n`)
  })

  async function expectProjectRemedyFor(basename: string) {
    const f = fixture(true)
    const repo = join(f.repo, basename)
    mkdirSync(join(repo, '.claude'), { recursive: true })
    writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'false' } }))
    expect(await runSecondOpinion({ ...f.options, repo, route: 'auto' }, dependencies(), f.env)).toBe(1)
    const quoted = quoteRemedyWord(repo)
    expect(readFileSync(f.out, 'utf8')).toContain(`run: wt-lane-consent --project ${quoted} --on\n`)
  }

  it.each(["it's a repo"])('quotes a project remedy containing %s', expectProjectRemedyFor)
  it.skipIf(process.platform === 'win32')('quotes a project remedy containing a "quoted" repo (Windows skipped: double quotes are invalid in paths)',
    () => expectProjectRemedyFor('a "quoted" repo'))

  it('names both remedies when the account is off and the project also narrows consent', async () => {
    const f = fixture(false)
    mkdirSync(join(f.repo, '.claude'))
    writeFileSync(join(f.repo, '.claude', 'settings.local.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'false' } }))
    const deps = dependencies()
    expect(await runSecondOpinion({ ...f.options, route: 'auto' }, deps, f.env)).toBe(1)

    const out = readFileSync(f.out, 'utf8')
    expect(out).toContain(`run: wt-lane-consent --on && wt-lane-consent --project ${quoteRemedyWord(f.repo)} --on\n`)
    expect(deps.resolveSdkQuery).not.toHaveBeenCalled()
  })

  it('refuses automatic routing when the consent setting cannot be read, never Opus', async () => {
    const f = fixture(false)
    writeFileSync(join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), '{ not json')
    const deps = dependencies()
    expect(await runSecondOpinion({ ...f.options, route: 'auto' }, deps, f.env)).toBe(1)

    const out = readFileSync(f.out, 'utf8')
    expect(out).toMatch(/^REFUSED: no consented external lane/)
    expect(out).toContain('the consent setting could not be read')
    expect(out).toContain('ask the user')
    expect(lines(f.out).at(-1)).toBe('EXIT=1')
    expect(deps.resolveSdkQuery).not.toHaveBeenCalled()
    expect(deps.runCodex).not.toHaveBeenCalled()
  })

  it('uses Astra when that route is forced and lane consent is active', async () => {
    const f = fixture(true)
    const deps = dependencies()
    expect(await runSecondOpinion({ ...f.options, route: 'astra' }, deps, f.env)).toBe(0)

    expect(lines(f.out)[0]).toBe('ROUTE=gpt-astra')
    expect(deps.runCodex).toHaveBeenCalledOnce()
    expect(deps.resolveSdkQuery).not.toHaveBeenCalled()
  })

  it('uses a fresh Opus consult when that route is forced despite active lane consent', async () => {
    const f = fixture(true)
    const deps = dependencies()
    expect(await runSecondOpinion({ ...f.options, route: 'opus' }, deps, f.env)).toBe(0)

    expect(lines(f.out)[0]).toBe('ROUTE=claude-opus')
    expect(deps.resolveSdkQuery).toHaveBeenCalledOnce()
    expect(deps.runCodex).not.toHaveBeenCalled()
  })

  it('refuses forced Astra with a named reason when lane consent is not active', async () => {
    const f = fixture(false)
    const deps = dependencies()
    expect(await runSecondOpinion({ ...f.options, route: 'astra' }, deps, f.env)).toBe(1)

    expect(lines(f.out)).toEqual([
      'REFUSED: Astra requires active GPT lane consent.',
      'EXIT=1',
    ])
    expect(deps.runCodex).not.toHaveBeenCalled()
    expect(deps.resolveSdkQuery).not.toHaveBeenCalled()
  })

  it('refuses a route outside auto, astra and opus instead of running Opus', async () => {
    const f = fixture(true)
    const deps = dependencies()
    expect(await runSecondOpinion({ ...f.options, route: 'Astra' }, deps, f.env)).toBe(2)

    expect(lines(f.out)).toEqual([
      'REFUSED: unknown route "Astra"; use auto, astra, or opus.',
      'EXIT=2',
    ])
    expect(deps.runCodex).not.toHaveBeenCalled()
    expect(deps.resolveSdkQuery).not.toHaveBeenCalled()
  })

  it('names an unreadable consent setting when forced Astra is refused', async () => {
    const f = fixture(false)
    writeFileSync(join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), '{ not json')
    const deps = dependencies()
    expect(await runSecondOpinion({ ...f.options, route: 'astra' }, deps, f.env)).toBe(1)

    expect(lines(f.out)[0]).toContain('the consent setting could not be read')
    expect(lines(f.out).at(-1)).toBe('EXIT=1')
    expect(deps.runCodex).not.toHaveBeenCalled()
    expect(deps.resolveSdkQuery).not.toHaveBeenCalled()
  })

  it('refuses an invalid --route value at the CLI before any collaborator runs', () => {
    const f = fixture(true)
    const result = spawnSync(process.execPath, [CLI, '--request', f.request, '--out', f.out, '--repo', f.repo, '--route', 'fabel'], { encoding: 'utf8', env: { ...process.env, ...f.env } })

    expect(result.status).toBe(2)
    expect(lines(f.out)).toEqual(['REFUSED: --route must be auto, astra, or opus', 'EXIT=2'])
  })

  it('accepts --route as a CLI flag rather than reporting an unknown argument', () => {
    const f = fixture(true)
    const result = spawnSync(process.execPath, [CLI, '--out', f.out, '--route', 'opus'], { encoding: 'utf8', env: { ...process.env, ...f.env } })

    expect(result.status).toBe(2)
    expect(lines(f.out)).toEqual(['REFUSED: --request is required', 'EXIT=2'])
  })

  it('uses Astra exactly once when lane consent and the Codex runtime are present', async () => {
    const f = fixture(true)
    const deps = dependencies()
    expect(await runSecondOpinion(f.options, deps, f.env)).toBe(0)

    expect(deps.runCodex).toHaveBeenCalledOnce()
    expect(deps.resolveSdkQuery).not.toHaveBeenCalled()
    const calls = deps.runCodex.mock.calls as unknown as Array<[{
      companion: string
      cwd: string
      effort: string
      request: string
    }]>
    const call = calls[0]?.[0]
    expect(call).toBeDefined()
    expect(call).toMatchObject({ companion: '/fake/codex-companion.mjs', cwd: f.repo, effort: 'medium' })
    expect(call?.request).toContain('MCP tools (including context-mode) are NOT available')
    expect(call?.request).toContain('Question with facts and sources.')
    expect(lines(f.out)[0]).toBe('ROUTE=gpt-astra')
    expect(lines(f.out).at(-1)).toBe('EXIT=0')
  })

  it('uses one fresh read-only Opus SDK query when the opus route is forced without lane consent', async () => {
    const f = fixture(false)
    const repoAlias = join(f.repo, '..', 'repo-alias')
    symlinkSync(f.repo, repoAlias, 'dir')
    f.repo = repoAlias
    f.options.repo = repoAlias
    writeFileSync(join(f.repo, 'CLAUDE.md'), '# Guide\n')
    let queryInput: unknown
    const query = vi.fn((input) => {
      queryInput = input
      return (async function* () {
        yield { type: 'result', subtype: 'success', is_error: false, result: 'independent answer' }
      })()
    })
    const deps = dependencies({ resolveSdkQuery: vi.fn(() => query) })
    expect(await runSecondOpinion({ ...f.options, route: 'opus' }, deps, f.env)).toBe(0)

    expect(query).toHaveBeenCalledOnce()
    expect(queryInput).toMatchObject({
      prompt: `${canonicalPath(join(f.repo, 'CLAUDE.md'))} is the repository's contributor guide; read it before planning or changing code.\n\nQuestion with facts and sources.`,
      options: {
        model: 'opus',
        effort: 'xhigh',
        cwd: f.repo,
        tools: ['Read', 'Glob', 'Grep'],
        settingSources: [],
      },
    })
    expect(lines(f.out)).toEqual(['ROUTE=claude-opus', 'independent answer', 'EXIT=0'])
    expect(deps.runCodex).not.toHaveBeenCalled()
  })

  it('runs the explicit Opus route at xhigh effort whatever effort the caller passed', async () => {
    const f = fixture(false)
    let sdkEffort: unknown
    const query = vi.fn((input: { options: { effort?: unknown } }) => {
      sdkEffort = input.options.effort
      return (async function* () {
        yield { type: 'result', subtype: 'success', is_error: false, result: 'opus answer' }
      })()
    })
    const deps = dependencies({ resolveSdkQuery: vi.fn(() => query) })
    expect(await runSecondOpinion({ ...f.options, effort: 'low', route: 'opus' }, deps, f.env)).toBe(0)

    expect(query).toHaveBeenCalledOnce()
    expect(sdkEffort).toBe('xhigh')
    expect(lines(f.out)[0]).toBe('ROUTE=claude-opus')
    expect(deps.runCodex).not.toHaveBeenCalled()

    // The same profile and the same SDK, with route auto: Opus must be reachable ONLY by the explicit route.
    expect(await runSecondOpinion({ ...f.options, effort: 'low', route: 'auto' }, deps, f.env)).toBe(1)
    expect(query).toHaveBeenCalledOnce()
    expect(deps.resolveSdkQuery).toHaveBeenCalledOnce()
    expect(lines(f.out)[0]).toMatch(/^REFUSED: /)
  })

  it('refuses rather than falling back to Opus when consent is given but Codex is missing', async () => {
    const f = fixture(true)
    const deps = dependencies({ resolveCodexCompanion: vi.fn(() => null) })
    expect(await runSecondOpinion(f.options, deps, f.env)).toBe(1)
    expect(lines(f.out)).toEqual([
      'REFUSED: GPT lane consent is active, but the Codex companion runtime is not installed; install the openai-codex plugin.',
      'EXIT=1',
    ])
    expect(deps.resolveSdkQuery).not.toHaveBeenCalled()
  })

  it('refuses with the SDK resolver fix when the opus route is forced and the SDK is missing', async () => {
    const f = fixture(false)
    const deps = dependencies({
      resolveSdkQuery: vi.fn(() => { throw new Error("@anthropic-ai/claude-agent-sdk is not installed; require >=0.3.280; run: npm install -g '@anthropic-ai/claude-agent-sdk@>=0.3.280'") }),
    })
    expect(await runSecondOpinion({ ...f.options, route: 'opus' }, deps, f.env)).toBe(1)
    expect(lines(f.out)).toEqual([
      'ROUTE=claude-opus',
      "REFUSED: Claude Agent SDK unavailable; run: npm install -g '@anthropic-ai/claude-agent-sdk@>=0.3.280'",
      'EXIT=1',
    ])
  })

  it('preserves a failed companion exit and keeps EXIT as the last output line', async () => {
    const f = fixture(true)
    const deps = dependencies({
      runCodex: vi.fn(() => ({ status: 7, stdout: 'partial answer\n', stderr: 'companion failed\n' })),
    })
    expect(await runSecondOpinion(f.options, deps, f.env)).toBe(7)
    expect(lines(f.out)).toEqual([
      'ROUTE=gpt-astra',
      'partial answer',
      'companion failed',
      'EXIT=7',
    ])
  })

  it('labels a Codex classifier refusal just before EXIT without changing its code', async () => {
    const f = fixture(true)
    const deps = dependencies({ runCodex: vi.fn(() => ({ status: 1, stdout: '', stderr: '[codex] Codex error: This content was flagged for possible cybersecurity risk.\n' })) })
    expect(await runSecondOpinion(f.options, deps, f.env)).toBe(1)
    expect(lines(f.out).slice(-2)).toEqual(['OUTCOME=refused-by-classifier provider=openai category=cyber', 'EXIT=1'])
  })

  it('labels an SDK classifier notice even when the result exits successfully', async () => {
    const f = fixture(false)
    const deps = dependencies({ resolveSdkQuery: vi.fn(() => async function* () {
      yield { type: 'system', subtype: 'informational', content: "Opus 5.5's safeguards stopped the response above" }
      yield { type: 'result', result: 'declined', is_error: false }
    }) })
    expect(await runSecondOpinion({ ...f.options, route: 'opus' }, deps, f.env)).toBe(0)
    expect(lines(f.out).at(-2)).toContain('OUTCOME=classifier-notice provider=anthropic')
    expect(lines(f.out).at(-1)).toBe('EXIT=0')
  })

  it('writes unavailable cleanup diagnostics before the exit marker', async () => {
    const f = fixture(true)
    const deps = dependencies({
      runCodex: vi.fn(() => ({
        status: 1,
        stdout: '',
        stderr: '',
        cleanup: ['app-server cleanup unavailable: broker not captured; process discovery unavailable on this platform'],
      })),
    })

    expect(await runSecondOpinion(f.options, deps, f.env)).toBe(1)
    expect(lines(f.out)).toEqual([
      'ROUTE=gpt-astra',
      'app-server cleanup unavailable: broker not captured; process discovery unavailable on this platform',
      'EXIT=1',
    ])
  })

  it('does not rewrite a completed result because the signal is aborted afterwards', async () => {
    const f = fixture(true)
    const controller = new AbortController()
    const deps = dependencies({
      runCodex: vi.fn(() => {
        controller.abort('SIGTERM')
        return { status: 0, stdout: 'complete\n', stderr: '', interrupted: false }
      }),
    })

    expect(await runSecondOpinion({ ...f.options, signal: controller.signal }, deps, f.env)).toBe(0)
    expect(lines(f.out).at(-1)).toBe('EXIT=0')
  })

  it('does not spawn a companion when the call was aborted before spawn', async () => {
    const f = fixture(true)
    const controller = new AbortController()
    controller.abort()
    const endProcessFamily = vi.fn()
    const deps = createSecondOpinionDependencies({
      platform: process.platform,
      endProcessFamily,
      readProcessSnapshot: vi.fn(),
    })
    deps.resolveCodexCompanion = () => '/this/path/must/not/spawn.mjs'

    expect(await runSecondOpinion({ ...f.options, route: 'astra', signal: controller.signal }, deps, f.env)).toBe(1)
    expect(lines(f.out)).toContain('Codex companion launch aborted before spawn.')
    expect(endProcessFamily).not.toHaveBeenCalled()
  })

  it('passes cancellation into the Opus SDK query instead of swallowing it', async () => {
    const f = fixture(false)
    const controller = new AbortController()
    let receivedController: AbortController | undefined
    const deps = dependencies({
      resolveSdkQuery: vi.fn(() => ({ options }: { options: { abortController?: AbortController } }) => {
        receivedController = options.abortController
        return (async function* () {
          await new Promise((resolve) => options.abortController?.signal.addEventListener('abort', resolve, { once: true }))
          throw new Error('query aborted')
        })()
      }),
    })
    const running = runSecondOpinion({ ...f.options, route: 'opus', abortController: controller }, deps, f.env)
    setTimeout(() => controller.abort(), 10)

    expect(await running).toBe(1)
    expect(receivedController).toBe(controller)
    expect(lines(f.out)).toEqual(['ROUTE=claude-opus', 'query aborted', 'EXIT=1'])
  })

  it.skipIf(process.platform === 'win32').each([['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const)(
    'stops the Codex app-server behind the detached broker on %s without stopping another session (Windows skipped: Node terminates before JS signal cleanup)',
    (signal, expectedExit) => {
    const f = detachedBrokerFixture()
    const wrapper = spawn(process.execPath, [CLI, '--request', f.request, '--out', f.out, '--repo', f.repo, '--route', 'astra'], {
      env: { ...process.env, ...f.env, HOME: f.home },
      stdio: 'ignore',
    })
    let appPid = 0
    let brokerPid = 0
    let otherBroker: ReturnType<typeof spawn> | null = null
    try {
      expect(waitFor(() => existsSync(f.appPidFile))).toBe(true)
      appPid = Number(readFileSync(f.appPidFile, 'utf8'))
      brokerPid = Number(readFileSync(f.brokerPidFile, 'utf8'))
      expect(processExists(appPid)).toBe(true)
      otherBroker = spawn(process.execPath, [join(f.companionDir, 'app-server-broker.mjs')], {
        cwd: f.repo,
        detached: true,
        stdio: 'ignore',
      })
      otherBroker.unref()
      expect(processExists(otherBroker.pid!)).toBe(true)
      process.kill(wrapper.pid!, signal)
      expect(waitFor(() => !processExists(appPid))).toBe(true)
      expect(processExists(otherBroker.pid!)).toBe(true)
      expect(waitFor(() => lines(f.out).at(-1) === `EXIT=${expectedExit}`)).toBe(true)
    } finally {
      if (wrapper.pid && processExists(wrapper.pid)) process.kill(wrapper.pid, 'SIGKILL')
      if (brokerPid && processExists(brokerPid)) {
        if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(brokerPid), '/t', '/f'])
        else process.kill(-brokerPid, 'SIGKILL')
      }
      if (otherBroker?.pid && processExists(otherBroker.pid)) process.kill(-otherBroker.pid, 'SIGKILL')
      if (appPid && processExists(appPid)) process.kill(appPid, 'SIGKILL')
    }
    },
  )

  // Runs the core in a child process with the REAL host adapter of `adapterPlatform` (on a POSIX
  // host the darwin adapter's `ps -axo lstart` path runs as-is, with the pass-through plan a non-Linux
  // host gets), each snapshot slowed until the broker is seen, as on a loaded macOS runner.
  const finishingCompanionCases = [...new Map([
    [process.platform, 'normal', 0], [process.platform, 'error', 7],
    ...(process.platform === 'win32' ? [] : [['darwin', 'normal', 0], ['darwin', 'error', 7]]),
  ].map((entry) => [entry.join(':'), entry as [string, 'normal' | 'error', number]])).values()]
  it.each(finishingCompanionCases)('stops the detached broker app-server after a companion end (%s host adapter, %s end, slow process snapshot)', (adapterPlatform, mode, expectedStatus) => {
    const passThrough = adapterPlatform !== 'linux'
    const f = detachedBrokerFixture(mode, passThrough ? '' : 'off')
    const harness = join(f.repo, 'finish-harness.mjs')
    const coreUrl = pathToFileURL(resolve(__dirname, '../../../../plugin/bin/lib/second-opinion-core.mjs')).href
    const adapterUrl = pathToFileURL(resolve(__dirname, '../../../../plugin/bin/lib/host/adapter.mjs')).href
    writeFileSync(harness, [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      `import { createSecondOpinionDependencies, runSecondOpinion } from ${JSON.stringify(coreUrl)}`,
      `import { createHostAdapter } from ${JSON.stringify(adapterUrl)}`,
      `const repo = ${JSON.stringify(f.repo)}`,
      `const marker = join(repo, ${JSON.stringify(BROKER_SEEN_MARKER)})`,
      "const pidIn = (name) => { try { return Number(readFileSync(join(repo, name), 'utf8')) } catch { return 0 } }",
      `const adapter = createHostAdapter({ platform: ${JSON.stringify(adapterPlatform)} })`,
      'const readSnapshot = adapter.readProcessSnapshot',
      'adapter.readProcessSnapshot = () => {',
      '  const seen = existsSync(marker)',
      '  if (!seen) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)',
      '  const table = readSnapshot()',
      "  const family = [pidIn('broker.pid'), pidIn('app-server.pid')]",
      "  if (!seen && table.supported && family.every((pid) => pid && table.processes.some((item) => item.pid === pid))) writeFileSync(marker, '')",
      '  return table',
      '}',
      `process.exitCode = await runSecondOpinion(${JSON.stringify({ ...f.options, route: 'astra' })}, createSecondOpinionDependencies(adapter), process.env)`,
    ].join('\n'))
    const result = spawnSync(process.execPath, [harness], {
      env: { ...process.env, ...f.env, HOME: f.home },
      encoding: 'utf8',
      timeout: 20_000,
    })
    expect(waitFor(() => existsSync(f.appPidFile))).toBe(true)
    const appPid = Number(readFileSync(f.appPidFile, 'utf8'))
    const brokerPid = Number(readFileSync(f.brokerPidFile, 'utf8'))
    try {
      expect(result.status, result.stderr).toBe(expectedStatus)
      if (passThrough) expect(lines(f.out)).toContain(`lane sandbox: none (bubblewrap sandbox is Linux-only; this host is ${adapterPlatform}); running with the environment allow-list only`)
      expect(lines(f.out).join('\n')).toMatch(/stopped broker\/app-server process family pid \d+ started by this call/)
      expect(waitFor(() => !processExists(appPid))).toBe(true)
      expect(waitFor(() => !processExists(brokerPid))).toBe(true)
    } finally {
      if (brokerPid && processExists(brokerPid)) {
        if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(brokerPid), '/t', '/f'])
        else process.kill(-brokerPid, 'SIGKILL')
      }
      if (appPid && processExists(appPid)) process.kill(appPid, 'SIGKILL')
    }
  }, 30_000)

  // The companion records its broker in broker.json and exits at once; every process snapshot taken while
  // it lives misses the broker (a `ps` too slow to list it yet). Ownership must still find the broker this
  // call started — from the broker.json in its private CLAUDE_PLUGIN_DATA root — and stop it.
  const fastCompanionAdapters = [...new Set([process.platform, ...(process.platform === 'win32' ? [] : ['darwin'])])]
  it.each(fastCompanionAdapters)('stops the broker a companion recorded when it exits before any snapshot saw that broker (%s host adapter)', (adapterPlatform) => {
    const passThrough = adapterPlatform !== 'linux'
    const f = detachedBrokerFixture('fast', passThrough ? '' : 'off')
    const harness = join(f.repo, 'fast-harness.mjs')
    const coreUrl = pathToFileURL(resolve(__dirname, '../../../../plugin/bin/lib/second-opinion-core.mjs')).href
    const adapterUrl = pathToFileURL(resolve(__dirname, '../../../../plugin/bin/lib/host/adapter.mjs')).href
    writeFileSync(harness, [
      "import { readFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      `import { createSecondOpinionDependencies, runSecondOpinion } from ${JSON.stringify(coreUrl)}`,
      `import { createHostAdapter } from ${JSON.stringify(adapterUrl)}`,
      `const repo = ${JSON.stringify(f.repo)}`,
      "const pidIn = (name) => { try { return Number(readFileSync(join(repo, name), 'utf8')) } catch { return 0 } }",
      // Alive or not yet reaped by this process: kill(pid, 0) fails only once the companion has been reaped.
      "const companionUnreaped = () => { const pid = pidIn('companion.pid'); if (!pid) return true; try { process.kill(pid, 0); return true } catch { return false } }",
      `const adapter = createHostAdapter({ platform: ${JSON.stringify(adapterPlatform)} })`,
      'const readSnapshot = adapter.readProcessSnapshot',
      'adapter.readProcessSnapshot = () => {',
      '  const hide = companionUnreaped()',
      '  const table = readSnapshot()',
      "  const broker = pidIn('broker.pid')",
      '  return hide && table.supported ? { ...table, processes: table.processes.filter((item) => item.pid !== broker) } : table',
      '}',
      `process.exitCode = await runSecondOpinion(${JSON.stringify({ ...f.options, route: 'astra' })}, createSecondOpinionDependencies(adapter), process.env)`,
    ].join('\n'))
    const result = spawnSync(process.execPath, [harness], {
      env: { ...process.env, ...f.env, HOME: f.home },
      encoding: 'utf8',
      timeout: 20_000,
    })
    expect(waitFor(() => existsSync(f.appPidFile))).toBe(true)
    const appPid = Number(readFileSync(f.appPidFile, 'utf8'))
    const brokerPid = Number(readFileSync(f.brokerPidFile, 'utf8'))
    try {
      expect(result.status, result.stderr).toBe(0)
      expect(lines(f.out).join('\n')).toContain(`stopped broker/app-server process family pid ${brokerPid} started by this call`)
      expect(waitFor(() => !processExists(appPid))).toBe(true)
      expect(waitFor(() => !processExists(brokerPid))).toBe(true)
    } finally {
      if (brokerPid && processExists(brokerPid)) {
        if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(brokerPid), '/t', '/f'])
        else process.kill(-brokerPid, 'SIGKILL')
      }
      if (appPid && processExists(appPid)) process.kill(appPid, 'SIGKILL')
    }
  }, 30_000)

  it('stops the detached broker app-server from the process exit hook', () => {
    const f = detachedBrokerFixture()
    const harness = join(f.repo, 'exit-harness.mjs')
    const coreUrl = pathToFileURL(resolve(__dirname, '../../../../plugin/bin/lib/second-opinion-core.mjs')).href
    const adapterUrl = pathToFileURL(resolve(__dirname, '../../../../plugin/bin/lib/host/adapter.mjs')).href
    writeFileSync(harness, [
      `import { createSecondOpinionDependencies, runSecondOpinion } from ${JSON.stringify(coreUrl)}`,
      `import { hostAdapter } from ${JSON.stringify(adapterUrl)}`,
      `runSecondOpinion(${JSON.stringify({ ...f.options, route: 'astra' })}, createSecondOpinionDependencies(hostAdapter), process.env)`,
      'setTimeout(() => process.exit(19), 300)',
    ].join('\n'))
    const result = spawnSync(process.execPath, [harness], {
      env: { ...process.env, ...f.env, HOME: f.home },
      encoding: 'utf8',
      timeout: 15_000,
    })
    expect(waitFor(() => existsSync(f.appPidFile))).toBe(true)
    const appPid = Number(readFileSync(f.appPidFile, 'utf8'))
    const brokerPid = Number(readFileSync(f.brokerPidFile, 'utf8'))
    try {
      expect(result.status).toBe(19)
      expect(waitFor(() => !processExists(appPid))).toBe(true)
      expect(waitFor(() => !processExists(brokerPid))).toBe(true)
    } finally {
      if (brokerPid && processExists(brokerPid)) {
        if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(brokerPid), '/t', '/f'])
        else process.kill(-brokerPid, 'SIGKILL')
      }
      if (appPid && processExists(appPid)) process.kill(appPid, 'SIGKILL')
    }
  }, 30_000)

  it('starts the Codex companion through the lane sandbox, records the sandbox line, and tells ownership the broker PID is namespaced', async () => {
    const f = fixture(true)
    const companion = join(f.repo, 'scripts', 'codex-companion.mjs')
    const brokerInChildPidNamespace = vi.fn()
    const requests: Array<Record<string, unknown>> = []
    const adapter = {
      platform: 'linux',
      createCodexBrokerOwnership: (env: Record<string, string>) => ({ env, capture: vi.fn(), stop: () => [], brokerInChildPidNamespace }),
    }
    const resolveSandbox = (request: Record<string, unknown>) => {
      requests.push(request)
      return { kind: 'bwrap', line: 'lane sandbox: bwrap (codex; writable /fixture)', unreadable: vi.fn(() => []), wrap: () => [process.execPath, ['-e', "process.stdout.write('ran inside the wrapper\\n')"]] }
    }
    const deps = createSecondOpinionDependencies(adapter, { resolveSandbox })
    deps.resolveCodexCompanion = () => companion

    expect(await runSecondOpinion({ ...f.options, route: 'astra' }, deps, f.env)).toBe(0)
    expect(lines(f.out)).toEqual(['ROUTE=gpt-astra', 'lane sandbox: bwrap (codex; writable /fixture)', 'ran inside the wrapper', 'EXIT=0'])
    expect(brokerInChildPidNamespace).toHaveBeenCalledOnce()
    expect(requests).toEqual([expect.objectContaining({ profile: 'codex', cwd: f.options.repo, paths: { readable: [f.repo] } })])
  })

  it('names output overflow and fails after terminating the owned companion family', async () => {
    const f = fixture(true)
    const companion = join(f.repo, 'overflow-companion.mjs')
    writeFileSync(companion, "process.stdout.write('x'.repeat(1024))\n")
    const stop = vi.fn(() => [])
    const adapter = {
      platform: process.platform,
      endProcessFamily: vi.fn(),
      readProcessSnapshot: () => ({ supported: true, processes: [] }),
      readProcessRelationships: () => ({ status: 'known', processes: [] }),
      createCodexBrokerOwnership: (env: Record<string, string>) => ({ env, capture: vi.fn(), stop }),
    }
    const deps = createSecondOpinionDependencies(adapter, { maxOutputBytes: 64, resolveSandbox: noSandbox })
    deps.resolveCodexCompanion = () => companion

    expect(await runSecondOpinion({ ...f.options, route: 'astra' }, deps, f.env)).toBe(1)
    expect(lines(f.out)).toEqual([
      'ROUTE=gpt-astra',
      'lane sandbox: none (pinned by the test)',
      'REFUSED: Codex companion output exceeded 64 bytes.',
      'EXIT=1',
    ])
    expect(stop).toHaveBeenCalled()
    expect(adapter.endProcessFamily).not.toHaveBeenCalled()
  })

  it('removes process-exit and abort listeners when companion spawning errors', async () => {
    const f = fixture(true)
    const baselineExitListeners = process.listenerCount('exit')
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    const adapter = {
      platform: process.platform,
      createCodexBrokerOwnership: (env: Record<string, string>) => ({ env, capture: vi.fn(), stop: () => [] }),
    }
    const deps = createSecondOpinionDependencies(adapter)
    deps.resolveCodexCompanion = () => join(f.repo, 'missing-companion.mjs')

    expect(await runSecondOpinion({ ...f.options, route: 'astra', signal }, deps, f.env)).toBe(1)
    expect(process.listenerCount('exit')).toBe(baselineExitListeners)
    expect(signal.removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('removes abort and exit listeners when spawn reports an error after sandbox planning', async () => {
    const f = fixture(true)
    const baselineExitListeners = process.listenerCount('exit')
    const signal = { aborted: false, reason: undefined, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const adapter = {
      platform: process.platform,
      createCodexBrokerOwnership: (env: Record<string, string>) => ({ env, capture: vi.fn(), stop: () => [] }),
    }
    const deps = createSecondOpinionDependencies(adapter, {
      resolveSandbox: () => ({ kind: 'bwrap', line: 'lane sandbox: bwrap (test)', unreadable: vi.fn(() => []), wrap: () => [join(f.repo, 'missing-executable'), []] }),
    })
    deps.resolveCodexCompanion = () => join(f.repo, 'missing-companion.mjs')

    expect(await runSecondOpinion({ ...f.options, route: 'astra', signal }, deps, f.env)).toBe(1)
    expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
    expect(signal.removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(process.listenerCount('exit')).toBe(baselineExitListeners)
  })

  // The real bwrap planner takes POSIX paths; a Windows os.tmpdir() fixture cannot exercise
  // its refusal reasons. The win32 pass-through and ownership cleanup are checked below.
  it.skipIf(process.platform === 'win32')('stops broker ownership and removes its temp root when sandbox planning refuses (Linux planner paths)', async () => {
    const core = process.env.WT_LANE_SECOND_OPINION_TEST_LIB
      ? await import(pathToFileURL(join(process.env.WT_LANE_SECOND_OPINION_TEST_LIB, 'second-opinion-core.mjs')).href)
      : { createSecondOpinionDependencies, runSecondOpinion }
    const sandbox = await import(pathToFileURL(join(process.env.WT_LANE_SANDBOX_TEST_LIB ?? resolve(__dirname, '../../../../plugin/bin/lib'), 'host/lane-sandbox.mjs')).href)
    for (const reason of ['no executable selected', 'parent traversal in a readable bind', 'codex realpath is covered'] as const) {
      const f = fixture(true)
      const ownershipRoot = mkdtempSync(join(f.repo, 'broker-ownership-'))
      const stop = vi.fn(() => { rmSync(ownershipRoot, { recursive: true, force: true }); return [] })
      const baseline = process.listenerCount('exit')
      const codex = '/opt/good/bin/codex'
      const env = { ...f.env, HOME: f.home, XDG_STATE_HOME: join(f.home, 'state'), PATH: reason === 'no executable selected' ? '' : '/opt/good/bin' }
      const adapter = {
        platform: 'linux',
        createCodexBrokerOwnership: () => ({ env, capture: vi.fn(), stop }),
      }
      const fs = {
        exists: () => true,
        realpath: (file: string) => file,
        isFile: (file: string) => file === codex,
        isExecutable: (file: string) => file === codex,
        isDir: (file: string) => reason !== 'codex realpath is covered' || !['/opt/good/bin', '/opt/good', '/opt', '/usr', '/usr/bin', '/usr/local/bin'].includes(file),
        readText: (file: string) => file === join(f.home, '.codex', 'auth.json') ? '{"tokens":{}}' : null,
        ensureDir: () => {}, ensureFile: () => {}, copy: () => {},
      }
      const resolveSandbox = vi.fn((request: Record<string, unknown>) => sandbox.resolveLaneSandbox({
        ...request,
        paths: { readable: [...(request.paths as { readable: string[] }).readable, ...(reason === 'parent traversal in a readable bind' ? ['/data/a/../b'] : [])] },
        fs, optionEnv: {}, bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', probe: () => ({ ok: true }),
        runtimeParent: f.home, spawnFn: () => { throw new Error('bridge started before refusal') },
      }))
      const deps = core.createSecondOpinionDependencies(adapter, { resolveSandbox })
      deps.resolveCodexCompanion = () => join(f.repo, 'scripts', 'codex-companion.mjs')
      expect(await core.runSecondOpinion({ ...f.options, route: 'astra' }, deps, f.env)).toBe(1)
      expect(resolveSandbox).toHaveBeenCalledOnce()
      expect(lines(f.out).join('\n')).toMatch(reason === 'no executable selected' ? /no executable selected/ : reason === 'parent traversal in a readable bind' ? /parent traversal in a bind/ : /realpath is covered/)
      expect(stop).toHaveBeenCalledOnce()
      expect(existsSync(ownershipRoot)).toBe(false)
      expect(process.listenerCount('exit')).toBe(baseline)
    }
  })

  it('stops broker ownership and removes its temp root after a win32 pass-through plan', async () => {
    const f = fixture(true)
    const ownershipRoot = mkdtempSync(join(f.repo, 'broker-ownership-'))
    const stop = vi.fn(() => { rmSync(ownershipRoot, { recursive: true, force: true }); return [] })
    const baseline = process.listenerCount('exit')
    // Exercise the Windows spelling even when this test runs on a POSIX CI worker.
    const windowsHome = process.platform === 'win32' ? f.home : 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\home'
    const adapter = {
      platform: 'win32',
      createCodexBrokerOwnership: (env: Record<string, string>) => ({ env: { ...env, HOME: windowsHome }, capture: vi.fn(), stop }),
    }
    const sandbox = await import(pathToFileURL(resolve(__dirname, '../../../../plugin/bin/lib/host/lane-sandbox.mjs')).href)
    const resolveSandbox = vi.fn((request: Record<string, unknown>) => sandbox.resolveLaneSandbox({ ...request, optionEnv: {} }))
    const deps = createSecondOpinionDependencies(adapter, { resolveSandbox })
    deps.resolveCodexCompanion = () => join(f.repo, 'missing-companion.mjs')

    expect(await runSecondOpinion({ ...f.options, route: 'astra' }, deps, f.env)).toBe(1)
    expect(resolveSandbox).toHaveBeenCalledOnce()
    expect((resolveSandbox.mock.calls[0]![0].env as Record<string, string>).HOME).toBe(windowsHome)
    expect(lines(f.out)).toContain('lane sandbox: none (bubblewrap sandbox is Linux-only; this host is win32); running with the environment allow-list only')
    expect(stop).toHaveBeenCalledOnce()
    expect(existsSync(ownershipRoot)).toBe(false)
    expect(process.listenerCount('exit')).toBe(baseline)
  })
})
