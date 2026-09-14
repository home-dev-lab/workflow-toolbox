import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { runSecondOpinion } from '../../../../plugin/bin/lib/second-opinion-core.mjs'

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
})
