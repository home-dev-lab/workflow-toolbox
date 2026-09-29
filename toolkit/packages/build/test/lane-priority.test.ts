import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { trustedSystemExecutable } from '../../../../plugin/bin/lib/host/lane-sandbox.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { applyLanePriority } from '../../../../plugin/bin/lib/host/lane-priority.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('applyLanePriority (injected platform, run and setPriority)', () => {
  const call = (priority: string, options: Record<string, unknown>) => {
    const calls: unknown[][] = []
    const line = applyLanePriority(priority, { pid: 42, setPriority: (...a: unknown[]) => { calls.push(['set', ...a]) }, run: (...a: unknown[]) => { calls.push(['run', ...a]); return { status: 0 } }, resolve: () => '/usr/bin/ionice', ...options })
    return { line, calls }
  }
  it('linux success sets niceness 19 and the idle I/O class', () => {
    const { line, calls } = call('low', { platform: 'linux' })
    expect(line).toBe('priority nice=19 ionice=idle')
    expect(calls).toEqual([['set', 42, 19], ['run', '/usr/bin/ionice', ['-c', '3', '-p', '42'], expect.anything()]])
  })
  it('linux without ionice on an absolute PATH entry says so and still niceness 19', () => {
    expect(call('low', { platform: 'linux', resolve: () => null }).line).toBe('priority nice=19 ionice=unavailable (not found in a trusted system location)')
  })
  it('linux ionice failing to start or exiting non-zero is degraded, never a failure', () => {
    expect(call('low', { platform: 'linux', run: () => ({ error: new Error('boom') }) }).line).toBe('priority nice=19 ionice=unavailable (boom)')
    expect(call('low', { platform: 'linux', run: () => ({ status: 1 }) }).line).toBe('priority nice=19 ionice=unavailable (exit 1)')
  })
  it('darwin keeps niceness 19 and reports ionice unsupported', () => {
    const { line, calls } = call('low', { platform: 'darwin' })
    expect(line).toBe('priority nice=19 ionice=unsupported-platform')
    expect(calls).toEqual([['set', 42, 19]])
  })
  it('win32 uses the below-normal priority class, not 19', () => {
    const { line, calls } = call('low', { platform: 'win32' })
    expect(line).toBe('priority nice=below-normal ionice=unsupported-platform')
    expect(calls).toEqual([['set', 42, 10]])
  })
  it('a throwing setPriority is named and does not stop ionice', () => {
    const { line } = call('low', { platform: 'linux', setPriority: () => { throw new Error('EPERM') } })
    expect(line).toBe('priority nice=unavailable (EPERM) ionice=idle')
  })
  it('normal calls nothing', () => {
    const { line, calls } = call('normal', { platform: 'linux' })
    expect(line).toBe('priority normal')
    expect(calls).toEqual([])
  })
  it('resolves ionice through the trusted system-executable resolver, never a relative or user-owned PATH entry', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-lane-path-'))); roots.push(root)
    writeFileSync(join(root, 'tool'), '#!/bin/sh\n', { mode: 0o755 }); chmodSync(join(root, 'tool'), 0o755)
    const relativeEntry = relative(process.cwd(), root)
    expect(trustedSystemExecutable('tool', ['relative-nowhere', relativeEntry].join(delimiter))).toBeNull()
    // Control: the same file on an ABSOLUTE entry is seen (and refused as untrusted), so the null above is not blindness.
    expect(() => trustedSystemExecutable('tool', root)).toThrow(/untrusted tool/)
    expect(trustedSystemExecutable('sh', '')).toMatch(/^\//)
  })
})
