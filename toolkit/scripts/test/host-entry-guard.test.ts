import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { isInvokedDirectly } from '../../../plugin/bin/lib/host/entry-guard.mjs'

const roots: string[] = []
const PLUGIN_ROOT = join(import.meta.dirname, '../../../plugin')
const REPORT_FINDINGS_CHECK = join(import.meta.dirname, '../../../plugin/bin/wt-report-findings-check.mjs')
const SUITE_LOCK_CLI = join(import.meta.dirname, '../../../plugin/bin/wt-suite-lock.mjs')
const TOOLKIT_OBSERVE_CLI = join(import.meta.dirname, '../../bin/wt-observe.mjs')
let cachedPluginRoot: string

const CACHE_ENTRYPOINTS = [
  { file: 'wt-actionable-snapshot-producer-hook.mjs', input: '{"hook_event_name":"Other"}' },
  { file: 'wt-actionable-snapshot-refresh.mjs', args: ['--help'], output: 'Usage:' },
  { file: 'wt-adopt-check-hook.mjs', input: '{"hook_event_name":"Other"}' },
  { file: 'wt-check-commit-signatures-hook.mjs', input: '{}' },
  { file: 'wt-lane-probe.mjs', args: ['--help'], output: 'wt-lane-probe' },
  { file: 'wt-lane.mjs', args: ['--help'], output: 'Usage:' },
  { file: 'wt-observe.mjs', args: ['--help'], output: 'usage: wt-observe' },
  { file: 'wt-opencode-verify.mjs', args: ['--help'], output: 'Usage:' },
  { file: 'wt-report-findings-check.mjs', args: ['--help'], output: 'wt-report-findings-check' },
  { file: 'wt-suite-lock.mjs', args: ['status'], output: 'suite lock' },
  { file: 'wt-verifier-cli-guard-hook.mjs', input: '{}' },
] as const

// A raw `process.argv[1] === fileURLToPath(import.meta.url)` (either operand order) breaks the
// moment the entrypoint is reached through a symlink: realpath differs from the symlink path, the
// direct-execution branch never runs, and the file silently does nothing (card 1872232864). Every
// file under plugin/bin must route that comparison through the symlink-safe isInvokedDirectly
// guard instead. This scans the whole tree so a third raw copy can never reappear unnoticed.
function findRawDirectExecutionComparisons(root: string): string[] {
  const RAW_COMPARISON = /process\.argv\[1\]\s*(?:===|==)\s*fileURLToPath\(import\.meta\.url\)|fileURLToPath\(import\.meta\.url\)\s*(?:===|==)\s*process\.argv\[1\]/
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.mjs')) continue
      const text = readFileSync(full, 'utf8')
      if (RAW_COMPARISON.test(text)) offenders.push(full)
    }
  }
  walk(root)
  return offenders
}

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'wt-plugin-cache-'))
  cachedPluginRoot = join(root, 'workflow-toolbox', '0.0.0')
  mkdirSync(cachedPluginRoot, { recursive: true })
  cpSync(PLUGIN_ROOT, cachedPluginRoot, { recursive: true })
})

afterAll(() => {
  rmSync(join(cachedPluginRoot, '..', '..'), { recursive: true, force: true })
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('host entry guard', () => {
  it('recognizes the same canonical file', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-entry-guard-')); roots.push(root)
    const file = join(root, 'entry.mjs')
    writeFileSync(file, '')

    expect(isInvokedDirectly(pathToFileURL(file).href, file)).toBe(true)
  })

  it('rejects another canonical file', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-entry-guard-')); roots.push(root)
    const entry = join(root, 'entry.mjs')
    const other = join(root, 'other.mjs')
    writeFileSync(entry, '')
    writeFileSync(other, '')

    expect(isInvokedDirectly(pathToFileURL(entry).href, other)).toBe(false)
  })

  it.each(['?test', '#test'])('rejects an import URL qualified with %s', (qualifier) => {
    const root = mkdtempSync(join(tmpdir(), 'wt-entry-guard-')); roots.push(root)
    const file = join(root, 'entry.mjs')
    writeFileSync(file, '')

    expect(isInvokedDirectly(`${pathToFileURL(file).href}${qualifier}`, file)).toBe(false)
  })

  it('returns false when either path is unavailable', () => {
    expect(isInvokedDirectly('file:///definitely-absent-entry.mjs', '/definitely-absent-argv.mjs')).toBe(false)
    expect(isInvokedDirectly(import.meta.url, '')).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('runs a hook invoked through a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-entry-guard-')); roots.push(root)
    const link = join(root, 'report-findings-check.mjs')
    symlinkSync(REPORT_FINDINGS_CHECK, link)

    const result = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' })

    expect(result.stdout).toContain('wt-report-findings-check')
  })

  it.skipIf(process.platform === 'win32')('runs wt-suite-lock.mjs status invoked through a symlink (card 1872232864: a raw argv[1]===import.meta.url comparison prints nothing here)', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-entry-guard-')); roots.push(root)
    const link = join(root, 'lock.mjs')
    symlinkSync(SUITE_LOCK_CLI, link)

    const result = spawnSync(process.execPath, [link, 'status'], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('suite lock')
  })

  it('never lets a raw process.argv[1]===fileURLToPath(import.meta.url) comparison reappear under plugin/bin', () => {
    const offenders = findRawDirectExecutionComparisons(join(PLUGIN_ROOT, 'bin'))

    expect(offenders).toEqual([])
  })

  it('runs the toolkit/bin copy of wt-observe.mjs directly (not just the plugin cache twin)', () => {
    const result = spawnSync(process.execPath, [TOOLKIT_OBSERVE_CLI, '--help'], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('usage: wt-observe')
  })

  it.each(CACHE_ENTRYPOINTS)('runs $file from a versioned plugin cache layout', ({ file, ...invocation }) => {
    const result = spawnSync(process.execPath, [join(cachedPluginRoot, 'bin', file), ...(invocation.args ?? [])], {
      encoding: 'utf8',
      input: invocation.input,
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(cachedPluginRoot, '.test-claude') },
    })

    expect(result.status, result.stderr).toBe(0)
    if (invocation.output) expect(result.stdout).toContain(invocation.output)
  })
})
