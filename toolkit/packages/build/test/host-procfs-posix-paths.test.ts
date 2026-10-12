import { describe, expect, it, vi } from 'vitest'

// procfs paths are POSIX on every host. Replacing the native join with the Windows one lets a
// Linux run reproduce what a Windows host does to a module that joins with the native separator.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>()
  const windowsNative = { ...actual, join: actual.win32.join }
  return { ...windowsNative, default: windowsNative }
})

const hostUrl = new URL('../../../../plugin/bin/lib/host/procfs.mjs', import.meta.url).href
const host = await import(/* @vite-ignore */ hostUrl)

describe('procfs path construction under a Windows-native path module', () => {
  it('builds every procfs path with forward slashes whatever the host separator', () => {
    const readFile = vi.fn((_file: string, ..._args: unknown[]) => 'value')
    const readdir = vi.fn((_dir: string, ..._args: unknown[]): string[] => [])
    const procfs = host.createProcfs({ platform: 'linux', readFile, readdir })
    procfs.readLoadAverage('utf8')
    procfs.readCommandLine(42)
    procfs.readDescriptorInfo(42, 7)
    procfs.listDescriptors(42)
    expect(readFile.mock.calls.map(([file]) => file)).toEqual(['/proc/loadavg', '/proc/42/cmdline', '/proc/42/fdinfo/7'])
    expect(readdir.mock.calls.map(([dir]) => dir)).toEqual(['/proc/42/fd'])
  })
})
