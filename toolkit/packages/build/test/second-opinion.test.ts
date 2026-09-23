import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createSecondOpinionDependencies, listProcessRelationships, listProcessTable, runSecondOpinion } from '../../../../plugin/bin/lib/second-opinion-core.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createHostAdapter } from '../../../../plugin/bin/lib/host/adapter.mjs'

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
    resolveSdkQuery: vi.fn(() => async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, result: 'opus answer' }
    }),
    listBrokers: vi.fn(() => ({ supported: true, pids: [] })),
    stopBroker: vi.fn(),
    ...overrides,
  }
}

describe('second-opinion advisor', () => {
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
      prompt: `${join(f.repo, 'CLAUDE.md')} is the repository's contributor guide; read it before planning or changing code.\n\nQuestion with facts and sources.`,
      options: {
        model: 'opus',
        effort: 'medium',
        cwd: f.repo,
        tools: ['Read', 'Glob', 'Grep'],
        settingSources: [],
      },
    })
    expect(lines(f.out)).toEqual(['ROUTE=claude-opus', 'independent answer', 'EXIT=0'])
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

  it('names output overflow and fails after terminating the owned companion family', async () => {
    const f = fixture(true)
    const companion = join(f.repo, 'overflow-companion.mjs')
    writeFileSync(companion, "process.stdout.write('x'.repeat(1024))\n")
    const endProcessFamily = vi.fn()
    const adapter = {
      platform: process.platform,
      endProcessFamily,
      readProcessSnapshot: () => ({ supported: true, processes: [] }),
      readProcessRelationships: () => ({ status: 'known', processes: [] }),
    }
    const deps = createSecondOpinionDependencies(adapter, { maxOutputBytes: 64 })
    deps.resolveCodexCompanion = () => companion

    expect(await runSecondOpinion({ ...f.options, route: 'astra' }, deps, f.env)).toBe(1)
    expect(lines(f.out)).toEqual([
      'ROUTE=gpt-astra',
      'REFUSED: Codex companion output exceeded 64 bytes.',
      'EXIT=1',
    ])
    expect(endProcessFamily).toHaveBeenCalled()
  })
})
