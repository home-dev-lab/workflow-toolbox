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
type Step = { name?: string; if?: string; run?: string; uses?: string; with?: Record<string, string>; 'timeout-minutes'?: number | string; 'continue-on-error'?: boolean | string }
const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as {
  jobs: { matrix: { strategy: { matrix: { include?: Entry[]; os?: string[] } }; 'timeout-minutes': number; steps: Step[] } }
}
const job = workflow.jobs.matrix
// A workflow without `include` entries (the pre-sharding `os: [...]` list) reads as no entries, so the tests below fail by assertion.
const entries = job.strategy.matrix.include ?? []
const steps = job.steps
const RUNNER_OS: Record<string, string> = { 'ubuntu-latest': 'Linux', 'macos-latest': 'macOS', 'windows-latest': 'Windows' }
// An unknown `runs-on` label throws: mapping it to no OS would let every `runner.os` condition read false and hide the entry.
function runnerOs(entry: Entry): string {
  const os = RUNNER_OS[entry.os]
  if (os === undefined) throw new Error(`cross-os.yml matrix entry runs on an unknown label \`${entry.os}\` (extend RUNNER_OS in this test)`)
  return os
}
const windows = entries.filter((entry) => runnerOs(entry) === 'Windows')
// Every per-shard check goes through this, so a workflow with no Windows entry fails instead of passing over an empty loop.
function windowsEntries(): Entry[] {
  expect(windows.length, 'Windows matrix entries').toBeGreaterThan(0)
  return windows
}

const strip = (expression: string) => expression.trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '')

