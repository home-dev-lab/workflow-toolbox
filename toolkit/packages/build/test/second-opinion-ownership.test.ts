import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createCodexBrokerOwnership } from '../../../../plugin/bin/lib/host/codex-broker-ownership.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const broker = (pid: number, ppid: number) => ({
  pid,
  ppid,
  command: `/home/test/.claude/plugins/cache/openai-codex/codex/1.0.5/scripts/app-server-broker.mjs`,
})

describe('second-opinion Codex broker ownership', () => {
  it.each([
    ['ubuntu', [{ pid: 2125, ppid: 2118, command: 'node wrapper' }, broker(2132, 2125), { pid: 2139, ppid: 2132, command: 'codex app-server' }]],
    ['macOS without a sid column', [{ pid: 4778, ppid: 4777, command: 'node wrapper' }, broker(4779, 4778), { pid: 4780, ppid: 4779, command: 'codex app-server' }]],
    ['Windows', [{ pid: 3500, ppid: 2192, command: 'node.exe wrapper' }, broker(984, 3500), { pid: 4000, ppid: 984, command: 'codex.exe app-server' }]],
  ])('identifies only the detached broker descended from the companion in the %s recording shape', (_platform, processes) => {
    processes.push(broker(9999, 1))
    const endProcessFamily = vi.fn(() => ({ status: 'ended' }))
    const ownership = createCodexBrokerOwnership({
      readProcessSnapshot: () => ({ supported: true, processes }),
      endProcessFamily,
    }, {})
    roots.push(ownership.env.CLAUDE_PLUGIN_DATA)

    ownership.stop(processes[0]!.pid)
    expect(endProcessFamily).toHaveBeenCalledOnce()
    expect(endProcessFamily).toHaveBeenCalledWith(processes[1]!.pid)
    expect(endProcessFamily).not.toHaveBeenCalledWith(9999)
  })

  it('stops the exact broker recorded in this call private state, not another session broker', () => {
    const endProcessFamily = vi.fn(() => ({ status: 'ended', kind: 'process_tree' }))
    const ownership = createCodexBrokerOwnership({
      readProcessSnapshot: vi.fn(),
      endProcessFamily,
    }, {})
    const root = ownership.env.CLAUDE_PLUGIN_DATA
    roots.push(root)
    const stateDir = join(root, 'state', 'workspace')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'broker.json'), JSON.stringify({ pid: 2132 }))

    expect(ownership.stop(2125)).toEqual(['stopped broker/app-server process family pid 2132 started by this call'])
    expect(endProcessFamily).toHaveBeenCalledOnce()
    expect(endProcessFamily).toHaveBeenCalledWith(2132)
    expect(endProcessFamily).not.toHaveBeenCalledWith(9999)
  })

  it('names the degraded path when neither private state nor process discovery can identify the broker', () => {
    const ownership = createCodexBrokerOwnership({
      readProcessSnapshot: () => ({ supported: false, processes: [], reason: 'process discovery unavailable on this platform' }),
      endProcessFamily: vi.fn(),
    }, {})
    roots.push(ownership.env.CLAUDE_PLUGIN_DATA)

    expect(ownership.stop(2125)).toEqual(['app-server cleanup unavailable: process discovery unavailable on this platform'])
  })
})
