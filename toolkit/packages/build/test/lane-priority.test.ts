import { describe, expect, it } from 'vitest'

// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { applyLanePriority, resolveIonice } from '../../../../plugin/bin/lib/host/lane-priority.mjs'

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
  // Host-independent: the trusted resolver and the PATH string are injected, so nothing here reads the real
  // filesystem, findOnPath, /bin/sh or the host's path delimiter. The real resolver's own behaviour is locked in the
  // lane-sandbox tests; this file locks only that ionice goes through it and nothing else.
  describe('default ionice resolution goes only through trustedSystemExecutable(name, PATH)', () => {
    const winPath = 'C:\\tools;relative'
    it('passes the name ionice and the given search path to the injected resolver, and returns its result', () => {
      const seen: unknown[][] = []
      const resolver = resolveIonice({ trusted: (...a: unknown[]) => { seen.push(a); return '/usr/bin/ionice' }, searchPath: winPath })
      expect(resolver('ionice')).toBe('/usr/bin/ionice')
      expect(seen).toEqual([['ionice', winPath]])
    })
    it('a refusal thrown by the resolver becomes { refusal: <message> } and the ionice=unavailable line', () => {
      const trusted = () => { throw new Error('untrusted ionice at C:\\tools\\ionice') }
      const resolver = resolveIonice({ trusted, searchPath: winPath })
      expect(resolver('ionice')).toEqual({ refusal: 'untrusted ionice at C:\\tools\\ionice' })
      expect(call('low', { platform: 'linux', resolve: resolver }).line).toBe('priority nice=19 ionice=unavailable (untrusted ionice at C:\\tools\\ionice)')
    })
    it('a non-Error throw is stringified into the refusal', () => {
      expect(resolveIonice({ trusted: () => { throw 'plain' }, searchPath: winPath })('ionice')).toEqual({ refusal: 'plain' })
    })
    it('null from the resolver becomes the not-found line', () => {
      const resolver = resolveIonice({ trusted: () => null, searchPath: winPath })
      expect(resolver('ionice')).toBeNull()
      expect(call('low', { platform: 'linux', resolve: resolver }).line).toBe('priority nice=19 ionice=unavailable (not found in a trusted system location)')
    })
    it.each(['win32', 'darwin'])('never consults the resolver on %s', (platform) => {
      let consulted = 0
      const resolver = resolveIonice({ trusted: () => { consulted += 1; return '/usr/bin/ionice' }, searchPath: winPath })
      const { line } = call('low', { platform, resolve: (...a: unknown[]) => resolver(...a) })
      expect(line).toContain('ionice=unsupported-platform')
      expect(consulted).toBe(0)
    })
    it('a normal priority never consults the resolver either', () => {
      let consulted = 0
      call('normal', { platform: 'linux', resolve: () => { consulted += 1; return null } })
      expect(consulted).toBe(0)
    })
  })
})
