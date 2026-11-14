import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error plugin runtime module
import { guardLightRun, heavyJobAdvice, lightRunScope } from '../../../../plugin/bin/lib/suite-lock-light-scope.mjs'
// @ts-expect-error toolkit test-support runtime module
import { suiteLeaseClassFor, vitestLightScopeGuard } from '../../../test-support/suite-lease.global-setup.mjs'
// @ts-expect-error plugin runtime module
import { readLightScopeFirings } from '../../../../plugin/bin/lib/host/suite-lock-light-scope-log.mjs'

type Scope = { kind: 'single' | 'multi' | 'suite' | 'other'; files: string[] }
const scope = (argv: string[]): Scope => lightRunScope(argv)

// Commands taken from real light runs on this suite lock (journal and transcripts, 2026-11-09..14).
describe('lightRunScope on commands that cover several test files', () => {
  it.each([
    [['node', '--test', 'scripts/login-alert-watch.test.mjs', 'scripts/lib/login-transcript-watch.test.mjs', 'scripts/lib/token-expiry-watch.test.mjs'], 3],
    [['npx', 'vitest', 'run', 'packages/build/test/signature-exception-installed.test.ts', 'packages/build/test/remote-signature-policy.test.ts'], 2],
    [['pnpm', 'exec', 'vitest', 'run', '--reporter=verbose', 'packages/build/test/node-false-green-probe.test.ts', 'packages/build/test/node-probe-gates.test.ts'], 2],
    [['pnpm', 'vitest', 'run', 'packages/build/test/plugin-superseded.test.ts', 'packages/build/test/delegate-wake'], 2],
    [['pnpm', '-C', 'toolkit', 'exec', 'vitest', 'run', 'a.test.ts', 'b.test.ts'], 2],
    [['node', '--test', 'scripts/host-dispatch-r5-payload.test.mjs', 'scripts/host-dispatch-r7.selftest.mjs'], 2],
    [['env', 'FOO=1', 'node', '--test', '--test-concurrency=1', 'a.test.mjs', 'b.test.mjs'], 2],
    // Review round 1 (cross-family counterexamples): wrappers and shells the first cut missed.
    [['vitest', 'a.test.ts', 'b.test.ts', '--run'], 2],
    [['env', '-i', 'node', '--test', 'a.test.mjs', 'b.test.mjs'], 2],
    [['/usr/bin/env', 'node', '--test', 'a.test.mjs', 'b.test.mjs'], 2],
    [['node', '--test', 'a.test.mjs', 'b.test.mjs', '--test-name-pattern', '--help'], 2],
    [['timeout', '--signal=TERM', '10s', 'node', '--test', 'a.test.mjs', 'b.test.mjs'], 2],
    // Review round 2: wrappers with their own options.
    [['pnpm', 'dlx', 'vitest', 'run', 'a.test.ts', 'b.test.ts'], 2],
    [['npx', '--yes', 'vitest', 'run', 'a.test.ts', 'b.test.ts'], 2],
    [['nice', '-n', '10', 'node', '--test', 'a.test.mjs', 'b.test.mjs'], 2],
    [['node', '/x/plugin/bin/wt-suite-lock.mjs', 'run', '--light', '--', 'node', '--test', 'a.test.mjs', 'b.test.mjs'], 2],
  ])('flags %j as multi (%i files)', (argv, count) => {
    const result = scope(argv)
    expect(result.kind).toBe('multi')
    expect(result.files).toHaveLength(count)
  })

  it.each([
    [['npx', 'vitest', 'run']],
    [['pnpm', 'exec', 'vitest', 'run']],
    [['node', '--test']],
    [['node', '--test', 'test/']],
    [['node', '--test', 'machine-pack/test/']],
    [['node', '--test', 'scripts/host-dispatch*.test.mjs']],
    [['pnpm', 'test']],
    [['npm', 'run', 'test']],
    [['vitest', 'run', 'src/']],
    [['pnpm', 'test', '--', 'a.test.ts', 'src/']],
  ])('flags %j as a whole suite', (argv) => {
    expect(scope(argv).kind).toBe('suite')
  })
})

