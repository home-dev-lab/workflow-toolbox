import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { laneSandboxContext, skipInsideLaneSandbox } from '../../../test-support/lane-sandbox-context.js'
// @ts-expect-error JS script module
import * as shardChecker from '../../../scripts/check-posix-shards.mjs'

// Locks for sharding in .github/workflows/cross-os.yml. The hosted Windows step of the unsharded suite measured
// 1217-1724 s against a 35-minute job, so Windows runs as parallel shard jobs. What must hold is an INVARIANT of the
// whole workflow (every gate still runs somewhere, exactly once, and no unsharded suite can reach Windows), so the test
// evaluates each step's `if` against each matrix entry instead of matching text.

const root = resolve(import.meta.dirname, '../../../..')
const WORKFLOW = join(root, '.github/workflows/cross-os.yml')
const DESCRIPTOR = 'toolkit/test-support/base-version-client.json'
const baseClients = JSON.parse(readFileSync(join(root, DESCRIPTOR), 'utf8')) as { clients: Record<string, string> }
const laneContext = laneSandboxContext()
function omittedHistoryReason(root: string, clients: Record<string, string>): string | null {
  const history = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (history.status !== 0 || history.stdout.trim() !== '1') return null
  const missing = Object.entries(clients).filter(([, commit]) =>
    spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: root }).status !== 0,
  )
  return missing.length ? `${DESCRIPTOR}: historical clients unavailable: ${missing.map(([role, commit]) => `${role} (${commit})`).join(', ')}` : null
}
beforeEach((ctx) => {
  if (!laneContext.inside || ctx.task.name !== 'resolves every descriptor client in this clone; only a local shallow clone may skip missing history') return
  skipInsideLaneSandbox(ctx, omittedHistoryReason(root, baseClients.clients), laneContext)
})

