import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper
import { createHostAdapter } from '../../../../plugin/bin/lib/host/adapter.mjs'
// @ts-expect-error runtime .mjs helper
const boundary = await import('../../../../plugin/bin/lib/host/process-signal-boundary.mjs').catch(() => null)

const root = resolve(import.meta.dirname, '../../../..')
const source = (name: string) => readFileSync(resolve(root, `plugin/bin/${name}.mjs`), 'utf8')

function invocation(code: string | null) {
  const kill = vi.fn(() => { if (code) throw Object.assign(new Error(code), { code }); return true })
  return { kill, host: createHostAdapter({ platform: 'linux', invoke: { kill } }) }
}

it.each(['EIO', 'EINVAL'])('keeps an old launch lock when its owner liveness is unknown (%s)', (code) => {
  const text = source('wt-lane')
  const start = text.indexOf('const lockStatus = ') + 'const lockStatus = '.length
  const end = text.indexOf('\n    const removeOwnedLock = ', start)
  expect(start).toBeGreaterThan('const lockStatus = '.length)
  expect(end).toBeGreaterThan(start)
  const { kill, host } = invocation(code)
  const lockStatus = runInNewContext(`(${text.slice(start, end).trim()})`, {
    process: { kill }, hostAdapter: host, consentModules: { hostAdapter: host },
    path: { join: (...parts: string[]) => parts.join('/') },
    readFileSync: () => JSON.stringify({ pid: 42, argv: ['fixture'], startTime: 1 }),
    statSync: () => ({ mtimeMs: 0 }), Date: { now: () => 240_001 },
    LAUNCH_LOCK_MAX_AGE_MS: 120_000, launcherInspect: () => null,
  }) as (path: string) => { stale: boolean }
  expect(lockStatus('fixture-lock').stale, 'unknown launch owner is not reclaimable').toBe(false)
  expect(kill).toHaveBeenCalledWith(42, 0)
})

it.each(['EPERM', 'EIO', 'EINVAL'])('retains quota watcher registration and duplicate ownership on %s', (code) => {
  const text = source('wt-quota-watch')
  const helper = /function isPidAlive\(pid\) \{[\s\S]*?\n\}/.exec(text)?.[0]
  const decisions = /const liveInstances = [^\n]+\nconst sameProjectWatcher = [^\n]+/.exec(text)?.[0]
  expect(helper, 'quota liveness helper').toBeDefined()
  expect(decisions, 'quota registration pruning and duplicate decision').toBeDefined()
  const { kill, host } = invocation(code)
  const entry = { pid: 42, cwd: 'fixture-project' }
  const result = runInNewContext(`${helper}\n${decisions};\n({liveInstances, sameProjectWatcher, alive:isPidAlive(42)})`, {
    process: { pid: 99, kill }, readWatchInstances: () => [entry], watchCwd: entry.cwd,
    retainProcessOwner: (pid: number) => boundary!.retainProcessOwner(pid, host.readProcessLiveness),
  }) as { liveInstances: typeof entry[]; sameProjectWatcher: typeof entry; alive: boolean }
  expect(result.alive).toBeTypeOf('boolean')
  expect(result.alive, 'unknown or denied quota PID is retained').toBe(true)
  expect(result.liveInstances).toHaveLength(1)
  expect(result.sameProjectWatcher).toBe(entry)
})