describe('lightRunScope on runs a light ticket is for', () => {
  it.each([
    [['node', '--test', 'scripts/statusline-speed-scenarios.test.mjs']],
    [['pnpm', 'exec', 'vitest', 'run', 'packages/build/test/lane-sandbox.test.ts', '-t', 'real target directory is unavailable']],
    [['npx', 'vitest', 'run', 'packages/build/test/actionability-gate.test.ts', '-t', 'C2']],
    [['pnpm', 'vitest', 'run', 'scripts/test/quality-owner.test.ts', '--project', 'unit']],
    [['pnpm', 'vitest', 'run', 'packages/build/test/sdk-pilot-lifecycle-server.test.ts', '--reporter', 'verbose']],
    [['node', '--test', '--test-name-pattern', 'D1 real supervisor', 'scripts/host-dispatch-real.test.mjs']],
    [['node', '.lane/quality-owner.selftest.mjs']],
    // Option values the runner reads as values, never as a second file (false hits would block a legitimate run).
    [['vitest', 'run', 'a.test.ts', '--hookTimeout', '60000']],
    [['vitest', 'run', 'a.test.ts', '--coverage.reporter', 'text']],
    [['vitest', 'run', 'a.test.ts', '--coverage.reportsDirectory', 'b.test.ts']],
    [['node', '--test', '--test-shard', '1/3', 'a.test.mjs']],
    // Review round 3: option values, a repeated path, and node options read only before the script.
    [['node', '--test', '--test-coverage-exclude', 'b.test.mjs', 'a.test.mjs']],
    [['node', '--title', 'scope-review', '--test', 'a.test.mjs']],
    [['node', '--test', 'a.test.mjs', 'a.test.mjs']],
    // Review rounds 1-2: option values in package-script arguments; only test-file-shaped words count there.
    [['npm', 'test', '--', 'a.test.ts', '-t', 'b.test.ts']],
    [['npm', 'test', '--', 'run', 'a.test.ts']],
    [['npm', 'test', '--', 'a.test.js', '--grep', 'smoke']],
    [['npm', 'test', '--', 'a.test.js', '--reporter-options', 'output=results.xml']],
  ])('accepts %j as one file', (argv) => {
    const result = scope(argv)
    expect(result.kind).toBe('single')
    expect(result.files).toHaveLength(1)
  })
})

describe('lightRunScope on commands that run no test file, or that it cannot see into', () => {
  it.each([
    [['pnpm', 'typecheck']],
    [['pnpm', 'lint']],
    [['pnpm', 'exec', 'eslint', '--max-warnings', '0', 'a.test.ts', 'b.test.ts']],
    [['pnpm', 'vitest', 'list', 'a.test.ts', 'b.test.ts']],
    // Review round 1: lint tools handed test files are a lint, never a multi-file test run.
    [['node', 'node_modules/eslint/bin/eslint.js', 'a.test.ts', 'b.test.ts']],
    [['bash', '-c', 'eslint a.test.ts b.test.ts']],
    // Review round 2: a shell string is opaque, like a script file (declared blind spot), so quoted text,
    // comments and loops never invent a run; node evaluating code or printing help runs no test file.
    [['bash', '-c', "echo 'ignored; node --test'"]],
    [['bash', '-c', 'node --test a.test.mjs # smoke check']],
    [['bash', '-lc', 'node --test a.test.mjs b.test.mjs']],
    [['node', '-e', 'console.log(process.argv.slice(1))', 'a.test.mjs', 'b.test.mjs']],
    [['node', '--test', '--help']],
    [['node', '--version']],
    // Review round 3: a node script's own arguments, help and version of wrappers and runners, typecheck mode.
    [['node', 'run-tests.mjs', 'a.test.mjs', 'b.test.mjs']],
    [['node', 'tool.mjs', '--test', 'ordinary-argument']],
    [['nice', '--help', 'node', '--test']],
    [['npx', '--version', 'vitest', 'run']],
    [['vitest', '--help']],
    [['vitest', '--version']],
    [['vitest', 'run', '--typecheck.only', 'a.test.ts', 'b.test.ts']],
    [['node', '/home/u/.claude/scripts/quality/run-quality.mjs', '--root', '/tmp/x']],
    [['bash', '.lane/red-proofs.sh']],
    [['zsh', '.lane/g1.zsh']],
    [['true']],
    [[]],
  ])('does not flag %j', (argv) => {
    expect(scope(argv).kind).toBe('other')
  })
})

