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

// A raw comparison between import.meta and process.argv[1] breaks the moment the entrypoint is
// reached through a symlink: import.meta.url is the realpath, argv[1] keeps the link, the
// direct-execution branch never runs, and the file silently does nothing. Every shape counts:
// `file://${argv[1]}`, pathToFileURL(argv[1]), path.resolve(argv[1]) against fileURLToPath or
// import.meta.filename, either operand order. Every file under plugin/ must route the comparison
// through the symlink-safe isInvokedDirectly guard, or call realpath on the same line.
// A line-based tripwire, not a proof: it cannot see a comparison split across lines, argv[1]
// read through an alias (a variable, process.argv.at(1)), or Object.is. Every raw guard found in
// this repository so far sat on one line, which is the shape it is built for.
function rawEntryGuardLines(text: string): number[] {
  const out: number[] = []
  text.split('\n').forEach((line, i) => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
    if (!line.includes('process.argv[1]')) return
    if (!/import\.meta\.(?:url|filename)/.test(line)) return
    if (!/[!=]==?/.test(line)) return
    if (/\brealpath(?:Sync)?\s*\(/.test(line)) return
    out.push(i + 1)
  })
  return out
}

function findRawDirectExecutionComparisons(root: string): string[] {
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(?:mjs|cjs|js)$/.test(entry.name)) continue
      for (const line of rawEntryGuardLines(readFileSync(full, 'utf8'))) offenders.push(`${full}:${line}`)
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

  it('flags the raw single-line entry-guard shapes and passes the realpath ones', () => {
    const raw = [
      'if (import.meta.url === `file://${process.argv[1]}`) main()',
      'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {',
      'if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()',
      'if (process.argv[1] === fileURLToPath(import.meta.url)) main()',
      'if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {',
      'if (import.meta.url === pathToFileURL(process.argv[1] ?? \'\').href) main()',
      'if (import.meta.url === pathToFileURL(process.argv[1]).href) main() // realpath later',
    ]
    for (const line of raw) expect(rawEntryGuardLines(line), line).toEqual([1])
    expect(rawEntryGuardLines('if (isInvokedDirectly(import.meta.url)) main()')).toEqual([])
    expect(rawEntryGuardLines('if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()')).toEqual([])
    expect(rawEntryGuardLines('// if (import.meta.url === `file://${process.argv[1]}`) main()')).toEqual([])
  })

  it('never lets a raw import.meta / process.argv[1] entry-guard comparison reappear anywhere under plugin/', () => {
    const offenders = findRawDirectExecutionComparisons(PLUGIN_ROOT)

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
