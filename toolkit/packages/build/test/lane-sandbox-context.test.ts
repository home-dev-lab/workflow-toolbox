import { afterEach, expect, it, vi } from 'vitest'
import console from 'node:console'
import { laneSandboxContext, noteInsideLaneSandbox, skipInsideLaneSandbox } from '../../../test-support/lane-sandbox-context.js'

const signals = { env: { WT_LANE_SANDBOX: 'bwrap' }, platform: 'linux' as NodeJS.Platform }
const files: Record<string, string> = { '/proc/self/uid_map': '1000 0 1\n', '/proc/1/comm': 'bwrap\n' }
const readFile = (file: string) => files[file]!
const inside = { inside: true, why: 'all signals held' }
const outside = { inside: false, why: 'not a lane' }
const task = { name: 'checks a capability', file: { filepath: '/tests/capability.test.ts' } }
afterEach(() => vi.restoreAllMocks())

it.each([
  ['platform', { ...signals, platform: 'darwin' as NodeJS.Platform }],
  ['WT_LANE_SANDBOX', { ...signals, env: {} }],
  ['CI', { ...signals, env: { ...signals.env, CI: 'true' } }],
])('requires %s independently of the other held signals', (condition, options) => {
  const context = laneSandboxContext({ ...options, readFile })
  expect(context.inside).toBe(false)
  expect(context.why).toContain(condition)
})

it.each([
  ['/proc/self/uid_map', ' 0  0  4294967295\n'],
  ['/proc/1/comm', 'systemd\n'],
  ['/proc/1/comm', 'bwrap-helper\n'],
])('requires the namespace fact at %s (%s)', (file, value) => {
  const context = laneSandboxContext({ ...signals, readFile: (name) => name === file ? value : readFile(name) })
  expect(context.inside).toBe(false)
  expect(context.why).toContain(file)
})

it.each(['/proc/self/uid_map', '/proc/1/comm'])('fails closed when %s is unreadable', (file) => {
  const context = laneSandboxContext({ ...signals, readFile: (name) => {
    if (name === file) throw new Error('unreadable')
    return readFile(name)
  } })
  expect(context.inside).toBe(false)
  expect(context.why).toContain(file)
})

it.each([undefined, ''])('recognizes all held signals with CI=%s and reads each namespace fact once', (CI) => {
  const reader = vi.fn(readFile)
  const context = laneSandboxContext({ ...signals, env: { ...signals.env, CI }, readFile: reader })
  expect(context.inside).toBe(true)
  expect(context.why).toMatch(/linux.*bwrap.*user namespace.*PID 1/)
  expect(reader.mock.calls).toEqual([['/proc/self/uid_map'], ['/proc/1/comm']])
})

it.each(['true', '1', 'false', '0', ' '])('never adapts for any nonempty CI value (%s)', (CI) => {
  expect(laneSandboxContext({ ...signals, env: { ...signals.env, CI }, readFile }).inside).toBe(false)
})

it('names the first failing condition without probing later signals', () => {
  const reader = vi.fn(readFile)
  expect(laneSandboxContext({ env: {}, platform: 'win32', readFile: reader }).why).toContain('platform')
  expect(reader).not.toHaveBeenCalled()
})

it('never skips or warns outside even with a missing capability', () => {
  const skip = vi.fn(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  skipInsideLaneSandbox({ task, skip }, 'untrusted bwrap', outside)
  expect(skip).not.toHaveBeenCalled()
  expect(warn).not.toHaveBeenCalled()
})

it.each(['untrusted bwrap', ' '])('warns once with test identity before skipping inside with a nonempty reason (%s)', (reason) => {
  const order: string[] = []
  const skip = vi.fn(() => { order.push('skip') })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => { order.push('warn') })
  skipInsideLaneSandbox({ task, skip }, reason, inside)
  expect(warn).toHaveBeenCalledExactlyOnceWith(`[lane-sandbox skip] capability.test.ts > checks a capability: ${reason}`)
  expect(skip).toHaveBeenCalledExactlyOnceWith('lane sandbox: ' + reason)
  expect(order).toEqual(['warn', 'skip'])
})

it.each([null, ''])('does not skip or warn inside without a capability reason (%s)', (reason) => {
  const skip = vi.fn(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  skipInsideLaneSandbox({ task, skip }, reason, inside)
  expect(skip).not.toHaveBeenCalled()
  expect(warn).not.toHaveBeenCalled()
})

it('reports omitted coverage only inside the lane sandbox', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  noteInsideLaneSandbox('capability.test.ts > collected tests', 'bwrap unavailable', outside)
  expect(warn).not.toHaveBeenCalled()
  noteInsideLaneSandbox('capability.test.ts > collected tests', 'bwrap unavailable', inside)
  expect(warn).toHaveBeenCalledExactlyOnceWith('[lane-sandbox skip] capability.test.ts > collected tests: lane sandbox: bwrap unavailable')
})
