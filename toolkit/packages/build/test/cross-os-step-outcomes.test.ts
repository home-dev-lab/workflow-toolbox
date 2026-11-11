import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'

// Locks for the step-status wiring of .github/workflows/cross-os.yml. A failed or skipped build must stop every step
// that runs tests, so the job names the step that broke instead of a wave of test failures against a missing dist.
// A red earlier gate (the real host contract) must still not hide the suite. The socat install for the lane-sandbox
// network cases is bounded and never gates the job: without socat those two cases skip with their named reason.
// The test replays GitHub's step-status rules (an `if` with no status function gets an implicit `success()`; a
// failed step without `continue-on-error` fails the job; `steps.<id>.outcome` is the step's own result) over the
// parsed workflow, one matrix entry and one forced failure at a time. It is a restricted model: the `matrix` job only
// (the `ubuntu-coverage` job's missing-shard message is locked in cross-os-workflow.test.ts), no cancellation or job
// timeout (`!cancelled()` is always true here), and a test step is any step whose command runs `test:shard` or vitest.

const root = resolve(import.meta.dirname, '../../../..')
const WORKFLOW = join(root, '.github/workflows/cross-os.yml')

type Entry = { os: string; shard?: number }
type Step = {
  id?: string
  name?: string
  uses?: string
  if?: string
  run?: string
  env?: Record<string, string>
  'timeout-minutes'?: number | string
  'continue-on-error'?: boolean
}
type Outcome = 'success' | 'failure' | 'skipped'

const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as { jobs: { matrix: { strategy: { matrix: { include: Entry[] } }; steps: Step[] } } }
const entries = workflow.jobs.matrix.strategy.matrix.include
const steps = workflow.jobs.matrix.steps
const RUNNER_OS: Record<string, string> = { 'ubuntu-latest': 'Linux', 'macos-latest': 'macOS', 'windows-latest': 'Windows' }
const STATUS = /\b(always|success|failure|cancelled)\(\)/

const strip = (expression: string) => expression.trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '')
const label = (step: Step) => step.name ?? step.uses ?? step.run ?? '(unnamed)'
const runsTests = (step: Step) => /test:shard|vitest/.test(step.run ?? '')
const isSuite = (step: Step) => /test:shard --shard=/.test(step.run ?? '')
const isBuild = (step: Step) => /build:dist/.test(step.run ?? '')
const isSocat = (step: Step) => /\bsocat\b/.test(step.name ?? '')
const isHostContract = (step: Step) => /host-adapter\.contract/.test(step.run ?? '')

type State = { entry: Entry; jobFailed: boolean; outcomes: Record<string, Outcome> }

function stepOutcomeTerm(text: string, step: Step, state: State): boolean | undefined {
  const outcome = /^steps\.([\w-]+)\.outcome\s*(==|!=)\s*'(\w+)'$/.exec(text)
  if (!outcome) return undefined
  const seen = state.outcomes[outcome[1]!]
  if (seen === undefined) throw new Error(`step "${label(step)}" reads steps.${outcome[1]} before any step with that id ran`)
  return (seen === outcome[3]) === (outcome[2] === '==')
}

function term(raw: string, step: Step, state: State): boolean {
  const text = raw.trim()
  if (text === 'always()' || text === '!cancelled()') return true
  if (text === 'success()') return !state.jobFailed
  if (text === 'failure()') return state.jobFailed
  const os = /^runner\.os\s*(==|!=)\s*'([A-Za-z]+)'$/.exec(text)
  if (os) return (RUNNER_OS[state.entry.os] === os[2]) === (os[1] === '==')
  const shard = /^matrix\.shard\s*(==|!=)\s*(\d+)$/.exec(text)
  if (shard) return ((state.entry.shard ?? 0) === Number(shard[2])) === (shard[1] === '==')
  const outcome = stepOutcomeTerm(text, step, state)
  if (outcome !== undefined) return outcome
  throw new Error(`step "${label(step)}": unsupported if term \`${text}\` (extend term() in this test)`)
}

function shouldRun(step: Step, state: State): boolean {
  if (step.if === undefined) return !state.jobFailed
  const expression = strip(String(step.if))
  if (/\|\||[()]/.test(expression.replace(/\b\w+\(\)/g, ''))) throw new Error(`step "${label(step)}": only && of simple terms is modelled`)
  return (STATUS.test(expression) || !state.jobFailed) && expression.split('&&').every((raw) => term(raw, step, state))
}

// Plays the job for one entry with `failing` forced to fail (when it runs); returns each step's outcome in order.
function play(entry: Entry, failing?: Step): { state: State; outcomes: Outcome[] } {
  const state: State = { entry, jobFailed: false, outcomes: {} }
  const outcomes = steps.map((step) => {
    const outcome: Outcome = !shouldRun(step, state) ? 'skipped' : step === failing ? 'failure' : 'success'
    if (step.id) state.outcomes[step.id] = outcome
    if (outcome === 'failure' && step['continue-on-error'] !== true) state.jobFailed = true
    return outcome
  })
  return { state, outcomes }
}