const historyRoots: string[] = []
function historyGit(root: string, args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=Workflow Test', '-c', 'user.email=workflow-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}
function historyFixture(count: number): { root: string; commits: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'workflow-history-'))
  historyRoots.push(root)
  historyGit(root, ['init', '--quiet'])
  const commits: string[] = []
  for (let index = 0; index < count; index++) {
    historyGit(root, ['commit', '--quiet', '--allow-empty', '-m', `fixture ${index}`])
    commits.push(historyGit(root, ['rev-parse', 'HEAD']))
  }
  return { root, commits }
}
afterEach(() => {
  for (const root of historyRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('omitted descriptor history evidence', () => {
  it('names an absent client in a one-commit export', () => {
    const { root } = historyFixture(1)
    const absent = '0'.repeat(40)
    expect(omittedHistoryReason(root, { absentClient: absent })).toContain(`absentClient (${absent})`)
  })

  it('does not excuse an absent client in a two-commit repository', () => {
    const { root } = historyFixture(2)
    expect(omittedHistoryReason(root, { absentClient: '0'.repeat(40) })).toBeNull()
  })

  it('needs no exemption when every client is present in a two-commit repository', () => {
    const { root, commits } = historyFixture(2)
    expect(omittedHistoryReason(root, { first: commits[0]!, second: commits[1]! })).toBeNull()
  })
})

type Entry = { os: string; shard?: number; timeout?: number }
type Step = { name?: string; if?: string; run?: string; shell?: string; uses?: string; with?: Record<string, string>; env?: Record<string, string>; 'timeout-minutes'?: number | string; 'continue-on-error'?: boolean | string }
const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as {
  jobs: { matrix: { strategy: { matrix: { include?: Entry[]; os?: string[] } }; 'timeout-minutes': number | string; steps: Step[] } }
}
it('cross-OS owner certification has first-parent history and no environment bypass', () => {
  const steps = workflow.jobs.matrix.steps
  const quality = steps.filter((step) => step.run?.trim() === 'pnpm quality')
  expect(quality).toHaveLength(1)
  expect(quality[0]!.env?.WT_QUALITY_CHANGED).toBeUndefined()
  expect(quality[0]!.env?.WT_QUALITY_BASE).toBe('HEAD^1')
  const checkouts = steps.filter((step) => step.uses?.startsWith('actions/checkout@'))
  expect(checkouts.length).toBeGreaterThan(0)
  for (const checkout of checkouts) expect(checkout.with?.['fetch-depth']).toBe(2)
})
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

// Evaluates the `if` forms this workflow uses: `&&` of `always()`, `success()`, `!cancelled()`, `runner.os ==|!= 'X'`,
// `matrix.shard ==|!= N`.
// Any other form throws, so a new shape forces this evaluator to be extended rather than silently read as true.
// An absent `if` is the implicit `success()`; `always()`, `success()` and `!cancelled()` are all true here (no earlier
// step is failed and the run is not cancelled).
// A matrix key the entry does not define is null in GitHub expressions, and null coerces to 0 in `==` / `!=` against a number.
function runsOn(step: Step, entry: Entry): boolean {
  if (step.if === undefined) return true
  return strip(String(step.if)).split('&&').every((raw) => {
    const term = raw.trim()
    if (term === 'always()' || term === 'success()' || term === '!cancelled()') return true
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
// The job's `timeout-minutes` for one entry: a number, or exactly `${{ matrix.timeout || 45 }}` (the entry's `timeout`, else 45).
function jobTimeoutOf(entry: Entry): number {
  const value = job['timeout-minutes']
  if (typeof value === 'number') return value
  if (value.replace(/\s+/g, ' ') !== '${{ matrix.timeout || 45 }}') throw new Error(`cross-os.yml job: unsupported timeout-minutes \`${value}\` (extend jobTimeoutOf in this test)`)
  return entry.timeout ?? 45
}
// Allowance for checkout, setup-node, corepack and install before the first suite step starts.
const SETUP_ALLOWANCE_MINUTES = 3
const isDiagnostic = (step: Step) => (step.name ?? '').startsWith('Diagnose ')
const stepsOnWindows = () => steps.filter((step) => windowsEntries().some((entry) => runsOn(step, entry)))
const isSuiteStep = (step: Step) => /test:shard/.test(step.run ?? '') && step.env?.WT_HOST_CONTRACT_REAL !== '1'
const windowsTestSteps = (entry: Entry) => steps.filter((step) => runsOn(step, entry) && !isDiagnostic(step) && isSuiteStep(step))
const runningOn = (step: Step) => windowsEntries().filter((entry) => runsOn(step, entry))

describe('cross-os workflow: Windows is sharded and every gate still runs once (part 1 of 5)', () => {
  it('the control: the evaluator reads the sharded Linux suite as Linux-only', () => {
    const linuxSuite = steps.find((step) => step.name?.startsWith('Test (Ubuntu shard'))
    expect(linuxSuite, 'the Linux suite step').toBeDefined()
    const selected = entries.filter((entry) => runsOn(linuxSuite as Step, entry))
    expect(selected).toEqual(entries.filter((entry) => runnerOs(entry) === 'Linux'))
    expect(selected.length).toBeGreaterThanOrEqual(2)
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
})

describe('cross-os workflow: Windows is sharded and every gate still runs once (part 2 of 5)', () => {
  it('runs the build before every sharded suite step on every OS', () => {
    const buildIndex = steps.findIndex((step) => /build:dist/.test(step.run ?? '') && /cross-repo-typecheck/.test(step.run ?? ''))
    expect(buildIndex, 'build step index').toBeGreaterThanOrEqual(0)
    const sharded = entries
    expect(sharded.map((entry) => runnerOs(entry))).toEqual(expect.arrayContaining(['Linux', 'macOS', 'Windows']))
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
})

describe('cross-os workflow: Windows is sharded and every gate still runs once (part 3 of 5)', () => {
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
      for (const os of ['ubuntu-latest', 'macos-latest']) {
        const selected = entries.filter((entry) => entry.os === os && runsOn(step, entry))
        expect(selected, `${fragment} on ${os}`).toHaveLength(1)
      }
    }
  })

  it('fits every Windows shard in the job budget: setup + suite budget + the Diagnose budget when it runs there', () => {
    for (const entry of windowsEntries()) {
      const suite = windowsTestSteps(entry)[0] as Step
      const diagnose = steps.filter((step) => isDiagnostic(step) && runsOn(step, entry))
      const total = SETUP_ALLOWANCE_MINUTES + timeoutOf(suite, entry) + diagnose.reduce((sum, step) => sum + timeoutOf(step, entry), 0)
      expect(timeoutOf(suite, entry), `Windows shard ${entry.shard} suite step timeout-minutes`).toBeLessThan(jobTimeoutOf(entry))
      expect(total, `Windows shard ${entry.shard}: setup ${SETUP_ALLOWANCE_MINUTES} + suite ${timeoutOf(suite, entry)} + Diagnose ${diagnose.map((step) => timeoutOf(step, entry)).join('+') || 0}`).toBeLessThanOrEqual(jobTimeoutOf(entry))
    }
  })
})

describe('cross-os workflow: Windows is sharded and every gate still runs once (part 4 of 5)', () => {
  it('fetches the base-version lock client on every entry before any suite step, since the checkout is shallow', () => {
    const fetchIndex = steps.findIndex((step) => /git fetch\b/.test(step.run ?? '') && /base-version-client\.json/.test(step.run ?? ''))
    expect(fetchIndex, 'a step fetches the commit named in test-support/base-version-client.json').toBeGreaterThanOrEqual(0)
    const fetchStep = steps[fetchIndex] as Step
    expect(fetchStep.if, 'the fetch runs on every entry').toBeUndefined()
    expect(fetchStep['continue-on-error'], 'a failed fetch is a red, not a silent skip').toBeUndefined()
    expect(fetchStep.shell, 'the $(...) substitution needs bash on every runner, Windows included').toBe('bash')
    expect(baseClients, 'historical clients are named by role, with no legacy single commit').not.toHaveProperty('commit')
    expect(Object.keys(baseClients.clients)).toEqual(expect.arrayContaining(['preLevels', 'preRelease']))
    for (const commit of Object.values(baseClients.clients)) expect(commit, 'full historical commit id').toMatch(/^[0-9a-f]{40}$/)
    // Execute the actual step with git replaced by an argv recorder: no network, but the descriptor reader and shell run normally.
    const capture = `git() { node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1))+"\\n")' "$@"; }\n${fetchStep.run}`
    const fetched = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', capture], { cwd: join(root, 'toolkit'), encoding: 'utf8' })
    expect(fetched.status, fetched.stderr).toBe(0)
    expect(fetched.stdout.trim().split('\n').map((line) => JSON.parse(line))).toEqual(
      Object.values(baseClients.clients).map((commit) => ['fetch', '--no-tags', '--depth=1', 'origin', commit]),
    )
    for (const entry of entries) {
      const suites = steps.map((step, index) => ({ step, index })).filter(({ step }) => runsOn(step, entry) && !isDiagnostic(step) && /pnpm test|test:shard/.test(step.run ?? ''))
      expect(suites.length, `suite steps of ${entry.os} shard ${entry.shard}`).toBeGreaterThanOrEqual(1)
      for (const { step, index } of suites) expect(index, `"${step.name}" comes after the fetch`).toBeGreaterThan(fetchIndex)
    }
  })

  it('resolves every descriptor client in this clone; only a local shallow clone may skip missing history', ({ skip }) => {
    expect(baseClients.clients, `clients in ${DESCRIPTOR}`).toBeDefined()
    const missing = Object.entries(baseClients.clients).filter(([, commit]) =>
      spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: root }).status !== 0,
    )
    if (missing.length === 0) return
    const reason = `${DESCRIPTOR}: historical clients unavailable: ${missing.map(([role, commit]) => `${role} (${commit})`).join(', ')}`
    const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, encoding: 'utf8' })
    if (!/^(1|true)$/i.test(process.env.CI ?? '') && shallow.status === 0 && shallow.stdout.trim() === 'true') skip(reason)
    expect(missing, reason).toEqual([])
  })
})

describe('cross-os workflow: Windows is sharded and every gate still runs once (part 5 of 5)', () => {
  it('keeps historical git archive invocations in the shared descriptor helper across every build test', () => {
    const testRoot = join(root, 'toolkit/packages/build/test')
    const files = readdirSync(testRoot, { recursive: true }).map(String).filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
    expect(files.length, 'build test files checked').toBeGreaterThan(0)
    const bypasses = files.filter((file) => /\[\s*['"]archive['"]\s*,|git\s+archive\s+[0-9a-f]{7,40}\b/.test(readFileSync(join(testRoot, file), 'utf8')))
    expect(bypasses, 'test files must unpack descriptor roles through helpers/base-version-client.ts').toEqual([])
  })

  it('names the diagnostics artifact differently for every matrix entry', () => {
    const upload = steps.find((step) => step.name === 'Upload cross-OS diagnostics') as Step
    const names = entries.map((entry) => interpolate(String(upload.with?.name), entry))
    expect(new Set(names).size, names.join(', ')).toBe(entries.length)
    for (const name of names) expect(name).not.toContain('/')
  })
})

describe('cross-os workflow: job timeout per matrix entry', () => {
  it('the control: the job timeout reads a number, `matrix.timeout || 45`, and refuses any other form', () => {
    const original = job['timeout-minutes']
    try {
      job['timeout-minutes'] = '${{ matrix.timeout || 45 }}'
      expect(jobTimeoutOf({ os: 'windows-latest', timeout: 75 })).toBe(75)
      expect(jobTimeoutOf({ os: 'ubuntu-latest' })).toBe(45)
      job['timeout-minutes'] = 60
      expect(jobTimeoutOf({ os: 'ubuntu-latest' })).toBe(60)
      job['timeout-minutes'] = '${{ matrix.os }}'
      expect(() => jobTimeoutOf({ os: 'ubuntu-latest' })).toThrow('unsupported timeout-minutes')
    } finally {
      job['timeout-minutes'] = original
    }
  })

  it('gives the Windows entries a 75-minute job timeout and keeps 45 for ubuntu and macOS', () => {
    for (const entry of entries) expect(jobTimeoutOf(entry), `${entry.os} shard ${entry.shard ?? '-'} job timeout`).toBe(entry.os === 'windows-latest' ? 75 : 45)
  })
})

describe('cross-os workflow: Windows shard count', () => {
  it('runs Windows as at least three shards: two were killed at the step timeout while still progressing', () => {
    expect(windowsEntries().length).toBeGreaterThanOrEqual(3)
  })

  // Vitest cuts its path-hashed file order into contiguous slices, so with three shards the last slice holds only
  // files that sat in the old second half, the half measured at over 28 minutes, while the first slice holds only
  // files from the old first half (about 16 minutes). The non-suite gates therefore belong on shard 1, the lightest.
  it('runs the non-suite gates and the Diagnose step on exactly one Windows shard, and that shard is shard 1', () => {
    const extras = steps.filter((step) => isDiagnostic(step) || /pnpm typecheck|pnpm quality|pnpm lint|ci-lifecycle-smoke|host-adapter\.contract/.test(step.run ?? ''))
    expect(extras.length, 'non-suite gate steps').toBeGreaterThanOrEqual(6)
    for (const step of extras) expect(runningOn(step).map((entry) => entry.shard), `"${step.name}" Windows shards`).toEqual([1])
  })

  it('fits every Windows shard in the job budget with the timeout of every build, suite, Diagnose and gate step it runs', () => {
    const counted = (step: Step) => /build:dist|test:shard|pnpm typecheck|pnpm quality|pnpm lint|ci-lifecycle-smoke/.test(step.run ?? '')
    for (const entry of windowsEntries()) {
      const caps = steps.filter((step) => runsOn(step, entry) && counted(step)).map((step) => timeoutOf(step, entry))
      const total = SETUP_ALLOWANCE_MINUTES + caps.reduce((sum, minutes) => sum + minutes, 0)
      expect(total, `Windows shard ${entry.shard}: setup ${SETUP_ALLOWANCE_MINUTES} + ${caps.join('+')}`).toBeLessThanOrEqual(jobTimeoutOf(entry))
    }
  })
})

describe('cross-os workflow: one red never hides the suite', () => {
  it('runs every sharded suite step even after an earlier gating step failed, so one red never hides the suite', () => {
    const suites = steps.filter((step) => /test:shard --shard=/.test(step.run ?? ''))
    expect(suites.length, 'sharded suite steps').toBeGreaterThanOrEqual(3)
    for (const step of suites) expect(strip(String(step.if ?? '')).split('&&').map((term) => term.trim()), `"${step.name}" if`).toContain('!cancelled()')
  })
})

const linux = entries.filter((entry) => runnerOs(entry) === 'Linux')
const linuxSuites = (entry: Entry) => steps.filter((step) => runsOn(step, entry) && isSuiteStep(step) && !isDiagnostic(step))

describe('cross-os workflow: Ubuntu shard budgets and gates', () => {
  it('numbers at least three Ubuntu shards contiguously, with one covered suite each and no full-suite fallback', () => {
    expect(linux.length).toBeGreaterThanOrEqual(3)
    expect(linux.map(({ shard }) => shard)).toEqual(linux.map((_, index) => index + 1))
    for (const entry of linux) {
      const suites = linuxSuites(entry)
      expect(suites).toHaveLength(1)
      expect(suites[0]!.run).toContain(`test:shard --shard=\${{ matrix.shard }}/${linux.length} --coverage`)
      expect(suites[0]!.shell).toBe('bash')
      expect(suites[0]!['continue-on-error']).toBeUndefined()
      for (const step of steps.filter((step) => runsOn(step, entry))) expect(step.run ?? '').not.toMatch(/pnpm test(?![:\w-])/)
    }
  })

  it('projects at least 30 percent headroom from the measured unsharded duration, without raising its old step limit', () => {
    for (const entry of linux) {
      const cap = timeoutOf(linuxSuites(entry)[0]!, entry)
      const projectedSeconds = (1782.44 - 300) * (partitionPlan.full.length / 504) / linux.length + 300
      expect(1 - projectedSeconds / (cap * 60)).toBeGreaterThanOrEqual(0.3)
      expect(cap).toBeLessThan(30)
      expect(jobTimeoutOf(entry)).toBe(45)
    }
  })

  it('deliberately puts every non-suite gate and the real host contract on Ubuntu shard 1 only', () => {
    const gates = steps.filter((step) => /pnpm typecheck|pnpm quality|pnpm lint|ci-lifecycle-smoke|host-adapter\.contract/.test(step.run ?? ''))
    expect(gates).toHaveLength(5)
    for (const gate of gates) expect(linux.filter((entry) => runsOn(gate, entry)).map(({ shard }) => shard)).toEqual([1])
  })
})

describe('cross-os workflow: coverage union wiring', () => {
  const config = parse(readFileSync(WORKFLOW, 'utf8')) as { jobs: Record<string, { needs?: string; if?: string; 'runs-on'?: string; defaults?: { run?: { shell?: string; 'working-directory'?: string } }; steps: Step[] }> }
  const merge = config.jobs['ubuntu-coverage']!

  it('exports JSON execution manifests and converted coverage blobs from every Ubuntu shard', () => {
    const uploads = steps.filter((step) => step.name === 'Upload Ubuntu coverage shard')
    expect(uploads).toHaveLength(1)
    expect(uploads[0]!.if).toContain('always()')
    expect(uploads[0]!.with).toMatchObject({ name: 'ubuntu-coverage-shard-${{ matrix.shard }}', 'if-no-files-found': 'error' })
    for (const entry of linux) {
      expect(runsOn(uploads[0]!, entry)).toBe(true)
      const run = linuxSuites(entry)[0]!.run!
      expect(run).toContain('--reporter=blob --reporter=json')
      expect(run).toContain('--outputFile.blob=ci-coverage/blob-${{ matrix.shard }}.json')
      expect(run).toContain('--outputFile.json=ci-diagnostics/ubuntu-shard-${{ matrix.shard }}.json')
      expect(run).not.toContain('--coverage.thresholds')
    }
    expect(entries.filter((entry) => runsOn(uploads[0]!, entry))).toEqual(linux)
  })

  it('checks the actual shard union before merging coverage with the unchanged full-suite thresholds', () => {
    expect(merge).toMatchObject({ needs: 'matrix', if: '${{ !cancelled() }}', 'runs-on': 'ubuntu-latest' })
    expect(merge.defaults?.run).toEqual({ shell: 'bash', 'working-directory': 'toolkit' })
    const download = merge.steps.find((step) => step.uses?.startsWith('actions/download-artifact'))!
    expect(download.with).toEqual({ pattern: 'ubuntu-coverage-shard-*', path: 'toolkit/', 'merge-multiple': true })
    const check = merge.steps.findIndex((step) => step.run === 'node scripts/check-posix-shards.mjs ci-diagnostics ci-coverage')
    const judgement = merge.steps.findIndex((step) => step.run === 'pnpm exec vitest --merge-reports=ci-coverage --coverage --coverage.provider=v8')
    expect(check).toBeGreaterThan(merge.steps.indexOf(download))
    expect(judgement).toBeGreaterThan(check)
    expect(merge.steps[judgement]!['continue-on-error']).toBeUndefined()
  })
})

describe('Ubuntu suite command runs with the hosted Bash pipeline semantics', () => {
  function runUbuntuCommand(body: string) {
    const directory = mkdtempSync(join(tmpdir(), 'posix-shard-command-'))
    historyRoots.push(directory)
    const command = linuxSuites(linux[0]!)[0]!.run!.replaceAll('${{ matrix.shard }}', '1')
    return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `pnpm() { ${body}; }\n${command}`], { cwd: directory, encoding: 'utf8' })
  }

  it('propagates a failing suite through tee rather than returning the log writer exit code', () => {
    expect(runUbuntuCommand('return 23').status).toBe(23)
  })

  it('passes one shard selector, coverage and all reporter outputs as distinct argv values', () => {
    const result = runUbuntuCommand(`node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "$@"`)
    expect(result.status, result.stderr).toBe(0)
    const args = JSON.parse(result.stdout) as string[]
    expect(args.filter((arg) => arg.startsWith('--shard='))).toEqual([`--shard=1/${linux.length}`])
    // A file filter, project or test-name selector would change which tests run. Permit only these reporting flags.
    expect(args).toEqual(['test:shard', `--shard=1/${linux.length}`, '--coverage',
      '--reporter=default', '--reporter=blob', '--reporter=json', '--outputFile.blob=ci-coverage/blob-1.json', '--outputFile.json=ci-diagnostics/ubuntu-shard-1.json'])
  })
})

const partitionScript = join(root, 'toolkit/scripts/check-posix-shards.mjs')
type Plan = { full: string[]; shards: string[][] }
let partitionPlan: Plan
function partitionCommand(...args: string[]) {
  return spawnSync(process.execPath, [partitionScript, ...args], { cwd: join(root, 'toolkit'), encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
}
function partitionFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'posix-shard-reports-'))
  historyRoots.push(directory)
  const shards = partitionPlan.shards.map((files) => [...files])
  writePartition(directory, shards)
  return { directory, shards }
}
function writePartition(directory: string, shards: string[][]) {
  shards.forEach((files, index) => writeFileSync(join(directory, `ubuntu-shard-${index + 1}.json`), JSON.stringify({ testResults: files.map((file) => ({ name: join(root, 'toolkit', file) })) })))
}

// Vitest's blob wire format is a flatted reference table, not ordinary JSON.
function blobFixture(files: string[], coverage: unknown) {
  const table: unknown[] = []
  function encode(value: unknown): unknown {
    if (value === null || typeof value !== 'object' && typeof value !== 'string') return value
    const index = table.length
    table.push(null)
    table[index] = typeof value === 'string' ? value : Array.isArray(value) ? value.map(encode)
      : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)]))
    return String(index)
  }
  encode(['4.1.11', files.map((file) => ({ filepath: join(root, 'toolkit', file) })), [], coverage, 1, {}])
  return JSON.stringify(table)
}