describe('heavyJobAdvice', () => {
  const twoFiles = { kind: 'multi', files: ['a.test.mjs', 'b.test.mjs'] }
  it('hands back the exact heavy-job command when WT_SUITE_LOCK_HEAVY_JOB names the wrapper', () => {
    const env = { WT_SUITE_LOCK_HEAVY_JOB: '/opt/x/heavy-job.sh', WT_SUITE_LOCK_PROJECT: 'wt-suite' }
    expect(heavyJobAdvice({ command: ['node', '--test', 'a.test.mjs', 'b.test.mjs'], scope: twoFiles, env })).toEqual({
      command: '/opt/x/heavy-job.sh --project wt-suite --expected-min 1 --suite-lock -- node --test a.test.mjs b.test.mjs', reason: null })
  })
  it('sizes --expected-min from the file count, 30 for a whole suite, and quotes words for a POSIX shell', () => {
    const env = { WT_SUITE_LOCK_HEAVY_JOB: '/opt/heavy-job.sh' }
    const files = Array.from({ length: 33 }, (_, i) => `${i}.test.mjs`)
    expect(heavyJobAdvice({ command: ['x'], scope: { kind: 'multi', files }, env }).command).toBe('/opt/heavy-job.sh --expected-min 14 --suite-lock -- x')
    expect(heavyJobAdvice({ command: ['vitest', 'run', '-t', "it's"], scope: { kind: 'suite', files: [] }, env }).command)
      .toBe(`/opt/heavy-job.sh --expected-min 30 --suite-lock -- vitest run -t 'it'"'"'s'`)
  })
  it('falls back to an exclusive ticket, with its reason, when the wrapper is unset or inside a lane', () => {
    const command = ['node', '--test', 'a.test.mjs', 'b.test.mjs']
    expect(heavyJobAdvice({ command, scope: twoFiles, env: {} })).toEqual({ command: 'wt-suite-lock run -- node --test a.test.mjs b.test.mjs', reason: 'WT_SUITE_LOCK_HEAVY_JOB is not set' })
    expect(heavyJobAdvice({ command, scope: twoFiles, env: { WT_SUITE_LOCK_HEAVY_JOB: '/h.sh', WT_SUITE_LOCK_BROKER: 'sock' } }).reason).toMatch(/lane sandbox/)
  })
})

const roots: string[] = []
const scratch = () => { const root = mkdtempSync(join(tmpdir(), 'wt-light-scope-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const cli = fileURLToPath(new URL('../../../../plugin/bin/wt-suite-lock.mjs', import.meta.url))

function runCli(args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, WT_SUITE_LEASE: '', WT_SUITE_LOCK: '1', WT_SUITE_LOCK_BROKER: '', WT_SUITE_LOCK_PRIORITY: 'P1', WT_SUITE_LOCK_HEAVY_JOB: '', WT_SUITE_LOCK_LIGHT_SCOPE: '', ...env } })
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.once('error', reject)
    child.once('exit', (code) => resolve({ code, stderr, stdout }))
  })
}

