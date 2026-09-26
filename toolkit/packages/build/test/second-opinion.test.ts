import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalPath } from './helpers/canonical-path.js'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createSecondOpinionDependencies, listProcessRelationships, listProcessTable, runSecondOpinion } from '../../../../plugin/bin/lib/second-opinion-core.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createHostAdapter } from '../../../../plugin/bin/lib/host/adapter.mjs'

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

// The ownership tests below read broker PIDs the fake companion writes from inside its process, so
// they run the UNSANDBOXED path (macOS, Windows, no bwrap); inside the sandbox those would be
// namespace PIDs. The sandboxed end of the family is locked by the namespace test further down.
function detachedBrokerFixture(mode: 'hang' | 'normal' | 'error' = 'hang', sandbox = 'off') {
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
    "import { mkdirSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "const child = spawn(process.execPath, [join(import.meta.dirname, 'app-server-broker.mjs')], { detached: true, stdio: 'ignore' })",
    'child.unref()',
    "writeFileSync(join(process.cwd(), 'broker.pid'), String(child.pid))",
    "const stateDir = join(process.env.CLAUDE_PLUGIN_DATA, 'state', 'fixture')",
    "setTimeout(() => { mkdirSync(stateDir, { recursive: true }); writeFileSync(join(stateDir, 'broker.json'), JSON.stringify({ pid: child.pid })) }, 1500)",
    mode === 'hang' ? 'setInterval(() => {}, 1000)' : `setTimeout(() => process.exit(${mode === 'normal' ? 0 : 7}), 100)`,
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

  it('uses one fresh read-only Opus SDK query when lane consent is not given', async () => {
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
    expect(await runSecondOpinion(f.options, deps, f.env)).toBe(0)

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

  it('runs the Opus fallback at xhigh effort whatever effort the caller passed', async () => {
    const f = fixture(false)
    let sdkEffort: unknown
    const query = vi.fn((input: { options: { effort?: unknown } }) => {
      sdkEffort = input.options.effort
      return (async function* () {
        yield { type: 'result', subtype: 'success', is_error: false, result: 'opus answer' }
      })()
    })
    const deps = dependencies({ resolveSdkQuery: vi.fn(() => query) })
    expect(await runSecondOpinion({ ...f.options, effort: 'low', route: 'auto' }, deps, f.env)).toBe(0)

    expect(query).toHaveBeenCalledOnce()
    expect(sdkEffort).toBe('xhigh')
    expect(lines(f.out)[0]).toBe('ROUTE=claude-opus')
    expect(deps.runCodex).not.toHaveBeenCalled()
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

  it('refuses with the SDK resolver fix when consent is absent and the SDK is missing', async () => {
    const f = fixture(false)
    const deps = dependencies({
      resolveSdkQuery: vi.fn(() => { throw new Error("@anthropic-ai/claude-agent-sdk is not installed; require >=0.3.280; run: npm install -g '@anthropic-ai/claude-agent-sdk@>=0.3.280'") }),
    })
    expect(await runSecondOpinion(f.options, deps, f.env)).toBe(1)
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

  it.each([['normal', 0], ['error', 7]] as const)('stops the detached broker app-server after a %s companion end', (mode, expectedStatus) => {
    const f = detachedBrokerFixture(mode)
    const result = spawnSync(process.execPath, [CLI, '--request', f.request, '--out', f.out, '--repo', f.repo, '--route', 'astra'], {
      env: { ...process.env, ...f.env, HOME: f.home },
      encoding: 'utf8',
      timeout: process.platform === 'win32' ? 15_000 : 5_000,
    })
    expect(waitFor(() => existsSync(f.appPidFile))).toBe(true)
    const appPid = Number(readFileSync(f.appPidFile, 'utf8'))
    const brokerPid = Number(readFileSync(f.brokerPidFile, 'utf8'))
    try {
      expect(result.status).toBe(expectedStatus)
      expect(waitFor(() => !processExists(appPid))).toBe(true)
      expect(waitFor(() => !processExists(brokerPid))).toBe(true)
    } finally {
      if (brokerPid && processExists(brokerPid)) {
        if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(brokerPid), '/t', '/f'])
        else process.kill(-brokerPid, 'SIGKILL')
      }
      if (appPid && processExists(appPid)) process.kill(appPid, 'SIGKILL')
    }
  }, process.platform === 'win32' ? 30_000 : 10_000)

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
      return { kind: 'bwrap', line: 'lane sandbox: bwrap (codex; writable /fixture)', wrap: () => [process.execPath, ['-e', "process.stdout.write('ran inside the wrapper\\n')"]] }
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
})