function writeBlobs(directory: string) {
  const blobs = join(directory, 'blobs')
  mkdirSync(blobs)
  partitionPlan.shards.forEach((files, index) => writeFileSync(join(blobs, `blob-${index + 1}.json`),
    blobFixture(files, { [`source-${index}.mjs`]: { path: `source-${index}.mjs`, s: { 0: index + 1 } } })))
  return blobs
}

beforeAll(() => {
  const result = partitionCommand('--plan')
  expect(result.status, result.stderr).toBe(0)
  partitionPlan = JSON.parse(result.stdout) as Plan
}, 40_000)

describe('Ubuntu shard union checker uses real Vitest-selected files and exit codes', () => {
  it('covers the real full file list exactly once, including every configured project', () => {
    expect(partitionPlan.full.length).toBeGreaterThan(0)
    expect(partitionPlan.shards).toHaveLength(linux.length)
    expect(partitionPlan.shards.flat().sort()).toEqual(partitionPlan.full)
    const { directory } = partitionFixture()
    const result = partitionCommand(directory)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('FULL_MINUS_UNION=[]\nUNION_MINUS_FULL=[]\nDUPLICATES=[]')
  })

  it.each(['missing', 'duplicated', 'extra'])('fails by exit code when the real report population has a %s file', (defect) => {
    const { directory, shards } = partitionFixture()
    if (defect === 'missing') shards[0]!.pop()
    if (defect === 'duplicated') shards[0]!.push(shards[1]![0]!)
    if (defect === 'extra') shards[0]!.push('packages/build/test/unselected-fixture.test.ts')
    writePartition(directory, shards)
    const result = partitionCommand(directory)
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('Shard union mismatch:')
    expect(result.stderr).toMatch(new RegExp(`"${defect}":\\["`))
  })

  it('refuses a union-preserving swap between two shards', () => {
    const { directory, shards } = partitionFixture()
    ;[shards[0]![0], shards[1]![0]] = [shards[1]![0]!, shards[0]![0]!]
    writePartition(directory, shards)
    const result = partitionCommand(directory)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Shard 1 membership:')
  })
})

