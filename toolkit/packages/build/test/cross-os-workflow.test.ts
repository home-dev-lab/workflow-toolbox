import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

// Lock for the Windows sharding of .github/workflows/cross-os.yml. The hosted Windows step of the unsharded suite measured
// 1217-1724 s against a 35-minute job, so Windows runs as parallel shard jobs. What must hold is an INVARIANT of the
// whole workflow (every gate still runs somewhere, exactly once, and no unsharded suite can reach Windows), so the test
// evaluates each step's `if` against each matrix entry instead of matching text.

const root = resolve(import.meta.dirname, '../../../..')
const WORKFLOW = join(root, '.github/workflows/cross-os.yml')

type Entry = { os: string; shard?: number }
type Step = { name?: string; if?: string; run?: string; uses?: string; with?: Record<string, string>; 'timeout-minutes'?: number }
const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as {
  jobs: { matrix: { strategy: { matrix: { include?: Entry[]; os?: string[] } }; 'timeout-minutes': number; steps: Step[] } }
}
const job = workflow.jobs.matrix
// A workflow without `include` entries (the pre-sharding `os: [...]` list) reads as no entries, so the tests below fail by assertion.
const entries = job.strategy.matrix.include ?? []
const steps = job.steps
const RUNNER_OS: Record<string, string> = { 'ubuntu-latest': 'Linux', 'macos-latest': 'macOS', 'windows-latest': 'Windows' }
const windows = entries.filter((entry) => RUNNER_OS[entry.os] === 'Windows')
// Every per-shard check goes through this, so a workflow with no Windows entry fails instead of passing over an empty loop.
function windowsEntries(): Entry[] {
  expect(windows.length, 'Windows matrix entries').toBeGreaterThan(0)
  return windows
}

const strip = (expression: string) => expression.trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '')

// Evaluates the `if` forms this workflow uses: `&&` of `always()`, `success()`, `runner.os ==|!= 'X'`, `matrix.shard ==|!= N`.
// Any other form throws, so a new shape forces this evaluator to be extended rather than silently read as true.
// An absent `if` is the implicit `success()`; `always()` and `success()` are both true here (no earlier step is failed).
function runsOn(step: Step, entry: Entry): boolean {
  if (step.if === undefined) return true
  return strip(String(step.if)).split('&&').every((raw) => {
    const term = raw.trim()
    if (term === 'always()' || term === 'success()') return true
    const os = /^runner\.os\s*(==|!=)\s*'([A-Za-z]+)'$/.exec(term)
    if (os) return (RUNNER_OS[entry.os] === os[2]) === (os[1] === '==')
    const shard = /^matrix\.shard\s*(==|!=)\s*(\d+)$/.exec(term)
    if (shard) return (String(entry.shard ?? '') === shard[2]) === (shard[1] === '==')
    throw new Error(`cross-os.yml step "${step.name}": unsupported if term \`${term}\` (extend runsOn in this test)`)
  })
}

// Interpolates the two `${{ }}` forms an artifact name may use; anything else throws.
function interpolate(text: string, entry: Entry): string {
  return text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_whole, expression: string) => {
    if (expression === 'matrix.os') return entry.os
    if (expression === "matrix.shard && format('-shard-{0}', matrix.shard) || ''") return entry.shard === undefined ? '' : `-shard-${entry.shard}`
    throw new Error(`unsupported expression \`${expression}\` (extend interpolate in this test)`)
  })
}

const isDiagnostic = (step: Step) => (step.name ?? '').startsWith('Diagnose ')
const stepsOnWindows = () => steps.filter((step) => windowsEntries().some((entry) => runsOn(step, entry)))
const windowsTestSteps = (entry: Entry) => steps.filter((step) => runsOn(step, entry) && !isDiagnostic(step) && /test:shard/.test(step.run ?? ''))
const runningOn = (step: Step) => windowsEntries().filter((entry) => runsOn(step, entry))