const ran = (entry: Entry, failing?: Step) => {
  const { outcomes } = play(entry, failing)
  return steps.filter((_, index) => outcomes[index] !== 'skipped')
}
const buildIndex = steps.findIndex(isBuild)
const linux = entries.filter((entry) => RUNNER_OS[entry.os] === 'Linux')

describe('cross-os workflow step outcomes: the model', () => {
  it('the control: with no failure every entry runs its build and exactly one suite step', () => {
    expect(entries.length).toBeGreaterThanOrEqual(9)
    for (const entry of entries) {
      const run = ran(entry)
      expect(run.filter(isBuild), `${entry.os} ${entry.shard}`).toHaveLength(1)
      expect(run.filter(isSuite), `${entry.os} ${entry.shard}`).toHaveLength(1)
    }
  })

  it('the control: an `if` without a status function is skipped after a failure, `!cancelled()` is not', () => {
    const state: State = { entry: linux[0]!, jobFailed: true, outcomes: {} }
    expect(shouldRun({ name: 'implicit', if: "${{ runner.os == 'Linux' }}" }, state)).toBe(false)
    expect(shouldRun({ name: 'explicit', if: "${{ !cancelled() && runner.os == 'Linux' }}" }, state)).toBe(true)
    expect(shouldRun({ name: 'none' }, state)).toBe(false)
  })
})

describe('cross-os workflow step outcomes: no test runs against a build that did not happen', () => {
  it('runs no test step on any entry once a gating step up to and including the build failed', () => {
    expect(buildIndex).toBeGreaterThan(0)
    for (const entry of entries) {
      const gating = steps.slice(0, buildIndex + 1).filter((step) => step['continue-on-error'] !== true && ran(entry).includes(step))
      expect(gating.length).toBeGreaterThan(3)
      for (const failing of gating) {
        const tests = ran(entry, failing).filter(runsTests).map(label)
        expect(tests, `${entry.os} shard ${entry.shard}: "${label(failing)}" failed`).toEqual([])
      }
    }
  })

  it('uploads no Ubuntu coverage shard when the suite was skipped, so the build failure stays the only red step', () => {
    const upload = steps.find((step) => step.name === 'Upload Ubuntu coverage shard')!
    expect(upload).toBeDefined()
    for (const entry of linux) {
      expect(ran(entry).includes(upload)).toBe(true)
      expect(ran(entry, steps[buildIndex]).includes(upload), `shard ${entry.shard}`).toBe(false)
    }
  })

  it('keeps the suite running after a red host contract, the reason the suite steps carry `!cancelled()`', () => {
    const contract = steps.find(isHostContract)!
    const covered = entries.filter((entry) => {
      const run = ran(entry)
      return run.includes(contract) && steps.indexOf(contract) < steps.indexOf(run.find(isSuite)!)
    })
    expect(covered.length).toBeGreaterThanOrEqual(2)
    for (const entry of covered) expect(ran(entry, contract).filter(isSuite), `${entry.os} shard ${entry.shard}`).toHaveLength(1)
  })
})

const REQUIRE_FORM = /^\$\{\{\s*steps\.socat\.outcome\s*==\s*'success'\s*&&\s*'1'\s*\|\|\s*'0'\s*\}\}$/
// Evaluates the Ubuntu suite's WT_LANE_SANDBOX_REQUIRE_SOCAT for one played job; any other form throws.
function requireSocat(entry: Entry, failing?: Step): string {
  const value = ran(entry).find(isSuite)?.env?.WT_LANE_SANDBOX_REQUIRE_SOCAT
  if (typeof value !== 'string' || !REQUIRE_FORM.test(value)) throw new Error(`unsupported WT_LANE_SANDBOX_REQUIRE_SOCAT \`${String(value)}\``)
  return play(entry, failing).state.outcomes.socat === 'success' ? '1' : '0'
}