// Two real test files; each leaves a marker so a test can tell whether the covered command ran.
function fixture() {
  const root = scratch()
  const work = scratch()
  for (const name of ['a', 'b']) writeFileSync(join(work, `${name}.test.mjs`), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(join(work, `${name}.ran`))}, '1')\n`)
  return { root, work }
}

describe('wt-suite-lock run --light over several test files', () => {
  it('warns with the heavy-job command, runs the command, and records the firing with its hold', async () => {
    const { root, work } = fixture()
    const env = { WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_HEAVY_JOB: '/opt/x/heavy-job.sh', WT_SUITE_LOCK_PROJECT: 'wt-suite' }
    const result = await runCli(['run', '--light', '--', 'node', '--test', 'a.test.mjs', 'b.test.mjs'], env, work)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('light ticket warning')
    expect(result.stderr).toContain('/opt/x/heavy-job.sh --project wt-suite --expected-min 1 --suite-lock -- node --test a.test.mjs b.test.mjs')
    expect(existsSync(join(work, 'a.ran')) && existsSync(join(work, 'b.ran'))).toBe(true)
    const firings = readLightScopeFirings(root)
    expect(firings).toHaveLength(1)
    expect(firings[0]).toMatchObject({ route: 'cli', mode: 'warn', outcome: 'warned', kind: 'multi', fileCount: 2, files: ['a.test.mjs', 'b.test.mjs'], project: 'wt-suite' })
    expect(typeof firings[0].holdS).toBe('number')
  })

  it('refuses before any lease in refuse mode: exit 2, the command never runs, the exclusive remedy without the wrapper', async () => {
    const { root, work } = fixture()
    const result = await runCli(['run', '--light', '--', 'node', '--test', 'a.test.mjs', 'b.test.mjs'], { WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_LIGHT_SCOPE: 'refuse' }, work)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('light ticket refused')
    expect(result.stderr).toContain('(WT_SUITE_LOCK_HEAVY_JOB is not set)')
    expect(result.stderr).toContain('wt-suite-lock run -- node --test a.test.mjs b.test.mjs')
    expect(existsSync(join(work, 'a.ran'))).toBe(false)
    expect(existsSync(join(root, 'journal.jsonl')) ? readFileSync(join(root, 'journal.jsonl'), 'utf8') : '').not.toContain('"event":"grant"')
    expect(readLightScopeFirings(root)).toMatchObject([{ outcome: 'refused', holdS: null }])
  })

})

describe('wt-suite-lock run outside the light-scope guard, and the light-scope listing', () => {
  it('accepts a one-file light run with no warning and no record', async () => {
    const { root, work } = fixture()
    const result = await runCli(['run', '--light', '--', 'node', '--test', 'a.test.mjs'], { WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_LIGHT_SCOPE: 'refuse' }, work)
    expect(result.code).toBe(0)
    expect(result.stderr).not.toContain('light ticket')
    expect(existsSync(join(work, 'a.ran'))).toBe(true)
    expect(readLightScopeFirings(root)).toEqual([])
  })

  it('leaves an exclusive (non-light) run over several files alone', async () => {
    const { root, work } = fixture()
    const result = await runCli(['run', '--', 'node', '--test', 'a.test.mjs', 'b.test.mjs'], { WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_LIGHT_SCOPE: 'refuse' }, work)
    expect(result.code).toBe(0)
    expect(result.stderr).not.toContain('light ticket')
  })

  it('lists the probation record with light-scope', async () => {
    const { root, work } = fixture()
    await runCli(['run', '--light', '--', 'node', '--test', 'a.test.mjs', 'b.test.mjs'], { WT_SUITE_LOCK_DIR: root }, work)
    const listing = await runCli(['light-scope'], { WT_SUITE_LOCK_DIR: root }, work)
    expect(listing.code).toBe(0)
    expect(listing.stdout).toMatch(/^light-scope: 1 firing\(s\) over 1 day\(s\); probation: flip the default to refuse after >= 20 firings/)
    expect(listing.stdout).toContain('cli warned multi 2 file(s), held ')
    const json = await runCli(['light-scope', '--json'], { WT_SUITE_LOCK_DIR: root }, work)
    expect(JSON.parse(json.stdout).firings).toHaveLength(1)
  })
})

describe('Vitest globalSetup light selections', () => {
  const two = { paths: ['a.test.ts', 'b.test.ts'], coverageEnabled: false }
  it('keeps 2 to 8 files light during probation and allows one file only in refuse mode', () => {
    expect(suiteLeaseClassFor({ ...two, env: {} })).toBe('light')
    expect(suiteLeaseClassFor({ ...two, env: { WT_SUITE_LOCK_LIGHT_SCOPE: 'refuse' } })).toBe('exclusive')
    expect(suiteLeaseClassFor({ paths: ['a.test.ts'], coverageEnabled: false, env: { WT_SUITE_LOCK_LIGHT_SCOPE: 'refuse' } })).toBe('light')
  })

  it('warns and records a light selection over two files, with its hold once it ends', () => {
    const root = scratch()
    let text = ''
    const guard = vitestLightScopeGuard(['vitest', 'run', 'a.test.ts', 'b.test.ts'], { env: {}, write: (chunk: string) => { text += chunk }, domain: () => root })
    expect(guard.refused).toBe(false)
    expect(text).toContain('light ticket warning')
    expect(text).toContain('wt-suite-lock run -- pnpm exec vitest run a.test.ts b.test.ts')
    guard.end(1500)
    expect(readLightScopeFirings(root)).toMatchObject([{ route: 'vitest', outcome: 'warned', fileCount: 2, holdS: 1.5 }])
  })

  it('never lets a failing stderr write stop the run (review round 1)', () => {
    const root = scratch()
    const guard = vitestLightScopeGuard(['vitest', 'run', 'a.test.ts', 'b.test.ts'], { env: {}, write: () => { throw new Error('EPIPE') }, domain: () => root })
    expect(guard.refused).toBe(false)
    expect(readLightScopeFirings(root)).toMatchObject([{ outcome: 'warned', fileCount: 2 }])
  })

  it('guards its own stderr write against an asynchronous EPIPE (review round 2)', () => {
    const listeners = process.stderr.listeners('error')
    process.stderr.removeAllListeners('error')
    try {
      vitestLightScopeGuard(['vitest', 'run', 'a.test.ts', 'b.test.ts'], { env: {}, domain: () => scratch() })
      expect(process.stderr.listenerCount('error')).toBeGreaterThan(0)
    } finally {
      process.stderr.removeAllListeners('error')
      for (const listener of listeners) process.stderr.on('error', listener as (error: Error) => void)
    }
  })

  it('stays silent for one file', () => {
    let text = ''
    vitestLightScopeGuard(['vitest', 'run', 'a.test.ts'], { env: {}, write: (chunk: string) => { text += chunk }, domain: () => scratch() })
    expect(text).toBe('')
  })
})

describe('guardLightRun never turns a recording failure into a different run (review round 3)', () => {
  const command = ['node', '--test', 'a.test.mjs', 'b.test.mjs']
  const failing = { record: () => { throw new Error('record failed') }, end: () => { throw new Error('end failed') } }
  it('warn mode lets the run through and its end never throws', () => {
    const guard = guardLightRun({ command, route: 'cli', env: {}, write: () => {}, log: failing })
    expect(guard.refused).toBe(false)
    expect(() => guard.end(10)).not.toThrow()
  })
  it('refuse mode still refuses when the record fails, and a bad clock is survived', () => {
    const guard = guardLightRun({ command, route: 'cli', env: { WT_SUITE_LOCK_LIGHT_SCOPE: 'refuse' }, write: () => {}, log: failing, now: () => Number.NaN })
    expect(guard.refused).toBe(true)
  })
})