describe('cross-os workflow: Windows is sharded and every gate still runs once', () => {
  it('the control: the evaluator reads the unsharded Linux suite as Linux-only', () => {
    const linuxSuite = steps.find((step) => /pnpm test(?![:\w-])/.test(step.run ?? ''))
    expect(linuxSuite, 'the Linux suite step').toBeDefined()
    expect(entries.filter((entry) => runsOn(linuxSuite as Step, entry)).map((entry) => entry.os)).toEqual(['ubuntu-latest'])
  })

  it('declares its matrix as include entries with one Windows entry per shard', () => {
    expect(job.strategy.matrix.include, 'strategy.matrix.include').toBeDefined()
    expect(entries.map((entry) => entry.os)).toEqual(expect.arrayContaining(['ubuntu-latest', 'macos-latest', 'windows-latest']))
  })

  it('has Windows shards numbered exactly 1..N with N >= 2', () => {
    const shards = windows.map((entry) => entry.shard)
    expect(windows.length).toBeGreaterThanOrEqual(2)
    expect(shards).toEqual(Array.from({ length: windows.length }, (_unused, index) => index + 1))
  })

  it('runs the build on Windows, because `test:shard` does not build', () => {
    const build = steps.filter((step) => /build:dist/.test(step.run ?? '') && /cross-repo-typecheck/.test(step.run ?? ''))
    expect(build).toHaveLength(1)
    for (const entry of windowsEntries()) expect(runsOn(build[0] as Step, entry), `Windows shard ${entry.shard} builds`).toBe(true)
  })

  it('runs each Windows shard `test:shard --shard=<its own number>/N --coverage`, exactly one suite step per shard', () => {
    const count = windowsEntries().length
    for (const entry of windowsEntries()) {
      const tests = windowsTestSteps(entry)
      expect(tests, `test steps of Windows shard ${entry.shard}`).toHaveLength(1)
      expect(tests[0]?.run).toContain(`test:shard --shard=\${{ matrix.shard }}/${count} --coverage`)
    }
  })

  it('runs no unsharded `pnpm test` on any step that can run on Windows', () => {
    for (const step of stepsOnWindows()) expect(step.run ?? '', `step "${step.name}"`).not.toMatch(/pnpm test(?![:\w-])/)
  })

  it('runs each of typecheck, quality, lint, the lifecycle smoke and the Diagnose step on exactly one Windows shard', () => {
    const once: Array<[string, (step: Step) => boolean]> = [
      ['typecheck', (step) => /pnpm typecheck/.test(step.run ?? '')],
      ['quality', (step) => /pnpm quality/.test(step.run ?? '')],
      ['lint', (step) => /pnpm lint/.test(step.run ?? '')],
      ['lifecycle smoke', (step) => /ci-lifecycle-smoke/.test(step.run ?? '')],
      ['Diagnose', isDiagnostic],
    ]
    for (const [label, pick] of once) {
      const picked = steps.filter(pick)
      expect(picked.length, `${label} steps`).toBeGreaterThanOrEqual(1)
      for (const step of picked) expect(runningOn(step).map((entry) => entry.shard), `${label}: "${step.name}" Windows shards`).toHaveLength(1)
    }
  })

  it('keeps the gates that ran on every OS running on ubuntu and macOS', () => {
    for (const fragment of ['pnpm typecheck', 'pnpm quality', 'pnpm lint', 'ci-lifecycle-smoke']) {
      const step = steps.find((candidate) => (candidate.run ?? '').includes(fragment)) as Step
      for (const os of ['ubuntu-latest', 'macos-latest']) expect(runsOn(step, { os }), `${fragment} on ${os}`).toBe(true)
    }
  })

  it('gives the Windows suite step a budget below the job budget', () => {
    for (const entry of windowsEntries()) {
      const timeout = windowsTestSteps(entry)[0]?.['timeout-minutes']
      expect(timeout, 'Windows suite step timeout-minutes').toBeTypeOf('number')
      expect(timeout as number).toBeLessThan(job['timeout-minutes'])
    }
  })

  it('names the diagnostics artifact differently for every matrix entry', () => {
    const upload = steps.find((step) => (step.uses ?? '').startsWith('actions/upload-artifact')) as Step
    const names = entries.map((entry) => interpolate(String(upload.with?.name), entry))
    expect(new Set(names).size, names.join(', ')).toBe(entries.length)
    for (const name of names) expect(name).not.toContain('/')
  })
})