// Evaluates the `if` forms this workflow uses: `&&` of `always()`, `success()`, `runner.os ==|!= 'X'`, `matrix.shard ==|!= N`.
// Any other form throws, so a new shape forces this evaluator to be extended rather than silently read as true.
// An absent `if` is the implicit `success()`; `always()` and `success()` are both true here (no earlier step is failed).
// A matrix key the entry does not define is null in GitHub expressions, and null coerces to 0 in `==` / `!=` against a number.
function runsOn(step: Step, entry: Entry): boolean {
  if (step.if === undefined) return true
  return strip(String(step.if)).split('&&').every((raw) => {
    const term = raw.trim()
    if (term === 'always()' || term === 'success()') return true
    const os = /^runner\.os\s*(==|!=)\s*'([A-Za-z]+)'$/.exec(term)
    if (os) return (runnerOs(entry) === os[2]) === (os[1] === '==')
    const shard = /^matrix\.shard\s*(==|!=)\s*(\d+)$/.exec(term)
    if (shard) return ((entry.shard ?? 0) === Number(shard[2])) === (shard[1] === '==')
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

// The `timeout-minutes` of a step for one entry: a number, or exactly `${{ matrix.shard == A && B || C }}` (B when the shard is A, else C).
function timeoutOf(step: Step, entry: Entry): number {
  const value = step['timeout-minutes']
  if (typeof value === 'number') return value
  const choice = /^\$\{\{\s*matrix\.shard\s*==\s*(\d+)\s*&&\s*(\d+)\s*\|\|\s*(\d+)\s*\}\}$/.exec(String(value))
  if (!choice) throw new Error(`cross-os.yml step "${step.name}": unsupported timeout-minutes \`${String(value)}\` (extend timeoutOf in this test)`)
  return (entry.shard ?? 0) === Number(choice[1]) ? Number(choice[2]) : Number(choice[3])
}
// Allowance for checkout, setup-node, corepack and install before the first suite step starts.
const SETUP_ALLOWANCE_MINUTES = 3
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

  it('the control: the evaluator reads a missing matrix.shard as 0 like GitHub and refuses an unknown runs-on label', () => {
    const noShard = { os: 'ubuntu-latest' }
    expect(runsOn({ if: '${{ matrix.shard == 0 }}' }, noShard)).toBe(true)
    expect(runsOn({ if: '${{ matrix.shard != 1 }}' }, noShard)).toBe(true)
    expect(runsOn({ if: '${{ matrix.shard == 1 }}' }, noShard)).toBe(false)
    expect(() => runsOn({ if: "${{ runner.os == 'Linux' }}" }, { os: 'ubuntu-24.04' })).toThrow('unknown label')
    expect(timeoutOf({ 'timeout-minutes': '${{ matrix.shard == 1 && 28 || 20 }}' }, { os: 'windows-latest', shard: 2 })).toBe(20)
    expect(() => timeoutOf({ 'timeout-minutes': '${{ matrix.os }}' }, noShard)).toThrow('unsupported timeout-minutes')
  })

  it('declares its matrix as include entries only: an `os` list beside them would merge the Windows entries into one combination', () => {
    expect(Object.keys(job.strategy.matrix), 'strategy.matrix keys').toEqual(['include'])
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

  it('runs the build before every Windows and macOS suite step, on macOS too', () => {
    const buildIndex = steps.findIndex((step) => /build:dist/.test(step.run ?? '') && /cross-repo-typecheck/.test(step.run ?? ''))
    expect(buildIndex, 'build step index').toBeGreaterThanOrEqual(0)
    const sharded = entries.filter((entry) => runnerOs(entry) !== 'Linux')
    expect(sharded.map((entry) => runnerOs(entry)), 'non-Linux entries').toEqual(expect.arrayContaining(['macOS', 'Windows']))
    for (const entry of sharded) {
      expect(runsOn(steps[buildIndex] as Step, entry), `build runs on ${entry.os} shard ${entry.shard}`).toBe(true)
      const suites = steps.map((step, index) => ({ step, index })).filter(({ step }) => runsOn(step, entry) && !isDiagnostic(step) && /test:shard/.test(step.run ?? ''))
      expect(suites.length, `suite steps of ${entry.os} shard ${entry.shard}`).toBeGreaterThanOrEqual(1)
      for (const { step, index } of suites) expect(index, `"${step.name}" comes after the build step`).toBeGreaterThan(buildIndex)
    }
  })

  it('lets no suite step and no typecheck, quality, lint or smoke step on Windows pass silently with `continue-on-error`', () => {
    const gating = (step: Step) => /pnpm typecheck|pnpm quality|pnpm lint|ci-lifecycle-smoke/.test(step.run ?? '')
    for (const entry of windowsEntries()) {
      const gates = steps.filter((step) => runsOn(step, entry) && !isDiagnostic(step) && (gating(step) || /test:shard/.test(step.run ?? '')))
      expect(gates.length, `gating steps of Windows shard ${entry.shard}`).toBeGreaterThanOrEqual(1)
      for (const step of gates) expect(step['continue-on-error'], `"${step.name}" continue-on-error`).toBeUndefined()
    }
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

  it('fits every Windows shard in the job budget: setup + suite budget + the Diagnose budget when it runs there', () => {
    for (const entry of windowsEntries()) {
      const suite = windowsTestSteps(entry)[0] as Step
      const diagnose = steps.filter((step) => isDiagnostic(step) && runsOn(step, entry))
      const total = SETUP_ALLOWANCE_MINUTES + timeoutOf(suite, entry) + diagnose.reduce((sum, step) => sum + timeoutOf(step, entry), 0)
      expect(timeoutOf(suite, entry), `Windows shard ${entry.shard} suite step timeout-minutes`).toBeLessThan(job['timeout-minutes'])
      expect(total, `Windows shard ${entry.shard}: setup ${SETUP_ALLOWANCE_MINUTES} + suite ${timeoutOf(suite, entry)} + Diagnose ${diagnose.map((step) => timeoutOf(step, entry)).join('+') || 0}`).toBeLessThanOrEqual(job['timeout-minutes'])
    }
  })

  it('names the diagnostics artifact differently for every matrix entry', () => {
    const upload = steps.find((step) => (step.uses ?? '').startsWith('actions/upload-artifact')) as Step
    const names = entries.map((entry) => interpolate(String(upload.with?.name), entry))
    expect(new Set(names).size, names.join(', ')).toBe(entries.length)
    for (const name of names) expect(name).not.toContain('/')
  })
})
