import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { runSecondOpinion } from '../../../../plugin/bin/lib/second-opinion-core.mjs'

const CLI = resolve(__dirname, '../../../../plugin/bin/wt-second-opinion.mjs')
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(consented: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'wt-second-opinion-'))
  roots.push(root)
  const repo = join(root, 'repo')
  const config = join(root, 'config')
  mkdirSync(repo)
  mkdirSync(config)
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
    request,
    out,
    env: { CLAUDE_CONFIG_DIR: config },
    options: { request, out, repo, effort: 'medium' },
  }
}

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
    probeQuota: vi.fn(() => ({ weekly_scoped: [{ scope: 'Claude Fable', percent: 12 }] })),
    resolveSdkQuery: vi.fn(() => async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, result: 'fable answer' }
    }),
    listBrokers: vi.fn(() => ({ supported: true, pids: [] })),
    stopBroker: vi.fn(),
    ...overrides,
  }
}

describe('second-opinion advisor', () => {
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

  it('uses Fable when that route is forced despite active lane consent', async () => {
    const f = fixture(true)
    const deps = dependencies()
    expect(await runSecondOpinion({ ...f.options, route: 'fable' }, deps, f.env)).toBe(0)

    expect(lines(f.out)[0]).toBe('ROUTE=claude-fable')
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

  it('refuses a route outside auto, astra and fable instead of running Fable', async () => {
    const f = fixture(true)
    const deps = dependencies()
    expect(await runSecondOpinion({ ...f.options, route: 'Astra' }, deps, f.env)).toBe(2)

    expect(lines(f.out)).toEqual([
      'REFUSED: unknown route "Astra"; use auto, astra, or fable.',
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
    expect(lines(f.out)).toEqual(['REFUSED: --route must be auto, astra, or fable', 'EXIT=2'])
  })

  it('accepts --route as a CLI flag rather than reporting an unknown argument', () => {
    const f = fixture(true)
    const result = spawnSync(process.execPath, [CLI, '--out', f.out, '--route', 'fable'], { encoding: 'utf8', env: { ...process.env, ...f.env } })

    expect(result.status).toBe(2)
    expect(lines(f.out)).toEqual(['REFUSED: --request is required', 'EXIT=2'])
  })

  it('refuses Fable when the quota probe reports no Fable scope, instead of reading silence as headroom', async () => {
    const f = fixture(false)
    const deps = dependencies({ probeQuota: vi.fn(() => ({ weekly_scoped: [{ scope: 'Opus', percent: 3 }] })) })
    expect(await runSecondOpinion(f.options, deps, f.env)).toBe(1)

    expect(lines(f.out)).toEqual([
      'ROUTE=claude-fable',
      'REFUSED: the quota probe reported no Claude Fable weekly scope, so the Fable quota guard cannot be applied.',
      'EXIT=1',
    ])
    expect(deps.resolveSdkQuery).not.toHaveBeenCalled()
  })

  it('applies the Fable quota guard when Fable is forced despite active lane consent', async () => {
    const f = fixture(true)
    const deps = dependencies({
      probeQuota: vi.fn(() => ({ weekly_scoped: [{ scope: 'Fable', percent: 90 }] })),
    })
    expect(await runSecondOpinion({ ...f.options, route: 'fable' }, deps, f.env)).toBe(1)

    expect(lines(f.out)).toEqual([
      'ROUTE=claude-fable',
      'REFUSED: Claude Fable weekly scoped quota is 90%, at or above the 90% limit.',
      'EXIT=1',
    ])
    expect(deps.resolveSdkQuery).not.toHaveBeenCalled()
    expect(deps.runCodex).not.toHaveBeenCalled()
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

  it('uses one read-only Fable SDK query when lane consent is not given', async () => {
    const f = fixture(false)
    let queryInput: unknown
    const query = vi.fn((input) => {
      queryInput = input
      return (async function* () {
        yield { type: 'result', subtype: 'success', is_error: false, result: 'independent answer' }
      })()
    })
    const deps = dependencies({ resolveSdkQuery: vi.fn(() => query) })
    expect(await runSecondOpinion(f.options, deps, f.env)).toBe(0)

    expect(deps.probeQuota).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledOnce()
    expect(queryInput).toMatchObject({
      prompt: 'Question with facts and sources.',
      options: {
        model: 'fable',
        cwd: f.repo,
        tools: ['Read', 'Glob', 'Grep'],
        settingSources: [],
      },
    })
    expect(lines(f.out)).toEqual(['ROUTE=claude-fable', 'independent answer', 'EXIT=0'])
    expect(deps.runCodex).not.toHaveBeenCalled()
  })

  it.each([90, 97])('refuses Fable at or above the default quota threshold (%s%%)', async (percent) => {
    const f = fixture(false)
    const deps = dependencies({
      probeQuota: vi.fn(() => ({ weekly_scoped: [{ scope: 'Fable', percent }] })),
    })
    expect(await runSecondOpinion(f.options, deps, f.env)).toBe(1)
    expect(deps.resolveSdkQuery).not.toHaveBeenCalled()
    expect(lines(f.out)).toEqual([
      'ROUTE=claude-fable',
      `REFUSED: Claude Fable weekly scoped quota is ${percent}%, at or above the 90% limit.`,
      'EXIT=1',
    ])
  })

  it('honors WT_SECOND_OPINION_FABLE_MAX_PCT', async () => {
    const f = fixture(false)
    const deps = dependencies({
      probeQuota: vi.fn(() => ({ weekly_scoped: [{ scope: 'Fable', percent: 74 }] })),
    })
    expect(await runSecondOpinion(f.options, deps, { ...f.env, WT_SECOND_OPINION_FABLE_MAX_PCT: '70' })).toBe(1)
    expect(lines(f.out)[1]).toContain('74%, at or above the 70% limit')
  })

  it('refuses rather than falling back to Fable when consent is given but Codex is missing', async () => {
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
      resolveSdkQuery: vi.fn(() => { throw new Error('@anthropic-ai/claude-agent-sdk is not installed; run: npm install -g @anthropic-ai/claude-agent-sdk') }),
    })
    expect(await runSecondOpinion(f.options, deps, f.env)).toBe(1)
    expect(lines(f.out)).toEqual([
      'ROUTE=claude-fable',
      'REFUSED: Claude Agent SDK unavailable; run: npm install -g @anthropic-ai/claude-agent-sdk',
      'EXIT=1',
    ])
  })

  it('preserves a failed companion exit and keeps EXIT as the last output line', async () => {
    const f = fixture(true)
    const deps = dependencies({
      runCodex: vi.fn(() => ({ status: 7, stdout: 'partial answer\n', stderr: 'companion failed\n' })),
      listBrokers: vi.fn(() => ({ supported: false, pids: [], reason: 'broker cleanup unavailable on this platform' })),
    })
    expect(await runSecondOpinion(f.options, deps, f.env)).toBe(7)
    expect(lines(f.out)).toEqual([
      'ROUTE=gpt-astra',
      'partial answer',
      'companion failed',
      'broker cleanup unavailable on this platform',
      'EXIT=7',
    ])
  })

  it('stops only brokers that appeared during its own Astra call', async () => {
    const f = fixture(true)
    const listBrokers = vi.fn()
      .mockReturnValueOnce({ supported: true, pids: [11, 12] })
      .mockReturnValueOnce({ supported: true, pids: [11, 12, 21] })
    const deps = dependencies({ listBrokers })
    expect(await runSecondOpinion(f.options, deps, f.env)).toBe(0)
    expect(deps.stopBroker).toHaveBeenCalledOnce()
    expect(deps.stopBroker).toHaveBeenCalledWith(21)
    expect(lines(f.out)).toContain('stopped broker pid 21 started by this call')
    expect(lines(f.out).at(-1)).toBe('EXIT=0')
  })

  it('stops the Codex app-server process family when the wrapper receives SIGTERM', () => {
    const f = fixture(true)
    const companionDir = join(f.env.CLAUDE_CONFIG_DIR, 'plugins', 'cache', 'openai-codex', 'codex', '1.0.0', 'scripts')
    const appPidFile = join(f.repo, 'app-server.pid')
    mkdirSync(companionDir, { recursive: true })
    writeFileSync(join(companionDir, 'codex-companion.mjs'), [
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'app-server'], { stdio: 'ignore' })",
      "writeFileSync(join(process.cwd(), 'app-server.pid'), String(child.pid))",
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    const wrapper = spawn(process.execPath, [CLI, '--request', f.request, '--out', f.out, '--repo', f.repo, '--route', 'astra'], {
      env: { ...process.env, ...f.env, HOME: f.repo },
      stdio: 'ignore',
    })
    let appPid = 0
    try {
      expect(waitFor(() => existsSync(appPidFile))).toBe(true)
      appPid = Number(readFileSync(appPidFile, 'utf8'))
      expect(processExists(appPid)).toBe(true)
      process.kill(wrapper.pid!, 'SIGTERM')
      expect(waitFor(() => !processExists(appPid))).toBe(true)
    } finally {
      if (wrapper.pid && processExists(wrapper.pid)) process.kill(wrapper.pid, 'SIGKILL')
      if (appPid && processExists(appPid)) process.kill(appPid, 'SIGKILL')
    }
  })
})