describe('Ubuntu shard union checker refuses incomplete artifact downloads', () => {
  it('refuses an absent shard report rather than accepting the surviving reports', () => {
    const { directory } = partitionFixture()
    rmSync(join(directory, 'ubuntu-shard-1.json'))
    const result = partitionCommand(directory)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Shard reports: expected')
  })

  it('requires exactly one coverage blob from every shard', () => {
    const { directory } = partitionFixture()
    const blobs = writeBlobs(directory)
    expect(partitionCommand(directory, blobs).status).toBe(0)
    rmSync(join(blobs, 'blob-1.json'))
    const result = partitionCommand(directory, blobs)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Coverage blobs: expected')
  })
})

describe('Ubuntu shard blobs must attest their own membership and coverage', () => {
  it('rejects a correctly named shard 2 blob with an empty coverage payload', () => {
    const { directory } = partitionFixture()
    const blobs = writeBlobs(directory)
    writeFileSync(join(blobs, 'blob-2.json'), blobFixture(partitionPlan.shards[1]!, {}))
    const result = partitionCommand(directory, blobs)
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.stderr).toContain('Shard 2 coverage payload is empty')
  })

  it('rejects a correctly named shard 2 blob copied from shard 1', () => {
    const { directory } = partitionFixture()
    const blobs = writeBlobs(directory)
    writeFileSync(join(blobs, 'blob-2.json'), readFileSync(join(blobs, 'blob-1.json')))
    const result = partitionCommand(directory, blobs)
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.stderr).toContain('Shard 2 blob membership:')
  })

  it('rejects shard 2 coverage copied from shard 1 even with its own correct test membership', () => {
    const { directory } = partitionFixture()
    const blobs = writeBlobs(directory)
    writeFileSync(join(blobs, 'blob-2.json'), blobFixture(partitionPlan.shards[1]!, { 'source-0.mjs': { path: 'source-0.mjs', s: { 0: 1 } } }))
    const result = partitionCommand(directory, blobs)
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.stderr).toContain('Shard 2 coverage payload duplicates shard 1')
  })
})

