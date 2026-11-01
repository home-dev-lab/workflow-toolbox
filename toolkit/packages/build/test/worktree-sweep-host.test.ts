import { describe, expect, it } from 'vitest'
const url = new URL('../../../../plugin/bin/lib/host/sweep-processes.mjs', import.meta.url).href
const host = await import(/* @vite-ignore */ url).catch(() => null)

describe('sweep real-host diagnostic', () => {
  it.skipIf(process.platform !== 'linux')('host: real /proc scan returns a named verdict', () => {
    expect(host).not.toBeNull()
    const result = host!.scanSweepProcesses()
    expect(['known', 'unknown']).toContain(result.status)
    if (result.status === 'unknown') expect(result.reason).toBeTruthy()
    expect(host!.hostNamespaceEvidence().reason).toBe('not in the host PID namespace')
  })
})