describe('cross-os workflow step outcomes: an unreachable Ubuntu mirror only skips the socat cases', () => {
  const socat = steps.find(isSocat)!

  it('still builds and runs the Ubuntu suite when the socat install fails', () => {
    expect(socat?.id).toBe('socat')
    for (const entry of linux) {
      const run = ran(entry, socat)
      expect(run.filter(isBuild), `shard ${entry.shard}`).toHaveLength(1)
      expect(run.filter(isSuite), `shard ${entry.shard}`).toHaveLength(1)
      expect(play(entry, socat).state.jobFailed, `shard ${entry.shard}`).toBe(false)
    }
  })

  it('requires socat in the suite exactly when it was installed, so a resolver regression still fails', () => {
    for (const entry of linux) {
      expect(requireSocat(entry)).toBe('1')
      expect(requireSocat(entry, socat)).toBe('0')
    }
  })
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeTool(dir: string, name: string, body: string) {
  writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`)
  chmodSync(join(dir, name), 0o755)
}

// Runs the socat step body under the hosted Bash flags with `timeout`, `sudo`, `apt-get` and `sleep` replaced by
// recorders. `plan` lists each apt-get call's result in order: `ok`, `fail` (exit 100) or `hang` (cut by timeout: 124).
function runSocatBody(plan: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'cross-os-socat-'))
  dirs.push(dir)
  const log = join(dir, 'calls.log')
  writeFileSync(log, '')
  writeFileSync(join(dir, 'plan'), plan.join('\n') + '\n')
  // Records the bound and its --kill-after grace (0 when absent) so the budget is computed from the real values.
  writeTool(dir, 'timeout', `grace=0\nwhile [[ "$1" == -* ]]; do case "$1" in --kill-after=*) grace="\${1#--kill-after=}";; -k) shift; grace="$1";; esac; shift; done\necho "timeout $1 $grace" >> "${log}"\nshift\n"$@"\ns=$?\nif [[ -f "${dir}/hung" ]]; then rm -f "${dir}/hung"; exit 124; fi\nexit $s`)
  writeTool(dir, 'sudo', `echo "sudo $1" >> "${log}"\nexec "$@"`)
  writeTool(dir, 'sleep', `echo "sleep $1" >> "${log}"`)
  writeTool(dir, 'apt-get', `echo "apt-get $*" >> "${log}"\nr=$(head -n 1 "${dir}/plan"); tail -n +2 "${dir}/plan" > "${dir}/plan.next"; mv "${dir}/plan.next" "${dir}/plan"\ncase "$r" in ok) exit 0;; hang) touch "${dir}/hung"; exit 1;; *) exit 100;; esac`)
  const summary = join(dir, 'summary.md')
  writeFileSync(summary, '')
  const socat = steps.find(isSocat)!
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', socat.run!], {
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH ?? ''}`, GITHUB_STEP_SUMMARY: summary },
  })
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
  return { status: result.status, stdout: result.stdout, calls, summary: readFileSync(summary, 'utf8'), timeoutMinutes: Number(socat['timeout-minutes']) }
}

const installs = (calls: string[]) => calls.filter((call) => /^apt-get .*install/.test(call)).length
const updates = (calls: string[]) => calls.filter((call) => /^apt-get .*update/.test(call)).length

// The socat step runs only on Linux (`runner.os == 'Linux'`); its recorders are POSIX shell scripts on a POSIX PATH,
// so the body is not replayed on Windows. macOS runs it: the recorders use no GNU-only option.
describe.skipIf(process.platform === 'win32')('cross-os workflow step outcomes: the socat install is bounded', () => {
  it('installs once and succeeds when the mirror answers', () => {
    const run = runSocatBody(['ok'])
    expect(run.status).toBe(0)
    expect([installs(run.calls), updates(run.calls)]).toEqual([1, 0])
  })

  it('refreshes the index and tries again after a first install that hangs, the 2026-11-11 tag-run condition', () => {
    const run = runSocatBody(['hang', 'ok', 'ok'])
    expect(run.status).toBe(0)
    expect([installs(run.calls), updates(run.calls)]).toEqual([2, 1])
    // Every apt-get call is cut by its own bound: an unbounded first install hangs until the step timeout kills the
    // whole step, and the fallback never runs (both tag runs of 2026-11-11).
    expect(run.calls.filter((call) => call.startsWith('timeout ')).length).toBe(installs(run.calls) + updates(run.calls))
    // The bound runs inside sudo: an unprivileged timeout cannot be relied on to kill root-owned apt and dpkg children.
    const sudo = run.calls.filter((call) => call.startsWith('sudo '))
    expect(sudo.length).toBe(installs(run.calls) + updates(run.calls))
    expect(sudo.every((call) => call === 'sudo timeout'), sudo.join('; ')).toBe(true)
  })

  it('gives up with a named warning and a job-summary line when every attempt hangs, inside the step budget', () => {
    const run = runSocatBody(['hang', 'hang', 'hang'])
    expect(run.status).not.toBe(0)
    expect(run.stdout).toMatch(/^::warning title=socat unavailable::.*lane-sandbox network cases.*skip with their named reason/m)
    expect(run.summary).toMatch(/socat unavailable/)
    const bounds = run.calls.filter((call) => call.startsWith('timeout ')).map((call) => call.split(' ').slice(1).map(Number))
    const sleeps = run.calls.filter((call) => call.startsWith('sleep ')).map((call) => Number(call.split(' ')[1]))
    expect(bounds.length).toBe(run.calls.filter((call) => call.startsWith('apt-get ')).length)
    expect(bounds.flat().every(Number.isFinite), JSON.stringify(bounds)).toBe(true)
    // Each bound plus its kill-after grace, plus the sleeps, must end before the step's own timeout cuts the step.
    const worst = bounds.reduce((sum, [bound, grace]) => sum + bound! + grace!, 0) + sleeps.reduce((sum, value) => sum + value, 0)
    expect(worst).toBeLessThan(run.timeoutMinutes * 60)
  })
})
