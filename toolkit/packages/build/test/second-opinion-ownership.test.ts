import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createCodexBrokerOwnership } from '../../../../plugin/bin/lib/host/codex-broker-ownership.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const broker = (pid: number, ppid: number, elapsedMs = 4_000) => ({
  pid,
  ppid,
  elapsedMs,
  command: `/home/test/.claude/plugins/cache/openai-codex/codex/1.0.5/scripts/app-server-broker.mjs`,
})

const companion = (pid: number, elapsedMs = 5_000) => ({
  pid,
  ppid: 1,
  elapsedMs,
  command: '/home/test/.claude/plugins/cache/openai-codex/codex/1.0.5/scripts/codex-companion.mjs task',
})

describe('second-opinion Codex broker ownership', () => {
  it.each([
    ['ubuntu', [companion(2125), broker(2132, 2125), { pid: 2139, ppid: 2132, elapsedMs: 3_000, command: 'codex app-server' }]],
    ['macOS without a sid column', [companion(4778), broker(4779, 4778), { pid: 4780, ppid: 4779, elapsedMs: 3_000, command: 'codex app-server' }]],
    ['Windows', [companion(3500), broker(984, 3500), { pid: 4000, ppid: 984, elapsedMs: 3_000, command: 'codex.exe app-server' }]],
  ])('identifies only the detached broker descended from the companion in the %s recording shape', (_platform, processes) => {
    processes.push(broker(9999, 1))
    const endProcessFamily = vi.fn((pid: number) => {
      const index = processes.findIndex((item) => item.pid === pid)
      if (index >= 0) processes.splice(index, 1)
      return { status: 'ended' }
    })
    const forceEndProcessFamily = vi.fn(() => ({ status: 'ended' }))
    const ownership = createCodexBrokerOwnership({
      readProcessSnapshot: () => ({ supported: true, processes }),
      endProcessFamily,
      forceEndProcessFamily,
    }, {}, { stopTimeoutMs: 0 })
    roots.push(ownership.env.CLAUDE_PLUGIN_DATA)

    const ownedPid = processes[1]!.pid
    ownership.capture(processes[0]!.pid)
    expect(ownership.stop()).toEqual([`stopped broker/app-server process family pid ${ownedPid} started by this call`])
    expect(endProcessFamily).toHaveBeenCalledOnce()
    expect(endProcessFamily).toHaveBeenCalledWith(ownedPid)
    expect(forceEndProcessFamily).not.toHaveBeenCalled()
  })

  it('stops the exact broker recorded in this call private state, not another session broker', () => {
    let processes = [companion(2125), broker(2132, 2125)]
    const endProcessFamily = vi.fn(() => { processes = []; return { status: 'ended', kind: 'process_tree' } })
    const ownership = createCodexBrokerOwnership({
      readProcessSnapshot: () => ({ supported: true, processes }),
      endProcessFamily,
      forceEndProcessFamily: vi.fn(),
    }, {}, { stopTimeoutMs: 0 })
    const root = ownership.env.CLAUDE_PLUGIN_DATA
    roots.push(root)
    const stateDir = join(root, 'state', 'workspace')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'broker.json'), JSON.stringify({ pid: 2132 }))

    ownership.capture(2125)
    expect(ownership.stop()).toEqual(['stopped broker/app-server process family pid 2132 started by this call'])
    expect(endProcessFamily).toHaveBeenCalledOnce()
    expect(endProcessFamily).toHaveBeenCalledWith(2132)
    expect(existsSync(root)).toBe(false)
  })

  it('refuses a stale state PID whose current command is not the owned broker', () => {
    const endProcessFamily = vi.fn()
    const ownership = createCodexBrokerOwnership({
      readProcessSnapshot: () => ({ supported: true, processes: [companion(2125), { pid: 2132, ppid: 2125, elapsedMs: 10, command: 'unrelated process' }] }),
      endProcessFamily,
      forceEndProcessFamily: vi.fn(),
    }, {})
    roots.push(ownership.env.CLAUDE_PLUGIN_DATA)
    const stateDir = join(ownership.env.CLAUDE_PLUGIN_DATA, 'state', 'workspace')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'broker.json'), JSON.stringify({ pid: 2132 }))

    ownership.capture(2125)
    expect(ownership.stop()).toEqual(['app-server cleanup unavailable for owned broker pid 2132: broker identity changed before cleanup'])
    expect(endProcessFamily).not.toHaveBeenCalled()
  })

  it('does not walk descendants after the companion has exited', () => {
    const readProcessSnapshot = vi.fn(() => ({ supported: true, processes: [companion(2125), broker(2132, 2125)] }))
    const endProcessFamily = vi.fn()
    const ownership = createCodexBrokerOwnership({ readProcessSnapshot, endProcessFamily, forceEndProcessFamily: vi.fn() }, {})
    roots.push(ownership.env.CLAUDE_PLUGIN_DATA)

    expect(ownership.stop()).toEqual(['app-server cleanup unavailable: broker not captured before companion exit'])
    expect(readProcessSnapshot).not.toHaveBeenCalled()
    expect(endProcessFamily).not.toHaveBeenCalled()
  })

  it('revalidates the captured broker start before signalling a reused PID', () => {
    let processes = [companion(2125, 10_000), broker(2132, 2125, 9_000)]
    const endProcessFamily = vi.fn()
    const ownership = createCodexBrokerOwnership({
      readProcessSnapshot: () => ({ supported: true, processes }),
      endProcessFamily,
      forceEndProcessFamily: vi.fn(),
    }, {}, { now: () => 20_000, stopTimeoutMs: 0 })
    roots.push(ownership.env.CLAUDE_PLUGIN_DATA)
    ownership.capture(2125)
    processes = [broker(2132, 1, 100)]

    expect(ownership.stop()).toEqual(['app-server cleanup unavailable for owned broker pid 2132: broker identity changed before cleanup'])
    expect(endProcessFamily).not.toHaveBeenCalled()
  })

  it('captures a broker descendant spawned seconds after a slow companion start', () => {
    let alive = true
    const endProcessFamily = vi.fn(() => { alive = false; return { status: 'ended' } })
    const ownership = createCodexBrokerOwnership({
      readProcessSnapshot: () => ({ supported: true, processes: alive ? [companion(2125, 10_000), broker(2132, 2125, 1_000)] : [companion(2125, 10_000)] }),
      endProcessFamily,
      forceEndProcessFamily: vi.fn(),
    }, {}, { now: () => 20_000 })
    roots.push(ownership.env.CLAUDE_PLUGIN_DATA)

    expect(ownership.capture(2125)).toBe(2132)
    expect(ownership.stop()).toEqual(['stopped broker/app-server process family pid 2132 started by this call'])
    expect(endProcessFamily).toHaveBeenCalledWith(2132)
  })

  it('rejects a state-file broker PID whose process started before this companion launch', () => {
    const endProcessFamily = vi.fn()
    const ownership = createCodexBrokerOwnership({
      readProcessSnapshot: () => ({ supported: true, processes: [companion(2125, 5_000), broker(2132, 1, 60_000)] }),
      endProcessFamily,
      forceEndProcessFamily: vi.fn(),
    }, {}, { now: () => 20_000 })
    roots.push(ownership.env.CLAUDE_PLUGIN_DATA)
    const stateDir = join(ownership.env.CLAUDE_PLUGIN_DATA, 'state', 'workspace')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'broker.json'), JSON.stringify({ pid: 2132 }))

    expect(ownership.capture(2125)).toBeNull()
    expect(endProcessFamily).not.toHaveBeenCalled()
  })

  it('confirms SIGTERM and escalates to SIGKILL when the broker remains alive', () => {
    let processes = [companion(2125), broker(2132, 2125)]
    const endProcessFamily = vi.fn(() => ({ status: 'ended' }))
    const forceEndProcessFamily = vi.fn(() => { processes = []; return { status: 'ended' } })
    const ownership = createCodexBrokerOwnership({
      readProcessSnapshot: () => ({ supported: true, processes }),
      endProcessFamily,
      forceEndProcessFamily,
    }, {}, { stopTimeoutMs: 0 })
    roots.push(ownership.env.CLAUDE_PLUGIN_DATA)
    ownership.capture(2125)

    expect(ownership.stop()).toEqual(['force-stopped broker/app-server process family pid 2132 started by this call'])
    expect(endProcessFamily).toHaveBeenCalledWith(2132)
    expect(forceEndProcessFamily).toHaveBeenCalledWith(2132)
  })

  it('removes its private temp directory even when host termination throws', () => {
    const ownership = createCodexBrokerOwnership({
      readProcessSnapshot: () => ({ supported: true, processes: [companion(2125), broker(2132, 2125)] }),
      endProcessFamily: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) },
      forceEndProcessFamily: vi.fn(),
    }, {})
    const root = ownership.env.CLAUDE_PLUGIN_DATA
    roots.push(root)
    ownership.capture(2125)

    expect(ownership.stop()).toEqual(['app-server cleanup unavailable for owned broker pid 2132: EBUSY'])
    expect(existsSync(root)).toBe(false)
  })

  it('names the degraded path when neither private state nor process discovery can identify the broker', () => {
    const ownership = createCodexBrokerOwnership({
      readProcessSnapshot: () => ({ supported: false, processes: [], reason: 'process discovery unavailable on this platform' }),
      endProcessFamily: vi.fn(),
      forceEndProcessFamily: vi.fn(),
    }, {})
    roots.push(ownership.env.CLAUDE_PLUGIN_DATA)

    ownership.capture(2125)
    expect(ownership.stop()).toEqual(['app-server cleanup unavailable: broker not captured; process discovery unavailable on this platform'])
  })
})