function coverageFixture() {
  const parent = mkdtempSync(join(tmpdir(), 'posix-coverage-merge-'))
  historyRoots.push(parent)
  mkdirSync(join(parent, 'real'))
  symlinkSync(join(parent, 'real'), join(parent, 'alias'), 'junction')
  // macOS's temp root may itself be an alias (/var -> /private/var); use one identity for Vite and Node.
  const directory = realpathSync(join(parent, 'alias'))
  const branch = join(directory, 'branch.mjs')
  writeFileSync(branch, 'export function choose(flag) {\n  if (flag) {\n    return 1\n  }\n  return 2\n}\n')
  const testConfig = { include: ['*.test.mjs'], globals: true, maxWorkers: 1, coverage: {
    provider: 'custom', customProviderModule: join(root, 'toolkit/scripts/child-process-coverage-provider.mjs').replaceAll('\\', '/'),
    include: ['branch.mjs'], reporter: ['json-summary'], reportsDirectory: 'coverage',
    thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
  } }
  writeFileSync(join(directory, 'vitest.config.mjs'), `export default ${JSON.stringify({ test: testConfig })}`)
  for (const flag of [true, false]) {
    const child = `import { choose } from ${JSON.stringify(pathToFileURL(branch).href)}; choose(${flag})`
    writeFileSync(join(directory, `${flag}.test.mjs`), `import { execFileSync } from 'node:child_process';\nit('child branch', () => { execFileSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(child)}]) })`)
  }
  return directory
}

function coverageRun(directory: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(root, 'plugin/bin/wt-suite-lock.mjs'), 'run', '--light', '--', process.execPath,
    join(root, 'toolkit/node_modules/vitest/vitest.mjs'), ...args, '--config', join(directory, 'vitest.config.mjs'), '--root', directory, '--coverage.enabled=true'], {
    cwd: directory, encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
  })
}

it('enforces thresholds on merged custom-provider blobs, including coverage executed only in child processes', () => {
  const directory = coverageFixture()
  const manifests: string[][] = []
  for (let index = 1; index <= 2; index++) {
    const result = coverageRun(directory, 'run', `--shard=${index}/2`, '--reporter=blob', '--reporter=json',
      `--outputFile.blob=blobs/blob-${index}.json`, `--outputFile.json=manifest-${index}.json`)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const report = JSON.parse(readFileSync(join(directory, `manifest-${index}.json`), 'utf8')) as { testResults: { name: string }[] }
    manifests.push(report.testResults.map(({ name }) => name.slice(directory.length + 1)))
  }
  expect(manifests.flat().sort()).toEqual(['false.test.mjs', 'true.test.mjs'])
  expect(() => shardChecker.assertCoverageBlobs(join(directory, 'blobs'), manifests, directory)).not.toThrow()
  const singleShard = coverageRun(directory, 'run', 'true.test.mjs', '--shard=1/1')
  expect(singleShard.status, singleShard.stdout + singleShard.stderr).toBe(1)
  expect(singleShard.stderr + singleShard.stdout).toMatch(/Coverage for .* does not meet global.*threshold/)
  const incomplete = join(directory, 'incomplete')
  mkdirSync(incomplete)
  writeFileSync(join(incomplete, 'blob-1.json'), readFileSync(join(directory, 'blobs/blob-1.json')))
  const red = coverageRun(directory, '--merge-reports=incomplete', '--coverage.provider=v8')
  expect(red.status, red.stdout + red.stderr).toBe(1)
  expect(red.stderr + red.stdout).toMatch(/Coverage for .* does not meet global.*threshold/)
  const green = coverageRun(directory, '--merge-reports=blobs', '--coverage.provider=v8')
  expect(green.status, green.stdout + green.stderr).toBe(0)
  const summary = JSON.parse(readFileSync(join(directory, 'coverage/coverage-summary.json'), 'utf8')) as { total: Record<string, { total: number; covered: number }> }
  for (const metric of ['lines', 'branches', 'functions', 'statements']) {
    expect(summary.total[metric]!.total).toBeGreaterThan(0)
    expect(summary.total[metric]!.covered).toBe(summary.total[metric]!.total)
  }
}, 180_000)
